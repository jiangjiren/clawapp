import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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

async function waitForMessage(events, predicate, startIndex = 0, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (let i = startIndex; i < events.length; i += 1) {
      if (predicate(events[i])) return events[i];
    }
    await delay(10);
  }
  throw new Error(`Timed out waiting for WebSocket event; received: ${JSON.stringify(events.slice(startIndex))}`);
}

test("WebSocket requests are acknowledged and duplicate IDs are not executed twice", { timeout: 15_000 }, async () => {
  const scratch = await mkdtemp(join(tmpdir(), "inkfellow-request-ack-"));
  const authFile = join(scratch, "auth-profile.json");
  const port = await reservePort();
  const token = "offline-request-test-token";
  await writeFile(authFile, JSON.stringify({
    activeProfileId: "p_codex",
    profiles: [{
      id: "p_codex",
      name: "Codex offline probe",
      provider: "codex",
      apiKey: "",
      baseUrl: "",
      opusModel: "gpt-5.4",
      sonnetModel: "gpt-5.4",
      haikuModel: "gpt-5.4-mini",
    }],
  }), "utf8");

  const child = spawn(process.execPath, ["server.js"], {
    cwd: new URL(".", import.meta.url),
    env: {
      ...process.env,
      PORT: String(port),
      HOST: "127.0.0.1",
      DESKTOP_AGENT_TOKEN: token,
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

  let ws;
  try {
    const deadline = Date.now() + 5000;
    while (!output.includes("claude-chat listening")) {
      if (child.exitCode != null) throw new Error(`sidecar exited early (${child.exitCode}): ${output}`);
      if (Date.now() >= deadline) throw new Error(`sidecar did not start: ${output}`);
      await delay(20);
    }

    ws = new WebSocket(`ws://127.0.0.1:${port}/?token=${encodeURIComponent(token)}`);
    const events = [];
    ws.on("message", raw => events.push(JSON.parse(raw.toString())));
    await new Promise((resolve, reject) => {
      ws.once("open", resolve);
      ws.once("error", reject);
    });

    const providersResponse = await fetch(`http://127.0.0.1:${port}/api/providers?token=${encodeURIComponent(token)}`);
    assert.equal(providersResponse.status, 200);
    const providerPayload = await providersResponse.json();
    assert.ok(Array.isArray(providerPayload.providers));
    const codexProvider = providerPayload.providers.find(profile => profile.provider === "codex");
    assert.equal(codexProvider?.model, "gpt-5.6-sol");
    assert.match(codexProvider?.goodAt || "", /重构|多文件/);
    assert.ok(providerPayload.providers.every(profile => typeof profile.goodAt === "string" && profile.goodAt.length > 0));
    const profileUpdateResponse = await fetch(
      `http://127.0.0.1:${port}/api/auth-profile?token=${encodeURIComponent(token)}`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "update",
          profile: { id: "p_codex", name: "Codex renamed probe" },
        }),
      },
    );
    assert.equal(profileUpdateResponse.status, 200);
    const profileUpdatePayload = await profileUpdateResponse.json();
    const updatedCodex = profileUpdatePayload.data?.profiles?.find(profile => profile.id === "p_codex");
    assert.match(updatedCodex?.goodAt || "", /重构|多文件/, "profile updates must preserve goodAt");

    const request = {
      conversationId: "conv_ack_probe",
      userMessageId: "user_ack_probe",
      displayText: "离线确认协议测试",
      composerText: "提醒我进行离线确认协议测试",
      prompt: "提醒我进行离线确认协议测试",
      profileId: "p_codex",
      model: "gpt-5.4",
      permissionMode: "auto",
      effort: "medium",
    };
    ws.send(JSON.stringify(request));
    await waitForMessage(events, event => event.type === "request_ack" && event.userMessageId === request.userMessageId && event.state === "running");
    await waitForMessage(events, event => event.type === "request_started" && event.userMessageId === request.userMessageId);
    await waitForMessage(events, event => event.type === "done" && event.userMessageId === request.userMessageId);
    assert.ok(events.some(event => event.type === "error" && event.userMessageId === request.userMessageId));

    const beforeDuplicate = events.length;
    const startedCount = events.filter(event => event.type === "request_started" && event.userMessageId === request.userMessageId).length;
    ws.send(JSON.stringify(request));
    await waitForMessage(
      events,
      event => event.type === "request_ack" && event.userMessageId === request.userMessageId && event.state === "error",
      beforeDuplicate,
    );
    await delay(75);
    assert.equal(
      events.filter(event => event.type === "request_started" && event.userMessageId === request.userMessageId).length,
      startedCount,
      "an acknowledged request ID must not execute a second time",
    );

    const dispatchStart = events.length;
    const dispatchRequest = {
      ...request,
      conversationId: "conv_dispatch_probe",
      userMessageId: "user_dispatch_probe",
      displayText: "@missing-vendor 验证结构化派发错误",
      prompt: "验证结构化派发错误",
      dispatchProvider: "missing-vendor",
      dispatchReason: "离线协议测试",
    };
    ws.send(JSON.stringify(dispatchRequest));
    await waitForMessage(
      events,
      event => event.type === "done" && event.userMessageId === dispatchRequest.userMessageId,
      dispatchStart,
    );
    const dispatchEvents = events.slice(dispatchStart);
    const dispatchToolUse = dispatchEvents.find(event =>
      event.type === "assistant"
      && event.message?.content?.some(block => block.type === "tool_use" && block.name === "dispatch_to_provider")
    );
    assert.equal(
      dispatchToolUse?.message?.content?.find(block => block.name === "dispatch_to_provider")?.input?.provider,
      "missing-vendor",
    );
    const dispatchToolResult = dispatchEvents.find(event =>
      event.type === "user"
      && event.message?.content?.some(block => block.type === "tool_result" && block.is_error)
    );
    assert.ok(dispatchToolResult, "manual provider dispatch must close the squad branch with an error result");
    assert.ok(dispatchEvents.some(event =>
      event.type === "error"
      && /当前可用厂商/.test(event.text || "")
      && /Codex renamed probe/.test(event.text || "")
    ));

    const runStateResponse = await fetch(`http://127.0.0.1:${port}/api/run-state?token=${encodeURIComponent(token)}`);
    assert.equal(runStateResponse.status, 200);
    assert.deepEqual(await runStateResponse.json(), { running: false });

    const leaseResponse = await fetch(`http://127.0.0.1:${port}/api/prepare-restart?token=${encodeURIComponent(token)}`, { method: "POST" });
    assert.equal(leaseResponse.status, 200);
    const lease = await leaseResponse.json();
    assert.equal(typeof lease.lease, "string");
    assert.ok(lease.expiresAt > Date.now());
    const leasedRunState = await fetch(`http://127.0.0.1:${port}/api/run-state?token=${encodeURIComponent(token)}`);
    assert.deepEqual(await leasedRunState.json(), { running: true });

    const retryStart = events.length;
    ws.send(JSON.stringify({ ...request, userMessageId: "user_restart_retry" }));
    await waitForMessage(
      events,
      event => event.type === "request_retry" && event.userMessageId === "user_restart_retry",
      retryStart,
    );
    assert.equal(
      events.slice(retryStart).some(event => event.type === "request_ack" && event.userMessageId === "user_restart_retry"),
      false,
      "a draining sidecar must not acknowledge a request that the restart would discard",
    );
  } finally {
    ws?.close();
    if (child.exitCode == null) {
      const exited = new Promise(resolve => child.once("exit", resolve));
      child.kill();
      const killTimeout = new Promise(resolve => {
        const timer = setTimeout(resolve, 2000);
        timer.unref?.();
      });
      await Promise.race([exited, killTimeout]);
    }
    await rm(scratch, { recursive: true, force: true });
  }
});

