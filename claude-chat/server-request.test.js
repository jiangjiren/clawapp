import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

    const request = {
      conversationId: "conv_ack_probe",
      userMessageId: "user_ack_probe",
      displayText: "离线确认协议测试",
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

// 回合终止依赖 system/session_state_changed state=idle，该事件自 SDK 0.2.83 起
// 为 opt-in。少了这个变量，持久 Query 的前台轮永远不结束、后续消息全部排队。
// server.js 顶层会 listen，所以放到子进程里跑（PORT=0 绑随机端口）。
test("buildAgentEnv opts into session_state_changed for every provider", { timeout: 20_000 }, async () => {
  const probe = `
    const { buildAgentEnv } = await import(${JSON.stringify(new URL("server.js", import.meta.url).href)});
    const KEY = "CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS";
    const cases = {
      claude: { activeProfileId: "p_claude", profiles: [{ id: "p_claude", provider: "claude" }] },
      anthropic: { activeProfileId: "p_a", profiles: [{ id: "p_a", provider: "anthropic", apiKey: "k", opusModel: "m" }] },
      deepseek: { activeProfileId: "p_d", profiles: [{ id: "p_d", provider: "deepseek", apiKey: "k", baseUrl: "https://x", opusModel: "m" }] },
    };
    const out = {};
    for (const [name, data] of Object.entries(cases)) out[name] = buildAgentEnv(data, "medium", null)[KEY];
    console.log("PROBE:" + JSON.stringify(out));
    process.exit(0);
  `;
  const child = spawn(process.execPath, ["--input-type=module", "-e", probe], {
    cwd: new URL(".", import.meta.url),
    env: { ...process.env, PORT: "0" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  child.stdout.on("data", chunk => { stdout += chunk; });
  const code = await new Promise(resolve => child.once("exit", resolve));
  assert.equal(code, 0, `probe exited ${code}`);
  const line = stdout.split("\n").find(l => l.startsWith("PROBE:"));
  assert.ok(line, `probe produced no result: ${stdout}`);
  const result = JSON.parse(line.slice("PROBE:".length));
  for (const provider of ["claude", "anthropic", "deepseek"]) {
    assert.equal(result[provider], "1", `${provider} profile must opt into session state events`);
  }
});
