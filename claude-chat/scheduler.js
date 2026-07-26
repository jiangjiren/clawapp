import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import crypto from "node:crypto";
import cron from "node-cron";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { Codex } from "@openai/codex-sdk";
import { buildModelCandidates, runWithModelFallback } from "./model-fallback.js";

// Injected server context
let ctx = null;

// jobId -> cancellable handle (node-cron task or { destroy: () => clearTimeout })
const activeTasks = new Map();
const MAX_TIMER_DELAY_MS = 2_147_483_647;

// Channel adapters: { send(peer, text) } — add feishu/telegram here later
const channelAdapters = {};

// ── Init ──────────────────────────────────────────────────────────────────────

export function init(context) {
  ctx = context;
  mkdirSync(join(ctx.DATA_DIR, "runs"), { recursive: true });

  // Register wechat adapter
  channelAdapters.wechat = {
    async send(peer, text) {
      if (!existsSync(ctx.WECHAT_CONFIG_FILE)) throw new Error("WeChat not connected");
      const creds = JSON.parse(readFileSync(ctx.WECHAT_CONFIG_FILE, "utf8"));
      if (!creds.token || !creds.baseUrl) throw new Error("WeChat credentials incomplete");
      const targets = typeof ctx.resolveWechatDeliveryTargets === "function"
        ? ctx.resolveWechatDeliveryTargets(peer)
        : (typeof ctx.resolveWechatDeliveryPeers === "function"
          ? ctx.resolveWechatDeliveryPeers(peer).map(candidate => ({ peer: candidate }))
          : [{ peer }]);
      let lastErr = null;
      for (const target of targets) {
        const candidate = typeof target === "string" ? target : target.peer;
        const contextToken = typeof target === "object" ? target.contextToken : undefined;
        try {
          await ctx.sendWechatMessage(creds.baseUrl, creds.token, candidate, text, contextToken, creds.botId || "");
          if (candidate !== peer) {
            console.log(`[Scheduler] WeChat delivery fallback succeeded: ${String(peer).slice(0, 12)}... -> ${String(candidate).slice(0, 12)}...`);
          }
          return;
        } catch (err) {
          lastErr = err;
          // 存储的 context_token 可能已过期（网关返回 ret -2），去掉 token 重试一次
          if (contextToken) {
            try {
              await ctx.sendWechatMessage(creds.baseUrl, creds.token, candidate, text, undefined, creds.botId || "");
              console.log(`[Scheduler] WeChat delivery succeeded without stale context token: ${String(candidate).slice(0, 12)}...`);
              return;
            } catch (retryErr) {
              lastErr = retryErr;
            }
          }
          if (target !== targets[targets.length - 1]) {
            console.warn(`[Scheduler] WeChat delivery to ${String(candidate).slice(0, 12)}... failed, trying fallback: ${lastErr.message}`);
          }
        }
      }
      // 全部投递失败：入待补发队列，用户下次发微信时自动补发
      let queued = false;
      if (typeof ctx.queueWechatPendingDelivery === "function") {
        try { ctx.queueWechatPendingDelivery(peer, text); queued = true; } catch { }
      }
      const baseMsg = (lastErr || new Error("WeChat delivery failed")).message;
      throw new Error(queued ? `${baseMsg}（已入待补发队列，用户下次发消息时自动补发）` : baseMsg);
    },
  };

  _loadAndResume();
}

// ── File helpers ──────────────────────────────────────────────────────────────

function schedulesFile() { return join(ctx.DATA_DIR, `schedules-${ctx.PORT}.json`); }
function stateFile()     { return join(ctx.DATA_DIR, `schedules-state-${ctx.PORT}.json`); }
function runsDir()       { return join(ctx.DATA_DIR, "runs"); }

function readSchedules() {
  if (!existsSync(schedulesFile())) return { version: 1, jobs: [] };
  try { return JSON.parse(readFileSync(schedulesFile(), "utf8")); }
  catch { return { version: 1, jobs: [] }; }
}

function writeSchedules(data) {
  writeFileSync(schedulesFile(), JSON.stringify(data, null, 2), "utf8");
}

function readState() {
  if (!existsSync(stateFile())) return {};
  try { return JSON.parse(readFileSync(stateFile(), "utf8")); }
  catch { return {}; }
}

function writeState(state) {
  writeFileSync(stateFile(), JSON.stringify(state, null, 2), "utf8");
}

