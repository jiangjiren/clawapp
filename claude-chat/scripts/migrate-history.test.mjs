import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  conversationToEvents,
  diffConversation,
  isValidConversationId,
  iterateConversationChunks,
  main,
  parseArgs,
  selfCheckEntries,
} from "./migrate-history.mjs";

const userMessage = (over = {}) => ({
  id: "user_1",
  role: "user",
  text: "你好",
  cost: null,
  createdAt: "2026-07-28T07:46:10.462Z",
  ...over,
});

const assistantMessage = (over = {}) => ({
  id: "assistant_1",
  role: "assistant",
  text: "",
  blocks: [],
  raw: [],
  events: [],
  cost: null,
  status: "complete",
  createdAt: "2026-07-28T07:46:11.000Z",
  ...over,
});

const conv = (messages, over = {}) => ({
  id: "ms4cqgp5a9ocn",
  title: "标题",
  date: "2026-07-28T10:28:37.116Z",
  sessionId: "sess-1",
  sessionProvider: "claude",
  profileId: "prof-1",
  messages,
  ...over,
});

// ── user 消息 ────────────────────────────────────────────────

test("纯 user 消息 → 1 条 user 事件", () => {
  const { entries } = conversationToEvents(conv([userMessage()]));
  assert.equal(entries.length, 1);
  assert.deepEqual(entries[0], {
    kind: "user",
    payload: { id: "user_1", text: "你好", createdAt: "2026-07-28T07:46:10.462Z" },
  });
});

test("user 消息缺 id 时补一个稳定的 migrated id", () => {
  const { entries } = conversationToEvents(conv([userMessage({ id: undefined })]));
  assert.equal(entries[0].payload.id, "user_migrated_0");
  // 确定性：同样输入两次结果一致
  const again = conversationToEvents(conv([userMessage({ id: undefined })]));
  assert.deepEqual(entries, again.entries);
});

test("user 消息带 images 时透传", () => {
  const { entries } = conversationToEvents(conv([userMessage({ images: ["data:image/png;base64,AAA"] })]));
  assert.deepEqual(entries[0].payload.images, ["data:image/png;base64,AAA"]);
});

// ── assistant：原始 events[] ─────────────────────────────────

test("assistant 带 events[] → 逐条 sdk + 1 条 turn", () => {
  const events = [
    { type: "assistant", message: { content: [{ type: "text", text: "第一段" }] } },
    { type: "assistant", message: { content: [{ type: "text", text: "第二段" }] } },
    { type: "result", subtype: "success", total_cost_usd: 0.12 },
  ];
  const { entries } = conversationToEvents(conv([assistantMessage({ events, cost: 0.12 })]));
  assert.equal(entries.length, 4);
  assert.deepEqual(entries.map(e => e.kind), ["sdk", "sdk", "sdk", "turn"]);
  // 原始事件原样透传，不做任何加工
  assert.deepEqual(entries.slice(0, 3).map(e => e.payload), events);
  assert.deepEqual(entries[3].payload, {
    turnId: "assistant_1",
    status: "complete",
    requestId: null,
    cost: 0.12,
  });
});

test("events[] 优先于 blocks[]", () => {
  const events = [{ type: "assistant", message: { content: [{ type: "text", text: "来自 events" }] } }];
  const blocks = [{ type: "text", text: "来自 blocks", raw: { type: "text", text: "来自 blocks" } }];
  const { entries } = conversationToEvents(conv([assistantMessage({ events, blocks })]));
  assert.equal(entries.filter(e => e.kind === "sdk").length, 1);
  assert.deepEqual(entries[0].payload, events[0]);
});

// ── assistant：blocks 兜底 ───────────────────────────────────

test("assistant 无 events 有 blocks → 1 条兜底 sdk（content 由 blocks 还原）+ 1 条 turn", () => {
  const blocks = [
    { type: "thinking", thinking: "想一下", signature: "sig", raw: { type: "thinking", thinking: "想一下", signature: "sig" } },
    {
      type: "tool_use", id: "toolu_1", name: "Bash", serverName: null, input: { command: "ls" },
      raw: { type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "ls" }, caller: { type: "direct" } },
    },
    { type: "text", text: "结果如下", citations: null, raw: { type: "text", text: "结果如下" } },
  ];
  const { entries } = conversationToEvents(conv([assistantMessage({ blocks, events: [], text: "结果如下" })]));

  assert.equal(entries.length, 2);
  assert.equal(entries[0].kind, "sdk");
  assert.equal(entries[0].payload.type, "assistant");
  // 还原走 event-log 的 blockToSdkContent：用归一化后的 block 字段重建 SDK content item
  assert.deepEqual(entries[0].payload.message.content, [
    { type: "thinking", thinking: "想一下", signature: "sig" },
    { type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "ls" } },
    { type: "text", text: "结果如下" },
  ]);
  assert.equal(entries[1].kind, "turn");
});

