// server.js 一 import 就 listen，同进程测不了——所有用例都把它拉到子进程里跑。
// harness（reservePort / 等启动日志 / waitForMessage）借自 desktop-lite 的同名文件，
// 用例是 main 专属的：这边没有 request_ack / DESKTOP_AGENT_TOKEN / run-state 那套。
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";

const HERE = new URL(".", import.meta.url);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

// 必须显式指定端口：默认 8082/8083 是生产实例，测试绝不能去抢
async function reservePort() {
  const server = createServer();
  await new Promise((resolve, reject) => server.listen(0, "127.0.0.1", resolve).once("error", reject));
  const { port } = server.address();
  await new Promise(resolve => server.close(resolve));
  return port;
}

const PROBE_PROFILES = {
  activeProfileId: "p_claude",
  profiles: [
    { id: "p_claude", name: "Claude 会员", provider: "claude", apiKey: "", baseUrl: "" },
    {
      id: "p_deepseek",
      name: "DeepSeek",
      provider: "deepseek",
      apiKey: "probe-key",
      baseUrl: "https://api.deepseek.test",
      opusModel: "deepseek-probe-opus",
      sonnetModel: "deepseek-probe-sonnet",
      haikuModel: "deepseek-probe-haiku",
    },
  ],
};

// 起一个隔离的 server.js：临时 data 目录 + 临时 auth-profile，绝不碰真实 vault/凭证
async function startServer() {
  const scratch = await mkdtemp(join(tmpdir(), "inkfellow-chat-test-"));
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

// buildAgentEnv 是降级链的地基：runWithModelFallback 靠 {...profileData,
// activeProfileId: candidate.profileId} 覆写来切换候选，覆写不生效的话降级会
// "降"到同一个 provider 上，症状是静默的。同样跑在子进程里（import 即 listen）。
async function evalInServer(expression) {
  const port = await reservePort();
  const child = spawn(process.execPath, ["--input-type=module", "-e", `
    const m = await import("./server.js");
    const out = (${expression})(m);
    console.log("__RESULT__" + JSON.stringify(out));
    process.exit(0);
  `], {
    cwd: HERE,
    env: { ...process.env, PORT: String(port), HOST: "127.0.0.1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", c => { output += c; });
  child.stderr.on("data", c => { output += c; });
  const code = await new Promise(resolve => child.once("exit", resolve));
  const marker = output.indexOf("__RESULT__");
  if (marker === -1) throw new Error(`子进程未产出结果 (exit ${code}): ${output}`);
  return JSON.parse(output.slice(marker + "__RESULT__".length).split("\n")[0]);
}

test("buildAgentEnv 按 activeProfileId 覆写切换候选 profile", { timeout: 40_000 }, async () => {
  const profiles = JSON.stringify(PROBE_PROFILES);
  const env = await evalInServer(`m => {
    const data = ${profiles};
    const claude = m.buildAgentEnv(data, "medium", "claude-sonnet-5");
    const deepseek = m.buildAgentEnv(
      { ...data, activeProfileId: "p_deepseek" }, "medium", "deepseek-probe-sonnet");
    return {
      claudeBaseUrl: claude.ANTHROPIC_BASE_URL ?? null,
      claudeModel: claude.ANTHROPIC_MODEL ?? null,
      deepseekBaseUrl: deepseek.ANTHROPIC_BASE_URL ?? null,
      deepseekModel: deepseek.ANTHROPIC_MODEL ?? null,
      deepseekHaiku: deepseek.ANTHROPIC_DEFAULT_HAIKU_MODEL ?? null,
      deepseekEffort: deepseek.CLAUDE_CODE_EFFORT_LEVEL ?? null,
    };
  }`);

  // claude 会员档走订阅，buildAgentEnv 提前 return，不注入任何兼容变量
  assert.equal(env.claudeBaseUrl, null);
  assert.equal(env.claudeModel, null);

  // 覆写后必须真的落到 deepseek profile 上
  assert.equal(env.deepseekBaseUrl, "https://api.deepseek.test");
  assert.equal(env.deepseekModel, "deepseek-probe-sonnet");
  assert.equal(env.deepseekHaiku, "deepseek-probe-haiku");
  assert.equal(env.deepseekEffort, "medium");
});

// 这条曾在 desktop-lite 静默失效数周：不设该变量，SDK 就不发
// session_state_changed，长驻 Query 的回合永远结束不了，且无报错无日志。
// 必须对所有 provider 都成立——buildAgentEnv 里按 provider 提前 return，
// 变量放错位置会漏掉 Claude 会员通道。
test("buildAgentEnv 对所有 provider 都开启 session_state_changed", { timeout: 40_000 }, async () => {
  const profiles = JSON.stringify(PROBE_PROFILES);
  const flags = await evalInServer(`m => {
    const data = ${profiles};
    return {
      claude: m.buildAgentEnv(data, "medium", null).CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS ?? null,
      deepseek: m.buildAgentEnv(
        { ...data, activeProfileId: "p_deepseek" }, "medium", null
      ).CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS ?? null,
      noProfile: m.buildAgentEnv(
        { activeProfileId: "nope", profiles: [] }, "medium", null
      ).CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS ?? null,
    };
  }`);
  assert.equal(flags.claude, "1");
  assert.equal(flags.deepseek, "1");
  assert.equal(flags.noProfile, "1");
});

test("buildAgentEnv 清掉继承来的 Claude 兼容环境变量，避免串档", { timeout: 40_000 }, async () => {
  const profiles = JSON.stringify(PROBE_PROFILES);
  const env = await evalInServer(`m => {
    process.env.ANTHROPIC_BASE_URL = "https://stale.example";
    process.env.ANTHROPIC_MODEL = "stale-model";
    const out = m.buildAgentEnv(${profiles}, "medium", null);
    return { baseUrl: out.ANTHROPIC_BASE_URL ?? null, model: out.ANTHROPIC_MODEL ?? null };
  }`);
  // 切回 claude 会员档时，进程里残留的第三方覆盖必须被清掉
  assert.equal(env.baseUrl, null);
  assert.equal(env.model, null);
});

test("连接建立后立即下发 skill init", { timeout: 30_000 }, async () => {
  const server = await startServer();
  let ws;
  try {
    const conn = await connect(server.port);
    ws = conn.ws;
    const init = await waitForMessage(conn.events, e => e.type === "system" && e.subtype === "init");
    // 活动 profile 是 claude，技能集应按该 provider 解析
    assert.equal(init.provider, "claude");
    assert.ok(Array.isArray(init.skills));
  } finally {
    ws?.close();
    await server.stop();
  }
});

test("应用层心跳 ping 得到 pong", { timeout: 30_000 }, async () => {
  const server = await startServer();
  let ws;
  try {
    const conn = await connect(server.port);
    ws = conn.ws;
    ws.send(JSON.stringify({ type: "ping" }));
    const pong = await waitForMessage(conn.events, e => e.type === "pong");
    assert.equal(pong.type, "pong");
  } finally {
    ws?.close();
    await server.stop();
  }
});

test("领回未知的 run 会收到 run_not_found 而不是静默丢弃", { timeout: 30_000 }, async () => {
  const server = await startServer();
  let ws;
  try {
    const conn = await connect(server.port);
    ws = conn.ws;
    ws.send(JSON.stringify({ resumeRun: "run-does-not-exist" }));
    const miss = await waitForMessage(conn.events, e => e.type === "run_not_found");
    assert.equal(miss.runId, "run-does-not-exist");
  } finally {
    ws?.close();
    await server.stop();
  }
});