function appendRunLog(jobId, entry) {
  const file = join(runsDir(), `${jobId}.jsonl`);
  appendFileSync(file, JSON.stringify(entry) + "\n", "utf8");
}

// ── Public API ────────────────────────────────────────────────────────────────

export function listJobs() {
  const { jobs } = readSchedules();
  const state = readState();
  return jobs.map(j => ({ ...j, state: state[j.id] || {} }));
}

export function createJob({ description, cronExpr, prompt, outputs, timezone, notePath, sourceChannel, sourcePeer }) {
  if (!cron.validate(cronExpr)) throw new Error(`无效的 cron 表达式: ${cronExpr}`);

  const data = readSchedules();
  const job = {
    id: crypto.randomUUID(),
    description,
    cronExpr,
    prompt,
    outputs: outputs || [],
    timezone: timezone || "Asia/Shanghai",
    notePath: notePath || null,
    sourceChannel: sourceChannel || null,
    sourcePeer: sourcePeer || null,
    enabled: true,
    createdAt: new Date().toISOString(),
  };
  writeSchedules({ ...data, jobs: [...data.jobs, job] });
  _registerTask(job);
  console.log(`[Scheduler] Created job "${job.description}" (${job.cronExpr}) source=${sourceChannel || "none"} peer=${sourcePeer ? String(sourcePeer).slice(0, 12) : "none"}...`);
  return job;
}

export function createOnceJob({ description, runAtMs, prompt, outputs, notePath, sourceChannel, sourcePeer }) {
  runAtMs = _validateRunAtMs(runAtMs);
  const delayMs = runAtMs - Date.now();
  if (delayMs < 0) throw new Error("runAtMs 必须是未来的时间");

  const data = readSchedules();
  const job = {
    id: crypto.randomUUID(),
    description,
    runAtMs,
    cronExpr: null,
    prompt,
    outputs: outputs || [],
    timezone: "Asia/Shanghai",
    notePath: notePath || null,
    sourceChannel: sourceChannel || null,
    sourcePeer: sourcePeer || null,
    enabled: true,
    once: true,
    createdAt: new Date().toISOString(),
  };
  writeSchedules({ ...data, jobs: [...data.jobs, job] });
  _registerTask(job);

  console.log(`[Scheduler] Created one-shot job "${job.description}" in ${Math.round(delayMs / 1000)}s source=${sourceChannel || "none"} peer=${sourcePeer ? String(sourcePeer).slice(0, 12) : "none"}...`);
  return job;
}

export function deleteJob(id) {
  const data = readSchedules();
  const job = data.jobs.find(j => j.id === id);
  if (!job) return false;
  _cancelTask(id);
  writeSchedules({ ...data, jobs: data.jobs.filter(j => j.id !== id) });
  console.log(`[Scheduler] Deleted job "${job.description}"`);
  return true;
}

export function toggleJob(id, enabled) {
  const data = readSchedules();
  const idx = data.jobs.findIndex(j => j.id === id);
  if (idx < 0) return false;
  if (enabled && data.jobs[idx].once) {
    data.jobs[idx].runAtMs = _validateRunAtMs(data.jobs[idx].runAtMs);
  }
  data.jobs[idx].enabled = enabled;
  writeSchedules(data);
  if (enabled) _registerTask(data.jobs[idx]); else _cancelTask(id);
  return true;
}

// ── Internal ──────────────────────────────────────────────────────────────────

function _loadAndResume() {
  const { jobs } = readSchedules();
  let count = 0;
  for (const job of jobs) {
    if (!job.enabled) continue;
    _registerTask(job);
    count++;
  }
  console.log(`[Scheduler] Resumed ${count} job(s)`);
}

function _cancelTask(id) {
  const task = activeTasks.get(id);
  if (task) { task.destroy(); activeTasks.delete(id); }
}

function _registerTask(job) {
  _cancelTask(job.id);
  if (job.once) {
    _registerOnceTask(job);
    return;
  }
  try {
    const task = cron.schedule(job.cronExpr, () => {
      _executeJob(job).catch(err =>
        console.error(`[Scheduler] Unhandled error in job "${job.description}":`, err)
      );
    }, { timezone: job.timezone || "Asia/Shanghai" });
    activeTasks.set(job.id, task);
  } catch (err) {
    console.error(`[Scheduler] Failed to register job "${job.description}":`, err.message);
  }
}