test("block.text 与 block.raw.text 打架时以干净的 block.text 为准", () => {
  // 老数据里出现过 raw.text 带 U+FFFD 替换字符、block.text 干净的情况（实测 7/1586 处）
  const blocks = [{ type: "text", text: "直接生成", raw: { type: "text", text: "���接生成" } }];
  const { entries } = conversationToEvents(conv([assistantMessage({ blocks })]));
  assert.deepEqual(entries[0].payload.message.content, [{ type: "text", text: "直接生成" }]);
});

test("sdk_event 这类没有归一形式的 block 回退到 raw", () => {
  const raw = { type: "user", subtype: "tool_result", tool_use_id: "toolu_1", content: "ok" };
  const blocks = [{ type: "sdk_event", eventType: "tool_result", raw }];
  const { entries } = conversationToEvents(conv([assistantMessage({ blocks })]));
  assert.deepEqual(entries[0].payload.message.content, [raw]);
});

test("blocks 没有 raw 时退回 block 本身", () => {
  const blocks = [{ type: "text", text: "裸 block" }];
  const { entries } = conversationToEvents(conv([assistantMessage({ blocks })]));
  assert.deepEqual(entries[0].payload.message.content, [{ type: "text", text: "裸 block" }]);
});

test("events 字段缺失（老格式）也走 blocks 兜底", () => {
  const message = { role: "assistant", text: "老数据", blocks: [{ type: "text", text: "老数据" }] };
  const { entries } = conversationToEvents(conv([message]));
  assert.deepEqual(entries.map(e => e.kind), ["sdk", "turn"]);
  assert.deepEqual(entries[0].payload.message.content, [{ type: "text", text: "老数据" }]);
});

// ── assistant：text 兜底 ────────────────────────────────────

test("assistant 只有 text → 合成 text content", () => {
  const { entries } = conversationToEvents(conv([assistantMessage({ blocks: [], events: [], text: "只有正文" })]));
  assert.deepEqual(entries.map(e => e.kind), ["sdk", "turn"]);
  assert.deepEqual(entries[0].payload, {
    type: "assistant",
    message: { content: [{ type: "text", text: "只有正文" }] },
  });
});

test("assistant 三者皆空 → 只有 turn 事件", () => {
  const { entries } = conversationToEvents(conv([assistantMessage({ blocks: [], events: [], text: "" })]));
  assert.deepEqual(entries.map(e => e.kind), ["turn"]);
});

// ── turn 事件 status ────────────────────────────────────────

for (const status of ["error", "stopped", "running", "continued", "complete"]) {
  test(`status "${status}" 原样透传到 turn 事件`, () => {
    const { entries } = conversationToEvents(conv([assistantMessage({ status, text: "x" })]));
    const turn = entries.at(-1);
    assert.equal(turn.kind, "turn");
    assert.equal(turn.payload.status, status);
  });
}

test("status 缺失 / 非法值按 complete", () => {
  for (const status of [undefined, null, "", "  ", "weird-status", 42]) {
    const { entries } = conversationToEvents(conv([assistantMessage({ status, text: "x" })]));
    assert.equal(entries.at(-1).payload.status, "complete", `status=${JSON.stringify(status)}`);
  }
});

test("turnId 缺 message.id 时按下标生成，cost 透传", () => {
  const { entries } = conversationToEvents(conv([
    userMessage(),
    assistantMessage({ id: undefined, text: "x", cost: 0.5 }),
  ]));
  assert.deepEqual(entries.at(-1).payload, {
    turnId: "turn_migrated_1",
    status: "complete",
    requestId: null,
    cost: 0.5,
  });
});

test("cost 为 undefined 时归一成 null", () => {
  const { entries } = conversationToEvents(conv([assistantMessage({ cost: undefined, text: "x" })]));
  assert.equal(entries.at(-1).payload.cost, null);
});

// ── 顺序 ────────────────────────────────────────────────────

