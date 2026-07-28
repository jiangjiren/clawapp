// P1 游标同步协议的集成测试（契约见 _design/p1-event-log.md 第 3 节）。
// 和 server-request.test.js 一样把 server.js 拉到子进程里跑：import 即 listen。
//
// 这些用例定义的是"客户端断线/刷新之后能不能不丢内容"这条不变量，
// 不依赖真实 Agent SDK——用 REST 写入会话，再用 WS 的 hello/sync 读回来。
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";

const HERE = new URL(".", import.meta.url);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function reservePort() {
  const server = createServer();
  await new Promise((resolve, reject) => server.listen(0, "127.0.0.1", resolve).once("error", reject));
  const { port } = server.address();
  await new Promise(resolve => server.close(resolve));
  return port;
}

const PROBE_PROFILES = {
  activeProfileId: "p_claude",
  profiles: [{ id: "p_claude", name: "Claude 会员", provider: "claude", apiKey: "", baseUrl: "" }],
};

async function startServer() {
  const scratch = await mkdtemp(join(tmpdir(), "inkfellow-sync-test-"));
  const authFile = join(scratch, "auth-profile.json");
  await writeFile(authFile, JSON.stringify(PROBE_PROFILES), "utf8");
  const port = await reservePort();

  const child = spawn(process.execPath, ["server.js"], {
    cwd: HERE,
    env: {
      ...process.env,
      PORT: String(port),
      HOST: "127.0.0.1",
      VAULT_PATH: scratch,
      CLAUDE_CHAT_DATA_DIR: scratch,
      CLAUDE_CHAT_AUTH_PROFILE_FILE: authFile,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let output = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", chunk => { output += chunk; });
  child.stderr.on("data", chunk => { output += chunk; });

  const deadline = Date.now() + 15_000;
  while (!output.includes("claude-chat listening")) {
    if (child.exitCode != null) throw new Error(`server.js 提前退出 (${child.exitCode}): ${output}`);
    if (Date.now() >= deadline) throw new Error(`server.js 未能启动: ${output}`);
    await delay(20);
  }

  return {
    port,
    scratch,
    log: () => output,
    async stop() {
      child.kill("SIGKILL");
      await new Promise(resolve => child.once("exit", resolve));
      await rm(scratch, { recursive: true, force: true });
    },
  };
}

async function connect(port) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/`);
  const events = [];
  ws.on("message", raw => {
    try { events.push(JSON.parse(raw.toString())); } catch { /* 非 JSON 帧忽略 */ }
  });
  await new Promise((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
  });
  return { ws, events };
}

async function waitForMessage(events, predicate, startIndex = 0, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (let i = startIndex; i < events.length; i += 1) {
      if (predicate(events[i])) return events[i];
    }
    await delay(10);
  }
  throw new Error(`等待 WS 事件超时；已收到: ${JSON.stringify(events.slice(startIndex))}`);
}

// 用 REST 造一个有内容的会话，避免依赖真实模型调用
async function seedConversation(port, id, messages) {
  const res = await fetch(`http://127.0.0.1:${port}/api/history/${id}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id, title: "同步测试", date: new Date().toISOString(), messages }),
  });
  assert.equal(res.status, 200);
}

const SEED_MESSAGES = [
  { id: "u_0001", role: "user", text: "第一个问题", cost: null },
  {
    id: "a_0001",
    role: "assistant",
    text: "第一个回答",
    blocks: [{ type: "text", text: "第一个回答", raw: { type: "text", text: "第一个回答" } }],
    events: [],
    cost: 0.01,
    status: "complete",
  },
];

test("hello 带 lastSeq=0 时回放整段会话", { timeout: 30_000 }, async () => {
  const server = await startServer();
  try {
    await seedConversation(server.port, "convsync0001", SEED_MESSAGES);
    const { ws, events } = await connect(server.port);
    ws.send(JSON.stringify({ type: "hello", conversationId: "convsync0001", lastSeq: 0 }));

    const sync = await waitForMessage(events, e => e.type === "sync");
    assert.equal(sync.conversationId, "convsync0001");
    assert.ok(sync.lastSeq > 0, "lastSeq 应该大于 0");
    // 要么给增量事件，要么给快照，两者必居其一
    assert.ok(Array.isArray(sync.events) || sync.reset === true);
    ws.close();
  } finally {
    await server.stop();
  }
});

test("hello 带上已同步的 lastSeq 时不再重复回放", { timeout: 30_000 }, async () => {
  const server = await startServer();
  try {
    await seedConversation(server.port, "convsync0002", SEED_MESSAGES);
    const first = await connect(server.port);
    first.ws.send(JSON.stringify({ type: "hello", conversationId: "convsync0002", lastSeq: 0 }));
    const sync1 = await waitForMessage(first.events, e => e.type === "sync");
    first.ws.close();

    const second = await connect(server.port);
    second.ws.send(JSON.stringify({ type: "hello", conversationId: "convsync0002", lastSeq: sync1.lastSeq }));
    const sync2 = await waitForMessage(second.events, e => e.type === "sync");
    assert.equal(sync2.lastSeq, sync1.lastSeq);
    assert.equal(sync2.reset, undefined, "游标已是最新，不该触发快照重置");
    assert.deepEqual(sync2.events, [], "游标已是最新，不该有增量事件");
    second.ws.close();
  } finally {
    await server.stop();
  }
});