function _registerOnceTask(job) {
  const runAtMs = Number(job.runAtMs);
  if (!Number.isFinite(runAtMs)) {
    console.error(`[Scheduler] Failed to register one-shot job "${job.description}": invalid runAtMs`);
    return;
  }

  let timer = null;
  let cancelled = false;

  const scheduleNext = () => {
    if (cancelled) return;

    const remainingMs = runAtMs - Date.now();
    if (remainingMs > 0) {
      timer = setTimeout(scheduleNext, Math.min(remainingMs, MAX_TIMER_DELAY_MS));
      return;
    }

    activeTasks.delete(job.id);
    console.log(`[Scheduler] Running one-shot job "${job.description}"`);
    (async () => {
      try {
        await _executeJob(job);
      } finally {
        _removeJob(job.id);
        console.log(`[Scheduler] One-shot job "${job.description}" completed and removed`);
      }
    })().catch(err => {
      console.error(`[Scheduler] Unhandled error in one-shot job "${job.description}":`, err);
    });
  };

  activeTasks.set(job.id, {
    destroy() {
      cancelled = true;
      if (timer) clearTimeout(timer);
    },
  });
  scheduleNext();
}

function _removeJob(id) {
  const d = readSchedules();
  writeSchedules({ ...d, jobs: d.jobs.filter(j => j.id !== id) });
}

function _validateRunAtMs(runAtMs) {
  const ts = Number(runAtMs);
  if (!Number.isFinite(ts)) throw new Error("runAtMs 必须是有效的毫秒时间戳");
  return ts;
}

async function _executeJob(job) {
  const startMs = Date.now();
  console.log(`[Scheduler] Running job "${job.description}" (${job.id})`);

  const state = readState();
  state[job.id] = { ...(state[job.id] || {}), lastRunAtMs: startMs, lastStatus: "running" };
  writeState(state);

  let finalResult = "";
  let status = "ok";
  let errorMsg = "";

  try {
    finalResult = await _runAgent(job);

    if (job.outputs?.includes("chat_history") && finalResult) {
      _injectChatHistory(job, finalResult);
    }

    // Deliver to source channel (default) + any explicitly overridden channels
    await _deliverResult(job, finalResult);

  } catch (err) {
    status = "error";
    errorMsg = err.message;
    const isDeliveryError = err.message.startsWith("结果投递失败");
    console.error(`[Scheduler] Job "${job.description}" ${isDeliveryError ? "delivery" : "execution"} error:`, err.message);
    if (!isDeliveryError) {
      await _deliverResult(job, `⚠️ 定时任务「${job.description}」执行失败：${err.message}`).catch(() => {});
    }
  }

  const durationMs = Date.now() - startMs;
  const newState = readState();
  newState[job.id] = {
    lastRunAtMs: startMs,
    lastStatus: status,
    lastError: errorMsg || undefined,
    lastDurationMs: durationMs,
    consecutiveErrors: status === "error" ? ((newState[job.id]?.consecutiveErrors || 0) + 1) : 0,
  };
  writeState(newState);

  appendRunLog(job.id, { ts: startMs, jobId: job.id, status, error: errorMsg || undefined, durationMs });
  console.log(`[Scheduler] Job "${job.description}" done — ${status} (${durationMs}ms)`);
}

// Resolve which channels to deliver to, then send
async function _deliverResult(job, text) {
  if (!text) return;

  // Build delivery targets: start with sourceChannel, then any overrides in outputs
  const targets = [];

  if (job.sourceChannel && job.sourcePeer && job.sourceChannel !== "web") {
    targets.push({ channel: job.sourceChannel, peer: job.sourcePeer });
  }

  // outputs can contain explicit overrides like { channel: "feishu", peer: "xxx" }
  // (for future use when user says "结果发到飞书")
  for (const out of (job.outputs || [])) {
    if (typeof out === "object" && out.channel && out.peer) {
      const alreadyIncluded = targets.some(t => t.channel === out.channel && t.peer === out.peer);
      if (!alreadyIncluded) targets.push(out);
    }
  }

  const msg = `📅 ${job.description}\n\n${text}`;
  const failures = [];
  for (const { channel, peer } of targets) {
    const adapter = channelAdapters[channel];
    if (!adapter) {
      const message = `No adapter for channel "${channel}"`;
      console.warn(`[Scheduler] ${message}, skipping`);
      failures.push(message);
      continue;
    }
    try {
      await adapter.send(peer, msg);
      console.log(`[Scheduler] Delivered to ${channel}:${String(peer).slice(0, 12)}...`);
    } catch (err) {
      const message = `Delivery to ${channel}:${String(peer).slice(0, 12)} failed: ${err.message}`;
      console.error(`[Scheduler] ${message}`);
      failures.push(message);
    }
  }

  if (failures.length > 0) {
    throw new Error(`结果投递失败：${failures.join("; ")}`);
  }
}