test("严格保持原 messages[] 顺序", () => {
  const messages = [
    userMessage({ id: "u1", text: "一" }),
    assistantMessage({ id: "a1", text: "答一" }),
    userMessage({ id: "u2", text: "二" }),
    assistantMessage({
      id: "a2",
      events: [
        { type: "assistant", message: { content: [{ type: "text", text: "答二上" }] } },
        { type: "result", subtype: "success" },
      ],
    }),
    userMessage({ id: "u3", text: "三" }),
  ];
  const { entries } = conversationToEvents(conv(messages));
  assert.deepEqual(entries.map(e => e.kind), [
    "user", "sdk", "turn", "user", "sdk", "sdk", "turn", "user",
  ]);
  assert.deepEqual(
    entries.filter(e => e.kind === "user").map(e => e.payload.id),
    ["u1", "u2", "u3"],
  );
  assert.deepEqual(
    entries.filter(e => e.kind === "turn").map(e => e.payload.turnId),
    ["a1", "a2"],
  );
});

test("未知 role 被跳过，不打乱其余顺序", () => {
  const { entries } = conversationToEvents(conv([
    userMessage({ id: "u1" }),
    { role: "system", text: "忽略我" },
    assistantMessage({ id: "a1", text: "答" }),
  ]));
  assert.deepEqual(entries.map(e => e.kind), ["user", "sdk", "turn"]);
});

// ── meta ────────────────────────────────────────────────────

test("meta 抽取全部字段", () => {
  const { meta } = conversationToEvents(conv([userMessage()]));
  assert.deepEqual(meta, {
    id: "ms4cqgp5a9ocn",
    title: "标题",
    date: "2026-07-28T10:28:37.116Z",
    sessionId: "sess-1",
    sessionProvider: "claude",
    profileId: "prof-1",
  });
});

test("meta 缺失字段归一成 null，title 回退到首条 user 文本", () => {
  const { meta } = conversationToEvents({
    id: "abcd1234",
    messages: [userMessage({ text: "帮我写\n一个脚本", createdAt: "2026-01-01T00:00:00.000Z" })],
  });
  assert.equal(meta.title, "帮我写 一个脚本");
  assert.equal(meta.sessionId, null);
  assert.equal(meta.sessionProvider, null);
  assert.equal(meta.profileId, null);
  // date 缺失时回退到消息里最新的时间戳
  assert.equal(meta.date, "2026-01-01T00:00:00.000Z");
});

test("title 全空时回退到 新对话", () => {
  const { meta } = conversationToEvents({ id: "abcd1234", messages: [] });
  assert.equal(meta.title, "新对话");
  assert.equal(meta.date, null);
});

// ── 容错 ────────────────────────────────────────────────────

test("空 conversation / messages 为 null / 非对象输入都不抛", () => {
  for (const input of [undefined, null, {}, 0, "x", [], { messages: null }, { messages: "nope" }]) {
    const result = conversationToEvents(input);
    assert.deepEqual(result.entries, [], `input=${JSON.stringify(input)}`);
    assert.equal(typeof result.meta, "object");
    assert.equal(result.meta.id, "");
  }
});

test("messages 里混入 null / 非对象元素时被过滤", () => {
  const { entries } = conversationToEvents(conv([null, userMessage({ id: "u1" }), undefined, "junk", 7]));
  assert.deepEqual(entries.map(e => e.kind), ["user"]);
  assert.equal(entries[0].payload.id, "u1");
});

test("events / blocks 里混入 null 时被过滤", () => {
  const { entries } = conversationToEvents(conv([
    assistantMessage({ events: [null, { type: "assistant" }, 0] }),
  ]));
  assert.deepEqual(entries.map(e => e.kind), ["sdk", "turn"]);
  assert.deepEqual(entries[0].payload, { type: "assistant" });
});

test("text 非字符串时归一成空串", () => {
  const { entries } = conversationToEvents(conv([userMessage({ text: 123 })]));
  assert.equal(entries[0].payload.text, "");
});

// ── id 校验 ─────────────────────────────────────────────────

test("isValidConversationId 拒绝目录穿越 / 过短 / 非字符串", () => {
  assert.ok(isValidConversationId("ms4cqgp5a9ocn"));
  assert.ok(isValidConversationId("srv_abc-123"));
  assert.ok(!isValidConversationId("../etc"));
  assert.ok(!isValidConversationId("a/b"));
  assert.ok(!isValidConversationId("abc")); // 少于 4 位
  assert.ok(!isValidConversationId(""));
  assert.ok(!isValidConversationId(null));
  assert.ok(!isValidConversationId("x".repeat(129)));
});

// ── 顶层数组流式切分 ─────────────────────────────────────────

test("iterateConversationChunks 切出顶层元素，嵌套括号和字符串不误伤", () => {
  const source = JSON.stringify([
    { id: "aaaa", messages: [{ role: "user", text: "含 } 和 ] 的字符串" }] },
    { id: "bbbb", messages: [{ role: "user", text: "转义 \" 引号" }] },
  ]);
  const chunks = [...iterateConversationChunks(source)];
  assert.equal(chunks.length, 2);
  assert.equal(JSON.parse(chunks[0]).id, "aaaa");
  assert.equal(JSON.parse(chunks[1]).messages[0].text, "转义 \" 引号");
});