test("未知会话的 hello 不报错，回一个空 sync", { timeout: 30_000 }, async () => {
  const server = await startServer();
  try {
    const { ws, events } = await connect(server.port);
    ws.send(JSON.stringify({ type: "hello", conversationId: "convsyncmissing", lastSeq: 0 }));
    const sync = await waitForMessage(events, e => e.type === "sync");
    assert.equal(sync.conversationId, "convsyncmissing");
    assert.equal(sync.lastSeq, 0);
    assert.equal(sync.turn, null);
    ws.close();
  } finally {
    await server.stop();
  }
});

test("conversationId 为 null 的 hello 被安全忽略", { timeout: 30_000 }, async () => {
  const server = await startServer();
  try {
    const { ws, events } = await connect(server.port);
    ws.send(JSON.stringify({ type: "hello", conversationId: null, lastSeq: 0 }));
    const sync = await waitForMessage(events, e => e.type === "sync");
    assert.equal(sync.conversationId, null);
    assert.equal(sync.lastSeq, 0);
    assert.equal(sync.turn, null);
    ws.close();
  } finally {
    await server.stop();
  }
});

test("客户端 lastSeq 超前于服务端时走快照重置", { timeout: 30_000 }, async () => {
  const server = await startServer();
  try {
    await seedConversation(server.port, "convsync0003", SEED_MESSAGES);
    const { ws, events } = await connect(server.port);
    // 服务端数据被重置过、客户端游标还停在旧的高位——不能静默什么都不发
    ws.send(JSON.stringify({ type: "hello", conversationId: "convsync0003", lastSeq: 999_999 }));
    const sync = await waitForMessage(events, e => e.type === "sync");
    assert.equal(sync.reset, true);
    assert.ok(sync.snapshot && Array.isArray(sync.snapshot.messages));
    ws.close();
  } finally {
    await server.stop();
  }
});

test("目录穿越的 conversationId 被拒绝且不写盘", { timeout: 30_000 }, async () => {
  const server = await startServer();
  try {
    const { ws, events } = await connect(server.port);
    ws.send(JSON.stringify({ type: "hello", conversationId: "../../etc/passwd", lastSeq: 0 }));
    const sync = await waitForMessage(events, e => e.type === "sync");
    assert.equal(sync.lastSeq, 0);
    assert.equal(sync.turn, null);
    ws.close();
    // 进程还活着说明没被非法路径搞崩
    const probe = await fetch(`http://127.0.0.1:${server.port}/api/history`);
    assert.equal(probe.status, 200);
  } finally {
    await server.stop();
  }
});

test("REST 历史接口在事件日志之上保持原有形状", { timeout: 30_000 }, async () => {
  const server = await startServer();
  try {
    await seedConversation(server.port, "convsync0004", SEED_MESSAGES);

    const listRes = await fetch(`http://127.0.0.1:${server.port}/api/history`);
    const list = await listRes.json();
    const summary = list.find(item => item.id === "convsync0004");
    assert.ok(summary, "列表里应该有这个会话");
    assert.equal(summary.messageCount, 2);
    assert.equal(typeof summary.title, "string");
    assert.equal(typeof summary.date, "string");

    const detailRes = await fetch(`http://127.0.0.1:${server.port}/api/history/convsync0004`);
    const conv = await detailRes.json();
    assert.equal(conv.id, "convsync0004");
    assert.equal(conv.messages.length, 2);
    assert.equal(conv.messages[0].role, "user");
    assert.equal(conv.messages[0].text, "第一个问题");
    assert.equal(conv.messages[1].role, "assistant");
    assert.equal(conv.messages[1].text, "第一个回答");
    assert.equal(conv.messages[1].cost, 0.01);
    assert.equal(conv.messages[1].blocks.length, 1);

    const delRes = await fetch(`http://127.0.0.1:${server.port}/api/history/convsync0004`, { method: "DELETE" });
    assert.equal(delRes.status, 200);
    const goneRes = await fetch(`http://127.0.0.1:${server.port}/api/history/convsync0004`);
    assert.equal(goneRes.status, 404);
  } finally {
    await server.stop();
  }
});

test("客户端把未改动的完整会话 PUT 回来时不重写事件日志或重置 seq", { timeout: 30_000 }, async () => {
  const server = await startServer();
  try {
    const id = "convsync0005";
    await seedConversation(server.port, id, SEED_MESSAGES);
    const detail = await fetch(`http://127.0.0.1:${server.port}/api/history/${id}`).then(res => res.json());
    const logFile = join(server.scratch, "conversations", id, "events.ndjson");
    const before = await readFile(logFile, "utf8");

    const put = await fetch(`http://127.0.0.1:${server.port}/api/history/${id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(detail),
    });
    assert.equal(put.status, 200);
    assert.equal(await readFile(logFile, "utf8"), before);

    const { ws, events } = await connect(server.port);
    ws.send(JSON.stringify({ type: "hello", conversationId: id, lastSeq: before.trim().split("\n").length }));
    const sync = await waitForMessage(events, event => event.type === "sync");
    assert.equal(sync.reset, undefined);
    assert.deepEqual(sync.events, []);
    ws.close();
  } finally {
    await server.stop();
  }
});
