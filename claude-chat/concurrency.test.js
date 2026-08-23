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
    constructor(prompt, options) { this.events = new EventQueue(); this.options = options; this.consume(prompt); }

    /* 模拟 AskUserQuestion：服务端把它接在 PreToolUse hook 上（见 server.js 的
       options.hooks），这里直接把那个 hook 调起来。它会一直挂着，直到前端把
       ask_user_question_response 发回来——正是要验证的那条路。 */
    async askTheUser() {
      const entry = (this.options?.hooks?.PreToolUse ?? []).find(h => h.matcher === "AskUserQuestion");
      const hook = entry?.hooks?.[0];
      if (!hook) return;
      let answered = null;
      try {
        const result = await this.runAskHook(hook);
        answered = result?.hookSpecificOutput?.updatedInput?.answers ?? null;
      } catch { /* 用户取消或答案无效：真实 SDK 会接住，这里同样不该崩 */ }
      // 把答案回显出来——测试据此判断「回答真的送到模型手上了」，
      // 而不只是「服务端没报错」
      if (answered) {
        this.events.push({
          type: "assistant",
          message: { role: "assistant", content: [{ type: "text", text: "ANSWERED:" + JSON.stringify(answered) }] },
        });
      }
    }

    async runAskHook(hook) {
      return hook({
        tool_name: "AskUserQuestion",
        tool_use_id: "ask-1",
        tool_input: {
          questions: [{
            question: "走哪条路", header: "选路",
            options: [{ label: "左", description: "往左" }, { label: "右", description: "往右" }],
          }],
        },
      }, "ask-1", {});
    }
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
        if (process.env.MOCK_ASK_QUESTION === "1") await this.askTheUser();
        // 默认刻意不发 result / idle：这一轮永远挂着，占住一个并发名额。
        // MOCK_AUTO_FINISH 打开时才正常收尾——验证「跑完之后」的那些事得靠它。
        if (process.env.MOCK_AUTO_FINISH === "1") {
          this.events.push({ type: "result", subtype: "success", is_error: false });
          this.events.push({ type: "system", subtype: "session_state_changed", state: "idle" });
        }
      }
    }
  }

  export const query = ({ prompt, options }) => new FakeQuery(prompt, options);
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
async function startServer({ limit = "2", autoFinish = false, askQuestion = false } = {}) {
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
      MOCK_AUTO_FINISH: autoFinish ? "1" : "0",
      MOCK_ASK_QUESTION: askQuestion ? "1" : "0",
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
    send: payload => ws.send(JSON.stringify(payload)),
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

test("一轮跑完之后，最后一条快照不能还说它在跑", { timeout: 30_000 }, async () => {
  /* 真实事故：跑完的对话切回去永远转着三个点，发送键卡在「停止」，而那一轮
     早结束了——只能重开窗口。

     根子在快照的发出时机。所有 deliverSessionsSnapshot 的调用点都在收尾代码里，
     而收尾是分好几步走完的：completeClientRequest 之后才轮到 claudeTurnCompletionPending
     和 abortCtrl 归零。当场算 runningIds，这两个字段还是「忙」。

     而这偏偏是那一轮的最后一条快照，之后没人来纠正。所以这里盯的不是「有没有
     发过一条对的」，是「最后停在哪个状态」。 */
  const server = await startServer({ limit: "5", autoFinish: true });
  try {
    server.askIn("conv_done", "user_done");
    await waitFor(server.events, e => e.type === "done" && e.conversationId === "conv_done");
    await delay(400);

    const last = server.events.filter(e => e.type === "sessions_snapshot").at(-1);
    assert.ok(last, "至少该发过一条快照");
    assert.deepEqual(
      last.running,
      [],
      "跑完了还报在跑；前端照着它渲染，就是一个永远转圈的界面",
    );
  } finally {
    await server.close();
  }
});

test("停止只停指定的那个对话，别的照跑", { timeout: 30_000 }, async () => {
  /* 前端原来发的是 { stop: true, userMessageId }，不带 conversationId。服务端拿
     它绑上下文，带不出来就落到 ambient——一个谁都不属于的兜底实例。于是按停止
     什么都没停掉，那一轮继续跑到自然结束。
     反过来也要成立：停一个不能把另一个也带走。 */
  const server = await startServer({ limit: "5" });
  try {
    server.askIn("conv_keep", "user_keep");
    await waitFor(server.events, e => e.type === "request_started" && e.userMessageId === "user_keep");
    server.askIn("conv_stop", "user_stop");
    await waitFor(server.events, e => e.type === "request_started" && e.userMessageId === "user_stop");
    await waitFor(server.events, e => e.type === "sessions_snapshot" && e.running.length === 2);

    server.send({ stop: true, conversationId: "conv_stop", userMessageId: "user_stop" });

    const stopped = await waitFor(server.events, e => e.type === "stopped");
    assert.equal(stopped.conversationId, "conv_stop", "停错了对话");
    await delay(400);

    const last = server.events.filter(e => e.type === "sessions_snapshot").at(-1);
    assert.deepEqual(last.running, ["conv_keep"], "该停的没停掉，或者把不该停的一起停了");
  } finally {
    await server.close();
  }
});

test("多开时回答 AI 的提问，得落到问问题的那个对话上", { timeout: 30_000 }, async () => {
  /* pendingAskUserQuestion 存在「问问题的那个对话」的 session 上。前端原来发回的
     ask_user_question_response 不带 conversationId，服务端拿不到就落到 ambient——
     那儿从来没有待答的问题，于是回答被判成「已过期，请重试」，而那一轮就一直挂在
     那里，等一个再也来不了的答案。

     两头都验：不带归属会被判过期（这正是当初的现场），带上归属答案要真的走到模型
     手上——mock 收到 hook 的返回后会把答案回显成一条 assistant，只断言「服务端没
     报错」是不够的，那跟「答案石沉大海」长得一样。 */
  const server = await startServer({ limit: "5", askQuestion: true });
  try {
    server.askIn("conv_ask", "user_ask");
    const question = await waitFor(server.events, e => e.type === "ask_user_question");
    assert.equal(question.conversationId, "conv_ask", "问题事件要带归属，前端才知道该在哪个窗口弹");

    const answer = requestId => ({
      type: "ask_user_question_response",
      requestId,
      answers: { "走哪条路": ["左"] },   // key 是问题原文，不是 header
    });

    server.send(answer(question.requestId));
    const expired = await waitFor(server.events, e => e.type === "ask_user_question_error");
    assert.match(expired.text ?? "", /expired/i, "不带归属只能落到 ambient，那儿没有待答的问题");

    server.send({ ...answer(question.requestId), conversationId: "conv_ask" });
    const echoed = await waitFor(server.events, e => (
      e.type === "assistant" && JSON.stringify(e).includes("ANSWERED:")
    ));
    assert.match(
      echoed.message.content[0].text,
      /走哪条路.*左/,
      "带上归属之后，答案要真的交到模型手上，不是发出去就没了下文",
    );
  } finally {
    await server.close();
  }
});