test("Claude steering applies at tool/idle safe points, survives reconnect, and preserves owner/history", { timeout: 25_000 }, async () => {
  const scratch = await mkdtemp(join(tmpdir(), "inkfellow-steering-"));
  const authFile = join(scratch, "auth-profile.json");
  const historyFile = join(scratch, "history.json");
  const mockLogFile = join(scratch, "mock-sdk.jsonl");
  const mockSdkFile = join(scratch, "mock-claude-sdk.mjs");
  const loaderFile = join(scratch, "mock-claude-loader.mjs");
  const port = await reservePort();
  const token = "offline-steering-test-token";
  const wsUrl = `ws://127.0.0.1:${port}/?token=${encodeURIComponent(token)}`;
  const apiUrl = `http://127.0.0.1:${port}`;

  await writeFile(authFile, JSON.stringify({
    activeProfileId: "p_claude",
    profiles: [{
      id: "p_claude",
      name: "Claude offline steering probe",
      provider: "claude",
      apiKey: "",
      baseUrl: "",
      opusModel: "",
      sonnetModel: "",
      haikuModel: "",
    }],
  }), "utf8");
  await writeFile(mockLogFile, "", "utf8");
  await writeFile(mockSdkFile, `
    import { appendFile } from "node:fs/promises";

    class EventQueue {
      constructor() {
        this.items = [];
        this.waiters = [];
        this.closed = false;
      }
      push(value) {
        if (this.closed) return;
        const waiter = this.waiters.shift();
        if (waiter) waiter({ value, done: false });
        else this.items.push(value);
      }
      next() {
        if (this.items.length > 0) return Promise.resolve({ value: this.items.shift(), done: false });
        if (this.closed) return Promise.resolve({ value: undefined, done: true });
        return new Promise(resolve => this.waiters.push(resolve));
      }
      return() {
        this.close();
        return Promise.resolve({ value: undefined, done: true });
      }
      close() {
        if (this.closed) return;
        this.closed = true;
        for (const waiter of this.waiters.splice(0)) waiter({ value: undefined, done: true });
      }
      [Symbol.asyncIterator]() { return this; }
    }

    const log = value => appendFile(process.env.MOCK_CLAUDE_LOG_FILE, JSON.stringify(value) + "\\n", "utf8");
    const textOf = message => {
      const content = message?.message?.content;
      if (typeof content === "string") return content;
      if (!Array.isArray(content)) return "";
      return content.filter(block => block?.type === "text").map(block => block.text).join("\\n");
    };

    class FakeQuery {
      constructor(prompt) {
        this.events = new EventQueue();
        this.turn = 0;
        this.consume(prompt);
      }
      [Symbol.asyncIterator]() { return this.events; }
      async setPermissionMode() {}
      async setModel() {}
      async interrupt() {
        await log({ kind: "interrupt" });
        this.events.push({ type: "system", subtype: "session_state_changed", state: "idle" });
      }
      close() {
        this.events.close();
      }
      async consume(prompt) {
        for await (const message of prompt) {
          const text = textOf(message);
          this.turn += 1;
          await log({ kind: "prompt", turn: this.turn, text, priority: message?.priority ?? null });
          if (this.turn === 1) {
            this.events.push({
              type: "system",
              subtype: "init",
              session_id: "11111111-1111-4111-8111-111111111111",
              skills: [],
            });
            this.events.push({ type: "system", subtype: "session_state_changed", state: "running" });
            const withTool = text.includes("[tool]");
            this.events.push({
              type: "assistant",
              message: {
                role: "assistant",
                content: withTool
                  ? [
                      { type: "text", text: "partial before tool" },
                      { type: "tool_use", id: "tool-safe-point", name: "Read", input: { file_path: "probe.txt" } },
                    ]
                  : [{ type: "text", text: "partial before idle" }],
              },
            });
            setTimeout(() => {
              if (withTool) {
                this.events.push({
                  type: "user",
                  message: {
                    role: "user",
                    content: [{ type: "tool_result", tool_use_id: "tool-safe-point", content: "tool complete" }],
                  },
                });
              } else {
                this.events.push({
                  type: "result",
                  subtype: "success",
                  is_error: false,
                  result: "first segment complete",
                  total_cost_usd: 0,
                  usage: {},
                });
                this.events.push({ type: "system", subtype: "session_state_changed", state: "idle" });
              }
            }, 900);
            continue;
          }
          this.events.push({
            type: "assistant",
            message: {
              role: "assistant",
              content: [{ type: "text", text: "continued: " + text }],
            },
          });
          this.events.push({
            type: "result",
            subtype: "success",
            is_error: false,
            result: "steering complete",
            total_cost_usd: 0,
            usage: {},
          });
          this.events.push({ type: "system", subtype: "session_state_changed", state: "idle" });
        }
      }
    }

    export const query = ({ prompt }) => new FakeQuery(prompt);
    export const tool = (name, description, schema, handler) => ({ name, description, schema, handler });
    export const createSdkMcpServer = config => config;
  `, "utf8");
  await writeFile(loaderFile, `
    import { pathToFileURL } from "node:url";
    export async function resolve(specifier, context, nextResolve) {
      if (specifier === "@anthropic-ai/claude-agent-sdk") {
        return { url: pathToFileURL(process.env.MOCK_CLAUDE_SDK_FILE).href, shortCircuit: true };
      }
      return nextResolve(specifier, context);
    }
  `, "utf8");

  const child = spawn(process.execPath, ["--experimental-loader", pathToFileURL(loaderFile).href, "server.js"], {
    cwd: new URL(".", import.meta.url),
    env: {
      ...process.env,
      PORT: String(port),
      HOST: "127.0.0.1",
      DESKTOP_AGENT_TOKEN: token,
      CLAUDE_CHAT_DATA_DIR: scratch,
      CLAUDE_CHAT_HISTORY_FILE: historyFile,
      CLAUDE_CHAT_AUTH_PROFILE_FILE: authFile,
      MOCK_CLAUDE_LOG_FILE: mockLogFile,
      MOCK_CLAUDE_SDK_FILE: mockSdkFile,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", chunk => { output += chunk; });
  child.stderr.on("data", chunk => { output += chunk; });

  const connect = async () => {
    const ws = new WebSocket(wsUrl);
    const events = [];
    ws.on("message", raw => events.push(JSON.parse(raw.toString())));
    await new Promise((resolve, reject) => {
      ws.once("open", resolve);
      ws.once("error", reject);
    });
    return { ws, events };
  };

  let connection;
  try {
    const deadline = Date.now() + 5000;
    while (!output.includes("claude-chat listening")) {
      if (child.exitCode != null) throw new Error(`sidecar exited early (${child.exitCode}): ${output}`);
      if (Date.now() >= deadline) throw new Error(`sidecar did not start: ${output}`);
      await delay(20);
    }

    connection = await connect();
    const first = {
      conversationId: "conv_tool_steering",
      userMessageId: "user_tool_first",
      displayText: "first tool turn",
      prompt: "[tool] first tool turn",
      profileId: "p_claude",
      permissionMode: "auto",
      effort: "medium",
    };
    connection.ws.send(JSON.stringify(first));
    await waitForMessage(
      connection.events,
      event => event.type === "assistant"
        && event.userMessageId === first.userMessageId
        && event.message?.content?.some(block => block.type === "tool_use"),
    );

    const crossConversation = {
      ...first,
      conversationId: "conv_cross_fallback",
      userMessageId: "user_cross_fallback",
      displayText: "cross conversation",
      prompt: "[tool] cross conversation",
      deliveryMode: "steer",
    };
    const steer = {
      ...first,
      userMessageId: "user_tool_steer",
      displayText: "steer at tool boundary",
      prompt: "steer at tool boundary",
      deliveryMode: "steer",
    };
    connection.ws.send(JSON.stringify(crossConversation));
    connection.ws.send(JSON.stringify(steer));
    connection.ws.send(JSON.stringify(steer));
    // 每个对话有自己的 runtime 之后，另一个对话直接开跑，不再挤进当前回合排队。
    // 要守的不变量没变——它绝不能被当成当前 runtime 的 steering（见下方断言）。
    const crossStarted = await waitForMessage(
      connection.events,
      event => event.type === "request_started" && event.userMessageId === crossConversation.userMessageId,
    );
    assert.equal(crossStarted.conversationId, crossConversation.conversationId);
    assert.equal(
      connection.events.some(
        event => event.type === "steering_queued" && event.userMessageId === crossConversation.userMessageId,
      ),
      false,
      "another conversation must not be queued into the active turn's steering",
    );
    const queuedSteer = await waitForMessage(
      connection.events,
      event => event.type === "steering_queued" && event.userMessageId === steer.userMessageId,
    );
    assert.equal(queuedSteer.delivery, "steer");

    await new Promise(resolve => {
      connection.ws.once("close", resolve);
      connection.ws.close();
    });
    connection = await connect();
    const snapshot = await waitForMessage(
      connection.events,
      event => event.type === "steering_snapshot"
        && event.items?.some(item => item.userMessageId === steer.userMessageId),
    );
    assert.deepEqual(
      snapshot.items
        .filter(item => [crossConversation.userMessageId, steer.userMessageId].includes(item.userMessageId))
        .map(item => [item.userMessageId, item.delivery]),
      [[steer.userMessageId, "steer"]],
      "reconnect restores this conversation's own pending steering; the other conversation runs on its own runtime and never enters this queue",
    );
    const attached = connection.events.find(event => event.type === "run_attached");
    assert.equal(attached?.userMessageId, first.userMessageId, "reconnect remains attached to the original foreground owner");

    const appliedTool = await waitForMessage(
      connection.events,
      event => event.type === "steering_applied" && event.userMessageId === steer.userMessageId,
    );
    assert.equal(appliedTool.safePoint, "tool_result");
    const continuedTool = await waitForMessage(
      connection.events,
      event => event.type === "assistant"
        && event.message?.content?.some(block => block.text === "continued: steer at tool boundary"),
    );
    assert.equal(
      continuedTool.userMessageId,
      first.userMessageId,
      "steering must not overwrite activeForegroundRequestId with the pending message id",
    );
    await waitForMessage(
      connection.events,
      event => event.type === "done" && event.userMessageId === first.userMessageId,
    );
    assert.equal(
      connection.events.some(event => event.type === "steering_applied" && event.userMessageId === crossConversation.userMessageId),
      false,
      "cross-conversation fallback must never be reported as applied to the current runtime",
    );
    assert.equal(
      connection.events.filter(event => event.type === "steering_applied" && event.userMessageId === steer.userMessageId).length,
      1,
      "a duplicate userMessageId is applied exactly once",
    );

    const toolHistoryResponse = await fetch(
      `${apiUrl}/api/history/${encodeURIComponent(first.conversationId)}?token=${encodeURIComponent(token)}`,
    );
    assert.equal(toolHistoryResponse.status, 200);
    const toolHistory = await toolHistoryResponse.json();
    assert.deepEqual(toolHistory.messages.map(message => message.role), ["user", "assistant", "user", "assistant"]);
    assert.equal(toolHistory.messages[0].id, first.userMessageId);
    assert.equal(toolHistory.messages[1].text, "partial before tool");
    assert.ok(
      toolHistory.messages[1].blocks?.some(block => block.type === "tool_use" && block.id === "tool-safe-point"),
      "the partial assistant segment retains its structured tool history",
    );
    assert.equal(toolHistory.messages[2].id, steer.userMessageId);
    assert.equal(toolHistory.messages[2].text, steer.displayText);
    assert.equal(toolHistory.messages[3].text, "continued: steer at tool boundary");

    /* 这里原本断言「另一个对话必须等当前回合跑完才开始」——那是单 runtime 时代
       排队的副产物。现在每个对话有自己的 runtime，真正并发，先后顺序不再是不变量。
       要守的「互不污染」由上面两条断言保证：它从未进入本回合的 steering 队列、
       也从未被报告为 applied；下面的历史断言进一步确认它没写进这个对话。 */
    assert.equal(
      connection.events.some(
        event => event.type === "steering_applied" && event.userMessageId === crossConversation.userMessageId,
      ),
      false,
      "the other conversation never enters this conversation's turn",
    );

    connection.ws.send(JSON.stringify({ reset: true, conversationId: crossConversation.conversationId }));
    await waitForMessage(connection.events, event => event.type === "reset_complete");

    const idleFirst = {
      ...first,
      conversationId: "conv_idle_steering",
      userMessageId: "user_idle_first",
      displayText: "first idle turn",
      prompt: "[idle] first idle turn",
    };
    const idleStart = connection.events.length;
    connection.ws.send(JSON.stringify(idleFirst));
    await waitForMessage(
      connection.events,
      event => event.type === "assistant"
        && event.userMessageId === idleFirst.userMessageId
        && event.message?.content?.some(block => block.text === "partial before idle"),
      idleStart,
    );
    const idleSteer = {
      ...idleFirst,
      userMessageId: "user_idle_steer",
      displayText: "steer at idle boundary",
      prompt: "steer at idle boundary",
      deliveryMode: "steer",
    };
    connection.ws.send(JSON.stringify(idleSteer));
    await waitForMessage(
      connection.events,
      event => event.type === "steering_queued" && event.userMessageId === idleSteer.userMessageId,
      idleStart,
    );
    const appliedIdle = await waitForMessage(
      connection.events,
      event => event.type === "steering_applied" && event.userMessageId === idleSteer.userMessageId,
      idleStart,
    );
    assert.equal(appliedIdle.safePoint, "idle", "a turn with no tool calls still continues at the idle boundary");
    await waitForMessage(
      connection.events,
      event => event.type === "done" && event.userMessageId === idleFirst.userMessageId,
      idleStart,
    );
    assert.equal(
      connection.events.slice(idleStart).some(event => event.type === "stopped"),
      false,
      "sending steering messages never produces an implicit Stop",
    );

    const idleHistoryResponse = await fetch(
      `${apiUrl}/api/history/${encodeURIComponent(idleFirst.conversationId)}?token=${encodeURIComponent(token)}`,
    );
    assert.equal(idleHistoryResponse.status, 200);
    const idleHistory = await idleHistoryResponse.json();
    assert.deepEqual(idleHistory.messages.map(message => message.role), ["user", "assistant", "user", "assistant"]);
    assert.equal(idleHistory.messages[1].text, "partial before idle");
    assert.equal(idleHistory.messages[2].id, idleSteer.userMessageId);
    assert.equal(idleHistory.messages[3].text, "continued: steer at idle boundary");

    const mockLog = (await readFile(mockLogFile, "utf8"))
      .split(/\r?\n/)
      .filter(Boolean)
      .map(line => JSON.parse(line));
    assert.equal(mockLog.some(entry => entry.kind === "interrupt"), false, "steering never calls SDK interrupt");
    const promptTexts = mockLog.filter(entry => entry.kind === "prompt").map(entry => entry.text);
    assert.equal(promptTexts.filter(text => text === steer.prompt).length, 1, "duplicate steering is not sent twice");
    assert.ok(promptTexts.indexOf(first.prompt) < promptTexts.indexOf(steer.prompt));
    assert.ok(promptTexts.indexOf(idleFirst.prompt) < promptTexts.indexOf(idleSteer.prompt));
  } finally {
    connection?.ws.close();
    if (child.exitCode == null) {
      const exited = new Promise(resolve => child.once("exit", resolve));
      child.kill();
      const killTimeout = new Promise(resolve => {
        const timer = setTimeout(resolve, 2000);
        timer.unref?.();
      });
      await Promise.race([exited, killTimeout]);
    }
    await rm(scratch, { recursive: true, force: true });
  }
});

// 回合终止依赖 system/session_state_changed state=idle，该事件自 SDK 0.2.83 起
// 为 opt-in。少了这个变量，持久 Query 的前台轮永远不结束、后续消息全部排队。
// server.js 顶层会 listen，所以放到子进程里跑（PORT=0 绑随机端口）。
test("buildAgentEnv opts into session_state_changed for every provider", { timeout: 20_000 }, async () => {
  const scratch = await mkdtemp(join(tmpdir(), "inkfellow-session-state-env-"));
  const authFile = join(scratch, "auth-profile.json");
  const historyFile = join(scratch, "history.json");
  let child;
  let childClosed = false;
  let stdout = "";
  let stderr = "";

  try {
    const probe = `
      const { buildAgentEnv, resolveDispatchProfile, listDispatchProviders, rememberDispatchSession, recallDispatchSession, forgetDispatchSessions, dropDispatchSession, isDispatchInflight, markDispatchInflight, dispatchGenerationOf, forgetDispatchSessionsForProfile, historyIdOrNull } = await import(${JSON.stringify(new URL("server.js", import.meta.url).href)});
      const KEY = "CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS";
      const cases = {
        claude: { activeProfileId: "p_claude", profiles: [{ id: "p_claude", provider: "claude" }] },
        anthropic: { activeProfileId: "p_a", profiles: [{ id: "p_a", provider: "anthropic", apiKey: "k", opusModel: "m" }] },
        deepseek: { activeProfileId: "p_d", profiles: [{ id: "p_d", provider: "deepseek", apiKey: "k", baseUrl: "https://x", opusModel: "m" }] },
        openrouter: { activeProfileId: "p_o", profiles: [{ id: "p_o", provider: "openrouter", apiKey: "k", baseUrl: "https://x", opusModel: "m" }] },
        minimax: { activeProfileId: "p_m", profiles: [{ id: "p_m", provider: "minimax", apiKey: "k", baseUrl: "https://x", opusModel: "m" }] },
        custom: { activeProfileId: "p_custom", profiles: [{ id: "p_custom", provider: "custom", apiKey: "k", baseUrl: "https://x", opusModel: "m" }] },
        codex: { activeProfileId: "p_codex", profiles: [{ id: "p_codex", provider: "codex" }] },
      };
      const out = { inherited: process.env[KEY], providers: {}, override: {} };
      for (const [name, data] of Object.entries(cases)) {
        out.providers[name] = buildAgentEnv(data, "medium", null)[KEY];
      }
      const mixed = {
        activeProfileId: "p_claude",
        profiles: [
          { id: "p_claude", provider: "claude" },
          { id: "p_d", name: "Deep Reasoner", provider: "deepseek", apiKey: "override-key", baseUrl: "https://override.example", sonnetModel: "deepseek-override", goodAt: "reasoning" },
        ],
      };
      const overrideEnv = buildAgentEnv(mixed, "medium", null, mixed.profiles[1]);
      out.override = {
        baseUrl: overrideEnv.ANTHROPIC_BASE_URL,
        token: overrideEnv.ANTHROPIC_AUTH_TOKEN,
        model: overrideEnv.ANTHROPIC_MODEL,
        byProvider: resolveDispatchProfile(mixed, "deepseek")?.id,
        byName: resolveDispatchProfile(mixed, "Deep Reasoner")?.id,
        listedModel: listDispatchProviders(mixed).find(profile => profile.id === "p_d")?.model,
      };

      // 派发会话续接：作用域是「对话 + 厂商」，重置一条对话不能波及另一条
      rememberDispatchSession("conv-a", "p_d", "sess-1");
      rememberDispatchSession("conv-b", "p_d", "sess-3");
      out.sessions = {
        recalled: recallDispatchSession("conv-a", "p_d") ?? null,
        otherProvider: recallDispatchSession("conv-a", "p_codex") ?? null,
        otherConversation: recallDispatchSession("conv-zzz", "p_d") ?? null,
      };
      rememberDispatchSession("conv-a", "p_d", "sess-2");
      out.sessions.afterOverwrite = recallDispatchSession("conv-a", "p_d") ?? null;
      forgetDispatchSessions("conv-a");
      out.sessions.afterForget = recallDispatchSession("conv-a", "p_d") ?? null;
      out.sessions.siblingSurvivesForget = recallDispatchSession("conv-b", "p_d") ?? null;
      // 空 sessionId 不该被记住，否则下一轮会拿着假 id 去续接
      rememberDispatchSession("conv-c", "p_d", null);
      out.sessions.ignoresBlankSessionId = recallDispatchSession("conv-c", "p_d") ?? null;

      // 坏 id 必须能单独丢弃：续接失败后留着它，之后每次都会拿同一个坏 id 去试
      rememberDispatchSession("conv-d", "p_d", "sess-bad");
      rememberDispatchSession("conv-d", "p_codex", "sess-keep");
      dropDispatchSession("conv-d", "p_d");
      out.sessions.afterDrop = recallDispatchSession("conv-d", "p_d") ?? null;
      out.sessions.dropSparesSibling = recallDispatchSession("conv-d", "p_codex") ?? null;

      // historyIdOrNull 在拿不到合法值时必须返回 null，不能像 normalizeHistoryId
      // 那样凭空造一个——那会让「按 id 清除」静默清了个寂寞
      out.historyId = {
        valid: historyIdOrNull("conv-abc"),
        empty: historyIdOrNull(""),
        nullish: historyIdOrNull(null),
        tooShort: historyIdOrNull("ab"),
        illegal: historyIdOrNull("has space"),
      };

      // 在途守卫：并发派同一家时后来者不该去续接同一条 thread。
      // 必须计数——三个并发时第一个跑完就清标记的话，第三个会误以为没人在跑
      out.inflight = {
        idleIsFalse: isDispatchInflight("conv-e", "p_d"),
        blankIsFalse: isDispatchInflight(null, "p_d"),
      };
      const relA = markDispatchInflight("conv-e", "p_d");
      const relB = markDispatchInflight("conv-e", "p_d");
      out.inflight.bothHeld = isDispatchInflight("conv-e", "p_d");
      relA();
      out.inflight.stillHeldAfterFirstRelease = isDispatchInflight("conv-e", "p_d");
      relA();  // 租约重复释放不能把别人的计数减掉
      out.inflight.doubleReleaseIsNoop = isDispatchInflight("conv-e", "p_d");
      relB();
      out.inflight.freeAfterAllReleased = isDispatchInflight("conv-e", "p_d");

      // 代际保护：reset 之后迟到的 onSession 不能把刚清掉的会话又填回去
      const genBefore = dispatchGenerationOf("conv-f");
      rememberDispatchSession("conv-f", "p_d", "sess-f");
      forgetDispatchSessions("conv-f");
      out.generation = {
        bumpedOnForget: dispatchGenerationOf("conv-f") > genBefore,
        blankIsZero: dispatchGenerationOf(null),
      };

      // 比对再删：并发分支写了新会话后，先来的那条失败不能把它删掉
      rememberDispatchSession("conv-g", "p_d", "sess-old");
      rememberDispatchSession("conv-g", "p_d", "sess-new");   // 并发分支覆盖
      dropDispatchSession("conv-g", "p_d", "sess-old");        // 先来的失败了
      out.cas = { keepsNewer: recallDispatchSession("conv-g", "p_d") ?? null };
      dropDispatchSession("conv-g", "p_d", "sess-new");        // 值对得上才删
      out.cas.dropsWhenMatched = recallDispatchSession("conv-g", "p_d") ?? null;
      rememberDispatchSession("conv-g", "p_d", "sess-x");
      dropDispatchSession("conv-g", "p_d");                    // 不传期望值＝无条件删
      out.cas.unconditionalStillWorks = recallDispatchSession("conv-g", "p_d") ?? null;

      // 改账号后，该 profile 在所有对话里的会话都要作废。
      // 用独立的 profile id，免得被前面几步留下的 p_d 记录干扰计数。
      rememberDispatchSession("conv-h", "p_wipe", "s1");
      rememberDispatchSession("conv-i", "p_wipe", "s2");
      rememberDispatchSession("conv-h", "p_keep", "s3");
      const wiped = forgetDispatchSessionsForProfile("p_wipe");
      out.profileWipe = {
        removed: wiped,
        convH: recallDispatchSession("conv-h", "p_wipe") ?? null,
        convI: recallDispatchSession("conv-i", "p_wipe") ?? null,
        otherProfileKept: recallDispatchSession("conv-h", "p_keep") ?? null,
      };

      process.stdout.write("PROBE:" + JSON.stringify(out) + "\\n", () => process.exit(0));
    `;
    child = spawn(process.execPath, ["--input-type=module", "-e", probe], {
      cwd: new URL(".", import.meta.url),
      env: {
        ...process.env,
        PORT: "0",
        HOST: "127.0.0.1",
        CLAUDE_CHAT_DATA_DIR: scratch,
        CLAUDE_CHAT_HISTORY_FILE: historyFile,
        CLAUDE_CHAT_AUTH_PROFILE_FILE: authFile,
        CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS: "0",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });
    child.once("close", () => { childClosed = true; });

    const outcome = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`probe timed out\nstdout:\n${stdout}\nstderr:\n${stderr}`));
      }, 10_000);
      timer.unref?.();
      child.once("error", error => {
        clearTimeout(timer);
        reject(error);
      });
      child.once("close", (code, signal) => {
        clearTimeout(timer);
        resolve({ code, signal });
      });
    });
    assert.equal(
      outcome.code,
      0,
      `probe exited ${outcome.code ?? `via signal ${outcome.signal}`}\nstdout:\n${stdout}\nstderr:\n${stderr}`,
    );
    const line = stdout.split(/\r?\n/).find(value => value.startsWith("PROBE:"));
    assert.ok(line, `probe produced no result\nstdout:\n${stdout}\nstderr:\n${stderr}`);
    const result = JSON.parse(line.slice("PROBE:".length));
    assert.equal(result.inherited, "0", "probe must start with the event flag disabled");
    for (const provider of ["claude", "anthropic", "deepseek", "openrouter", "minimax", "custom", "codex"]) {
      assert.equal(result.providers[provider], "1", `${provider} profile must opt into session state events`);
    }
    assert.deepEqual(result.override, {
      baseUrl: "https://override.example",
      token: "override-key",
      model: "deepseek-override",
      byProvider: "p_d",
      byName: "p_d",
      listedModel: "deepseek-override",
    });
    assert.deepEqual(result.sessions, {
      recalled: "sess-1",
      otherProvider: null,
      otherConversation: null,
      afterOverwrite: "sess-2",
      afterForget: null,
      siblingSurvivesForget: "sess-3",
      ignoresBlankSessionId: null,
      afterDrop: null,
      dropSparesSibling: "sess-keep",
    }, "派发会话必须按「对话 + 厂商」隔离，重置时整条清掉，续接失败时能单独丢弃坏 id");
    assert.deepEqual(result.historyId, {
      valid: "conv-abc",
      empty: null,
      nullish: null,
      tooShort: null,
      illegal: null,
    }, "historyIdOrNull 必须在拿不到合法 id 时返回 null，否则按 id 清除会清了个寂寞");
    assert.deepEqual(result.inflight, {
      idleIsFalse: false,
      blankIsFalse: false,
      bothHeld: true,
      stillHeldAfterFirstRelease: true,
      doubleReleaseIsNoop: true,
      freeAfterAllReleased: false,
    }, "在途守卫必须计数：先完成的那个不能把还在跑的标记清掉，租约重复释放也不能");
    assert.deepEqual(result.generation, {
      bumpedOnForget: true,
      blankIsZero: 0,
    }, "清除会话必须推进代际，否则 reset 后迟到的回调会把会话又填回去");
    assert.deepEqual(result.cas, {
      keepsNewer: "sess-new",
      dropsWhenMatched: null,
      unconditionalStillWorks: null,
    }, "丢弃会话必须比对再删，否则并发分支刚写的好会话会被先来者的失败连带删掉");
    assert.deepEqual(result.profileWipe, {
      removed: 2,
      convH: null,
      convI: null,
      otherProfileKept: "s3",
    }, "改账号凭据后，该 profile 在所有对话里的会话都要作废，别的 profile 不受影响");
  } finally {
    if (child && !childClosed) {
      await new Promise((resolve, reject) => {
        const forceTimer = setTimeout(() => child.kill("SIGKILL"), 2_000);
        const closeTimer = setTimeout(() => {
          child.off("close", onClose);
          reject(new Error(`probe did not close after SIGKILL\nstdout:\n${stdout}\nstderr:\n${stderr}`));
        }, 4_000);
        const onClose = () => {
          clearTimeout(forceTimer);
          clearTimeout(closeTimer);
          resolve();
        };
        child.once("close", onClose);
        child.kill();
      });
    }
    await rm(scratch, { recursive: true, force: true });
  }
});