async function _runAgent(job) {
  let fullPrompt = job.prompt;

  if (job.outputs?.includes("new_note")) {
    const date = new Date().toISOString().slice(0, 10);
    const noteDir = join(ctx.VAULT_PATH, "定时任务结果");
    const notePath = join(noteDir, `${date}-${job.id.slice(0, 8)}.md`);
    fullPrompt += `\n\n请将任务结果保存为 Markdown 笔记，路径：${notePath}（目录不存在时自动创建）。`;
  }

  if (job.outputs?.includes("append_note") && job.notePath) {
    fullPrompt += `\n\n请将任务结果以追加方式写入笔记：${job.notePath}，在文件末尾添加分隔线和日期标题后写入内容。`;
  }

  const cwd = ctx.resolveAllowedCwd("");
  const profileData = ctx.readProfiles();
  const candidates = buildModelCandidates(profileData);
  const ac = new AbortController();
  const timeout = setTimeout(() => ac.abort(), 5 * 60 * 1000);
  try {
    return await runWithModelFallback(
      candidates,
      candidate => candidate.provider === "codex"
        ? _runCodexCandidate(candidate, fullPrompt, cwd, ac.signal)
        : _runClaudeCandidate(candidate, profileData, fullPrompt, cwd, ac),
      { logPrefix: `Scheduler ${job.id.slice(0, 8)}` },
    );
  } finally {
    clearTimeout(timeout);
  }
}

async function _runClaudeCandidate(candidate, profileData, fullPrompt, cwd, abortController) {
  const candidateProfiles = { ...profileData, activeProfileId: candidate.profileId };
  const agentEnv = ctx.buildAgentEnv(candidateProfiles, "medium", candidate.model);
  agentEnv.PWD = cwd;

  const userMsg = {
    type: "user",
    message: { role: "user", content: [{ type: "text", text: fullPrompt }] },
    parent_tool_use_id: null,
  };

  let finalResult = "";
  for await (const ev of query({
    prompt: (async function* () { yield userMsg; })(),
    options: {
      cwd,
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      includePartialMessages: false,
      env: agentEnv,
      abortController,
      ...(candidate.provider === "claude" ? { model: candidate.model } : {}),
    },
  })) {
    if (ev.type === "assistant") {
      const text = (ev.message?.content || ev.content || [])
        .filter(b => b.type === "text").map(b => b.text).join("");
      if (text) finalResult = text;
    }
    if (ev.type === "result" && ev.subtype === "success" && ev.result) {
      finalResult = ev.result;
    }
  }

  return finalResult;
}

async function _runCodexCandidate(candidate, fullPrompt, cwd, signal) {
  const codex = new Codex();
  const thread = codex.startThread({
    workingDirectory: cwd,
    skipGitRepoCheck: true,
    approvalPolicy: "never",
    sandboxMode: "danger-full-access",
    modelReasoningEffort: "medium",
    model: candidate.model,
    networkAccessEnabled: true,
    webSearchMode: "live",
  });
  const result = await thread.run(fullPrompt, { signal });
  return result.finalResponse || "";
}

function _injectChatHistory(job, result) {
  try {
    const history = ctx.readHistory();
    const entry = {
      id: `cron-${job.id.slice(0, 8)}-${Date.now()}`,
      title: `[定时任务] ${job.description}`,
      messages: [
        { role: "user", content: `[定时任务自动触发] ${job.description}` },
        { role: "assistant", content: result },
      ],
      createdAt: new Date().toISOString(),
    };
    history.unshift(entry);
    if (history.length > 100) history.splice(100);
    ctx.writeHistory(history);
    console.log(`[Scheduler] Injected result into chat history`);
  } catch (err) {
    console.error(`[Scheduler] Failed to inject chat history:`, err.message);
  }
}