test("iterateConversationChunks 对空数组 / 非数组 / 非字符串安全", () => {
  assert.deepEqual([...iterateConversationChunks("[]")], []);
  assert.deepEqual([...iterateConversationChunks("{}")], []);
  assert.deepEqual([...iterateConversationChunks("")], []);
  assert.deepEqual([...iterateConversationChunks(null)], []);
});

// ── 比对口径 ────────────────────────────────────────────────

test("diffConversation 对完全一致的投影返回空数组", () => {
  const original = conv([
    userMessage({ id: "u1", text: "问" }),
    assistantMessage({ id: "a1", text: "答", blocks: [{ type: "text", text: "答" }], cost: 0.1 }),
  ]);
  const projected = JSON.parse(JSON.stringify(original));
  assert.deepEqual(diffConversation(original, projected), { diffs: [], notes: [] });
});

test("diffConversation 报出 role / text / blocks.length / cost / status 差异", () => {
  const original = conv([assistantMessage({ id: "a1", text: "答", blocks: [{ type: "text" }], cost: 0.1 })]);
  const projected = conv([assistantMessage({ id: "a1", text: "错", blocks: [], cost: 0.2, status: "error" })]);
  const diffs = diffConversation(original, projected).diffs.join("\n");
  assert.match(diffs, /text len/);
  assert.match(diffs, /blocks\.length 1 → 0/);
  assert.match(diffs, /cost/);
  assert.match(diffs, /status/);
});

test("diffConversation 把缺失 status 视作 complete，不算差异", () => {
  const original = conv([assistantMessage({ status: undefined, text: "答" })]);
  const projected = conv([assistantMessage({ status: "complete", text: "答" })]);
  assert.deepEqual(diffConversation(original, projected).diffs, []);
});

test("diffConversation 报出消息条数差异", () => {
  const { diffs } = diffConversation(conv([userMessage()]), conv([]));
  assert.match(diffs.join("\n"), /messages\.length 1 → 0/);
});

test("diffConversation 把 text 兜底合成算 note 不算 diff（老客户端 blocks:null）", () => {
  const original = conv([assistantMessage({ text: "正文", blocks: null, events: null })]);
  const projected = conv([assistantMessage({ text: "正文", blocks: [{ type: "text", text: "正文" }] })]);
  const { diffs, notes } = diffConversation(original, projected);
  assert.deepEqual(diffs, []);
  assert.equal(notes.length, 1);
  assert.match(notes[0], /text 兜底合成/);
});

test("blocks 0 → 1 但正文不一致时仍算真差异", () => {
  const original = conv([assistantMessage({ text: "正文", blocks: null })]);
  const projected = conv([assistantMessage({ text: "别的正文", blocks: [{ type: "text", text: "别的正文" }] })]);
  const { diffs, notes } = diffConversation(original, projected);
  assert.deepEqual(notes, []);
  assert.match(diffs.join("\n"), /blocks\.length 0 → 1/);
});

test("源 text 与自身 blocks 本就对不上时，按 blocks 重算记为 note", () => {
  // 老数据里网页端整段 PUT 存下的消息，message.text 会跟自己的 blocks 轻微漂移；
  // UI 渲染的是 blocks，所以投影按 blocks 重算才是忠实还原
  const stale = assistantMessage({
    text: "陈旧的正文",
    blocks: [{ type: "text", text: "干净的正文" }],
  });
  const projected = conv([assistantMessage({
    text: "干净的正文",
    blocks: [{ type: "text", text: "干净的正文" }],
  })]);
  const { diffs, notes } = diffConversation(conv([stale]), projected);
  assert.deepEqual(diffs, []);
  assert.equal(notes.length, 1);
  assert.match(notes[0], /按 blocks 重算/);
});

test("投影正文既不等于源 text 也不等于 blocks 拼接时是真差异", () => {
  const original = conv([assistantMessage({ text: "陈旧的正文", blocks: [{ type: "text", text: "干净的正文" }] })]);
  const projected = conv([assistantMessage({ text: "第三种正文", blocks: [{ type: "text", text: "干净的正文" }] })]);
  const { diffs, notes } = diffConversation(original, projected);
  assert.deepEqual(notes, []);
  assert.match(diffs.join("\n"), /text len/);
});

