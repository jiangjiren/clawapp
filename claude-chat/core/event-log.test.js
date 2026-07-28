// event-log 的单元测试。全部跑在临时目录里，绝不碰 claude-chat/data 的真实数据。
import test from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import * as log from "./event-log.js";

function freshStore() {
  const dir = mkdtempSync(join(tmpdir(), "event-log-test-"));
  log.configure({ dataDir: dir });
  return {
    dir,
    logFile: convId => join(dir, "conversations", convId, "events.ndjson"),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

test("append 后 seq 从 1 开始单调递增", () => {
  const store = freshStore();
  try {
    log.ensureConversation("convaaaa0001");
    const a = log.appendEvent("convaaaa0001", "user", { id: "u1", text: "你好" });
    const b = log.appendEvent("convaaaa0001", "sdk", { type: "assistant", message: { content: [] } });
    assert.equal(a.seq, 1);
    assert.equal(b.seq, 2);
    assert.equal(log.getMeta("convaaaa0001").lastSeq, 2);
  } finally { store.cleanup(); }
});

test("appendEvents 批量写入单次 I/O，seq 连续", () => {
  const store = freshStore();
  try {
    const written = log.appendEvents("convaaaa0002", [
      { kind: "user", payload: { id: "u1", text: "一" } },
      { kind: "sdk", payload: { type: "done" } },
      { kind: "turn", payload: { turnId: "t1", status: "complete" } },
    ]);
    assert.deepEqual(written.map(w => w.seq), [1, 2, 3]);
    const lines = readFileSync(store.logFile("convaaaa0002"), "utf8").trim().split("\n");
    assert.equal(lines.length, 3);
  } finally { store.cleanup(); }
});

test("readEventsSince 只返回游标之后的事件", () => {
  const store = freshStore();
  try {
    log.appendEvents("convaaaa0003", [
      { kind: "user", payload: { id: "u1", text: "一" } },
      { kind: "user", payload: { id: "u2", text: "二" } },
      { kind: "user", payload: { id: "u3", text: "三" } },
    ]);
    const result = log.readEventsSince("convaaaa0003", 1);
    assert.deepEqual(result.events.map(e => e.seq), [2, 3]);
    assert.equal(result.lastSeq, 3);
    assert.equal(result.truncated, false);
  } finally { store.cleanup(); }
});

test("游标已是最新时返回空数组", () => {
  const store = freshStore();
  try {
    log.appendEvent("convaaaa0004", "user", { id: "u1", text: "一" });
    const result = log.readEventsSince("convaaaa0004", 1);
    assert.deepEqual(result.events, []);
    assert.equal(result.lastSeq, 1);
  } finally { store.cleanup(); }
});

test("超过 limit 时标记 truncated", () => {
  const store = freshStore();
  try {
    log.appendEvents("convaaaa0005",
      Array.from({ length: 10 }, (_, i) => ({ kind: "user", payload: { id: `u${i}`, text: `${i}` } })));
    const result = log.readEventsSince("convaaaa0005", 0, { limit: 4 });
    assert.equal(result.events.length, 4);
    assert.equal(result.truncated, true);
    assert.equal(result.lastSeq, 10);
  } finally { store.cleanup(); }
});

test("最后一行是半截 JSON 时跳过而不是抛异常", () => {
  const store = freshStore();
  try {
    log.appendEvents("convaaaa0006", [
      { kind: "user", payload: { id: "u1", text: "完整的" } },
      { kind: "user", payload: { id: "u2", text: "也完整" } },
    ]);
    // 模拟进程被 kill 时写了一半
    appendFileSync(store.logFile("convaaaa0006"), '{"seq":3,"ts":123,"kind":"user","pay', "utf8");
    const result = log.readEventsSince("convaaaa0006", 0);
    assert.equal(result.events.length, 2);
    assert.deepEqual(result.events.map(e => e.payload.text), ["完整的", "也完整"]);
  } finally { store.cleanup(); }
});

test("meta 坏掉时 lastSeq 从日志重算", () => {
  const store = freshStore();
  try {
    log.appendEvents("convaaaa0007", [
      { kind: "user", payload: { id: "u1", text: "一" } },
      { kind: "user", payload: { id: "u2", text: "二" } },
    ]);
    writeFileSync(join(store.dir, "conversations", "convaaaa0007", "meta.json"), "{坏掉的", "utf8");
    log.configure({ dataDir: store.dir }); // 清缓存，强制回磁盘
    assert.equal(log.getMeta("convaaaa0007").lastSeq, 2);
  } finally { store.cleanup(); }
});

test("meta 完整但落后于日志时以实际最大 seq 为准，后续不复用序号", () => {
  const store = freshStore();
  try {
    const id = "convaaaa0023";
    log.appendEvent(id, "user", { id: "u1", text: "第一条" });
    // 模拟 append 已成功、meta 尚未更新就被 kill：日志里有 seq=2，meta 仍是 1。
    appendFileSync(
      store.logFile(id),
      `${JSON.stringify({ seq: 2, ts: Date.now(), kind: "user", payload: { id: "u2", text: "第二条" } })}\n`,
      "utf8",
    );
    log.configure({ dataDir: store.dir });
    assert.equal(log.getMeta(id).lastSeq, 2);
    assert.equal(log.appendEvent(id, "user", { id: "u3", text: "第三条" }).seq, 3);
    assert.deepEqual(log.readEventsSince(id, 0).events.map(event => event.seq), [1, 2, 3]);
  } finally { store.cleanup(); }
});

test("meta 超前或日志末行损坏时 lastSeq 回落到实际值，下一条从完整记录继续", () => {
  const store = freshStore();
  try {
    const id = "convaaaa0024";
    log.appendEvent(id, "user", { id: "u1", text: "完整" });
    appendFileSync(store.logFile(id), '{"seq":2,"ts":123,"kind":"user","payload":', "utf8");
    writeFileSync(join(store.dir, "conversations", id, "meta.json"), JSON.stringify({
      ...log.getMeta(id),
      lastSeq: 99,
    }), "utf8");

    log.configure({ dataDir: store.dir });
    assert.equal(log.getMeta(id).lastSeq, 1);
    assert.equal(log.appendEvent(id, "user", { id: "u2", text: "崩溃后" }).seq, 2);
    const events = log.readEventsSince(id, 0).events;
    assert.deepEqual(events.map(event => event.seq), [1, 2]);
    assert.equal(events[1].payload.text, "崩溃后");
  } finally { store.cleanup(); }
});

test("updateMeta 不允许外部覆盖 lastSeq", () => {
  const store = freshStore();
  try {
    log.appendEvent("convaaaa0008", "user", { id: "u1", text: "一" });
    const meta = log.updateMeta("convaaaa0008", { lastSeq: 999, title: "改过的标题" });
    assert.equal(meta.lastSeq, 1);
    assert.equal(meta.title, "改过的标题");
  } finally { store.cleanup(); }
});

test("turn 事件把轮次快照刷进 meta", () => {
  const store = freshStore();
  try {
    log.appendEvent("convaaaa0009", "turn", { turnId: "t1", status: "running", requestId: "r1" });
    assert.deepEqual(log.getMeta("convaaaa0009").turn, { turnId: "t1", status: "running", requestId: "r1" });
    log.appendEvent("convaaaa0009", "turn", { turnId: "t1", status: "complete", requestId: "r1" });
    assert.equal(log.getMeta("convaaaa0009").turn.status, "complete");
  } finally { store.cleanup(); }
});

test("session 事件把 sessionId 落进 meta", () => {
  const store = freshStore();
  try {
    log.appendEvent("convaaaa0010", "sdk", { type: "session", sessionId: "sess-1", provider: "claude" });
    const meta = log.getMeta("convaaaa0010");
    assert.equal(meta.sessionId, "sess-1");
    assert.equal(meta.sessionProvider, "claude");
  } finally { store.cleanup(); }
});

test("project 还原出典型一轮对话", () => {
  const store = freshStore();
  try {
    const id = "convaaaa0011";
    log.appendEvents(id, [
      { kind: "user", payload: { id: "u1", text: "帮我查一下" } },
      { kind: "turn", payload: { turnId: "t1", status: "running", requestId: "r1" } },
      { kind: "sdk", payload: { type: "assistant", message: { content: [{ type: "text", text: "好的，我查一下" }] } } },
      { kind: "sdk", payload: { type: "assistant", message: { content: [{ type: "tool_use", id: "tu1", name: "WebSearch", input: { q: "x" } }] } } },
      { kind: "sdk", payload: { type: "tool_result", tool_use_id: "tu1", content: "结果" } },
      { kind: "sdk", payload: { type: "assistant", message: { content: [{ type: "text", text: "查到了" }] } } },
      { kind: "sdk", payload: { type: "result", subtype: "success", total_cost_usd: 0.02 } },
    ]);

    const conv = log.project(id);
    assert.equal(conv.messages.length, 2);
    assert.equal(conv.messages[0].role, "user");
    assert.equal(conv.messages[0].text, "帮我查一下");

    const assistant = conv.messages[1];
    assert.equal(assistant.role, "assistant");
    assert.equal(assistant.status, "complete");
    assert.equal(assistant.cost, 0.02);
    // 两段 text 用空行拼接，与 server.js 现有行为一致
    assert.equal(assistant.text, "好的，我查一下\n\n查到了");
    assert.equal(assistant.blocks.filter(b => b.type === "tool_use").length, 1);
    assert.equal(conv.title, "帮我查一下");
  } finally { store.cleanup(); }
});

test("同 id 的 block 是更新而不是追加", () => {
  const store = freshStore();
  try {
    const id = "convaaaa0012";
    log.appendEvents(id, [
      { kind: "sdk", payload: { type: "assistant", message: { content: [{ type: "tool_use", id: "tu1", name: "Bash", input: {} }] } } },
      { kind: "sdk", payload: { type: "assistant", message: { content: [{ type: "tool_use", id: "tu1", name: "Bash", input: { command: "ls" } }] } } },
    ]);
    const assistant = log.project(id).messages[0];
    const toolBlocks = assistant.blocks.filter(b => b.type === "tool_use");
    assert.equal(toolBlocks.length, 1);
    assert.deepEqual(toolBlocks[0].input, { command: "ls" });
  } finally { store.cleanup(); }
});

test("轮次结束后回来的后台任务事件挂回上一条 assistant 消息", () => {
  const store = freshStore();
  try {
    const id = "convaaaa0013";
    log.appendEvents(id, [
      { kind: "sdk", payload: { type: "assistant", message: { content: [{ type: "text", text: "已派出后台任务" }] } } },
      { kind: "sdk", payload: { type: "result", subtype: "success" } },
      // 跨轮次回来的后台任务通知：不该凭空开一条新的 assistant 消息
      { kind: "sdk", payload: { type: "system", subtype: "task_notification", task_id: "bg1" } },
    ]);
    const conv = log.project(id);
    assert.equal(conv.messages.length, 1);
    assert.ok(conv.messages[0].blocks.some(b => b.eventType === "task_notification"));
    assert.equal(conv.messages[0].status, "complete");
  } finally { store.cleanup(); }
});

test("error / stopped 的 turn 状态正确透传", () => {
  const store = freshStore();
  try {
    log.appendEvents("convaaaa0014", [
      { kind: "sdk", payload: { type: "assistant", message: { content: [{ type: "text", text: "写到一半" }] } } },
      { kind: "turn", payload: { turnId: "t1", status: "stopped" } },
    ]);
    assert.equal(log.project("convaaaa0014").messages[0].status, "stopped");
  } finally { store.cleanup(); }
});

test("replaceFromConversation 往返后关键字段一致", () => {
  const store = freshStore();
  try {
    const source = {
      id: "convaaaa0015",
      title: "往返测试",
      date: new Date().toISOString(),
      sessionId: "sess-9",
      sessionProvider: "claude",
      profileId: "p_claude",
      messages: [
        { id: "u1", role: "user", text: "问题一", cost: null },
        {
          id: "a1", role: "assistant", text: "回答一", cost: 0.03, status: "complete",
          blocks: [{ type: "text", text: "回答一", raw: { type: "text", text: "回答一" } }],
          events: [],
        },
      ],
    };
    log.replaceFromConversation(source);
    const back = log.project("convaaaa0015");
    assert.equal(back.messages.length, 2);
    assert.equal(back.messages[0].role, "user");
    assert.equal(back.messages[0].text, "问题一");
    assert.equal(back.messages[1].role, "assistant");
    assert.equal(back.messages[1].text, "回答一");
    assert.equal(back.messages[1].cost, 0.03);
    assert.equal(back.messages[1].status, "complete");
    assert.equal(back.messages[1].blocks.length, 1);
    assert.equal(back.messages[1].id, "a1");
    assert.equal(back.sessionId, "sess-9");
  } finally { store.cleanup(); }
});

test("user images 在 replace / project 往返中保留", () => {
  const store = freshStore();
  try {
    const images = [{ mediaType: "image/png", data: "AAAA" }];
    log.replaceFromConversation({
      id: "convaaaa0025",
      title: "图片",
      messages: [{ id: "u1", role: "user", text: "看图", images }],
    });
    assert.deepEqual(log.project("convaaaa0025").messages[0].images, images);
  } finally { store.cleanup(); }
});

test("replaceFromConversation 覆盖而不是追加", () => {
  const store = freshStore();
  try {
    const base = {
      id: "convaaaa0016", title: "t", date: new Date().toISOString(),
      messages: [{ id: "u1", role: "user", text: "一", cost: null }],
    };
    log.replaceFromConversation(base);
    log.replaceFromConversation({ ...base, messages: [{ id: "u2", role: "user", text: "二", cost: null }] });
    const back = log.project("convaaaa0016");
    assert.equal(back.messages.length, 1);
    assert.equal(back.messages[0].text, "二");
  } finally { store.cleanup(); }
});

test("重复 id 的 user 事件只投影一次", () => {
  const store = freshStore();
  try {
    log.appendEvents("convaaaa0017", [
      { kind: "user", payload: { id: "u1", text: "重发的消息" } },
      { kind: "user", payload: { id: "u1", text: "重发的消息" } },
    ]);
    assert.equal(log.project("convaaaa0017").messages.length, 1);
  } finally { store.cleanup(); }
});

test("listConversations 按时间倒序且带消息数", () => {
  const store = freshStore();
  try {
    log.replaceFromConversation({
      id: "convaaaa0018", title: "旧的", date: "2026-01-01T00:00:00.000Z",
      messages: [{ id: "u1", role: "user", text: "一", cost: null }],
    });
    log.replaceFromConversation({
      id: "convaaaa0019", title: "新的", date: "2026-07-01T00:00:00.000Z",
      messages: [{ id: "u1", role: "user", text: "一", cost: null }],
    });
    const list = log.listConversations();
    assert.equal(list[0].id, "convaaaa0019");
    assert.equal(list[0].messageCount, 1);
  } finally { store.cleanup(); }
});

test("deleteConversation 删干净且再读为 null", () => {
  const store = freshStore();
  try {
    log.appendEvent("convaaaa0020", "user", { id: "u1", text: "一" });
    assert.equal(log.deleteConversation("convaaaa0020"), true);
    assert.equal(log.getMeta("convaaaa0020"), null);
    assert.equal(log.project("convaaaa0020"), null);
    assert.equal(log.deleteConversation("convaaaa0020"), false);
  } finally { store.cleanup(); }
});

test("非法 conversationId 被拒绝（防目录穿越）", () => {
  const store = freshStore();
  try {
    for (const bad of ["../../etc/passwd", "a/b", "ab", "", null, "x".repeat(129), "有中文"]) {
      assert.throws(() => log.appendEvent(bad, "user", {}), /非法的 conversationId/);
      assert.equal(log.normalizeConvId(bad), null);
    }
    // 只读接口对非法 id 应该安全返回空，而不是抛
    assert.equal(log.getMeta("../../etc/passwd"), null);
    assert.equal(log.project("../../etc/passwd"), null);
    assert.deepEqual(log.readEventsSince("../../etc/passwd", 0), { events: [], lastSeq: 0, truncated: false });
  } finally { store.cleanup(); }
});

test("未知会话的只读接口返回空而不抛", () => {
  const store = freshStore();
  try {
    assert.equal(log.getMeta("convmissing001"), null);
    assert.equal(log.project("convmissing001"), null);
    const result = log.readEventsSince("convmissing001", 0);
    assert.deepEqual(result, { events: [], lastSeq: 0, truncated: false });
  } finally { store.cleanup(); }
});

test("project 结果被缓存，但 append 之后立即失效", () => {
  const store = freshStore();
  try {
    const id = "convaaaa0021";
    log.appendEvent(id, "user", { id: "u1", text: "一" });
    assert.equal(log.project(id).messages.length, 1);
    log.appendEvent(id, "user", { id: "u2", text: "二" });
    assert.equal(log.project(id).messages.length, 2);
  } finally { store.cleanup(); }
});

test("project 返回的是副本，改它不会污染缓存", () => {
  const store = freshStore();
  try {
    const id = "convaaaa0022";
    log.appendEvent(id, "user", { id: "u1", text: "原文" });
    const first = log.project(id);
    first.messages[0].text = "被改过";
    assert.equal(log.project(id).messages[0].text, "原文");
  } finally { store.cleanup(); }
});
