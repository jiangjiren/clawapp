/**
 * 多开的端到端验证：并发上限、以及每条事件能不能被认领到自己的对话。
 *
 * SessionRegistry 的单元测试覆盖了判断逻辑，这里验证接线——真起一个 server，
 * 让几个对话同时挂住不放，看拦截和归属对不对。
 *
 * mock 的 SDK 刻意只发 running、不发 idle：这一轮永远跑不完，正好占住名额。
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { WebSocket } from "ws";

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function reservePort() {
  const server = createServer();
  await new Promise((resolve, reject) => server.listen(0, "127.0.0.1", resolve).once("error", reject));
  const { port } = server.address();
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function waitFor(events, predicate, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const hit = events.find(predicate);
    if (hit) return hit;
    await delay(10);
  }
  throw new Error(`等超时；收到的事件: ${JSON.stringify(events.map(e => e.type))}`);
}

const MOCK_SDK = `
  class EventQueue {
    constructor() { this.items = []; this.waiters = []; this.closed = false; }
    push(value) {
      const waiter = this.waiters.shift();
      if (waiter) waiter({ value, done: false });
      else this.items.push(value);
    }
    next() {
      if (this.items.length > 0) return Promise.resolve({ value: this.items.shift(), done: false });
      if (this.closed) return Promise.resolve({ value: undefined, done: true });
      return new Promise(resolve => this.waiters.push(resolve));
    }
    return() { this.close(); return Promise.resolve({ value: undefined, done: true }); }
    close() {
      if (this.closed) return;
      this.closed = true;
      for (const waiter of this.waiters.splice(0)) waiter({ value: undefined, done: true });
    }
    [Symbol.asyncIterator]() { return this; }
  }

  let seq = 0;
  class FakeQuery {
    constructor(prompt) { this.events = new EventQueue(); this.consume(prompt); }
    [Symbol.asyncIterator]() { return this.events; }
    async setPermissionMode() {}
    async setModel() {}
    async interrupt() { this.events.push({ type: "system", subtype: "session_state_changed", state: "idle" }); }
    close() { this.events.close(); }
    async consume(prompt) {
      for await (const message of prompt) {
        seq += 1;
        this.events.push({ type: "system", subtype: "init", session_id: "0000000-" + seq, skills: [] });
        this.events.push({ type: "system", subtype: "session_state_changed", state: "running" });
        this.events.push({
          type: "assistant",
          message: { role: "assistant", content: [
            { type: "text", text: "working" },
            { type: "tool_use", id: "hold-" + seq, name: "Read", input: { file_path: "probe.txt" } },
          ] },
        });
        // 刻意不发 result / idle：这一轮永远挂着，占住一个并发名额
      }
    }
  }

  export const query = ({ prompt }) => new FakeQuery(prompt);
  export const tool = (name, description, schema, handler) => ({ name, description, schema, handler });
  export const createSdkMcpServer = config => config;
`;

const LOADER = `
  import { pathToFileURL } from "node:url";
  export async function resolve(specifier, context, nextResolve) {
    if (specifier === "@anthropic-ai/claude-agent-sdk") {
      return { url: pathToFileURL(process.env.MOCK_CLAUDE_SDK_FILE).href, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  }
`;

/** 起一个真实的 server 并接上 WebSocket，返回操作句柄。 */
async function startServer({ limit = "2" } = {}) {
  const scratch = await mkdtemp(join(tmpdir(), "inkfellow-concurrency-"));
  const authFile = join(scratch, "auth-profile.json");
  const mockSdkFile = join(scratch, "mock-sdk.mjs");
  const loaderFile = join(scratch, "loader.mjs");
  const port = await reservePort();
  const token = "concurrency-test-token";

  await writeFile(authFile, JSON.stringify({
    activeProfileId: "p_claude",
    profiles: [{
      id: "p_claude", name: "Claude probe", provider: "claude",
      apiKey: "", baseUrl: "",
      opusModel: "claude-opus-5", sonnetModel: "claude-sonnet-5",
      haikuModel: "claude-haiku-4-5-20251001",
    }],
  }), "utf8");
  await writeFile(mockSdkFile, MOCK_SDK, "utf8");
  await writeFile(loaderFile, LOADER, "utf8");

  const child = spawn(process.execPath, ["--experimental-loader", pathToFileURL(loaderFile).href, "server.js"], {
    cwd: new URL(".", import.meta.url),
    env: {
      ...process.env,
      PORT: String(port),
      HOST: "127.0.0.1",
      DESKTOP_AGENT_TOKEN: token,
      CLAUDE_CHAT_DATA_DIR: scratch,
      CLAUDE_CHAT_HISTORY_FILE: join(scratch, "history.json"),
      CLAUDE_CHAT_AUTH_PROFILE_FILE: authFile,
      MOCK_CLAUDE_SDK_FILE: mockSdkFile,
      MAX_CONCURRENT_CONVERSATIONS: limit,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", chunk => { output += chunk; });
  child.stderr.on("data", chunk => { output += chunk; });

  const wsUrl = `ws://127.0.0.1:${port}/?token=${encodeURIComponent(token)}`;
  let ws = null;
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline && !ws) {
    try {
      const candidate = new WebSocket(wsUrl);
      await new Promise((resolve, reject) => {
        candidate.once("open", resolve);
        candidate.once("error", reject);
      });
      ws = candidate;
    } catch {
      await delay(150);
    }
  }
  assert.ok(ws, `server 没起来:\n${output}`);

  const events = [];
  ws.on("message", raw => events.push(JSON.parse(raw.toString())));

  return {
    events,
    askIn: (conversationId, userMessageId) => ws.send(JSON.stringify({
      conversationId,
      userMessageId,
      displayText: "hold this turn",
      prompt: "hold this turn",
      profileId: "p_claude",
      permissionMode: "auto",
      effort: "medium",
    })),
    async close() {
      try { ws.close(); } catch { }
      child.kill();
      await new Promise(resolve => child.once("exit", resolve));
      await rm(scratch, { recursive: true, force: true });
    },
  };
}

test("并发时每条会话事件都带着自己的归属", { timeout: 30_000 }, async () => {
  /* 真实事故：request_ack 不带 conversationId，于是另一个对话的 ack 被前端当成
     当前对话的，界面上凭空多出一个「正在生成」的三个点——而那一轮早就结束了。
     会话相关的事件必须都能被认领，前端才谈得上按对话路由。 */
  const server = await startServer({ limit: "5" });
  try {
    server.askIn("conv_alpha", "user_alpha");
    await waitFor(server.events, e => e.type === "request_started" && e.userMessageId === "user_alpha");
    server.askIn("conv_beta", "user_beta");
    await waitFor(server.events, e => e.type === "request_started" && e.userMessageId === "user_beta");
    await delay(300);

    /* 这几类允许没有归属：连接级的快照、心跳，以及 run_attached——
       连接刚建立、没有任何对话在跑时，它报的就是「没附着任何对话」。
       除此之外一律要带，否则前端没法判断该不该渲染。 */
    const mayLackOwner = new Set([
      "ping", "sessions_snapshot", "steering_snapshot", "reset_complete", "system", "run_attached",
    ]);
    const orphans = server.events.filter(e => !mayLackOwner.has(e.type) && !e.conversationId);
    assert.deepEqual(
      [...new Set(orphans.map(e => e.type))],
      [],
      "这些事件没带 conversationId，前端无从判断它属于哪个对话",
    );

    // 归属还得是对的：alpha 的事件不能标成 beta 的
    const ownerOf = { user_alpha: "conv_alpha", user_beta: "conv_beta" };
    for (const ev of server.events) {
      const expected = ownerOf[ev.userMessageId];
      if (!expected) continue;
      assert.equal(ev.conversationId, expected, `${ev.type} 的归属错了`);
    }

    // request_ack 正是当初漏网的那个
    const acks = server.events.filter(e => e.type === "request_ack");
    assert.ok(acks.length > 0, "应该收到过 request_ack");
    assert.ok(acks.every(e => e.conversationId), "request_ack 必须带归属");
  } finally {
    await server.close();
  }
});

test("并发上限拦住超出的对话，已在跑的不受影响", { timeout: 30_000 }, async () => {
  const server = await startServer({ limit: "2" });
  try {
    // 前两个对话各占一个名额，且都停在「跑着」的状态
    server.askIn("conv_one", "user_one");
    await waitFor(server.events, e => e.type === "request_started" && e.userMessageId === "user_one");
    server.askIn("conv_two", "user_two");
    await waitFor(server.events, e => e.type === "request_started" && e.userMessageId === "user_two");

    const full = await waitFor(server.events, e => e.type === "sessions_snapshot" && e.running.length === 2);
    assert.equal(full.limit, 2);
    assert.deepEqual([...full.running].sort(), ["conv_one", "conv_two"]);

    // 第三个应当被拦下来，并且明确告诉用户为什么
    server.askIn("conv_three", "user_three");
    const rejected = await waitFor(server.events, e => e.type === "error" && /上限/.test(e.text ?? ""));
    assert.match(rejected.text, /2 个/, "错误里要带上具体的上限数字");
    assert.equal(
      server.events.some(e => e.type === "request_started" && e.userMessageId === "user_three"),
      false,
      "被拦下的对话不能真的跑起来",
    );

    // 已经在跑的那个再发一条是它自己的下一轮，不占新名额，不该被拦
    const rejectedAt = server.events.indexOf(rejected);
    server.askIn("conv_one", "user_one_again");
    await waitFor(server.events, e => e.type === "request_ack" && e.userMessageId === "user_one_again");
    assert.equal(
      server.events.slice(rejectedAt + 1).some(e => e.type === "error" && /上限/.test(e.text ?? "")),
      false,
      "同一个对话的下一轮不该被并发上限拦住",
    );
  } finally {
    await server.close();
  }
});