test("blocks 为空的消息不吃 blocks 重算豁免", () => {
  const original = conv([assistantMessage({ text: "正文", blocks: [] })]);
  const projected = conv([assistantMessage({ text: "", blocks: [] })]);
  const { diffs, notes } = diffConversation(original, projected);
  assert.deepEqual(notes, []);
  assert.match(diffs.join("\n"), /text len/);
});

test("源数据自洽时的 text 差异仍是真差异", () => {
  const clean = assistantMessage({
    text: "正文",
    blocks: [{ type: "text", text: "正文", raw: { type: "text", text: "正文" } }],
  });
  const projected = conv([assistantMessage({
    text: "别的正文",
    blocks: [{ type: "text", text: "别的正文" }],
  })]);
  const { diffs } = diffConversation(conv([clean]), projected);
  assert.match(diffs.join("\n"), /text len/);
});

test("user 消息的 blocks 数量变化不被当成 text 兜底", () => {
  const original = conv([userMessage({ text: "问", blocks: null })]);
  const projected = conv([userMessage({ text: "问", blocks: [{ type: "text", text: "问" }] })]);
  const { diffs, notes } = diffConversation(original, projected);
  assert.deepEqual(notes, []);
  assert.equal(diffs.length, 1);
});

// ── dry-run 结构自检 ────────────────────────────────────────

test("selfCheckEntries 对正常会话无告警", () => {
  const c = conv([userMessage(), assistantMessage({ text: "答" })]);
  const { entries } = conversationToEvents(c);
  assert.deepEqual(selfCheckEntries(c, entries), []);
});

test("selfCheckEntries 报出 assistant 无 sdk 事件 / 未知 role", () => {
  const c = conv([assistantMessage({ text: "", blocks: [], events: [] }), { role: "system" }]);
  const { entries } = conversationToEvents(c);
  const problems = selfCheckEntries(c, entries).join("\n");
  assert.match(problems, /未产生任何 sdk 事件/);
  assert.match(problems, /role 非 user\/assistant/);
});

// ── CLI 参数解析 ────────────────────────────────────────────

test("parseArgs 支持空格与等号两种写法及各开关", () => {
  assert.deepEqual(parseArgs(["--port", "8082", "--dry-run", "--verify", "--force"]), {
    port: "8082", file: null, dryRun: true, verify: true, force: true, help: false,
  });
  assert.deepEqual(parseArgs(["--port=8083", "--file=/tmp/h.json"]), {
    port: "8083", file: "/tmp/h.json", dryRun: false, verify: false, force: false, help: false,
  });
  assert.deepEqual(parseArgs([]).port, null);
});

test("parseArgs 对未知参数报错", () => {
  assert.throws(() => parseArgs(["--nope"]), /未知参数/);
});

test("--dry-run --verify 在临时事件库做真实 project 比对且不写源目录", async () => {
  const dir = mkdtempSync(join(tmpdir(), "migrate-history-cli-test-"));
  try {
    const source = join(dir, "history.json");
    writeFileSync(source, JSON.stringify([
      conv([
        userMessage({ id: "user_cli_1", text: "问题" }),
        assistantMessage({
          id: "assistant_cli_1",
          text: "回答",
          blocks: [{ type: "text", text: "回答" }],
        }),
      ], { id: "convcliverify01" }),
    ]), "utf8");

    assert.equal(await main(["--file", source, "--dry-run", "--verify"]), 0);
    assert.equal(existsSync(join(dir, "conversations")), false);
    assert.equal(existsSync(`${source}.pre-p1.bak`), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("真实迁移重复执行会跳过已有日志，并保留可回滚的源文件与备份", async () => {
  const dir = mkdtempSync(join(tmpdir(), "migrate-history-idempotency-test-"));
  try {
    const source = join(dir, "history.json");
    const original = JSON.stringify([
      conv([
        userMessage({ id: "user_cli_2", text: "问题" }),
        assistantMessage({
          id: "assistant_cli_2",
          text: "回答",
          blocks: [{ type: "text", text: "回答" }],
        }),
      ], { id: "convcliidempotent01" }),
    ]);
    writeFileSync(source, original, "utf8");

    assert.equal(await main(["--file", source, "--verify"]), 0);
    // --file 没有实例端口，保留通用 conversations/<id> 布局；
    // 正式多实例迁移使用 --port，才进入 conversations/<PORT>/。
    const logFile = join(dir, "conversations", "convcliidempotent01", "events.ndjson");
    const firstLog = readFileSync(logFile, "utf8");
    assert.equal(readFileSync(source, "utf8"), original);
    assert.equal(readFileSync(`${source}.pre-p1.bak`, "utf8"), original);

    assert.equal(await main(["--file", source, "--verify"]), 0);
    assert.equal(readFileSync(logFile, "utf8"), firstLog);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
