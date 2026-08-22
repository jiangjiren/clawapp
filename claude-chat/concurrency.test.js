/**
 * 并发上限的端到端验证。
 *
 * SessionRegistry 的单元测试已经覆盖了 canRun 的判断逻辑，这里验证的是接线：
 * 真的起一个 server，让两个对话同时挂住不放，看第三个会不会被拦下来，
 * 以及 sessions_snapshot 报的数字对不对。
 *
 * mock 的 SDK 刻意只发 running、不发 idle——这一轮永远跑不完，正好占住名额。
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

test("并发上限拦住超出的对话，已在跑的不受影响", { timeout: 30_000 }, async () => {
  const scratch = await mkdtemp(join(tmpdir(), "inkfellow-concurrency-"));
  const authFile = join(scratch, "auth-profile.json");
  const mockSdkFile = join(scratch, "mock-sdk.mjs");
  const loaderFile = join(scratch, "loader.mjs");
  const port = await reservePort();
  const token = "concurrency-test-token";

  await writeFile(authFile, JSON.stringify({
    activeProfileId: "p_claude",
    profiles: [{
      id: "p_claude",
      name: "Claude probe",
      provider: "claude",
      apiKey: "",
      baseUrl: "",
      opusModel: "claude-opus-5",
      sonnetModel: "claude-sonnet-5",
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
      MAX_CONCURRENT_CONVERSATIONS: "2",     // 用小值，不然要挂 10 个才测得出
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", chunk => { output += chunk; });
  child.stderr.on("data", chunk => { output += chunk; });

  let ws;
  try {
    const wsUrl = `ws://127.0.0.1:${port}/?token=${encodeURIComponent(token)}`;
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      try {
        const candidate = new WebSocket(wsUrl);
        await new Promise((resolve, reject) => {
          candidate.once("open", resolve);
          candidate.once("error", reject);
        });
        ws = candidate;
        break;
      } catch {
        await delay(150);
      }
    }
    assert.ok(ws, `server 没起来:\n${output}`);

    const events = [];
    ws.on("message", raw => events.push(JSON.parse(raw.toString())));

    const askIn = (conversationId, userMessageId) => ws.send(JSON.stringify({
      conversationId,
      userMessageId,
      displayText: "hold this turn",
      prompt: "hold this turn",
      profileId: "p_claude",
      permissionMode: "auto",
      effort: "medium",
    }));

    // 前两个对话各占一个名额，且都停在「跑着」的状态
    askIn("conv_one", "user_one");
    await waitFor(events, e => e.type === "request_started" && e.userMessageId === "user_one");
    askIn("conv_two", "user_two");
    await waitFor(events, e => e.type === "request_started" && e.userMessageId === "user_two");

    const full = await waitFor(events, e => e.type === "sessions_snapshot" && e.running.length === 2);
    assert.equal(full.limit, 2);
    assert.deepEqual([...full.running].sort(), ["conv_one", "conv_two"]);

    // 第三个应当被拦下来，并且明确告诉用户为什么
    askIn("conv_three", "user_three");
    const rejected = await waitFor(events, e => e.type === "error" && /上限/.test(e.text ?? ""));
    assert.match(rejected.text, /2 个/, "错误里要带上具体的上限数字");
    assert.equal(
      events.some(e => e.type === "request_started" && e.userMessageId === "user_three"),
      false,
      "被拦下的对话不能真的跑起来",
    );

    // 已经在跑的那个再发一条是它自己的下一轮，不占新名额，不该被拦
    askIn("conv_one", "user_one_again");
    await waitFor(events, e => e.type === "request_ack" && e.userMessageId === "user_one_again");
    assert.equal(
      events.some(e => e.type === "error" && /上限/.test(e.text ?? "") && events.indexOf(e) > events.indexOf(rejected)),
      false,
      "同一个对话的下一轮不该被并发上限拦住",
    );
  } finally {
    try { ws?.close(); } catch { }
    child.kill();
    await new Promise(resolve => child.once("exit", resolve));
    await rm(scratch, { recursive: true, force: true });
  }
});
