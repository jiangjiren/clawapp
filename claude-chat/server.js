import { createServer } from "node:http";
import { chmodSync, readFileSync, existsSync, writeFileSync, mkdirSync, renameSync, readdirSync, statSync, lstatSync, unlinkSync } from "node:fs";
import { extname } from "node:path";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import crypto from "node:crypto";

const MIME = { ".js": "text/javascript", ".css": "text/css", ".html": "text/html" };
import { WebSocketServer } from "ws";
import { query, tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import Anthropic from "@anthropic-ai/sdk";
import { Codex } from "@openai/codex-sdk";
import * as scheduler from "./scheduler.js";
import { PersistentQueryRuntime, isTaskLifecycleEvent } from "./agent-session.js";
import { z } from "zod";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = Number.parseInt(process.env.PORT || "8082", 10);
const HOST = process.env.HOST || "127.0.0.1";
const DESKTOP_AGENT_TOKEN = process.env.DESKTOP_AGENT_TOKEN || "";
const DEFAULT_CWD = resolve(process.env.VAULT_PATH || process.cwd());
const PERMISSION_MODES = new Set(["plan", "acceptEdits", "auto", "bypassPermissions"]);
const EFFORT_LEVELS = new Set(["low", "medium", "high", "xhigh", "max"]);
const DEFAULT_PERMISSION_MODE = PERMISSION_MODES.has(process.env.CLAUDE_PERMISSION_MODE)
  ? process.env.CLAUDE_PERMISSION_MODE
  : "auto";

// One-shot background channels such as WeChat still use a dead-stream watchdog.
// The desktop WebSocket runtime below intentionally has no silent-time abort and
// remains alive until the user explicitly stops or resets the conversation.
const STREAM_STALL_MS = 30 * 60_000;
const ASK_USER_QUESTION_TOOL = "AskUserQuestion";
const USAGE_LIMIT_QUERY_TIMEOUT_MS = 12_000;

const htmlPath   = join(__dirname, "public/index.html");
const AUTH_PROFILE_FILE = process.env.CLAUDE_CHAT_AUTH_PROFILE_FILE || join(__dirname, "auth-profile.json");
const WEB_SCHEDULER_PEER = `web:${PORT}`;

const SCHEDULER_INTENT_RE = /分钟后|小时后|一会儿|稍后|稍候|等会|定时|每天|每周|每月|每小时|每隔|工作日|提醒|自动|取消任务|删除任务|查看任务|暂停任务|恢复任务/;
const INKFELLOW_SCHEDULER_PROMPT = `【inkfellow 定时任务规则】

当用户提到以下任一场景时，必须使用 scheduler MCP 工具处理，不能只用文字承诺：
- 定时、每天、每周、每月、每小时、工作日、提醒我、自动
- X分钟后、X小时后、一会儿、稍后、等会
- 查看任务、取消任务、删除任务、暂停任务、恢复任务

可用工具：
- create_schedule：创建循环或一次性任务
- list_schedules：查看当前用户的任务
- delete_schedule：删除任务
- toggle_schedule：暂停或恢复任务

创建规则：
- 周期任务使用 kind="cron"，并填写 cronExpr。
- 一次性任务使用 kind="once"，并填写 runAtMs，runAtMs 是 Unix 毫秒时间戳。
- timezone 默认使用 Asia/Shanghai。
- taskPrompt 必须是任务触发时发给 Agent 的完整执行指令，不能只写一句模糊描述。
- 只有工具调用成功后，才能告诉用户“已创建/已删除/已设置”。

禁止：
- 不要使用 Bash、curl 或 /api/cron/jobs。
- 不要让用户手动配置 sourceChannel/sourcePeer。
- 不要编造任务 ID。
- 不要只回复“好的，到时提醒你”。

常用 cron：
- 0 9 * * *：每天 9:00
- 0 9 * * 1-5：工作日 9:00
- 0 21 * * *：每天 21:00
- 0 9 * * 1：每周一 9:00
- 0 0 1 * *：每月 1 日 0:00

交互规则：
- 如果用户说“每天早上提醒我复盘”，应直接创建任务。
- 如果时间不明确，例如“明天提醒我”，需要先问具体时间。
- 如果任务内容不明确，例如“提醒我一下”，需要先问提醒什么。
- 如果用户要取消、暂停或恢复任务，先 list_schedules，再根据用户描述匹配任务并调用对应工具。`;

const WECHAT_OUTPUT_PROMPT = `【微信通道输出规则】

你正在通过微信 bot 和用户对话，用户只能看到你发到微信里的内容。

当用户要求你生成、编辑、制作、发送图片，或要求把文件/图片“发给我/发到微信”时：
- 如果你生成了本地图片，最终回复必须单独包含一行 Markdown 图片引用，格式严格为：![图片](/absolute/path/to/image.png)
- 图片路径必须是真实存在的本地文件路径，支持 .png/.jpg/.jpeg/.webp/.gif。
- 系统会自动读取这个 Markdown 图片引用，把本地图片上传并发送到微信。
- 不要只描述图片效果，也不要只说“已经发了”；没有写出 Markdown 图片引用就等于没有发到微信。
- 如果你已经知道图片文件路径，直接在最终回复中引用它，不要让用户再问一次。

当用户引用之前发过的图片时，优先查看对话历史里的附件本地路径。`;

// per-PORT 运行时文件统一放在 data/ 子目录，一条 gitignore 收口，备份运维清晰。
// activeProfileId 完全由前端 localStorage 管理（与 model/effort/permission 同一机制），
// 服务端只接受客户端请求里的 profileId 参数，不再持久化「当前选哪个厂商」。
const DATA_DIR = process.env.CLAUDE_CHAT_DATA_DIR || join(__dirname, "data");
mkdirSync(DATA_DIR, { recursive: true });

// 启动时自动迁移旧位置的 per-PORT 文件
for (const name of [`session-${PORT}.json`, `history-${PORT}.json`, "history.json",
                     `wechat-bot-${PORT}.json`, `wechat-bot-${PORT}.sync.json`,
                     `wechat-history-${PORT}.json`, `active-profile-${PORT}.json`]) {
  const oldPath = join(__dirname, name);
  const newPath = join(DATA_DIR, name);
  if (existsSync(oldPath) && !existsSync(newPath)) {
    try { renameSync(oldPath, newPath); } catch { }
  }
}

const SESSION_FILE      = join(DATA_DIR, `session-${PORT}.json`);
const WECHAT_CONFIG_FILE = join(DATA_DIR, `wechat-bot-${PORT}.json`);
const WECHAT_SYNC_FILE   = join(DATA_DIR, `wechat-bot-${PORT}.sync.json`);
const FIXED_BASE_URL = "https://ilinkai.weixin.qq.com";
const WECHAT_CDN_BASE_URL = process.env.WECHAT_CDN_BASE_URL || "https://novac2c.cdn.weixin.qq.com/c2c";
const WECHAT_MEDIA_DIR = join(DATA_DIR, `wechat-media-${PORT}`);
const WECHAT_MAX_INLINE_IMAGE_BYTES = Number.parseInt(process.env.WECHAT_MAX_INLINE_IMAGE_BYTES || String(5 * 1024 * 1024), 10);
const WECHAT_MAX_MEDIA_BYTES = Number.parseInt(process.env.WECHAT_MAX_MEDIA_BYTES || String(25 * 1024 * 1024), 10);
mkdirSync(WECHAT_MEDIA_DIR, { recursive: true });

const WECHAT_MESSAGE_ITEM_TYPE = {
  TEXT: 1,
  IMAGE: 2,
  VOICE: 3,
  FILE: 4,
  VIDEO: 5,
};

const WECHAT_UPLOAD_MEDIA_TYPE = {
  IMAGE: 1,
  VIDEO: 2,
  FILE: 3,
  VOICE: 4,
};

const WECHAT_IMAGE_MIME_BY_EXT = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

const WECHAT_MIME_BY_EXT = {
  ...WECHAT_IMAGE_MIME_BY_EXT,
  ".bmp": "image/bmp",
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
  ".mkv": "video/x-matroska",
  ".avi": "video/x-msvideo",
  ".mp3": "audio/mpeg",
  ".ogg": "audio/ogg",
  ".wav": "audio/wav",
  ".pdf": "application/pdf",
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".csv": "text/csv",
  ".zip": "application/zip",
};

const CODEX_DEFAULT_MODELS = {
  opusModel: "gpt-5.6-sol",
  sonnetModel: "gpt-5.6-terra",
  haikuModel: "gpt-5.6-luna",
};

const PROVIDER_PRESETS = {
  anthropic:  { baseUrl: "",                                    opusModel: "claude-opus-5",                   sonnetModel: "claude-sonnet-5",                  haikuModel: "claude-haiku-4-5-20251001" },
  deepseek:   { baseUrl: "https://api.deepseek.com/anthropic", opusModel: "deepseek-v4-pro[1m]",            sonnetModel: "deepseek-v4-pro[1m]",             haikuModel: "deepseek-v4-flash" },
  openrouter: { baseUrl: "https://openrouter.ai/api",          opusModel: "~anthropic/claude-opus-latest",   sonnetModel: "~anthropic/claude-sonnet-latest",  haikuModel: "~anthropic/claude-haiku-latest" },
  codex:      { baseUrl: "",                                    ...CODEX_DEFAULT_MODELS },
};
const PROVIDER_GOOD_AT = {
  claude: "综合能力强，写代码和长文本理解均衡",
  anthropic: "综合能力强，写代码和长文本理解均衡",
  deepseek: "长链条推理、算法与数学、疑难 bug 根因分析",
  openrouter: "按所配置模型处理通用推理、写作与代码任务",
  codex: "大范围重构、需要反复跑测试收敛的任务、复杂多文件实现",
  custom: "按所配置模型处理专项任务",
};
const CLAUDE_COMPAT_ENV_KEYS = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_MODEL",
  "ANTHROPIC_DEFAULT_OPUS_MODEL",
  "ANTHROPIC_DEFAULT_SONNET_MODEL",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL",
  "CLAUDE_CODE_SUBAGENT_MODEL",
  "CLAUDE_CODE_EFFORT_LEVEL",
  // 剥离从父进程继承来的陈旧 PWD：本服务可能从 clawapp/claude-chat 目录启动，
  // 若把该 PWD 透传给 agent，Claude 会误报工作目录（实际 cwd 已由 SDK 设为 vault）。
  "PWD",
  "OLDPWD",
];

// ── Session persistence ───────────────────────────────────
let sessionId = null;
try {
  if (existsSync(SESSION_FILE)) {
    sessionId = JSON.parse(readFileSync(SESSION_FILE, "utf8")).sessionId ?? null;
    if (sessionId) console.log(`Restored session: ${sessionId}`);
  }
} catch { }

function saveSession(id) {
  sessionId = id;
  try { writeFileSync(SESSION_FILE, JSON.stringify({ sessionId }), "utf8"); } catch { }
}

function clearSession() {
  sessionId = null;
  try { writeFileSync(SESSION_FILE, JSON.stringify({ sessionId: null }), "utf8"); } catch { }
}

// ── Codex thread persistence ───────────────────────────────
const CODEX_THREAD_FILE = join(DATA_DIR, `codex-thread-${PORT}.json`);
let codexThreadId = null;
try {
  if (existsSync(CODEX_THREAD_FILE)) {
    codexThreadId = JSON.parse(readFileSync(CODEX_THREAD_FILE, "utf8")).threadId ?? null;
    if (codexThreadId) console.log(`Restored codex thread: ${codexThreadId}`);
  }
} catch { }

function saveCodexThread(id) {
  codexThreadId = id;
  try { writeFileSync(CODEX_THREAD_FILE, JSON.stringify({ threadId: id }), "utf8"); } catch { }
}

function clearCodexThread() {
  codexThreadId = null;
  try { writeFileSync(CODEX_THREAD_FILE, JSON.stringify({ threadId: null }), "utf8"); } catch { }
}

function isCodexAuthAvailable() {
  const authFile = join(homedir(), ".codex", "auth.json");
  if (!existsSync(authFile)) return false;
  try {
    const auth = JSON.parse(readFileSync(authFile, "utf8"));
    return !!(auth.tokens?.access_token || auth.OPENAI_API_KEY);
  } catch { return false; }
}

function codexSandboxMode(permissionMode) {
  if (permissionMode === "plan") return "read-only";
  if (permissionMode === "bypassPermissions") return "danger-full-access";
  return "workspace-write";
}

function codexItemText(item) {
  if (!item) return "";
  if (typeof item.text === "string") return item.text;
  if (typeof item.message === "string") return item.message;
  return "";
}

function codexToolName(item) {
  if (!item) return "tool";
  if (item.type === "command_execution") return "Bash";
  if (item.type === "mcp_tool_call") return item.tool || "mcp";
  if (item.type === "web_search") return "web_search";
  if (item.type === "file_change") return "apply_patch";
  return item.type || "tool";
}

function codexToolInput(item) {
  if (!item) return {};
  if (item.type === "command_execution") return { command: item.command || "" };
  if (item.type === "mcp_tool_call") return item.arguments ?? {};
  if (item.type === "web_search") return { query: item.query || "" };
  if (item.type === "file_change") return { changes: item.changes || [], status: item.status };
  if (item.type === "todo_list") return { items: item.items || [] };
  return item;
}

function codexContentBlock(item) {
  if (!item) return null;
  const raw = item;
  if (item.type === "agent_message") {
    const text = codexItemText(item);
    return text ? { type: "text", text, raw } : null;
  }
  if (item.type === "reasoning") {
    const thinking = codexItemText(item);
    return thinking ? { type: "thinking", thinking, raw } : null;
  }
  if (item.type === "mcp_tool_call") {
    return {
      type: "mcp_tool_result",
      content: item.result?.content ?? item.result ?? item.error ?? null,
      raw,
    };
  }
  if (item.type === "command_execution") {
    return {
      type: "tool_result",
      content: item.aggregated_output || "",
      raw,
    };
  }
  if (item.type === "error") {
    return { type: "codex_error", message: item.message || "Codex item error", raw };
  }
  return { type: `codex_${item.type || "item"}`, raw };
}

function sendCodexItemEvent(send, eventType, item) {
  if (!item) return;
  if (eventType === "item.started") {
    if (item.type === "command_execution" || item.type === "mcp_tool_call" || item.type === "web_search" || item.type === "file_change") {
      send({
        type: item.type === "mcp_tool_call" ? "mcp_tool_use" : "server_tool_use",
        id: item.id ?? "",
        name: codexToolName(item),
        server_name: item.server ?? null,
        input: codexToolInput(item),
        provider: "codex",
        raw: item,
      });
      return;
    }
    if (item.type === "reasoning") {
      const block = codexContentBlock(item);
      if (block) send({ type: "assistant", message: { role: "assistant", content: [block] } });
      return;
    }
  }
  if (eventType === "item.updated") {
    if (item.type === "command_execution" || item.type === "mcp_tool_call" || item.type === "todo_list") {
      send({ type: "tool_progress", provider: "codex", itemType: item.type, raw: item });
    }
    return;
  }
  if (eventType === "item.completed") {
    const block = codexContentBlock(item);
    if (block) send({ type: "assistant", message: { role: "assistant", content: [block] } });
  }
}

// Locate the Claude Code session JSONL for a given session id. The file lives under
// ~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl; we glob across project dirs
// rather than re-deriving the cwd encoding, so we stay robust to path-encoding quirks.
function findSessionFile(id) {
  if (!id) return null;
  const base = join(homedir(), ".claude", "projects");
  try {
    for (const dir of readdirSync(base)) {
      const p = join(base, dir, `${id}.jsonl`);
      if (existsSync(p)) return p;
    }
  } catch { }
  return null;
}

// Extract plain-text conversation history from a (possibly corrupted) session file.
// We keep only user/assistant *text* blocks and drop thinking / tool_use / tool_result
// — the same approach the WeChat path uses to sidestep the thinking-signature problem.
// Returns the most-recent turns within a char budget so we preserve as much recent
// context as fits without blowing the context window.
function extractSessionTextHistory(id, charBudget = 16000) {
  const file = findSessionFile(id);
  if (!file) return [];
  let lines;
  try { lines = readFileSync(file, "utf8").split("\n"); } catch { return []; }
  const turns = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    let o; try { o = JSON.parse(line); } catch { continue; }
    if (o.type !== "user" && o.type !== "assistant") continue;
    const m = o.message;
    if (!m || (m.role !== "user" && m.role !== "assistant")) continue;
    let text = "";
    if (typeof m.content === "string") text = m.content;
    else if (Array.isArray(m.content)) {
      text = m.content.filter(b => b && b.type === "text").map(b => b.text).join("");
    }
    text = text.trim();
    if (text) turns.push({ role: m.role, text });
  }
  // Walk backwards keeping the most recent turns until we hit the budget.
  const kept = [];
  let used = 0;
  for (let i = turns.length - 1; i >= 0; i--) {
    used += turns[i].text.length;
    if (used > charBudget && kept.length > 0) break;
    kept.unshift(turns[i]);
  }
  return kept;
}

// ── Profiles (账号配置) ────────────────────────────────────
function genProfileId() {
  return `p_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

function normalizeProfile(raw) {
  const p = raw && typeof raw === "object" ? raw : {};
  const provider = typeof p.provider === "string" && p.provider.trim() ? p.provider.trim() : "claude";
  const preset = PROVIDER_PRESETS[provider] ?? {};
  // Legacy field migration: old model/fastModel → new three-tier fields
  const legacyModel     = typeof p.model     === "string" ? p.model.trim()     : "";
  const legacyFastModel = typeof p.fastModel === "string" ? p.fastModel.trim() : "";
  const str = (v) => typeof v === "string" && v.trim() ? v.trim() : "";
  return {
    id:          str(p.id)   || genProfileId(),
    name:        str(p.name) || provider,
    provider,
    apiKey:      typeof p.apiKey === "string" ? p.apiKey.trim() : "",
    opusModel:   str(p.opusModel)   || legacyModel          || preset.opusModel   || "",
    sonnetModel: str(p.sonnetModel) || legacyModel          || preset.sonnetModel || "",
    haikuModel:  str(p.haikuModel)  || legacyFastModel || legacyModel || preset.haikuModel  || "",
    baseUrl:     str(p.baseUrl)     || preset.baseUrl || "",
    goodAt:      str(p.goodAt)      || PROVIDER_GOOD_AT[provider] || PROVIDER_GOOD_AT.custom,
  };
}

/** 从旧格式迁移到新 profiles 格式 */
function migrateOldFormat(old) {
  const profiles = [];
  // Claude 始终存在
  profiles.push({ id: "p_claude", name: "Claude 会员", provider: "claude", apiKey: "", opusModel: "", sonnetModel: "", haikuModel: "", baseUrl: "", goodAt: PROVIDER_GOOD_AT.claude });

  // 迁移 DeepSeek keys
  const dsKeys = Array.isArray(old.deepseek?.keys) ? old.deepseek.keys : [];
  if (old.deepseek?.apiKey && !dsKeys.some(k => k.apiKey === old.deepseek.apiKey)) {
    dsKeys.unshift({ id: "deepseek-default", name: "默认", apiKey: old.deepseek.apiKey });
  }
  for (const key of dsKeys) {
    if (key.apiKey) {
      const legacyModel     = old.deepseek?.model     || PROVIDER_PRESETS.deepseek.sonnetModel;
      const legacyFastModel = old.deepseek?.flashModel || old.deepseek?.fastModel || PROVIDER_PRESETS.deepseek.haikuModel;
      profiles.push({
        id: key.id || genProfileId(),
        name: key.name || "DeepSeek",
        provider: "deepseek",
        apiKey: key.apiKey,
        opusModel:   legacyModel,
        sonnetModel: legacyModel,
        haikuModel:  legacyFastModel,
        baseUrl: PROVIDER_PRESETS.deepseek.baseUrl,
        goodAt: PROVIDER_GOOD_AT.deepseek,
      });
    }
  }

  // 迁移 OpenRouter key
  if (old.openrouter?.apiKey) {
    profiles.push({
      id: genProfileId(),
      name: "OpenRouter",
      provider: "openrouter",
      apiKey: old.openrouter.apiKey,
      opusModel:   old.openrouter.opusModel   || PROVIDER_PRESETS.openrouter.opusModel,
      sonnetModel: old.openrouter.sonnetModel || PROVIDER_PRESETS.openrouter.sonnetModel,
      haikuModel:  old.openrouter.haikuModel  || PROVIDER_PRESETS.openrouter.haikuModel,
      baseUrl: PROVIDER_PRESETS.openrouter.baseUrl,
      goodAt: PROVIDER_GOOD_AT.openrouter,
    });
  }

  if (isCodexAuthAvailable()) {
    profiles.push({ id: "p_codex", name: "Codex（GPT 会员）", provider: "codex", apiKey: "", baseUrl: "", goodAt: PROVIDER_GOOD_AT.codex, ...CODEX_DEFAULT_MODELS });
  }
  let activeProfileId = "p_claude";
  if (old.provider === "deepseek") {
    const match = profiles.find(p => p.provider === "deepseek" &&
      (old.deepseek?.selectedKeyId ? p.id === old.deepseek.selectedKeyId : true));
    if (match) activeProfileId = match.id;
  } else if (old.provider === "openrouter") {
    const match = profiles.find(p => p.provider === "openrouter");
    if (match) activeProfileId = match.id;
  }
  return { activeProfileId, profiles };
}

function normalizeProfiles(raw) {
  const data = raw && typeof raw === "object" ? raw : {};
  // 旧格式没有 profiles 数组 → 迁移
  if (!Array.isArray(data.profiles)) return migrateOldFormat(data);

  const profiles = data.profiles.map(normalizeProfile).filter(p =>
    p.provider === "claude" || p.provider === "codex" || p.apiKey
  );
  if (!profiles.some(p => p.provider === "claude")) {
    profiles.unshift({ id: "p_claude", name: "Claude 会员", provider: "claude", apiKey: "", opusModel: "", sonnetModel: "", haikuModel: "", baseUrl: "", goodAt: PROVIDER_GOOD_AT.claude });
  }
  // 注入或同步 Codex 会员 profile（强制覆盖模型字段，防止旧数据残留）
  const existingCodex = profiles.find(p => p.provider === "codex");
  if (isCodexAuthAvailable()) {
    if (existingCodex) {
      Object.assign(existingCodex, CODEX_DEFAULT_MODELS);
    } else {
      profiles.push({ id: "p_codex", name: "Codex（GPT 会员）", provider: "codex", apiKey: "", baseUrl: "", goodAt: PROVIDER_GOOD_AT.codex, ...CODEX_DEFAULT_MODELS });
    }
  }
  const activeProfileId = typeof data.activeProfileId === "string" && profiles.some(p => p.id === data.activeProfileId)
    ? data.activeProfileId
    : profiles[0].id;
  return { activeProfileId, profiles };
}

function readProfiles() {
  try {
    if (existsSync(AUTH_PROFILE_FILE)) {
      return normalizeProfiles(JSON.parse(readFileSync(AUTH_PROFILE_FILE, "utf8")));
    }
  } catch { }
  return normalizeProfiles(null);
}

function writeProfiles(data) {
  writeFileSync(AUTH_PROFILE_FILE, JSON.stringify(data, null, 2), "utf8");
  try { chmodSync(AUTH_PROFILE_FILE, 0o600); } catch { }
}

function maskSecret(secret) {
  if (!secret) return "";
  if (secret.length <= 10) return "已保存";
  return `${secret.slice(0, 5)}…${secret.slice(-4)}`;
}

function toPublicProfiles(data = readProfiles()) {
  return {
    activeProfileId: data.activeProfileId,
    profiles: data.profiles.map(p => ({
      id:           p.id,
      name:         p.name,
      provider:     p.provider,
      maskedApiKey: maskSecret(p.apiKey),
      opusModel:   p.opusModel,
      sonnetModel: p.sonnetModel,
      haikuModel:  p.haikuModel,
      goodAt:      p.goodAt,
      // 仅 custom provider 暴露 baseUrl（内置厂商不需要显示）
      ...(p.provider === "custom" ? { baseUrl: p.baseUrl } : {}),
    })),
  };
}

function getActiveProfile(data = readProfiles()) {
  return data.profiles.find(p => p.id === data.activeProfileId) ?? data.profiles[0] ?? null;
}

// overrideProfile：跨厂商派发时传入目标 profile，为它单独构造一套 env，
// 不受 activeProfileId 影响（见 _buildDispatchMcpServer）。不传则沿用当前激活的。
export function buildAgentEnv(profileData, effort, requestedModel, overrideProfile = null) {
  const env = { ...process.env };
  for (const key of CLAUDE_COMPAT_ENV_KEYS) delete env[key];

  // 持久 Query 的前台轮靠 system/session_state_changed state=idle 结束（见
  // handlePersistentClaudeEvent）。该事件自 SDK 0.2.83 起改为 opt-in，不开启就
  // 永远不发，回合无法结束、后续消息会一直排队。必须在下面按 provider 提前
  // return 之前设置，否则对 Claude 会员账号不生效。
  env.CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS = "1";

  const active = overrideProfile || getActiveProfile(profileData);
  if (!active || active.provider === "claude") return env;
  if (!active.apiKey) return env;
  // anthropic provider uses the default Anthropic base URL — no baseUrl required
  if (!active.baseUrl && active.provider !== "anthropic") return env;

  const opusM   = active.opusModel   || "";
  const sonnetM = active.sonnetModel || opusM;
  const haikuM  = active.haikuModel  || sonnetM;
  // requestedModel = 用户在顶部下拉手动选择的模型，作为当前对话的主模型
  const conversationModel = requestedModel || sonnetM || opusM;

  if (active.provider === "anthropic") {
    // Direct Anthropic API key — standard ANTHROPIC_API_KEY, no base URL override
    env.ANTHROPIC_API_KEY = active.apiKey;
  } else {
    // Third-party providers (DeepSeek / OpenRouter / custom) use bearer token + custom base URL
    env.ANTHROPIC_API_KEY    = "";
    env.ANTHROPIC_BASE_URL   = active.baseUrl;
    env.ANTHROPIC_AUTH_TOKEN = active.apiKey;
  }

  env.ANTHROPIC_MODEL                = conversationModel;
  env.ANTHROPIC_DEFAULT_OPUS_MODEL   = opusM   || conversationModel;
  env.ANTHROPIC_DEFAULT_SONNET_MODEL = sonnetM || conversationModel;
  env.ANTHROPIC_DEFAULT_HAIKU_MODEL  = haikuM  || conversationModel;  // ← haiku 用快速模型
  env.CLAUDE_CODE_SUBAGENT_MODEL     = haikuM  || conversationModel;  // ← subagent 用快速模型
  // DeepSeek 成本低，默认给满；其余保守用 medium
  env.CLAUDE_CODE_EFFORT_LEVEL = (active.provider === "deepseek") ? (effort || "max") : (effort || "medium");
  if (active.provider === "openrouter") env.CLAUDE_CODE_SKIP_FAST_MODE_ORG_CHECK = "1";

  return env;
}

// ── Server-side history ────────────────────────────────────
function clampPercent(value) {
  if (!Number.isFinite(value)) return null;
  return Math.max(0, Math.min(100, Math.round(value)));
}

function normalizeUsageResetAt(value) {
  if (value == null || value === "") return null;
  if (typeof value === "number" && Number.isFinite(value)) {
    const millis = value < 10_000_000_000 ? value * 1000 : value;
    return new Date(millis).toISOString();
  }
  const numeric = Number(value);
  if (Number.isFinite(numeric) && String(value).trim() !== "") {
    const millis = numeric < 10_000_000_000 ? numeric * 1000 : numeric;
    return new Date(millis).toISOString();
  }
  return value;
}

function normalizeUsageWindow(raw) {
  if (!raw || typeof raw !== "object") return null;
  const utilizationRaw = raw.utilization ?? raw.percent ?? raw.used_percent;
  const utilizationNum = typeof utilizationRaw === "number" ? utilizationRaw : Number(utilizationRaw);
  const usedPercent = clampPercent(utilizationNum <= 1 ? utilizationNum * 100 : utilizationNum);
  const windowSecondsRaw = raw.limit_window_seconds ?? raw.window_seconds ?? raw.windowSeconds;
  const windowSecondsNum = typeof windowSecondsRaw === "number" ? windowSecondsRaw : Number(windowSecondsRaw);
  return {
    usedPercent,
    remainingPercent: usedPercent == null ? null : clampPercent(100 - usedPercent),
    resetAt: normalizeUsageResetAt(raw.resets_at ?? raw.resetsAt ?? raw.reset_at ?? null),
    windowSeconds: Number.isFinite(windowSecondsNum) && windowSecondsNum > 0
      ? Math.round(windowSecondsNum)
      : null,
  };
}

function normalizeCodexUsageWindows(rateLimit) {
  const primary = normalizeUsageWindow(rateLimit?.primary_window);
  const secondary = normalizeUsageWindow(rateLimit?.secondary_window);
  const windows = [primary, secondary].filter(Boolean);
  const hasDurationMetadata = windows.some(win => win.windowSeconds != null);

  // Older responses did not expose window length. Keep the original positional
  // mapping in that case, but prefer semantic duration whenever it is available.
  if (!hasDurationMetadata) return { fiveHour: primary, week: secondary };

  const fiveHour = windows.find(win => win.windowSeconds != null && win.windowSeconds <= 8 * 60 * 60)
    ?? (primary?.windowSeconds == null ? primary : null);
  const week = windows.find(win => (
    win.windowSeconds != null
    && win.windowSeconds >= 5 * 24 * 60 * 60
    && win.windowSeconds <= 9 * 24 * 60 * 60
  )) ?? (secondary?.windowSeconds == null ? secondary : null);

  return { fiveHour, week };
}

async function getClaudeSubscriptionLimits() {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), USAGE_LIMIT_QUERY_TIMEOUT_MS);
  let usageQuery = null;
  try {
    async function* emptyPrompt() {}
    usageQuery = query({
      prompt: emptyPrompt(),
      options: {
        cwd: DEFAULT_CWD,
        abortController: controller,
        env: buildAgentEnv({ activeProfileId: "p_claude", profiles: [{ id: "p_claude", provider: "claude" }] }),
      },
    });
    const usage = await usageQuery.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET();
    const rateLimits = usage?.rate_limits ?? null;
    return {
      provider: "claude",
      status: usage?.rate_limits_available && rateLimits ? "ok" : "unavailable",
      authenticated: true,
      available: usage?.rate_limits_available === true && !!rateLimits,
      subscriptionType: usage?.subscription_type ?? null,
      fiveHour: normalizeUsageWindow(rateLimits?.five_hour),
      week: normalizeUsageWindow(rateLimits?.seven_day),
      updatedAt: new Date().toISOString(),
    };
  } catch (err) {
    return {
      provider: "claude",
      status: controller.signal.aborted ? "timeout" : "error",
      authenticated: false,
      available: false,
      message: controller.signal.aborted ? "Claude usage query timed out" : String(err?.message || err),
      updatedAt: new Date().toISOString(),
    };
  } finally {
    clearTimeout(timeout);
    try { usageQuery?.close?.(); } catch { }
    try { controller.abort(); } catch { }
  }
}

function readCodexSubscriptionAuth() {
  const authFile = join(homedir(), ".codex", "auth.json");
  if (!existsSync(authFile)) {
    return { ok: false, status: "unauthenticated", message: "Codex is not logged in" };
  }
  try {
    const auth = JSON.parse(readFileSync(authFile, "utf8"));
    if (auth.auth_mode && auth.auth_mode !== "chatgpt") {
      return { ok: false, status: "unavailable", message: "Codex is not using ChatGPT OAuth auth" };
    }
    const accessToken = auth.tokens?.access_token;
    if (!accessToken) {
      return { ok: false, status: "unauthenticated", message: "Codex OAuth access_token is missing" };
    }
    return { ok: true, accessToken, accountId: auth.tokens?.account_id ?? null };
  } catch (err) {
    return { ok: false, status: "error", message: `Failed to parse Codex auth.json: ${String(err?.message || err)}` };
  }
}

async function queryCodexSubscriptionLimits() {
  const auth = readCodexSubscriptionAuth();
  if (!auth.ok) {
    return {
      provider: "codex",
      status: auth.status,
      authenticated: false,
      available: false,
      message: auth.message,
      updatedAt: new Date().toISOString(),
    };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), USAGE_LIMIT_QUERY_TIMEOUT_MS);
  try {
    const headers = {
      Authorization: `Bearer ${auth.accessToken}`,
      "User-Agent": "codex-cli",
      Accept: "application/json",
    };
    if (auth.accountId) headers["ChatGPT-Account-Id"] = auth.accountId;

    const resp = await fetch("https://chatgpt.com/backend-api/wham/usage", {
      headers,
      signal: controller.signal,
    });

    if (resp.status === 401 || resp.status === 403) {
      return {
        provider: "codex",
        status: "expired",
        authenticated: true,
        available: false,
        message: `Codex OAuth expired or unauthorized (HTTP ${resp.status})`,
        updatedAt: new Date().toISOString(),
      };
    }
    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      return {
        provider: "codex",
        status: "error",
        authenticated: true,
        available: false,
        message: `Codex usage query failed (HTTP ${resp.status}): ${text.slice(0, 300)}`,
        updatedAt: new Date().toISOString(),
      };
    }

    const body = await resp.json();
    const rateLimit = body?.rate_limit ?? null;
    const windows = normalizeCodexUsageWindows(rateLimit);
    return {
      provider: "codex",
      status: rateLimit ? "ok" : "unavailable",
      authenticated: true,
      available: !!rateLimit,
      planType: body?.plan_type ?? null,
      fiveHour: windows.fiveHour,
      week: windows.week,
      updatedAt: new Date().toISOString(),
    };
  } catch (err) {
    return {
      provider: "codex",
      status: controller.signal.aborted ? "timeout" : "error",
      authenticated: true,
      available: false,
      message: controller.signal.aborted ? "Codex usage query timed out" : String(err?.message || err),
      updatedAt: new Date().toISOString(),
    };
  } finally {
    clearTimeout(timeout);
  }
}

const CUSTOM_HISTORY_FILE = Boolean(process.env.CLAUDE_CHAT_HISTORY_FILE);
const HISTORY_FILE = process.env.CLAUDE_CHAT_HISTORY_FILE || join(DATA_DIR, "history.json");
const LEGACY_HISTORY_FILE_RE = /^history-\d+\.json$/;
const HISTORY_MIGRATION_MARKER = join(DATA_DIR, ".history-port-migration-v2");
const MAX_SERVER_HISTORY = 100;

export function resolveAllowedCwd(requestedCwd) {
  const cwd = typeof requestedCwd === "string" && requestedCwd.trim()
    ? resolve(requestedCwd)
    : DEFAULT_CWD;
  const rel = relative(DEFAULT_CWD, cwd);
  if (rel.startsWith("..") || isAbsolute(rel)) return DEFAULT_CWD;
  return cwd;
}

function resolvePublicFile(urlPath) {
  let decoded;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return null;
  }

  const normalized = decoded.replace(/^\/+/, "");
  const filePath = resolve(__dirname, "public", normalized);
  const publicRoot = resolve(__dirname, "public");
  const rel = relative(publicRoot, filePath);
  if (rel.startsWith("..") || isAbsolute(rel)) return null;
  return filePath;
}

function readHistoryFile(filePath) {
  try {
    if (!existsSync(filePath)) return [];
    const parsed = JSON.parse(readFileSync(filePath, "utf8"));
    return Array.isArray(parsed) ? parsed : [];
  } catch { }
  return [];
}

function historyMessageCount(item) {
  return Array.isArray(item?.messages) ? item.messages.length : 0;
}

function historyTime(item) {
  const value = Date.parse(item?.date ?? "");
  return Number.isFinite(value) ? value : 0;
}

function isHistoryItem(item) {
  return item && typeof item === "object" && typeof item.id === "string" && item.id.trim();
}

function shouldReplaceHistoryItem(current, next) {
  if (!current) return true;
  const currentMessages = historyMessageCount(current);
  const nextMessages = historyMessageCount(next);
  if (nextMessages !== currentMessages) return nextMessages > currentMessages;
  return historyTime(next) >= historyTime(current);
}

function mergeHistoryRecords(...groups) {
  const byId = new Map();
  for (const group of groups) {
    for (const item of group) {
      if (!isHistoryItem(item)) continue;
      const current = byId.get(item.id);
      if (shouldReplaceHistoryItem(current, item)) byId.set(item.id, item);
    }
  }
  return [...byId.values()]
    .sort((a, b) => historyTime(b) - historyTime(a));
}

function writeJsonFile(filePath, value) {
  try {
    const tmp = `${filePath}.tmp`;
    writeFileSync(tmp, JSON.stringify(value), "utf8");
    renameSync(tmp, filePath);
  } catch { }
}

function migrateLegacyHistoryFiles() {
  if (CUSTOM_HISTORY_FILE) return;

  const canonical = readHistoryFile(HISTORY_FILE);
  const legacyGroups = [];
  const sourceFiles = [];

  try {
    for (const name of readdirSync(DATA_DIR).sort()) {
      if (!LEGACY_HISTORY_FILE_RE.test(name)) continue;
      const filePath = join(DATA_DIR, name);
      const records = readHistoryFile(filePath);
      if (records.length === 0) continue;
      legacyGroups.push(records);
      sourceFiles.push(name);
    }
  } catch { }

  if (legacyGroups.length === 0) {
    if (!existsSync(HISTORY_FILE)) writeJsonFile(HISTORY_FILE, []);
    return;
  }

  const merged = mergeHistoryRecords(canonical, ...legacyGroups);
  writeJsonFile(HISTORY_FILE, merged);
  writeJsonFile(HISTORY_MIGRATION_MARKER, {
    migratedAt: new Date().toISOString(),
    sourceFiles,
    conversations: merged.length,
  });
}

migrateLegacyHistoryFiles();

let historyStore = readHistoryFile(HISTORY_FILE);
let historyFlushTimer = null;
let historyDirty = false;

function flushHistoryNow() {
  if (historyFlushTimer) {
    clearTimeout(historyFlushTimer);
    historyFlushTimer = null;
  }
  if (!historyDirty) return;
  historyDirty = false;
  writeJsonFile(HISTORY_FILE, historyStore);
}

function scheduleHistoryFlush(delayMs = 500) {
  historyDirty = true;
  if (historyFlushTimer) return;
  historyFlushTimer = setTimeout(flushHistoryNow, delayMs);
}

function readHistory() {
  return historyStore;
}

function writeHistory(arr, options = {}) {
  historyStore = Array.isArray(arr) ? arr : [];
  historyDirty = true;
  if (options.defer) scheduleHistoryFlush(options.delayMs);
  else flushHistoryNow();
}

process.on("beforeExit", flushHistoryNow);
process.on("SIGINT", () => {
  flushHistoryNow();
  process.exit(130);
});
process.on("SIGTERM", () => {
  flushHistoryNow();
  process.exit(143);
});

function cloneHistoryJson(value) {
  if (value == null) return value;
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return value;
  }
}

function normalizeHistoryId(value) {
  const raw = typeof value === "string" ? value.trim() : "";
  return raw && /^[A-Za-z0-9_-]{4,128}$/.test(raw)
    ? raw
    : `srv_${Date.now().toString(36)}_${crypto.randomBytes(3).toString("hex")}`;
}

/**
 * 和 normalizeHistoryId 的区别：这个在拿不到合法 id 时返回 null，不会凭空造一个。
 * 用在「按 id 查找/清除已有数据」的场合——那里造出来的新 id 谁也匹配不上，
 * 会让清除操作静默地什么都没清掉。
 */
export function historyIdOrNull(value) {
  const raw = typeof value === "string" ? value.trim() : "";
  return raw && /^[A-Za-z0-9_-]{4,128}$/.test(raw) ? raw : null;
}

function makeHistoryMessageId(prefix = "msg") {
  return `${prefix}_${crypto.randomUUID()}`;
}

function titleFromUserText(text) {
  const title = String(text || "").replace(/[\n\r]+/g, " ").trim().slice(0, 60);
  return title || "新对话";
}

function countAssistantBlocks(messages) {
  return (messages || [])
    .filter(m => m?.role === "assistant")
    .reduce((sum, m) => sum + (Array.isArray(m.blocks) ? m.blocks.length : 0), 0);
}

function countTextChars(messages) {
  return (messages || []).reduce((sum, m) => sum + String(m?.text || "").length, 0);
}

function historyMessagesScore(messages) {
  if (!Array.isArray(messages)) {
    return { total: 0, assistants: 0, assistantBlocks: 0, textChars: 0 };
  }
  return {
    total: messages.length,
    assistants: messages.filter(m => m?.role === "assistant").length,
    assistantBlocks: countAssistantBlocks(messages),
    textChars: countTextChars(messages),
  };
}

function shouldAcceptIncomingMessages(currentMessages, incomingMessages) {
  if (!Array.isArray(incomingMessages)) return false;
  if (!Array.isArray(currentMessages) || currentMessages.length === 0) return true;
  const current = historyMessagesScore(currentMessages);
  const incoming = historyMessagesScore(incomingMessages);
  if (incoming.assistants < current.assistants) return false;
  if (incoming.assistants === current.assistants && incoming.total < current.total) return false;
  if (incoming.assistants === current.assistants && incoming.assistantBlocks < current.assistantBlocks) return false;
  return true;
}

function upsertHistoryConversation(conv, options = {}) {
  if (!conv || typeof conv !== "object" || !conv.id) return null;
  const id = normalizeHistoryId(conv.id);
  const history = readHistory();
  const idx = history.findIndex(h => h.id === id);
  const current = idx >= 0 ? history[idx] : null;
  const next = {
    ...(current || {}),
    ...conv,
    id,
    date: conv.date || new Date().toISOString(),
  };

  if (current) {
    if ("messages" in conv) {
      next.messages = shouldAcceptIncomingMessages(current.messages, conv.messages)
        ? conv.messages
        : current.messages;
    } else if (current.messages) {
      next.messages = current.messages;
    }
    history[idx] = next;
  } else {
    if (!Array.isArray(next.messages)) next.messages = [];
    history.unshift(next);
    if (history.length > MAX_SERVER_HISTORY) history.splice(MAX_SERVER_HISTORY);
  }

  writeHistory(history, options);
  return next;
}

function ensureHistoryConversation(id, { userText = "", sessionId: nextSessionId = null } = {}) {
  const convId = normalizeHistoryId(id);
  const history = readHistory();
  let conv = history.find(h => h.id === convId);
  if (!conv) {
    conv = {
      id: convId,
      title: titleFromUserText(userText),
      date: new Date().toISOString(),
      sessionId: nextSessionId,
      messages: [],
    };
    history.unshift(conv);
    if (history.length > MAX_SERVER_HISTORY) history.splice(MAX_SERVER_HISTORY);
  } else {
    conv.date = new Date().toISOString();
    if (nextSessionId) conv.sessionId = nextSessionId;
    if (!Array.isArray(conv.messages)) conv.messages = [];
  }
  return conv;
}

function persistHistoryDeferred() {
  writeHistory(readHistory(), { defer: true });
}

function persistHistoryImmediate() {
  writeHistory(readHistory());
}

function blockText(block) {
  return (block?.type === "text" || block?.type === "refusal") && block.text
    ? String(block.text)
    : "";
}

function textFromHistoryBlocks(blocks) {
  return (blocks || []).map(blockText).filter(Boolean).join("\n\n");
}

function assistantBlockKey(block) {
  const id = block?.id || block?.raw?.id || block?.raw?.call_id || block?.raw?.tool_use_id || block?.raw?.raw?.id;
  return id ? `${block.type || "unknown"}:${id}` : "";
}

function normalizeAssistantHistoryBlocks(content, fallbackText = "") {
  const blocks = [];
  const items = Array.isArray(content) ? content : (content ? [content] : []);
  for (const item of items) {
    if (!item) continue;
    const raw = cloneHistoryJson(item);
    if (item.type === "thinking" && item.thinking) {
      blocks.push({ type: "thinking", thinking: item.thinking, signature: item.signature ?? null, raw });
    } else if (item.type === "redacted_thinking") {
      blocks.push({ type: "redacted_thinking", data: item.data ?? null, raw });
    } else if (item.type === "text" && item.text) {
      blocks.push({ type: "text", text: item.text, citations: item.citations ?? null, raw });
    } else if (item.type === "refusal") {
      blocks.push({ type: "refusal", text: item.refusal ?? "", raw });
    } else if (item.type === "tool_use" || item.type === "server_tool_use" || item.type === "mcp_tool_use") {
      blocks.push({
        type: item.type,
        id: item.id ?? "",
        name: item.name ?? "tool",
        serverName: item.server_name ?? item.serverName ?? null,
        input: item.input ?? {},
        raw,
      });
    } else {
      const type = item.type || "unknown";
      const block = raw && typeof raw === "object" && !Array.isArray(raw)
        ? { ...raw, type, raw }
        : { type, raw };
      blocks.push(block);
    }
  }
  if (!blocks.some(block => block.type === "text") && fallbackText) {
    blocks.push({ type: "text", text: fallbackText });
  }
  return blocks;
}

let activeHistoryConversationId = null;
let activeAssistantHistoryMessage = null;
let activeHistoryTurnOpen = false;
let activeHistoryTurnConversationId = null;
const taskHistoryTargets = new Map();
const taskHistoryTargetTimers = new Map();

function scheduleTaskHistoryTargetCleanup(taskId) {
  clearTimeout(taskHistoryTargetTimers.get(taskId));
  const timer = setTimeout(() => {
    taskHistoryTargetTimers.delete(taskId);
    taskHistoryTargets.delete(taskId);
  }, 5 * 60_000);
  timer.unref?.();
  taskHistoryTargetTimers.set(taskId, timer);
}

function beginServerConversationFromClient(msg) {
  const conversationId = normalizeHistoryId(msg.conversationId);
  const displayText = typeof msg.displayText === "string" && msg.displayText.trim()
    ? msg.displayText.trim()
    : String(msg.prompt || "").trim();
  const userMessageId = normalizeHistoryId(msg.userMessageId || makeHistoryMessageId("user"));
  activeHistoryConversationId = conversationId;
  activeAssistantHistoryMessage = null;
  activeHistoryTurnOpen = true;
  activeHistoryTurnConversationId = conversationId;

  const conv = ensureHistoryConversation(conversationId, { userText: displayText });
  if (!conv.messages.some(m => m.id === userMessageId)) {
    conv.messages.push({
      id: userMessageId,
      role: "user",
      text: displayText,
      cost: null,
      createdAt: new Date().toISOString(),
    });
  }
  conv.date = new Date().toISOString();
  persistHistoryImmediate();
  return conversationId;
}

function clearActiveHistoryConversation() {
  activeHistoryConversationId = null;
  activeAssistantHistoryMessage = null;
  activeHistoryTurnOpen = false;
  activeHistoryTurnConversationId = null;
  for (const timer of taskHistoryTargetTimers.values()) clearTimeout(timer);
  taskHistoryTargetTimers.clear();
  taskHistoryTargets.clear();
}

function ensureActiveAssistantHistoryMessage() {
  if (!activeHistoryConversationId) return null;
  const conv = ensureHistoryConversation(activeHistoryConversationId);
  if (
    activeAssistantHistoryMessage
    && conv.messages.includes(activeAssistantHistoryMessage)
  ) {
    return activeAssistantHistoryMessage;
  }
  const msg = {
    id: makeHistoryMessageId("assistant"),
    role: "assistant",
    text: "",
    blocks: [],
    raw: [],
    events: [],
    cost: null,
    status: "running",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  conv.messages.push(msg);
  conv.date = new Date().toISOString();
  activeAssistantHistoryMessage = msg;
  return msg;
}

function appendAssistantHistoryBlocks(blocks, rawEvent = null, { rawMessage = null } = {}) {
  if (!blocks?.length) return;
  const msg = ensureActiveAssistantHistoryMessage();
  if (!msg) return;
  if (!Array.isArray(msg.blocks)) msg.blocks = [];
  if (!Array.isArray(msg.raw)) msg.raw = [];
  if (!Array.isArray(msg.events)) msg.events = [];

  for (const block of blocks) {
    const key = assistantBlockKey(block);
    if (key) {
      const existingIdx = msg.blocks.findIndex(existing => assistantBlockKey(existing) === key);
      if (existingIdx >= 0) {
        msg.blocks[existingIdx] = block;
        continue;
      }
    }
    msg.blocks.push(block);
  }

  if (rawMessage) msg.raw.push(cloneHistoryJson(rawMessage));
  if (rawEvent) msg.events.push(cloneHistoryJson(rawEvent));
  msg.text = textFromHistoryBlocks(msg.blocks);
  msg.updatedAt = new Date().toISOString();
  const conv = ensureHistoryConversation(activeHistoryConversationId);
  conv.date = msg.updatedAt;
  persistHistoryDeferred();
}

function finalizeActiveAssistantHistory(status = "complete", cost = null) {
  if (activeHistoryTurnConversationId) activeHistoryConversationId = activeHistoryTurnConversationId;
  activeHistoryTurnOpen = false;
  activeHistoryTurnConversationId = null;
  if (!activeAssistantHistoryMessage) return;
  activeAssistantHistoryMessage.status = status;
  activeAssistantHistoryMessage.updatedAt = new Date().toISOString();
  if (cost != null) activeAssistantHistoryMessage.cost = cost;
  activeAssistantHistoryMessage.text = textFromHistoryBlocks(activeAssistantHistoryMessage.blocks);
  const conv = ensureHistoryConversation(activeHistoryConversationId);
  conv.date = activeAssistantHistoryMessage.updatedAt;
  persistHistoryImmediate();
  activeAssistantHistoryMessage = null;
}

function appendTaskLifecycleHistoryEvent(ev) {
  if (!activeHistoryConversationId || !isTaskLifecycleEvent(ev)) return;
  const existingTarget = ev.task_id ? taskHistoryTargets.get(ev.task_id) : null;
  const conversationId = existingTarget?.conversationId ?? activeHistoryConversationId;
  const conv = ensureHistoryConversation(conversationId);
  let target = existingTarget?.message;
  if (!target || !conv.messages.includes(target)) {
    target = activeHistoryTurnOpen && conversationId === activeHistoryConversationId
      ? ensureActiveAssistantHistoryMessage()
      : [...conv.messages].reverse().find(message => message.role === "assistant");
  }
  if (!target) return;
  if (ev.task_id && !existingTarget) {
    taskHistoryTargets.set(ev.task_id, { conversationId, message: target });
  }
  if (!Array.isArray(target.blocks)) target.blocks = [];
  if (!Array.isArray(target.raw)) target.raw = [];
  if (!Array.isArray(target.events)) target.events = [];
  const raw = cloneHistoryJson(ev);
  target.blocks.push({ type: "sdk_event", eventType: ev.subtype, raw });
  target.raw.push(raw);
  target.events.push(raw);
  target.updatedAt = new Date().toISOString();
  target.text = textFromHistoryBlocks(target.blocks);
  conv.date = target.updatedAt;
  persistHistoryDeferred();
  const terminalUpdate = ev.subtype === "task_updated"
    && ["completed", "failed", "killed"].includes(ev.patch?.status);
  if (ev.subtype === "task_notification" && ev.task_id) {
    clearTimeout(taskHistoryTargetTimers.get(ev.task_id));
    taskHistoryTargetTimers.delete(ev.task_id);
    taskHistoryTargets.delete(ev.task_id);
  } else if (terminalUpdate && ev.task_id) {
    scheduleTaskHistoryTargetCleanup(ev.task_id);
  }
}

function updateActiveConversationSession(nextSessionId) {
  if (!activeHistoryConversationId || !nextSessionId) return;
  const conv = ensureHistoryConversation(activeHistoryConversationId, { sessionId: nextSessionId });
  conv.sessionId = nextSessionId;
  conv.date = new Date().toISOString();
  persistHistoryDeferred();
}

function isOutboundToolUse(type) {
  return type === "tool_use" || type === "server_tool_use" || type === "mcp_tool_use";
}

function isOutboundToolResult(type) {
  return type === "tool_result" || type === "mcp_tool_result" || type?.includes("tool_result");
}

function persistOutboundAgentEvent(ev) {
  if (!activeHistoryConversationId || !ev?.type) return;
  if (ev.type === "session" && ev.sessionId) {
    updateActiveConversationSession(ev.sessionId);
    return;
  }
  if (isTaskLifecycleEvent(ev)) {
    appendTaskLifecycleHistoryEvent(ev);
    return;
  }
  if (ev.type === "assistant") {
    const content = ev.message?.content ?? ev.content ?? [];
    const blocks = normalizeAssistantHistoryBlocks(content);
    appendAssistantHistoryBlocks(blocks, ev, { rawMessage: ev.message ?? ev });
    return;
  }
  if (isOutboundToolUse(ev.type)) {
    appendAssistantHistoryBlocks([{
      type: ev.type,
      id: ev.id ?? "",
      name: ev.name ?? "tool",
      serverName: ev.server_name ?? ev.serverName ?? null,
      input: ev.input ?? {},
      raw: cloneHistoryJson(ev),
    }], ev);
    return;
  }
  if (isOutboundToolResult(ev.type)) {
    appendAssistantHistoryBlocks([{ type: ev.type, raw: cloneHistoryJson(ev) }], ev);
    return;
  }
  if (ev.type === "tool_progress" || ev.type === "tool_use_summary" || ev.type === "permission_denied" || ev.type === "task_notification") {
    appendAssistantHistoryBlocks([{ type: "sdk_event", eventType: ev.type, raw: cloneHistoryJson(ev) }], ev);
    return;
  }
  if (ev.type === "error") {
    appendAssistantHistoryBlocks([{
      type: "codex_error",
      message: ev.text || ev.message || "Assistant error",
      raw: cloneHistoryJson(ev),
    }], ev);
    finalizeActiveAssistantHistory("error");
    return;
  }
  if (ev.type === "result") {
    finalizeActiveAssistantHistory(ev.subtype === "success" || !ev.is_error ? "complete" : "error", ev.total_cost_usd ?? null);
    return;
  }
  if (ev.type === "done") {
    finalizeActiveAssistantHistory("complete");
    return;
  }
  if (ev.type === "stopped") {
    finalizeActiveAssistantHistory("stopped");
  }
}

// ── Skills preload ─────────────────────────────────────────
function addSkillSlugsFromDir(slugs, dir) {
  try {
    for (const entry of readdirSync(dir)) {
      if (!entry || entry.startsWith(".")) continue;
      try {
        // Use lstatSync so broken symlinks are counted (symlink = installed skill)
        const st = lstatSync(join(dir, entry));
        if (st.isDirectory() || st.isSymbolicLink()) slugs.add(entry);
      } catch { /* skip */ }
    }
  } catch { /* dir not found */ }
}

function skillDirsForProvider(provider) {
  if (provider === "codex") {
    return [
      join(homedir(), ".codex", "skills"),
      join(homedir(), ".codex", "skills", ".system"),
      join(homedir(), ".agents", "skills"),
      join(DEFAULT_CWD, ".codex", "skills"),
      join(DEFAULT_CWD, ".codex", "skills", ".system"),
      join(DEFAULT_CWD, ".agents", "skills"),
    ];
  }
  return [
    join(homedir(), ".claude", "skills"),
    join(DEFAULT_CWD, ".claude", "skills"),
  ];
}

function normalizeSkillProvider(provider) {
  return provider === "codex" ? "codex" : "claude";
}

function loadSkillsFromDisk(provider = "claude") {
  const slugs = new Set();
  for (const dir of skillDirsForProvider(normalizeSkillProvider(provider))) {
    addSkillSlugsFromDir(slugs, dir);
  }
  return [...slugs].sort();
}

const cachedSkillsByProvider = {
  claude: loadSkillsFromDisk("claude"),
  codex: loadSkillsFromDisk("codex"),
};
console.log(`Loaded ${cachedSkillsByProvider.claude.length} Claude skills and ${cachedSkillsByProvider.codex.length} Codex skills from disk`);

function skillsForProvider(provider) {
  const key = normalizeSkillProvider(provider);
  cachedSkillsByProvider[key] = loadSkillsFromDisk(key);
  return cachedSkillsByProvider[key];
}

function sendSkillInit(send, provider) {
  const key = normalizeSkillProvider(provider);
  const skills = skillsForProvider(key);
  send({ type: "system", subtype: "init", provider: key, skills, slash_commands: skills });
}


// ── WeChat Bot In-Memory Session & Live Poller Loop ──────────
const activeWechatLogins = new Map();
let wechatPollingController = null;

// 每个微信 sender 的对话历史（多轮上下文）
// 结构 Map<sender, { turns: [{role, content}], lastAt: number }>
// 使用 Anthropic SDK messages.create() 直接传结构化消息，彻底绕开 thinking signature 问题
const wechatSenderSessions = new Map();
const WECHAT_SESSION_TTL_MS = 30 * 60 * 1000; // 30 分钟无消息自动开启新对话
const WECHAT_MAX_HISTORY_TURNS = 10;           // 最多保留 10 轮（5 来 5 回）
const WECHAT_HISTORY_FILE = join(DATA_DIR, `wechat-history-${PORT}.json`);

// 启动时从文件恢复历史
try {
  if (existsSync(WECHAT_HISTORY_FILE)) {
    const raw = JSON.parse(readFileSync(WECHAT_HISTORY_FILE, "utf8"));
    for (const [sender, entry] of Object.entries(raw)) {
      wechatSenderSessions.set(sender, entry);
    }
    console.log(`[WeChat] Restored history for ${wechatSenderSessions.size} senders.`);
  }
} catch { }

function saveWechatHistory() {
  try {
    const obj = Object.fromEntries(wechatSenderSessions);
    writeFileSync(WECHAT_HISTORY_FILE, JSON.stringify(obj), "utf8");
  } catch { }
}

// 根据当前激活的账号配置构建 Anthropic SDK 客户端
// claude 会员返回 null —— OAuth token 不能直接调 API，需走 query()
function buildAnthropicClientForWechat(profileData) {
  const active = getActiveProfile(profileData);
  const DEFAULT_MODEL = "claude-sonnet-5";

  // claude 会员：OAuth token 仅供网页端使用，直接调 API 会触发 429
  // 返回 null，调用方改走 query() 路径
  if (!active || active.provider === "claude") return null;

  // 直接 Anthropic API Key
  if (active.provider === "anthropic") {
    const model = active.sonnetModel || active.opusModel || DEFAULT_MODEL;
    return { client: new Anthropic({ apiKey: active.apiKey }), model };
  }

  // 第三方兼容接口（DeepSeek / OpenRouter / custom）：Bearer token + 自定义 baseURL
  // 模型名去掉 Claude Code 内部的 ~ 前缀
  const model = (active.sonnetModel || active.opusModel || DEFAULT_MODEL).replace(/^~/, "");
  return {
    client: new Anthropic({ authToken: active.apiKey, baseURL: active.baseUrl }),
    model,
  };
}

function randomWechatUin() {
  const uint32 = crypto.randomBytes(4).readUInt32BE(0);
  return Buffer.from(String(uint32), "utf-8").toString("base64");
}

async function requestWechat(baseUrl, token, endpoint, body = {}) {
  const url = `${baseUrl.replace(/\/$/, "")}/${endpoint.replace(/^\//, "")}`;
  const headers = {
    "Content-Type": "application/json",
    "AuthorizationType": "ilink_bot_token",
    "iLink-App-Id": "bot",
    "iLink-App-ClientVersion": "132099",
    "X-WECHAT-UIN": randomWechatUin(),
  };
  if (token) headers.Authorization = `Bearer ${token}`;

  const res = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({
      ...body,
      base_info: { channel_version: "2.4.3", bot_agent: "inkfellow-wechat" }
    })
  });
  if (!res.ok) throw new Error(`WeChat Gateway HTTP ${res.status}`);
  return res.json();
}

function aesEcbPaddedSize(plaintextSize) {
  return Math.ceil((plaintextSize + 1) / 16) * 16;
}

function encryptAesEcb(plaintext, key) {
  const cipher = crypto.createCipheriv("aes-128-ecb", key, null);
  return Buffer.concat([cipher.update(plaintext), cipher.final()]);
}

function decryptAesEcb(ciphertext, key) {
  const decipher = crypto.createDecipheriv("aes-128-ecb", key, null);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

function parseWechatAesKey(aesKeyBase64) {
  const decoded = Buffer.from(aesKeyBase64, "base64");
  if (decoded.length === 16) return decoded;
  if (decoded.length === 32 && /^[0-9a-fA-F]{32}$/.test(decoded.toString("ascii"))) {
    return Buffer.from(decoded.toString("ascii"), "hex");
  }
  throw new Error(`Invalid WeChat media aes_key length: ${decoded.length}`);
}

function normalizeWechatAesKeyBase64(hexOrBase64) {
  const value = String(hexOrBase64 || "");
  if (/^[0-9a-fA-F]{32}$/.test(value)) {
    return Buffer.from(value, "hex").toString("base64");
  }
  return value;
}

function buildWechatCdnDownloadUrl(encryptQueryParam) {
  return `${WECHAT_CDN_BASE_URL}/download?encrypted_query_param=${encodeURIComponent(encryptQueryParam)}`;
}

function buildWechatCdnUploadUrl(uploadParam, filekey) {
  return `${WECHAT_CDN_BASE_URL}/upload?encrypted_query_param=${encodeURIComponent(uploadParam)}&filekey=${encodeURIComponent(filekey)}`;
}

function getMimeFromFileName(fileName) {
  return WECHAT_MIME_BY_EXT[extname(fileName).toLowerCase()] || "application/octet-stream";
}

function sniffImageMime(data, fallback = "application/octet-stream") {
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return "image/jpeg";
  if (data.length >= 8 && data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (data.length >= 6) {
    const header = data.subarray(0, 6).toString("ascii");
    if (header === "GIF87a" || header === "GIF89a") return "image/gif";
  }
  if (data.length >= 12 && data.subarray(0, 4).toString("ascii") === "RIFF" && data.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
  return fallback;
}

function extFromMime(mime, fallback = ".bin") {
  const entry = Object.entries(WECHAT_MIME_BY_EXT).find(([, value]) => value === mime);
  return entry?.[0] || fallback;
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 30000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function fetchWechatCdnBytes(media) {
  const url = media.full_url || buildWechatCdnDownloadUrl(media.encrypt_query_param);
  const res = await fetchWithTimeout(url, {}, 30000);
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`WeChat CDN download ${res.status}: ${body.slice(0, 120)}`);
  }
  return Buffer.from(await res.arrayBuffer());
}

async function downloadWechatMediaItem(item) {
  let kind = "";
  let media = null;
  let aesKeyBase64 = "";
  let fileName = "";
  let mime = "application/octet-stream";

  if (item.type === WECHAT_MESSAGE_ITEM_TYPE.IMAGE) {
    const image = item.image_item;
    media = image?.media || image?.thumb_media;
    if (!media?.encrypt_query_param && !media?.full_url) return null;
    aesKeyBase64 = normalizeWechatAesKeyBase64(image?.aeskey || media.aes_key || "");
    kind = "image";
  } else if (item.type === WECHAT_MESSAGE_ITEM_TYPE.VOICE) {
    const voice = item.voice_item;
    media = voice?.media;
    if (!media?.encrypt_query_param && !media?.full_url) return null;
    aesKeyBase64 = normalizeWechatAesKeyBase64(media.aes_key || "");
    kind = "voice";
    fileName = "voice.silk";
    mime = "audio/silk";
  } else if (item.type === WECHAT_MESSAGE_ITEM_TYPE.FILE) {
    const file = item.file_item;
    media = file?.media;
    if (!media?.encrypt_query_param && !media?.full_url) return null;
    aesKeyBase64 = normalizeWechatAesKeyBase64(media.aes_key || "");
    kind = "file";
    fileName = file?.file_name || "attachment.bin";
    mime = getMimeFromFileName(fileName);
  } else if (item.type === WECHAT_MESSAGE_ITEM_TYPE.VIDEO) {
    const video = item.video_item;
    media = video?.media;
    if (!media?.encrypt_query_param && !media?.full_url) return null;
    aesKeyBase64 = normalizeWechatAesKeyBase64(media.aes_key || "");
    kind = "video";
    fileName = "video.mp4";
    mime = "video/mp4";
  } else {
    return null;
  }

  const encryptedOrPlain = await fetchWechatCdnBytes(media);
  const data = aesKeyBase64 ? decryptAesEcb(encryptedOrPlain, parseWechatAesKey(aesKeyBase64)) : encryptedOrPlain;
  if (data.length > WECHAT_MAX_MEDIA_BYTES) {
    throw new Error(`media too large (${data.length} bytes)`);
  }

  if (kind === "image") {
    mime = sniffImageMime(data, "image/jpeg");
    fileName = `image-${Date.now()}-${crypto.randomBytes(4).toString("hex")}${extFromMime(mime, ".jpg")}`;
  } else {
    const safeBase = basename(fileName).replace(/[^\w.\-()\u4e00-\u9fa5]/g, "_") || `${kind}.bin`;
    fileName = `${Date.now()}-${crypto.randomBytes(4).toString("hex")}-${safeBase}`;
  }

  const filePath = join(WECHAT_MEDIA_DIR, fileName);
  writeFileSync(filePath, data);
  return { kind, fileName, filePath, mime, size: data.length, data };
}

async function uploadWechatMediaFile(baseUrl, token, toUser, filePath) {
  const data = readFileSync(filePath);
  if (data.length > WECHAT_MAX_MEDIA_BYTES) {
    throw new Error(`media too large for WeChat upload (${data.length} bytes)`);
  }

  const mime = getMimeFromFileName(filePath);
  const mediaType = mime.startsWith("image/")
    ? WECHAT_UPLOAD_MEDIA_TYPE.IMAGE
    : mime.startsWith("video/")
      ? WECHAT_UPLOAD_MEDIA_TYPE.VIDEO
      : WECHAT_UPLOAD_MEDIA_TYPE.FILE;
  const filekey = crypto.randomBytes(16).toString("hex");
  const aeskey = crypto.randomBytes(16);
  const rawsize = data.length;
  const rawfilemd5 = crypto.createHash("md5").update(data).digest("hex");
  const filesize = aesEcbPaddedSize(rawsize);

  const uploadResp = await requestWechat(baseUrl, token, "ilink/bot/getuploadurl", {
    filekey,
    media_type: mediaType,
    to_user_id: toUser,
    rawsize,
    rawfilemd5,
    filesize,
    no_need_thumb: true,
    aeskey: aeskey.toString("hex"),
  });
  const uploadParam = uploadResp.upload_param;
  if (!uploadParam && !uploadResp.upload_full_url) {
    throw new Error(`getuploadurl returned no upload_param: ${JSON.stringify(uploadResp).slice(0, 300)}`);
  }

  const ciphertext = encryptAesEcb(data, aeskey);
  const uploadUrl = uploadResp.upload_full_url || buildWechatCdnUploadUrl(uploadParam, filekey);
  const uploadRes = await fetchWithTimeout(uploadUrl, {
    method: "POST",
    headers: { "Content-Type": "application/octet-stream" },
    body: new Uint8Array(ciphertext),
  }, 30000);
  if (uploadRes.status !== 200) {
    const errText = uploadRes.headers.get("x-error-message") || await uploadRes.text().catch(() => "");
    throw new Error(`WeChat CDN upload ${uploadRes.status}: ${errText.slice(0, 160)}`);
  }

  const downloadParam = uploadRes.headers.get("x-encrypted-param");
  if (!downloadParam) {
    throw new Error("WeChat CDN upload response missing x-encrypted-param");
  }

  const aesKeyForMessage = Buffer.from(aeskey.toString("hex")).toString("base64");
  if (mediaType === WECHAT_UPLOAD_MEDIA_TYPE.IMAGE) {
    return {
      type: WECHAT_MESSAGE_ITEM_TYPE.IMAGE,
      image_item: {
        media: { encrypt_query_param: downloadParam, aes_key: aesKeyForMessage, encrypt_type: 1 },
        aeskey: aeskey.toString("hex"),
        mid_size: filesize,
      },
    };
  }
  if (mediaType === WECHAT_UPLOAD_MEDIA_TYPE.VIDEO) {
    return {
      type: WECHAT_MESSAGE_ITEM_TYPE.VIDEO,
      video_item: {
        media: { encrypt_query_param: downloadParam, aes_key: aesKeyForMessage, encrypt_type: 1 },
        video_size: filesize,
      },
    };
  }
  return {
    type: WECHAT_MESSAGE_ITEM_TYPE.FILE,
    file_item: {
      media: { encrypt_query_param: downloadParam, aes_key: aesKeyForMessage, encrypt_type: 1 },
      file_name: basename(filePath),
      len: String(rawsize),
    },
  };
}

async function sendWechatItem(baseUrl, token, toUser, item, contextToken = undefined) {
  const clientId = `inkfellow-wechat-${crypto.randomUUID()}`;
  await requestWechat(baseUrl, token, "ilink/bot/sendmessage", {
    msg: {
      from_user_id: "",
      to_user_id: toUser,
      client_id: clientId,
      message_type: 2, // MessageType.BOT
      message_state: 2, // MessageState.FINISH
      item_list: [item],
      context_token: contextToken || undefined,
    }
  });
}

async function sendWechatMessage(baseUrl, token, toUser, text, contextToken = undefined) {
  await sendWechatItem(baseUrl, token, toUser, {
    type: WECHAT_MESSAGE_ITEM_TYPE.TEXT,
    text_item: { text: text }
  }, contextToken);
}

function extractWechatOutboundMediaRefs(text) {
  const refs = [];
  const seen = new Set();
  const addRef = (raw, target) => {
    const clean = String(target || "")
      .trim()
      .replace(/^<(.+)>$/, "$1")
      .replace(/^["'](.+)["']$/, "$1");
    if (!clean || seen.has(clean)) return;
    if (!/\.(png|jpe?g|webp|gif)(?:[?#].*)?$/i.test(clean)) return;
    seen.add(clean);
    refs.push({ raw, target: clean });
  };

  const markdownImageRe = /!\[[^\]]*]\((<[^>\n]+>|[^)\n]+)\)/g;
  let match;
  while ((match = markdownImageRe.exec(text)) !== null) {
    addRef(match[0], match[1]);
  }

  const markdownLinkRe = /(?<!!)\[[^\]]+]\((<[^>\n]+>|[^)\n]+)\)/g;
  while ((match = markdownLinkRe.exec(text)) !== null) {
    addRef(match[0], match[1]);
  }

  const pathRe = /(`?)(file:\/\/\/[^`'")\s<>]+\.(?:png|jpe?g|webp|gif)|\/[^`'")\s<>]+\.(?:png|jpe?g|webp|gif)|(?:\.{1,2}\/|claude-chat\/data\/|data\/|wechat-media-\d+\/)[^`'")\s<>]+\.(?:png|jpe?g|webp|gif))\1/gi;
  while ((match = pathRe.exec(text)) !== null) {
    addRef(match[0], match[2]);
  }

  return refs.slice(0, 5);
}

function resolveWechatOutboundLocalPath(target) {
  const clean = String(target || "")
    .trim()
    .replace(/^file:\/\//, "")
    .replace(/[?#].*$/, "");
  if (!clean || /^https?:\/\//i.test(clean)) return null;
  const candidates = [
    isAbsolute(clean) ? clean : resolve(DEFAULT_CWD, clean),
    isAbsolute(clean) ? clean : resolve(process.cwd(), clean),
    isAbsolute(clean) ? clean : resolve(__dirname, clean),
  ];
  for (const candidate of candidates) {
    try {
      const st = statSync(candidate);
      if (st.isFile()) return candidate;
    } catch { }
  }
  return null;
}

async function downloadOutboundRemoteMedia(target) {
  const url = new URL(target);
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;

  const res = await fetchWithTimeout(url.toString(), {}, 20000);
  if (!res.ok) throw new Error(`download ${res.status}`);

  const contentLength = Number.parseInt(res.headers.get("content-length") || "0", 10);
  if (contentLength > WECHAT_MAX_MEDIA_BYTES) {
    throw new Error(`remote media too large (${contentLength} bytes)`);
  }

  const data = Buffer.from(await res.arrayBuffer());
  if (data.length > WECHAT_MAX_MEDIA_BYTES) {
    throw new Error(`remote media too large (${data.length} bytes)`);
  }

  const contentType = (res.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
  let ext = extFromMime(contentType, "");
  if (!ext) ext = extname(url.pathname).toLowerCase() || ".bin";
  const fileName = `outbound-${Date.now()}-${crypto.randomBytes(4).toString("hex")}${ext}`;
  const filePath = join(WECHAT_MEDIA_DIR, fileName);
  writeFileSync(filePath, data);
  return filePath;
}

async function sendWechatResponseWithMedia(baseUrl, token, toUser, text, contextToken = undefined) {
  const refs = extractWechatOutboundMediaRefs(text);
  if (refs.length === 0) {
    console.log("[WeChat Media] No outbound media refs found in response.");
    await sendWechatMessage(baseUrl, token, toUser, text, contextToken);
    return;
  }
  console.log(`[WeChat Media] Found ${refs.length} outbound media ref(s): ${refs.map(r => r.target).join(", ")}`);

  let caption = text;
  for (const ref of refs) {
    caption = caption.replace(ref.raw, "").trim();
  }
  if (caption) {
    await sendWechatMessage(baseUrl, token, toUser, caption, contextToken);
  }

  for (const ref of refs) {
    try {
      const localPath = resolveWechatOutboundLocalPath(ref.target) || await downloadOutboundRemoteMedia(ref.target);
      if (!localPath) continue;
      const item = await uploadWechatMediaFile(baseUrl, token, toUser, localPath);
      await sendWechatItem(baseUrl, token, toUser, item, contextToken);
      console.log(`[WeChat Media] Sent outbound media: ${localPath}`);
    } catch (err) {
      console.warn(`[WeChat Media] Failed to send outbound media ${ref.target}: ${err.message}`);
      await sendWechatMessage(baseUrl, token, toUser, `图片发送失败：${ref.target}`, contextToken).catch(() => {});
    }
  }
}

async function sendWechatTyping(baseUrl, token, toUser, status = 1, contextToken = undefined) {
  try {
    const config = await requestWechat(baseUrl, token, "ilink/bot/getconfig", {
      ilink_user_id: toUser,
      context_token: contextToken || undefined,
    });
    if (config.typing_ticket) {
      await requestWechat(baseUrl, token, "ilink/bot/sendtyping", {
        ilink_user_id: toUser,
        typing_ticket: config.typing_ticket,
        status
      });
    }
  } catch {}
}

function extractWechatTextParts(msg) {
  const parts = [];
  for (const item of msg.item_list || []) {
    if (item.type === WECHAT_MESSAGE_ITEM_TYPE.TEXT && item.text_item?.text) {
      parts.push(String(item.text_item.text));
    }
    if (item.type === WECHAT_MESSAGE_ITEM_TYPE.VOICE && item.voice_item?.voice_to_text) {
      parts.push(String(item.voice_item.voice_to_text));
    }
  }
  return parts.map(t => t.trim()).filter(Boolean);
}

function buildWechatPrompt(textParts, mediaFiles) {
  const userText = textParts.join("\n").trim();
  if (userText) return userText;
  if (mediaFiles.some(f => f.kind === "image")) return "请分析我发来的图片。";
  if (mediaFiles.some(f => f.kind === "voice")) return "请处理我发来的语音消息。";
  if (mediaFiles.length > 0) return "请处理我发来的文件。";
  return "";
}

function formatWechatMediaSummary(mediaFiles) {
  if (mediaFiles.length === 0) return "";
  return mediaFiles.map((file, idx) =>
    `[${idx + 1}] ${file.kind}: ${file.fileName}, ${file.mime}, ${file.size} bytes, saved at ${file.filePath}`
  ).join("\n");
}

function buildWechatUserContent(prompt, mediaFiles, { includeImageBlocks }) {
  const supportedImages = mediaFiles.filter(file =>
    file.kind === "image" &&
    Object.values(WECHAT_IMAGE_MIME_BY_EXT).includes(file.mime) &&
    file.size <= WECHAT_MAX_INLINE_IMAGE_BYTES
  );
  const imageBlocks = includeImageBlocks
    ? supportedImages.map(file => ({
      type: "image",
      source: {
        type: "base64",
        media_type: file.mime,
        data: file.data.toString("base64"),
      },
    }))
    : [];

  const nonInlineMedia = mediaFiles.filter(file => !supportedImages.includes(file));
  const summary = formatWechatMediaSummary(nonInlineMedia);
  const text = summary
    ? `${prompt}\n\n收到以下附件，已保存到服务器本地路径，必要时可按路径读取：\n${summary}`
    : prompt;
  return [{ type: "text", text }, ...imageBlocks];
}

function summarizeWechatHistoryPrompt(prompt, mediaFiles) {
  const summary = formatWechatMediaSummary(mediaFiles);
  return summary ? `${prompt}\n\n附件：\n${summary}` : prompt;
}

async function handleWechatInboundMessage(baseUrl, token, msg, abortSignal) {
  const sender = msg.from_user_id;
  const contextToken = msg.context_token;
  if (!sender) return;

  const textParts = extractWechatTextParts(msg);
  const mediaItems = (msg.item_list || []).filter(item =>
    item.type === WECHAT_MESSAGE_ITEM_TYPE.IMAGE ||
    item.type === WECHAT_MESSAGE_ITEM_TYPE.VOICE ||
    item.type === WECHAT_MESSAGE_ITEM_TYPE.FILE ||
    item.type === WECHAT_MESSAGE_ITEM_TYPE.VIDEO
  );

  const mediaFiles = [];
  for (const item of mediaItems) {
    try {
      const file = await downloadWechatMediaItem(item);
      if (file) mediaFiles.push(file);
    } catch (err) {
      console.warn(`[WeChat Media] Failed to download inbound media from ${sender}: ${err.message}`);
      await sendWechatMessage(baseUrl, token, sender, `附件下载失败：${err.message}`, contextToken).catch(() => {});
    }
  }

  const prompt = buildWechatPrompt(textParts, mediaFiles);
  if (!prompt) return;

  console.log(`[WeChat Inbound] message from ${sender}: "${prompt}" media=${mediaFiles.length}`);

  // 用户主动开启新对话
  if (mediaFiles.length === 0 && /^(新对话|new|\/new|重新开始|清除记忆)$/i.test(prompt)) {
    wechatSenderSessions.delete(sender);
    sendWechatMessage(baseUrl, token, sender, "已开启新对话，之前的上下文已清除。", contextToken).catch(() => {});
    return;
  }

  processWechatQuery(baseUrl, token, sender, prompt, contextToken, abortSignal, mediaFiles);
}

async function startWechatPolling(baseUrl, token, initialBuf = "") {
  if (wechatPollingController) {
    wechatPollingController.abort();
  }
  
  const ac = new AbortController();
  wechatPollingController = ac;
  let getUpdatesBuf = initialBuf;

  console.log(`[WeChat Loop] Poller initiated on base: ${baseUrl}`);

  (async () => {
    while (!ac.signal.aborted) {
      try {
        const resp = await requestWechat(baseUrl, token, "ilink/bot/getupdates", {
          get_updates_buf: getUpdatesBuf
        });

        if (ac.signal.aborted) break;

        const isApiError = (resp.ret !== undefined && resp.ret !== 0) || (resp.errcode !== undefined && resp.errcode !== 0);
        if (isApiError) {
          console.warn(`[WeChat Loop] Polling error ret=${resp.ret} errcode=${resp.errcode}. Backing off...`);
          await new Promise(r => setTimeout(r, 5000));
          continue;
        }

        if (resp.get_updates_buf) {
          getUpdatesBuf = resp.get_updates_buf;
          try {
            writeFileSync(WECHAT_SYNC_FILE, JSON.stringify({ get_updates_buf }), "utf8");
          } catch {}
        }

        const messages = resp.msgs ?? [];
        for (const msg of messages) {
          handleWechatInboundMessage(baseUrl, token, msg, ac.signal).catch(err => {
            console.error("[WeChat Loop] Error handling inbound message:", err.message);
          });
        }
      } catch (err) {
        if (ac.signal.aborted) break;
        console.error("[WeChat Loop] Error polling updates:", err.message);
        await new Promise(r => setTimeout(r, 5000));
      }
    }
    console.log("[WeChat Loop] Poller stopped successfully.");
  })();
}

function hasSchedulerIntent(prompt) {
  return SCHEDULER_INTENT_RE.test(String(prompt || ""));
}

function normalizeProviderSelector(value) {
  return String(value || "").trim().toLocaleLowerCase();
}

export function resolveDispatchProfile(profileData, selector) {
  const wanted = normalizeProviderSelector(selector);
  if (!wanted) return null;
  const profiles = Array.isArray(profileData?.profiles) ? profileData.profiles : [];
  return profiles.find(profile => normalizeProviderSelector(profile.id) === wanted)
    ?? profiles.find(profile => normalizeProviderSelector(profile.provider) === wanted)
    ?? profiles.find(profile => normalizeProviderSelector(profile.name) === wanted)
    ?? null;
}

function dispatchModelForProfile(profile) {
  if (!profile) return "";
  if (profile.provider === "codex") {
    return profile.opusModel || profile.sonnetModel || profile.haikuModel || CODEX_DEFAULT_MODELS.opusModel;
  }
  if (profile.provider === "claude") {
    return profile.sonnetModel || profile.opusModel || "claude-sonnet-5";
  }
  return profile.sonnetModel || profile.opusModel || profile.haikuModel || "";
}

export function listDispatchProviders(profileData = readProfiles()) {
  return (profileData?.profiles ?? []).map(profile => ({
    id: profile.id,
    name: profile.name,
    provider: profile.provider,
    goodAt: profile.goodAt || PROVIDER_GOOD_AT[profile.provider] || PROVIDER_GOOD_AT.custom,
    model: dispatchModelForProfile(profile),
  }));
}

function unavailableProviderMessage(profileData, selector) {
  const available = listDispatchProviders(profileData)
    .map(profile => `${profile.name}（${profile.provider}）`)
    .join("、");
  return `未找到可派发的厂商「${String(selector || "").trim() || "（空）"}」。当前可用厂商：${available || "无"}`;
}

// 主模型自主判断并派发给其他厂商的能力开关。关闭时只保留 ">厂商 任务" 的手动派发，
// 主模型看不到 dispatch_to_provider / list_providers 工具，不会自作主张外包。
const DISPATCH_AUTO_ENABLED = process.env.INKFELLOW_DISPATCH_AUTO === "1";

/** 派发步骤的关联键：前端从 tool_use 的 input 里能算出同样的值，用来把步骤挂回正确的卡片 */
function dispatchStepKey(provider, task) {
  return `${String(provider || "").trim()}|${String(task || "").trim().slice(0, 100)}`;
}

// ── 派发会话续接 ───────────────────────────────────────────────────────────
// 同一条对话里再次派给同一个厂商时接着上一轮说，对方记得刚才做过什么。
// 边界取「对话 + 厂商账号」：换对话是新话题，换厂商本来就是另一个模型的会话。
//
// 只放内存，进程重启即失效。这是有意的——sessionId 的另一半在对方 CLI 的
// 会话存储里，我们无法保证它还在；宁可开一个新会话，也不要拿着可能失效的 id
// 让用户以为对方记得。
const DISPATCH_SESSIONS = new Map();
const DISPATCH_SESSION_LIMIT = 200;

function dispatchSessionKey(conversationId, profileId) {
  return `${String(conversationId || "").trim()}|${String(profileId || "").trim()}`;
}

export function rememberDispatchSession(conversationId, profileId, sessionId) {
  if (!conversationId || !profileId || !sessionId) return;
  const key = dispatchSessionKey(conversationId, profileId);
  // 重新 set 一次让它排到 Map 末尾，下面按插入序淘汰时才是真正的 LRU
  DISPATCH_SESSIONS.delete(key);
  DISPATCH_SESSIONS.set(key, sessionId);
  while (DISPATCH_SESSIONS.size > DISPATCH_SESSION_LIMIT) {
    const oldest = DISPATCH_SESSIONS.keys().next().value;
    if (oldest === undefined) break;
    DISPATCH_SESSIONS.delete(oldest);
  }
}

export function recallDispatchSession(conversationId, profileId) {
  if (!conversationId || !profileId) return null;
  return DISPATCH_SESSIONS.get(dispatchSessionKey(conversationId, profileId)) || null;
}

export function dropDispatchSession(conversationId, profileId) {
  if (!conversationId || !profileId) return;
  DISPATCH_SESSIONS.delete(dispatchSessionKey(conversationId, profileId));
}

// 同一个 (对话, 厂商) 正在派发中的计数。并发派同一家时，后来者不去续接同一个
// 会话——两个进程同时往一条 thread 里写，对方那边的历史会交错成谁也读不懂的样子。
// 不加锁排队：派发动辄几分钟，排队会让第二个请求看起来像卡死。
//
// 必须计数而不是 Set：三个并发时，第一个跑完就把标记删了，第三个会误以为没人
// 在跑而去续接一条正被写的 thread。租约也只允许释放一次，重复调用不会把别人的
// 计数减掉。
const DISPATCH_INFLIGHT = new Map();

export function isDispatchInflight(conversationId, profileId) {
  if (!conversationId || !profileId) return false;
  return (DISPATCH_INFLIGHT.get(dispatchSessionKey(conversationId, profileId)) || 0) > 0;
}

export function markDispatchInflight(conversationId, profileId) {
  if (!conversationId || !profileId) return () => {};
  const key = dispatchSessionKey(conversationId, profileId);
  DISPATCH_INFLIGHT.set(key, (DISPATCH_INFLIGHT.get(key) || 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const next = (DISPATCH_INFLIGHT.get(key) || 1) - 1;
    if (next > 0) DISPATCH_INFLIGHT.set(key, next);
    else DISPATCH_INFLIGHT.delete(key);
  };
}

// reset 之后，那些还在跑的派发迟早会回调 onSession。没有代际保护的话，它们会把
// 刚清掉的会话又填回去，于是「新对话」接上了旧话题的上下文。
// 每清一次该对话就 +1，回调时对不上代际就丢弃。
const DISPATCH_GENERATION = new Map();

export function dispatchGenerationOf(conversationId) {
  if (!conversationId) return 0;
  return DISPATCH_GENERATION.get(conversationId) || 0;
}

function bumpDispatchGeneration(conversationId) {
  if (!conversationId) return;
  DISPATCH_GENERATION.set(conversationId, dispatchGenerationOf(conversationId) + 1);
}

export function forgetDispatchSessions(conversationId) {
  if (!conversationId) return;
  const prefix = `${String(conversationId).trim()}|`;
  for (const key of [...DISPATCH_SESSIONS.keys()]) {
    if (key.startsWith(prefix)) DISPATCH_SESSIONS.delete(key);
  }
  // 还在跑的那些派发之后会回调 onSession，代际一变它们就写不回来了
  bumpDispatchGeneration(String(conversationId).trim());
}

async function executeProviderDispatch({
  provider,
  task,
  cwd,
  permissionMode,
  profileData = readProfiles(),
  abortController = null,
  onStep = null,   // (name, input) => void：子 agent 每次调工具时回调，供前端画步骤流
  resumeSessionId = null,  // 有值就接着这个会话往下说，对方记得上一轮
  // (sessionId) => void：会话 id 一拿到就回调，不等本轮成功。
  // 用户中断时对方已经建立了上下文，这个 id 仍然有效，丢掉就白费了。
  onSession = null,
}) {
  const targetProfile = resolveDispatchProfile(profileData, provider);
  if (!targetProfile) throw new Error(unavailableProviderMessage(profileData, provider));
  if (targetProfile.provider === "codex" && !isCodexAuthAvailable()) {
    throw new Error(`${targetProfile.name} 尚未登录，请先打开 Codex 客户端或运行 codex login。`);
  }
  if (targetProfile.provider !== "claude" && targetProfile.provider !== "codex" && !targetProfile.apiKey) {
    throw new Error(`${targetProfile.name} 的 API Key 还没有配置。`);
  }

  const model = dispatchModelForProfile(targetProfile);
  const controller = abortController || new AbortController();
  let output = "";
  // 本轮结束后回传给调用方，让它记住以便下一轮续接
  let sessionId = null;
  // 对方是否在这一轮真的把会话接上了。用来区分两种失败：resume 的 id 已经失效
  // （对方压根没认这条会话，该丢掉），还是接上之后跑到一半才出错（thread 是好的，
  // 丢掉就白白浪费了它已经建立的上下文）。
  let sessionEstablished = false;
  const noteSession = (id, { fromVendor = false } = {}) => {
    if (fromVendor) sessionEstablished = true;
    if (!id || id === sessionId) return;
    sessionId = id;
    if (onSession) {
      try { onSession(id); } catch { /* 记录失败不该影响派发本身 */ }
    }
  };
  const tagError = (error) => {
    if (error && typeof error === "object") {
      try { error.dispatchSessionEstablished = sessionEstablished; } catch { /* 冻结对象就算了 */ }
    }
    return error;
  };

  try {
  if (targetProfile.provider === "codex") {
    const codex = new Codex();
    const threadOptions = {
      workingDirectory: cwd,
      approvalPolicy: "never",
      sandboxMode: codexSandboxMode(permissionMode),
      modelReasoningEffort: "medium",
      ...(model ? { model } : {}),
    };
    // resumeThread 拿到的是同一条 thread，历史还在；id 失效时 SDK 会抛错，
    // 这里不兜底重开——静默换成新会话会让用户以为对方记得，其实已经忘了
    const thread = resumeSessionId
      ? codex.resumeThread(resumeSessionId, threadOptions)
      : codex.startThread(threadOptions);
    // 续接时 id 是我们自己传进去的，立刻就有；新建线程则要等 thread.started
    // 事件才拿得到——SDK 里 thread.id 的注释写明「Populated after the first
    // turn starts」，在这儿读永远是 null
    noteSession(resumeSessionId || thread.id || null);
    const { events } = await thread.runStreamed(task, { signal: controller.signal });
    const answerParts = [];
    for await (const event of events) {
      // 新建线程唯一能拿到 id 的时机，错过它中断就白跑一趟。
      // 收到这个事件也说明对方认了这条会话（续接时同理）
      if (event.type === "thread.started") noteSession(event.thread_id, { fromVendor: true });
      // 工具动作实时抛给前端，否则卡片只能一直显示"等待子任务的第一个动作"
      if (onStep && event.type === "item.started" && event.item && event.item.type !== "agent_message") {
        try { onStep(codexToolName(event.item) || event.item.type, codexToolInput(event.item)); } catch { /* 步骤上报失败不该影响主流程 */ }
      }
      if (event.type === "item.completed" && event.item?.type === "agent_message") {
        const text = codexItemText(event.item).trim();
        if (text) answerParts.push(text);
      } else if (event.type === "turn.failed") {
        throw new Error(event.error?.message || `${targetProfile.name} 请求失败`);
      } else if (event.type === "error") {
        throw new Error(event.message || `${targetProfile.name} 请求失败`);
      }
    }
    output = answerParts.join("\n\n").trim();
    noteSession(thread.id || resumeSessionId || null);
  } else {
    const env = buildAgentEnv(profileData, "medium", null, targetProfile);
    env.PWD = cwd;
    const options = {
      cwd,
      env,
      permissionMode,
      allowDangerouslySkipPermissions: permissionMode === "bypassPermissions",
      abortController: controller,
      includePartialMessages: false,
      ...(resumeSessionId ? { resume: resumeSessionId } : {}),
      ...(targetProfile.provider === "claude" && model ? { model } : {}),
    };
    const answerParts = [];
    const generator = query({ prompt: task, options });
    for await (const event of generator) {
      // 子 agent 的工具调用实时上报，前端据此画步骤流
      if (onStep && event.type === "assistant") {
        for (const block of (event.message?.content ?? event.content ?? [])) {
          if (block?.type === "tool_use" || block?.type === "server_tool_use" || block?.type === "mcp_tool_use") {
            try { onStep(block.name, block.input); } catch { /* 步骤上报失败不该影响主流程 */ }
          }
        }
      }
      if (event.type === "assistant") {
        const text = (event.message?.content ?? event.content ?? [])
          .filter(block => block?.type === "text")
          .map(block => block.text)
          .join("")
          .trim();
        if (text) answerParts.push(text);
      } else if (event.type === "system" && event.subtype === "init") {
        // 续接时 SDK 仍会发 init，带的是同一个 session_id。这是最早能拿到 id
        // 的时机，立刻上报，后面中断也不影响已经记下的这一份。
        // 能走到这儿说明会话确实建起来了
        noteSession(event.session_id, { fromVendor: true });
      } else if (event.type === "result") {
        noteSession(event.session_id, { fromVendor: true });
        if (event.subtype !== "success" || event.is_error) {
          throw new Error(event.result || `${targetProfile.name} 请求失败`);
        }
        if (typeof event.result === "string" && event.result.trim()) output = event.result.trim();
      }
    }
    if (!output) output = answerParts.join("\n\n").trim();
  }
  } catch (error) {
    throw tagError(error);
  }

  if (!output) throw new Error(`${targetProfile.name} 没有返回可用的文本结果。`);

  return {
    provider: targetProfile.provider,
    providerName: targetProfile.name,
    profileId: targetProfile.id,
    model,
    output,
    sessionId,
    resumed: Boolean(resumeSessionId),
  };
}

// conversationId 必须由调用方显式传入，不能在工具执行时去读全局的
// activeHistoryConversationId：同一个 builder 也被微信链路和可跨回合存活的
// 后台任务用着，那个全局变量指的是 Web UI 当前正在看的对话，跟它们无关，
// 读到就会把会话记到别人头上。拿不到就传 null——不续接总好过串台。
// getAbortSignal 让派发跟着外层一起取消。executeProviderDispatch 拿不到信号时
// 会自建一个 AbortController，那样外面按停止根本传不进去——子进程会一直跑到
// 自然结束，用户以为停了，其实还在烧钱。传函数而不是信号本身：MCP server 会
// 跨多轮复用，每次调用要拿的是当前这一轮的信号。
function _buildDispatchMcpServer({ cwd, permissionMode, profileData, sendStep = null, conversationId = null, getAbortSignal = null }) {
  // 持久 Query 会跨多轮复用 MCP server；每次调用都重新读取配置，避免用户在
  // 会话中编辑了非当前账号后，派发仍拿着旧 key / 模型 / goodAt。
  const currentProfiles = () => {
    const latest = readProfiles();
    return latest?.profiles?.length ? latest : profileData;
  };
  const dispatchTool = tool(
    "dispatch_to_provider",
    "把一个完整子任务交给另一个已配置厂商的 agent 执行。子 agent 使用当前会话相同的工作目录和文件权限；返回实际厂商、模型与完整输出。",
    {
      provider: z.string().describe("目标厂商的 provider、账号名称或 profile id；先用 list_providers 查看"),
      task: z.string().describe("交给目标 agent 的完整、可独立执行的任务描述"),
      reason: z.string().optional().describe("为什么选择该厂商；会展示给用户"),
    },
    async ({ provider, task, reason }) => {
      try {
        const profiles = currentProfiles();
        // 跟 ">厂商" 手动路径保持同样的续接行为，否则同一个厂商在两条路径下
        // 记不记得上一轮会不一致，用户无从预期
        const convId = conversationId;
        const targetProfile = resolveDispatchProfile(profiles, provider);
        const profileId = targetProfile?.id || null;
        const canResume = Boolean(convId && profileId) && !isDispatchInflight(convId, profileId);
        const resumeSessionId = canResume ? recallDispatchSession(convId, profileId) : null;
        const releaseInflight = markDispatchInflight(convId, profileId);
        const generation = dispatchGenerationOf(convId);
        // 把外层的取消挂到这次派发上。外层已经停了就不必再发起——直接抛，
        // 免得白开一个几分钟的子进程
        const outerSignal = getAbortSignal ? getAbortSignal() : null;
        if (outerSignal?.aborted) {
          releaseInflight();
          throw Object.assign(new Error("已取消"), { name: "AbortError" });
        }
        const dispatchController = new AbortController();
        const onOuterAbort = () => dispatchController.abort();
        outerSignal?.addEventListener("abort", onOuterAbort, { once: true });
        let result;
        try {
          result = await executeProviderDispatch({
            provider,
            task,
            cwd,
            permissionMode,
            profileData: profiles,
            resumeSessionId,
            abortController: dispatchController,
            // 拿到 id 立刻记，中断也不丢。对话已被重置过就别写回去了
            onSession: (id) => {
              if (dispatchGenerationOf(convId) !== generation) return;
              rememberDispatchSession(convId, profileId, id);
            },
            // MCP 工具内部拿不到自己的 tool_use_id，改用 provider+task 前缀做关联键，
            // 前端从 tool_use 的 input 能算出同样的键，据此把步骤挂回对应卡片
            onStep: sendStep
              ? (name, input) => sendStep({ key: dispatchStepKey(provider, task), name, input })
              : null,
          });
        } catch (error) {
          // 只在「对方压根没认这条会话」时丢弃。接上之后才出错的（限流、超时）
          // thread 是好的，丢掉等于白白扔掉它已经建立的上下文。
          // 代际变了说明这条对话已被重置，那把删除也没意义，交给 reset 处理。
          if (resumeSessionId
            && error?.dispatchSessionEstablished === false
            && dispatchGenerationOf(convId) === generation) {
            dropDispatchSession(convId, profileId);
          }
          throw error;
        } finally {
          // 监听器必须摘掉：MCP server 跨多轮复用，外层 signal 活得比这次调用长，
          // 攒着不摘就是内存泄漏
          outerSignal?.removeEventListener("abort", onOuterAbort);
          releaseInflight();
        }
        return {
          content: [{
            type: "text",
            text: JSON.stringify({ ok: true, reason: reason || null, ...result }),
          }],
        };
      } catch (error) {
        return {
          isError: true,
          content: [{ type: "text", text: String(error?.message || error) }],
        };
      }
    },
  );

  const listProvidersTool = tool(
    "list_providers",
    "列出当前可以派发的厂商、实际派发模型和各自擅长的任务。选择跨厂商子 agent 前先参考此列表。",
    {},
    async () => ({
      content: [{ type: "text", text: JSON.stringify(listDispatchProviders(currentProfiles())) }],
    }),
  );

  return createSdkMcpServer({
    name: "provider-dispatch",
    instructions: "需要让另一个厂商独立完成子任务时，先用 list_providers 了解能力，再用 dispatch_to_provider 派发。必须把完整任务上下文写入 task，并把返回结果整合进当前回复。",
    tools: [dispatchTool, listProvidersTool],
    alwaysLoad: true,
  });
}

function _buildSchedulerMcpServer({ sourceChannel, sourcePeer, defaultOutputs = [] }) {
  const nowMs = Date.now();
  const nowStr = new Date(nowMs).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" });
  const isCurrentJob = job => job.sourceChannel === sourceChannel && job.sourcePeer === sourcePeer;

  const createScheduleTool = tool(
    "create_schedule",
    "创建定时任务（循环或一次性）。sourceChannel 和 sourcePeer 由系统固定注入，不需要传入。",
    {
      kind: z.enum(["once", "cron"]).describe("once=一次性任务，cron=循环任务"),
      description: z.string().describe("任务的简短描述，如：每天提醒喝水"),
      taskPrompt: z.string().describe("任务触发时发给 Agent 的完整执行指令"),
      cronExpr: z.string().optional().describe("cron 表达式，kind=cron 时必填，如 '0 9 * * *'（Asia/Shanghai）"),
      runAtMs: z.number().optional().describe(`Unix 毫秒时间戳，kind=once 时必填。当前时间：${nowStr}，当前毫秒戳：${nowMs}`),
      timezone: z.string().optional().describe("时区，默认 Asia/Shanghai"),
    },
    async ({ kind, description, taskPrompt, cronExpr, runAtMs, timezone }) => {
      try {
        let job;
        const common = {
          description,
          prompt: taskPrompt,
          outputs: defaultOutputs,
          sourceChannel,
          sourcePeer,
        };
        if (kind === "cron") {
          job = scheduler.createJob({ ...common, cronExpr, timezone: timezone || "Asia/Shanghai" });
        } else {
          job = scheduler.createOnceJob({ ...common, runAtMs });
        }
        const runTime = job.runAtMs
          ? new Date(job.runAtMs).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })
          : `cron: ${job.cronExpr}`;
        return { content: [{ type: "text", text: JSON.stringify({ ok: true, id: job.id, description: job.description, scheduledAt: runTime }) }] };
      } catch (err) {
        return { isError: true, content: [{ type: "text", text: `创建定时任务失败：${err.message}` }] };
      }
    }
  );

  const listSchedulesTool = tool(
    "list_schedules",
    "列出当前用户的所有定时任务",
    {},
    async () => {
      const jobs = scheduler.listJobs().filter(isCurrentJob);
      const summary = jobs.map(j => ({ id: j.id, description: j.description, cronExpr: j.cronExpr || null, runAtMs: j.runAtMs || null, enabled: j.enabled }));
      return { content: [{ type: "text", text: JSON.stringify(summary) }] };
    }
  );

  const deleteScheduleTool = tool(
    "delete_schedule",
    "删除指定 ID 的定时任务",
    { id: z.string().describe("要删除的任务 ID（从 list_schedules 获取）") },
    async ({ id }) => {
      const job = scheduler.listJobs().find(j => j.id === id);
      if (!job || !isCurrentJob(job)) {
        return { isError: true, content: [{ type: "text", text: "未找到当前用户可删除的定时任务" }] };
      }
      const ok = scheduler.deleteJob(id);
      return { content: [{ type: "text", text: JSON.stringify({ ok, id }) }] };
    }
  );

  const toggleScheduleTool = tool(
    "toggle_schedule",
    "暂停或恢复指定 ID 的定时任务",
    {
      id: z.string().describe("要暂停或恢复的任务 ID（从 list_schedules 获取）"),
      enabled: z.boolean().describe("true=恢复任务，false=暂停任务"),
    },
    async ({ id, enabled }) => {
      const job = scheduler.listJobs().find(j => j.id === id);
      if (!job || !isCurrentJob(job)) {
        return { isError: true, content: [{ type: "text", text: "未找到当前用户可操作的定时任务" }] };
      }
      const ok = scheduler.toggleJob(id, enabled);
      return { content: [{ type: "text", text: JSON.stringify({ ok, id, enabled }) }] };
    }
  );

  return createSdkMcpServer({
    name: "scheduler",
    instructions: INKFELLOW_SCHEDULER_PROMPT,
    tools: [createScheduleTool, listSchedulesTool, deleteScheduleTool, toggleScheduleTool],
    alwaysLoad: true,
  });
}

async function processWechatQuery(baseUrl, token, sender, prompt, contextToken, abortSignal, mediaFiles = []) {
  console.log(`[WeChat Agent] processWechatQuery starting for ${sender}...`);
  try {
    await sendWechatTyping(baseUrl, token, sender, 1, contextToken);

    const profileData = readProfiles();
    const active = getActiveProfile(profileData);
    console.log(`[WeChat Agent] Active profile: ${active ? active.name : "none"} (provider: ${active ? active.provider : "none"})`);

    // 取出该 sender 的对话历史，超时则清除重新开始
    const sessionEntry = wechatSenderSessions.get(sender);
    const isExpired = sessionEntry && (Date.now() - sessionEntry.lastAt >= WECHAT_SESSION_TTL_MS);
    if (isExpired) wechatSenderSessions.delete(sender);
    const history = (!isExpired && sessionEntry?.turns) ? sessionEntry.turns : [];

    const hasScheduler = hasSchedulerIntent(prompt);
    const sdkClient = buildAnthropicClientForWechat(profileData);
    const includeImageBlocks = !sdkClient || active?.provider !== "deepseek";
    const userContent = buildWechatUserContent(prompt, mediaFiles, { includeImageBlocks });
    const historyPrompt = summarizeWechatHistoryPrompt(prompt, mediaFiles);
    const wechatSystemPrompt = hasScheduler
      ? `${WECHAT_OUTPUT_PROMPT}\n\n${INKFELLOW_SCHEDULER_PROMPT}`
      : WECHAT_OUTPUT_PROMPT;

    const typingInterval = setInterval(() => {
      sendWechatTyping(baseUrl, token, sender, 1, contextToken);
    }, 6000);

    let finalResponse = "";
    let wechatStallTimer = null;
    let isWechatStall = false;
    try {
      if (sdkClient && !hasScheduler) {
        // ── 有独立 API Key 的 provider（anthropic / deepseek / openrouter）──
        // 用 Anthropic SDK messages.create()，传结构化消息数组
        const { client, model } = sdkClient;
        const messages = [
          ...history.map(t => ({ role: t.role, content: t.content })),
          { role: "user", content: userContent },
        ];
        console.log(`[WeChat Agent] messages.create (model: ${model}, history: ${history.length} turns)`);
        const response = await client.messages.create({ model, max_tokens: 4096, system: WECHAT_OUTPUT_PROMPT, messages });
        // 只取 text 块，过滤掉 thinking / redacted_thinking（不存 signature，不会报错）
        finalResponse = response.content.filter(b => b.type === "text").map(b => b.text).join("");
      } else {
        // ── claude 会员，或需要工具能力的请求：走 Agent SDK query() ──
        // 不使用 resume（thinking signature 问题），改用文本注入历史
        const agentEnv = buildAgentEnv(profileData, "medium", null);
        const wechatCwd = resolveAllowedCwd("");
        agentEnv.PWD = wechatCwd; // 工作目录与实际 cwd 一致，避免误报为启动目录
        let fullPrompt = prompt;
        if (history.length > 0) {
          const historyText = history.map(t => `${t.role === "user" ? "用户" : "助手"}：${t.content}`).join("\n");
          fullPrompt = `以下是本次对话的历史记录：\n${historyText}\n\n用户：${prompt}`;
        }
        const agentUserContent = buildWechatUserContent(fullPrompt, mediaFiles, { includeImageBlocks });
        const extraMcpServers = {
          ...(DISPATCH_AUTO_ENABLED ? {
            dispatch: _buildDispatchMcpServer({
              cwd: wechatCwd,
              permissionMode: "auto",
              profileData,
              // 微信链路按发信人隔离会话，跟 Web 那边的对话 id 是两套命名空间
              conversationId: sender ? `wechat_${String(sender).replace(/[^A-Za-z0-9_-]/g, "")}` : null,
              getAbortSignal: () => queryAbortController.signal,
            }),
          } : {}),
          ...(hasScheduler
            ? { scheduler: _buildSchedulerMcpServer({ sourceChannel: "wechat", sourcePeer: sender }) }
            : {}),
        };
        console.log(`[WeChat Agent] query() via Agent SDK (history: ${history.length} turns, scheduler: ${hasScheduler})`);
        const userMsg = {
          type: "user",
          message: { role: "user", content: agentUserContent },
          parent_tool_use_id: null,
        };
        const queryAbortController = new AbortController();
        const resetWechatStall = () => {
          clearTimeout(wechatStallTimer);
          wechatStallTimer = setTimeout(() => {
            isWechatStall = true;
            queryAbortController.abort();
          }, STREAM_STALL_MS);
        };
        if (abortSignal.aborted) {
          queryAbortController.abort();
        } else {
          abortSignal.addEventListener("abort", () => queryAbortController.abort(), { once: true });
        }
        const generator = query({
          prompt: (async function* () { yield userMsg; })(),
          options: {
            cwd: wechatCwd,
            permissionMode: "auto",
            allowDangerouslySkipPermissions: true,
            includePartialMessages: false,
            env: agentEnv,
            abortController: queryAbortController,
            mcpServers: extraMcpServers,
            systemPrompt: { type: "preset", preset: "claude_code", append: wechatSystemPrompt },
            ...(hasScheduler ? {
              disallowedTools: ["Bash"],
            } : {}),
          },
        });
        resetWechatStall();
        for await (const ev of generator) {
          resetWechatStall();
          if (ev.type === "assistant") {
            const text = (ev.message?.content || ev.content || []).filter(b => b.type === "text").map(b => b.text).join("");
            if (text) finalResponse = text;
          }
          if (ev.type === "result" && ev.subtype === "success" && ev.result) finalResponse = ev.result;
        }
        clearTimeout(wechatStallTimer);
      }
    } catch (err) {
      if (abortSignal.aborted) { console.warn(`[WeChat Agent] Aborted.`); return; }
      if (err?.name === "AbortError" && isWechatStall) {
        console.warn(`[WeChat Agent] Stream emitted no events for ${STREAM_STALL_MS / 60_000} min; aborted as frozen.`);
        finalResponse = "⚠️ AI 响应超时，请稍后重试。";
      } else {
        console.error("[WeChat Agent] Error:", err);
        finalResponse = `⚠️ 助手发生错误: ${err.message}`;
      }
    } finally {
      clearTimeout(wechatStallTimer);
      clearInterval(typingInterval);
      await sendWechatTyping(baseUrl, token, sender, 2, contextToken);
    }

    console.log(`[WeChat Agent] Response (length: ${finalResponse.length}): "${finalResponse.slice(0, 60)}..."`);

    if (!abortSignal.aborted && finalResponse.trim()) {
      try {
        await sendWechatResponseWithMedia(baseUrl, token, sender, finalResponse.trim(), contextToken);
        console.log(`[WeChat Agent] Message sent to ${sender}.`);

        // 追加本轮到历史，只存文本，超限时丢弃最早一轮
        const newTurns = [...history,
          { role: "user", content: historyPrompt },
          { role: "assistant", content: finalResponse.trim() },
        ];
        if (newTurns.length > WECHAT_MAX_HISTORY_TURNS * 2) newTurns.splice(0, 2);
        wechatSenderSessions.set(sender, { turns: newTurns, lastAt: Date.now() });
        saveWechatHistory();
      } catch (err) {
        console.error("[WeChat Agent] Failed to send message to WeChat:", err.message);
      }
    }
  } catch (outerErr) {
    console.error("[WeChat Agent] Outer execution crash:", outerErr);
  }
}

// Automatically spin up WeChat polling at server boot if credentials exist
if (existsSync(WECHAT_CONFIG_FILE)) {
  try {
    const creds = JSON.parse(readFileSync(WECHAT_CONFIG_FILE, "utf8"));
    if (creds.token && creds.baseUrl) {
      let syncBuf = "";
      if (existsSync(WECHAT_SYNC_FILE)) {
        syncBuf = JSON.parse(readFileSync(WECHAT_SYNC_FILE, "utf8")).get_updates_buf ?? "";
      }
      startWechatPolling(creds.baseUrl, creds.token, syncBuf);
    }
  } catch (err) {
    console.error("[WeChat Boot] Failed to auto-start polling:", err.message);
  }
}


// ── Scheduler init ────────────────────────────────────────
scheduler.init({
  PORT,
  DATA_DIR,
  VAULT_PATH: DEFAULT_CWD,
  WECHAT_CONFIG_FILE,
  sendWechatMessage,
  buildAgentEnv,
  getActiveProfile,
  readProfiles,
  readHistory,
  writeHistory,
  resolveAllowedCwd,
});

// ── HTTP ──────────────────────────────────────────────────
const http = createServer((req, res) => {
  const url = (req.url ?? "/").split("?")[0];
  const queryParams = new URLSearchParams((req.url ?? "/").split("?")[1] ?? "");
  const method = req.method?.toUpperCase() ?? "GET";

  // Desktop pages are only usable by the Tauri host that started this sidecar.
  if (
    DESKTOP_AGENT_TOKEN
    && queryParams.get("desktop") === "1"
    && queryParams.get("token") !== DESKTOP_AGENT_TOKEN
  ) {
    res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Forbidden");
    return;
  }

  if (url === "/api/run-state" && method === "GET") {
    if (!DESKTOP_AGENT_TOKEN || queryParams.get("token") !== DESKTOP_AGENT_TOKEN) {
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "forbidden" }));
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    res.end(JSON.stringify({ running: isAgentRunActive() }));
    return;
  }

  if (url === "/api/prepare-restart" && method === "POST") {
    if (!DESKTOP_AGENT_TOKEN || queryParams.get("token") !== DESKTOP_AGENT_TOKEN) {
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "forbidden" }));
      return;
    }
    const lease = acquireRestartLease();
    if (!lease) {
      res.writeHead(409, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      res.end(JSON.stringify({ running: true }));
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    res.end(JSON.stringify(lease));
    return;
  }

  // ── WeChat Settings API ──
  if (url === "/api/wechat/status" && method === "GET") {
    res.writeHead(200, { "Content-Type": "application/json" });
    if (existsSync(WECHAT_CONFIG_FILE)) {
      try {
        const creds = JSON.parse(readFileSync(WECHAT_CONFIG_FILE, "utf8"));
        res.end(JSON.stringify({ connected: true, botId: creds.botId ?? "微信助手" }));
        return;
      } catch {}
    }
    res.end(JSON.stringify({ connected: false }));
    return;
  }

  if (url === "/api/wechat/login/start" && method === "POST") {
    (async () => {
      try {
        const qrResp = await requestWechat(FIXED_BASE_URL, null, "ilink/bot/get_bot_qrcode?bot_type=3", { local_token_list: [] });
        if (!qrResp.qrcode_img_content) {
          throw new Error("Tencent Gateway returned empty QR code payload");
        }
        const sessionKey = `s_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
        activeWechatLogins.set(sessionKey, {
          qrcode: qrResp.qrcode,
          qrcodeUrl: qrResp.qrcode_img_content,
          startedAt: Date.now(),
          pollBaseUrl: FIXED_BASE_URL
        });
        
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, sessionKey, qrcodeUrl: qrResp.qrcode_img_content }));
      } catch (err) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      }
    })();
    return;
  }

  if (url === "/api/wechat/login/poll" && method === "GET") {
    const sessionKey = queryParams.get("sessionKey");
    const verifyCode = queryParams.get("verifyCode") ?? "";
    const session = activeWechatLogins.get(sessionKey);
    
    if (!session) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Invalid or expired login session" }));
      return;
    }

    (async () => {
      try {
        let endpoint = `ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(session.qrcode)}`;
        if (verifyCode) endpoint += `&verify_code=${encodeURIComponent(verifyCode)}`;

        const fetchUrl = `${session.pollBaseUrl}/${endpoint}`;
        const pollRes = await fetch(fetchUrl, {
          method: "GET",
          headers: { "iLink-App-Id": "bot", "iLink-App-ClientVersion": "132099" }
        });
        
        if (!pollRes.ok) {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ status: "wait" }));
          return;
        }

        const data = await pollRes.json();
        if (data.status === "scaned_but_redirect" && data.redirect_host) {
          session.pollBaseUrl = `https://${data.redirect_host}`;
        }

        if (data.status === "confirmed") {
          const configData = {
            token: data.bot_token,
            savedAt: new Date().toISOString(),
            baseUrl: data.baseurl || session.pollBaseUrl,
            userId: data.ilink_user_id,
            botId: data.ilink_bot_id
          };
          writeFileSync(WECHAT_CONFIG_FILE, JSON.stringify(configData, null, 2), "utf8");
          activeWechatLogins.delete(sessionKey);

          // Start WeChat Listener background loop automatically
          startWechatPolling(configData.baseUrl, configData.token);
        }

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: data.status, botId: data.ilink_bot_id }));
      } catch (err) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      }
    })();
    return;
  }

  if (url === "/api/wechat/logout" && method === "POST") {
    if (wechatPollingController) {
      wechatPollingController.abort();
      wechatPollingController = null;
    }
    if (existsSync(WECHAT_CONFIG_FILE)) unlinkSync(WECHAT_CONFIG_FILE);
    if (existsSync(WECHAT_SYNC_FILE)) unlinkSync(WECHAT_SYNC_FILE);

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  // ── REST API: cron scheduler ──────────────────────────────
  if (url === "/api/cron/jobs" && method === "GET") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(scheduler.listJobs()));
    return;
  }

  if (url === "/api/cron/jobs" && method === "POST") {
    let body = "";
    req.on("data", c => { body += c; });
    req.on("end", () => {
      try {
        const payload = JSON.parse(body || "{}");
        const job = scheduler.createJob(payload);
        res.writeHead(201, { "Content-Type": "application/json" });
        res.end(JSON.stringify(job));
      } catch (err) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  if (url === "/api/cron/jobs/once" && method === "POST") {
    let body = "";
    req.on("data", c => { body += c; });
    req.on("end", () => {
      try {
        const payload = JSON.parse(body || "{}");
        const job = scheduler.createOnceJob(payload);
        res.writeHead(201, { "Content-Type": "application/json" });
        res.end(JSON.stringify(job));
      } catch (err) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  const cronJobRe = url.match(/^\/api\/cron\/jobs\/([^/]+)$/);
  if (cronJobRe) {
    const id = cronJobRe[1];
    if (method === "DELETE") {
      const ok = scheduler.deleteJob(id);
      res.writeHead(ok ? 200 : 404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok }));
      return;
    }
    if (method === "PATCH") {
      let body = "";
      req.on("data", c => { body += c; });
      req.on("end", () => {
        try {
          const payload = JSON.parse(body || "{}");
          if (typeof payload.enabled !== "boolean") throw new Error("enabled 必须是布尔值");
          const ok = scheduler.toggleJob(id, payload.enabled);
          res.writeHead(ok ? 200 : 404, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok }));
        } catch (err) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: err.message }));
        }
      });
      return;
    }
  }

  // ── REST API: history ─────────────────────────────────────
  if (url === "/api/history" && method === "GET") {
    const history = readHistory();
    // 列表只返回摘要，不带消息内容，避免传输几MB JSON
    const summaries = history.map(({ id, title, date, messages }) => ({
      id, title, date, messageCount: messages ? messages.length : 0,
    }));
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(summaries));
    return;
  }

  if (url === "/api/auth-profile" && method === "GET") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(toPublicProfiles()));
    return;
  }

  if (url === "/api/providers" && method === "GET") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ providers: listDispatchProviders() }));
    return;
  }

  // ── Claude subscription auth status ──────────────────────────
  // Run `claude auth status` — the only reliable way to check login state,
  // since credentials may be stored in the system keychain rather than a file.
  if (url === "/api/health/claude-auth" && method === "GET") {
    let stdout = "";
    let stderr = "";
    const proc = spawn("claude", ["auth", "status"], {
      timeout: 6000,
      env: { ...process.env, NO_COLOR: "1" },
    });
    proc.stdout?.on("data", d => { stdout += d; });
    proc.stderr?.on("data", d => { stderr += d; });
    // Guard against double-response: both "error" and "close" fire when spawn fails,
    // the second writeHead call crashes the server (ERR_HTTP_HEADERS_SENT).
    let authResponded = false;
    const sendAuthResponse = (body) => {
      if (authResponded) return;
      authResponded = true;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    };
    proc.on("error", () => sendAuthResponse({ authenticated: false, detail: "claude CLI not found" }));
    proc.on("close", () => {
      let detail = {};
      try { detail = JSON.parse(stdout); } catch { detail = { raw: stdout.trim() || stderr.trim() }; }
      sendAuthResponse({ authenticated: detail.loggedIn === true, detail });
    });
    return;
  }

  if (url === "/api/health/codex-auth" && method === "GET") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ authenticated: isCodexAuthAvailable() }));
    return;
  }

  if (url === "/api/usage-limits" && method === "GET") {
    (async () => {
      const [claude, codex] = await Promise.all([
        getClaudeSubscriptionLimits(),
        queryCodexSubscriptionLimits(),
      ]);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        providers: {
          claude,
          codex,
        },
      }));
    })().catch((err) => {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: String(err?.message || err) }));
    });
    return;
  }

  if (url === "/api/auth-profile" && method === "PUT") {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      try {
        const payload = JSON.parse(body || "{}");
        const current = readProfiles();
        let next;

        if (payload.action === "activate") {
          // 切换当前账号
          const id = String(payload.profileId ?? "");
          if (!current.profiles.some(p => p.id === id)) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "账号不存在" }));
            return;
          }
          next = { ...current, activeProfileId: id };

        } else if (payload.action === "add") {
          // 新增账号
          const profile = normalizeProfile(payload.profile ?? {});
          if (profile.provider !== "claude" && profile.provider !== "codex" && !profile.apiKey) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "API Key 不能为空" }));
            return;
          }
          if (!profile.baseUrl && profile.provider !== "claude" && profile.provider !== "anthropic" && profile.provider !== "codex") {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Base URL 不能为空" }));
            return;
          }
          next = { ...current, profiles: [...current.profiles, profile], activeProfileId: profile.id };

        } else if (payload.action === "update") {
          // 编辑已有账号
          const id = String(payload.profile?.id ?? "");
          const target = current.profiles.find(p => p.id === id);
          if (!target) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "账号不存在" }));
            return;
          }
          const updated = normalizeProfile({ ...target, ...payload.profile, id: target.id, provider: target.provider });
          if (updated.provider !== "claude" && updated.provider !== "codex" && !updated.apiKey) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "API Key 不能为空" }));
            return;
          }
          if (!updated.baseUrl && updated.provider !== "claude" && updated.provider !== "anthropic" && updated.provider !== "codex") {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Base URL 不能为空" }));
            return;
          }
          next = { ...current, profiles: current.profiles.map(p => p.id === id ? updated : p) };

        } else if (payload.action === "delete") {
          // 删除账号（不能删 Claude 会员 / 不能删到空）
          const id = String(payload.profileId ?? "");
          const target = current.profiles.find(p => p.id === id);
          if (!target || target.provider === "claude") {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "该账号不能删除" }));
            return;
          }
          const profiles = current.profiles.filter(p => p.id !== id);
          const activeProfileId = current.activeProfileId === id
            ? (profiles[0]?.id ?? "p_claude")
            : current.activeProfileId;
          next = { profiles, activeProfileId };

        } else {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "unknown action" }));
          return;
        }

        const changed = JSON.stringify(current) !== JSON.stringify(next);
        writeProfiles(next);
        if (changed) clearSession();

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, resetSession: changed, data: toPublicProfiles(next) }));
      } catch {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "bad request" }));
      }
    });
    return;
  }

  const historyItemRe = url.match(/^\/api\/history\/([^/]+)$/);
  if (historyItemRe) {
    const id = historyItemRe[1];
    if (method === "GET") {
      const conv = readHistory().find(h => h.id === id);
      if (conv) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(conv));
      } else {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "not found" }));
      }
      return;
    }
    if (method === "PUT") {
      let body = "";
      req.on("data", (chunk) => { body += chunk; });
      req.on("end", () => {
        try {
          const payload = JSON.parse(body || "{}");
          const saved = upsertHistoryConversation({ ...payload, id });
          if (!saved) throw new Error("invalid conversation");
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true }));
        } catch {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "bad request" }));
        }
      });
      return;
    }
    if (method === "DELETE") {
      const history = readHistory().filter(h => h.id !== id);
      writeHistory(history);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
  }

  // ── Static assets ─────────────────────────────────────────
  if (url !== "/" && url !== "/index.html") {
    const filePath = resolvePublicFile(url);
    if (filePath && existsSync(filePath)) {
      const mime = MIME[extname(filePath)] ?? "application/octet-stream";
      res.writeHead(200, { "Content-Type": mime });
      res.end(readFileSync(filePath));
      return;
    }
  }
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(readFileSync(htmlPath, "utf8"));
});


// ── WebSocket ─────────────────────────────────────────────

const wss = new WebSocketServer({ noServer: true });

http.on("upgrade", (req, socket, head) => {
  const params = new URL(req.url ?? "/", `http://${req.headers.host || "localhost"}`).searchParams;
  if (DESKTOP_AGENT_TOKEN && params.get("token") !== DESKTOP_AGENT_TOKEN) {
    socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
    socket.destroy();
    return;
  }
wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit("connection", ws, req);
  });
});

function normalizeAskUserQuestions(input) {
  const rawQuestions = Array.isArray(input?.questions) ? input.questions : [];
  return rawQuestions.slice(0, 4).map((raw, index) => {
    const question = typeof raw?.question === "string" && raw.question.trim()
      ? raw.question.trim()
      : `Question ${index + 1}`;
    const header = typeof raw?.header === "string" && raw.header.trim()
      ? raw.header.trim().slice(0, 24)
      : `Q${index + 1}`;
    const options = Array.isArray(raw?.options) ? raw.options.slice(0, 4).map((opt, optIndex) => ({
      label: typeof opt?.label === "string" && opt.label.trim() ? opt.label.trim() : `Option ${optIndex + 1}`,
      description: typeof opt?.description === "string" ? opt.description.trim() : "",
      ...(typeof opt?.preview === "string" ? { preview: opt.preview } : {}),
    })).filter(opt => opt.label) : [];
    return {
      question,
      header,
      options,
      multiSelect: raw?.multiSelect === true,
    };
  }).filter(q => q.question && q.options.length >= 2);
}

function makeAbortError(message) {
  const err = new Error(message);
  err.name = "AbortError";
  return err;
}

// ── Background-run state (module scope) ──────────────────
// The desktop app is a single-user client, and runs must survive WebSocket drops
// (sleep/wake, webview reloads, proxy switches). So the abort controller, the
// pending clarification question, and the outbound channel live at module scope
// instead of per-connection: a dropped socket detaches the client but leaves the
// run alive; events are buffered and flushed when the client reconnects.
let activeWs = null;
let abortCtrl = null;
let pendingAskUserQuestion = null;
const DETACHED_BUFFER_MAX = 2000;
let detachedBuffer = [];
const RESTART_LEASE_MS = 15_000;
let restartLease = null;
let activeForegroundRequestId = null;
let activeForegroundConversationId = null;
let claudeRuntimeConversationId = null;
let claudeAutoWakeOwner = null;
let claudeAutoWakeOwnerTimer = null;
const taskEventOwners = new Map();
const taskEventOwnerTimers = new Map();
const TASK_EVENT_OWNER_TTL_MS = 5 * 60_000;

function getActiveRestartLease() {
  if (restartLease && restartLease.expiresAt > Date.now()) return restartLease;
  restartLease = null;
  return null;
}

function acquireRestartLease() {
  const existing = getActiveRestartLease();
  if (existing) return existing;
  if (isAgentWorkActive()) return null;
  restartLease = {
    lease: crypto.randomUUID(),
    expiresAt: Date.now() + RESTART_LEASE_MS,
  };
  // The process is about to restart, so close an otherwise-idle persistent
  // Query under the same atomic lease. This prevents a late autonomous SDK
  // continuation from starting between the lease grant and process restart.
  if (claudeRuntime.started) {
    claudeRuntime.close();
    claudeRuntimeSignature = null;
    claudeRuntimeConversationId = null;
  }
  return restartLease;
}

function currentAgentEventOwner() {
  if (activeForegroundRequestId || activeForegroundConversationId) {
    return {
      requestId: activeForegroundRequestId,
      conversationId: activeForegroundConversationId,
    };
  }
  if (claudeAutoWakeOwner) return claudeAutoWakeOwner;
  return {
    requestId: null,
    conversationId: claudeRuntimeConversationId,
  };
}

function scheduleTaskEventOwnerCleanup(taskId) {
  clearTimeout(taskEventOwnerTimers.get(taskId));
  const timer = setTimeout(() => {
    taskEventOwnerTimers.delete(taskId);
    taskEventOwners.delete(taskId);
  }, TASK_EVENT_OWNER_TTL_MS);
  timer.unref?.();
  taskEventOwnerTimers.set(taskId, timer);
}

function ensureTaskEventOwner(event) {
  if (!isTaskLifecycleEvent(event) || !event.task_id) return null;
  let owner = taskEventOwners.get(event.task_id);
  if (!owner) {
    owner = currentAgentEventOwner();
    taskEventOwners.set(event.task_id, owner);
  }
  const terminalUpdate = event.subtype === "task_updated"
    && ["completed", "failed", "killed"].includes(event.patch?.status);
  if (event.subtype === "task_notification" || terminalUpdate) {
    scheduleTaskEventOwnerCleanup(event.task_id);
  }
  return owner;
}

function setClaudeAutoWakeOwner(owner) {
  if (!owner) return;
  claudeAutoWakeOwner = owner;
  clearTimeout(claudeAutoWakeOwnerTimer);
  claudeAutoWakeOwnerTimer = setTimeout(() => {
    claudeAutoWakeOwner = null;
    claudeAutoWakeOwnerTimer = null;
  }, 30_000);
  claudeAutoWakeOwnerTimer.unref?.();
}

function tagAgentEvent(obj) {
  if (!obj || (obj.type === "system" && obj.subtype === "init")) return obj;
  const owner = isTaskLifecycleEvent(obj)
    ? (ensureTaskEventOwner(obj) ?? currentAgentEventOwner())
    : currentAgentEventOwner();
  const tagged = { ...obj };
  if (!("userMessageId" in tagged) && owner?.requestId) tagged.userMessageId = owner.requestId;
  if (!("conversationId" in tagged) && owner?.conversationId) tagged.conversationId = owner.conversationId;
  return tagged;
}

const deliver = (obj) => {
  if (activeWs && activeWs.readyState === activeWs.OPEN) {
    try {
      activeWs.send(JSON.stringify(obj));
      return;
    } catch (error) {
      console.warn("[Web Agent] WebSocket delivery failed; buffering until reconnect:", String(error));
      activeWs = null;
    }
  }
  // No client attached: buffer so the UI can catch up after reconnect, but only
  // while something is actually in flight (run or unanswered question).
  if (isAgentRunActive()) {
    detachedBuffer.push(obj);
    if (detachedBuffer.length > DETACHED_BUFFER_MAX) {
      detachedBuffer.splice(0, detachedBuffer.length - DETACHED_BUFFER_MAX);
    }
  }
};

const send = (obj) => {
  const tagged = tagAgentEvent(obj);
  persistOutboundAgentEvent(tagged);
  deliver(tagged);
};

const CLIENT_REQUEST_STATE_MAX = 500;
const clientRequestStates = new Map();

function getClientRequestId(msg) {
  if (msg?.userMessageId == null || String(msg.userMessageId).trim() === "") return null;
  return normalizeHistoryId(String(msg.userMessageId));
}

function rememberClientRequest(requestId, state) {
  if (!requestId) return;
  clientRequestStates.set(requestId, { state, updatedAt: Date.now() });
  if (clientRequestStates.size <= CLIENT_REQUEST_STATE_MAX) return;
  for (const [id, entry] of clientRequestStates) {
    if (id === activeForegroundRequestId || entry.state === "queued" || entry.state === "running") continue;
    clientRequestStates.delete(id);
    if (clientRequestStates.size <= CLIENT_REQUEST_STATE_MAX) break;
  }
}

function acknowledgeClientRequest(requestId, state) {
  if (!requestId) return;
  deliver({ type: "request_ack", userMessageId: requestId, state });
}

function startClientRequest(requestId, conversationId) {
  activeForegroundRequestId = requestId;
  activeForegroundConversationId = conversationId;
  rememberClientRequest(requestId, "running");
  acknowledgeClientRequest(requestId, "running");
  deliver({ type: "request_started", userMessageId: requestId, conversationId });
}

function completeClientRequest(state, requestId = activeForegroundRequestId) {
  if (requestId) rememberClientRequest(requestId, state);
  if (activeForegroundRequestId === requestId) {
    activeForegroundRequestId = null;
    activeForegroundConversationId = null;
  }
}

const FORWARDED_CLAUDE_SYSTEM_EVENTS = new Set([
  "api_retry",
  "status",
  "session_state_changed",
  "task_started",
  "task_progress",
  "task_updated",
  "task_notification",
]);

let claudeRuntimeSignature = null;
let claudeTurnCompletionPending = false;
let claudeStopRequested = false;
let claudeRecoveryContext = null;
let claudePendingRecovery = null;
let claudeErrorHandled = false;
let claudeTaskWakeGraceUntil = 0;
let claudeTurnEpoch = 0;
const queuedClientPrompts = [];
let queuedClientPromptDrain = null;
let queuedClientPromptDrainTimer = null;

function scheduleQueuedClientPromptDrain(delayMs = 0) {
  // Never replace the task-wake grace timer with an earlier callback that can
  // only return. This used to strand queued prompts forever after auto-wake.
  const graceDelay = Math.max(0, claudeTaskWakeGraceUntil - Date.now() + 10);
  const effectiveDelay = Math.max(delayMs, graceDelay);
  clearTimeout(queuedClientPromptDrainTimer);
  queuedClientPromptDrainTimer = setTimeout(() => {
    queuedClientPromptDrainTimer = null;
    queuedClientPromptDrain?.();
  }, effectiveDelay);
}

function isThinkingSignatureError(error) {
  const text = String(error);
  return text.includes("signature") && text.includes("thinking");
}

// 回合终止依赖 SDK 的 session_state_changed/idle，而该事件是 opt-in 的（见
// buildAgentEnv）。上一次它静默失效时没有任何报错、日志或测试失败，只有用户
// 手动发第二条消息才暴露。看门狗把这种失效变成可见信号：result 之后短时间内
// 没等到 idle 就告警。纯观察，不改变回合行为。
const TURN_IDLE_WATCHDOG_MS = 3_000;
let turnIdleWatchdog = null;

function clearTurnIdleWatchdog() {
  clearTimeout(turnIdleWatchdog);
  turnIdleWatchdog = null;
}

function armTurnIdleWatchdog() {
  clearTurnIdleWatchdog();
  if (!claudeTurnCompletionPending) return;
  const epoch = claudeTurnEpoch;
  turnIdleWatchdog = setTimeout(() => {
    turnIdleWatchdog = null;
    // 回合已经换代或已结束 → 不是失效，是正常时序
    if (epoch !== claudeTurnEpoch || !claudeTurnCompletionPending) return;
    console.warn(
      `[Web Agent] result 后 ${TURN_IDLE_WATCHDOG_MS}ms 未收到 session_state_changed/idle：`
      + "本轮无法结束，后续消息将被排队。检查 SDK 是否仍支持 "
      + "CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS=1（见 buildAgentEnv）。"
    );
  }, TURN_IDLE_WATCHDOG_MS);
  turnIdleWatchdog.unref?.();
}

function finishClaudeTurn() {
  clearTurnIdleWatchdog();
  if (!claudeTurnCompletionPending) return;
  const wasStopped = claudeStopRequested;
  const completedRequestId = activeForegroundRequestId;
  // Emit the terminal event while the run is still marked active so a detached
  // desktop WebView buffers it and cannot reconnect stuck in generating state.
  clearPendingAskUserQuestion("request finished");
  send({ type: wasStopped ? "stopped" : "done" });
  completeClientRequest(wasStopped ? "stopped" : "complete", completedRequestId);
  claudeTurnCompletionPending = false;
  claudeStopRequested = false;
  claudeRecoveryContext = null;
  claudeErrorHandled = false;
  scheduleQueuedClientPromptDrain();
}

async function handlePersistentClaudeEvent(ev) {
  const taskOwner = ensureTaskEventOwner(ev);
  const terminalTaskUpdate = ev.type === "system"
    && ev.subtype === "task_updated"
    && ["completed", "failed", "killed"].includes(ev.patch?.status);
  if (ev.type === "system" && ev.subtype === "task_notification") {
    setClaudeAutoWakeOwner(taskOwner);
  }
  if (ev.type === "system" && ev.subtype === "init") {
    if (claudeRuntimeConversationId) activeHistoryConversationId = claudeRuntimeConversationId;
    saveSession(ev.session_id);
    send({ type: "session", sessionId: ev.session_id });
    const skillsFromSdk = Array.isArray(ev.skills) && ev.skills.length > 0
      ? ev.skills
      : (Array.isArray(ev.slash_commands) ? ev.slash_commands : []);
    if (skillsFromSdk.length > 0) cachedSkillsByProvider["claude"] = skillsFromSdk;
    send({
      type: "system",
      subtype: "init",
      slash_commands: skillsFromSdk,
      skills: skillsFromSdk,
    });
    return;
  }

  if (ev.type === "system") {
    if (ev.subtype === "task_notification" || terminalTaskUpdate) {
      // A completed background task can immediately inject a synthetic message
      // and wake the model. Keep restart deferral active across that tiny gap.
      claudeTaskWakeGraceUntil = Date.now() + 5_000;
      scheduleQueuedClientPromptDrain(5_050);
    }
    if (
      ev.subtype === "session_state_changed"
      && ev.state !== "idle"
      && !claudeTurnCompletionPending
    ) {
      if (claudeRuntimeConversationId) activeHistoryConversationId = claudeRuntimeConversationId;
      claudeTurnCompletionPending = true;
      claudeStopRequested = false;
      claudeErrorHandled = false;
      activeHistoryTurnOpen = true;
      activeHistoryTurnConversationId = claudeRuntimeConversationId;
      activeAssistantHistoryMessage = null;
    }
    if (FORWARDED_CLAUDE_SYSTEM_EVENTS.has(ev.subtype)) send(ev);
    if (ev.subtype === "session_state_changed" && ev.state === "idle") finishClaudeTurn();
    return;
  }

  send(ev);
  // origin 非空表示这条 result 来自后台任务的自动续写，不是用户轮的收尾，
  // 此时前台轮可能仍在正常运行 —— 不进入看门狗，避免误报。
  if (ev.type === "result" && !ev.origin) armTurnIdleWatchdog();
}

async function handlePersistentClaudeError(error) {
  const recovery = claudeRecoveryContext;
  if (
    claudeTurnCompletionPending
    && !claudeStopRequested
    && recovery
    && !recovery.attempted
    && isThinkingSignatureError(error)
  ) {
    const message = recovery.buildMessage();
    if (message) {
      recovery.attempted = true;
      clearSession();
      const options = { ...recovery.options };
      delete options.resume;
      claudePendingRecovery = { message, options, signature: recovery.signature };
      console.warn("[Web Agent] Thinking-signature error; recovering with text-injected history.");
      return;
    }
  }

  claudeErrorHandled = true;
  if (claudeStopRequested || error?.name === "AbortError") {
    claudeStopRequested = true;
  } else {
    send({ type: "error", text: String(error) });
  }
  finishClaudeTurn();
}

async function handlePersistentClaudeClose() {
  const recovery = claudePendingRecovery;
  claudePendingRecovery = null;
  if (recovery) {
    try {
      claudeRuntime.start(recovery.options);
      claudeRuntimeSignature = recovery.signature;
      claudeRuntime.send(recovery.message);
      return;
    } catch (error) {
      send({ type: "error", text: String(error) });
    }
  }
  claudeRuntimeSignature = null;
  claudeRuntimeConversationId = null;
  if (claudeTurnCompletionPending && !claudeErrorHandled) finishClaudeTurn();
}

const claudeRuntime = new PersistentQueryRuntime({
  queryFactory: query,
  onEvent: handlePersistentClaudeEvent,
  onError: handlePersistentClaudeError,
  onClose: handlePersistentClaudeClose,
  onCallbackError: (error, context) => {
    console.error(`[Web Agent] ${context.source} callback failed without stopping the Claude runtime:`, error);
  },
});

function isForegroundRunActive() {
  return Boolean(abortCtrl || claudeTurnCompletionPending || claudeRuntime.foregroundRunning || pendingAskUserQuestion);
}

function shouldQueueClientPrompt() {
  return isForegroundRunActive() || Date.now() < claudeTaskWakeGraceUntil;
}

function isAgentWorkActive() {
  return Boolean(
    abortCtrl
    || activeForegroundRequestId
    || claudeTurnCompletionPending
    || claudeRuntime.running
    || pendingAskUserQuestion
    || queuedClientPrompts.length > 0
    || Date.now() < claudeTaskWakeGraceUntil
  );
}

function isAgentRunActive() {
  return isAgentWorkActive() || Boolean(getActiveRestartLease());
}

const clearPendingAskUserQuestion = (reason = "cancelled") => {
    if (!pendingAskUserQuestion) return;
    const pending = pendingAskUserQuestion;
    pendingAskUserQuestion = null;
    pending.cleanup?.();
    pending.reject(makeAbortError(reason));
    send({ type: "ask_user_question_cancelled", requestId: pending.requestId, reason });
  };

  const waitForAskUserQuestionAnswer = (input, context = {}) => {
    const questions = normalizeAskUserQuestions(input);
    if (questions.length === 0) {
      return Promise.reject(new Error("AskUserQuestion request is missing questions/options"));
    }
    clearPendingAskUserQuestion("new question replaced the previous question");

    const requestId = crypto.randomUUID();
    send({
      type: "ask_user_question",
      requestId,
      toolUseID: context.toolUseID ?? null,
      questions,
    });

    return new Promise((resolve, reject) => {
      const onAbort = () => {
        if (pendingAskUserQuestion?.requestId !== requestId) return;
        pendingAskUserQuestion = null;
        reject(makeAbortError("user input cancelled"));
        send({ type: "ask_user_question_cancelled", requestId, reason: "aborted" });
      };
      const signal = context.signal;
      if (signal?.aborted) {
        reject(makeAbortError("user input cancelled"));
        return;
      }
      signal?.addEventListener("abort", onAbort, { once: true });
      pendingAskUserQuestion = {
        requestId,
        questions,
        toolUseID: context.toolUseID ?? null,
        cleanup: () => signal?.removeEventListener("abort", onAbort),
        reject,
        resolve: (payload = {}) => {
          if (pendingAskUserQuestion?.requestId !== requestId) return;
          pendingAskUserQuestion = null;
          signal?.removeEventListener("abort", onAbort);
          const rawAnswers = payload && typeof payload.answers === "object" && payload.answers !== null
            ? payload.answers
            : {};
          const answers = {};
          for (const question of questions) {
            const raw = rawAnswers[question.question];
            const value = Array.isArray(raw)
              ? raw.map(v => String(v ?? "").trim()).filter(Boolean).join(", ")
              : String(raw ?? "").trim();
            if (value) answers[question.question] = value;
          }
          const response = typeof payload.response === "string" ? payload.response.trim() : "";
          if (Object.keys(answers).length === 0 && !response) {
            reject(new Error("No valid answer received"));
            return;
          }
          resolve({ questions, answers, response });
        },
      };
    });
  };

wss.on("connection", (ws) => {
  // Last connection wins; any previous socket is stale (single-user desktop app).
  const previousWs = activeWs;
  activeWs = ws;
  if (previousWs && previousWs !== ws && previousWs.readyState === previousWs.OPEN) {
    previousWs.close(1000, "replaced by newer connection");
  }

  // Application-level heartbeat: browser JS can't observe protocol-level pings,
  // so send a JSON ping the frontend can use to detect a silently dead socket.
  const pingTimer = setInterval(() => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: "ping" }));
  }, 30_000);

  // Send the persisted default first; the browser sends a profile-specific refresh
  // after it loads its local activeProfileId.
  sendSkillInit(send, getActiveProfile(readProfiles())?.provider);

  // Reattach to an in-flight run: restore the generating UI, replay whatever
  // happened while detached, and re-show a still-unanswered question.
  const queuedAttachRequestId = getClientRequestId(queuedClientPrompts[0]);
  const attachedRequestId = activeForegroundRequestId || queuedAttachRequestId;
  const queuedAttachConversationId = queuedClientPrompts[0]?.conversationId
    ? normalizeHistoryId(queuedClientPrompts[0].conversationId)
    : null;
  const attachedConversationId = activeForegroundConversationId || queuedAttachConversationId;
  const reattachRunning = isForegroundRunActive() || Boolean(attachedRequestId);
  if (isAgentRunActive() || detachedBuffer.length > 0) {
    const backlog = detachedBuffer;
    detachedBuffer = [];
    let questionInBacklog = false;
    for (const obj of backlog) {
      if (obj?.type === "ask_user_question" && obj.requestId === pendingAskUserQuestion?.requestId) {
        questionInBacklog = true;
      }
      deliver(obj);
    }
    if (pendingAskUserQuestion && !questionInBacklog) {
      deliver({
        type: "ask_user_question",
        requestId: pendingAskUserQuestion.requestId,
        toolUseID: pendingAskUserQuestion.toolUseID ?? null,
        questions: pendingAskUserQuestion.questions,
      });
    }
  }
  // Replay events under their original owner first, then publish the current
  // foreground/queued snapshot. This prevents old backlog from being mistaken
  // for the newly attached request.
  deliver({
    type: "run_attached",
    running: reattachRunning,
    userMessageId: attachedRequestId,
    conversationId: attachedConversationId,
  });

  let handleClientMessage;
  const drainThisConnection = () => {
    if (activeWs !== ws || shouldQueueClientPrompt() || queuedClientPrompts.length === 0) return;
    const next = queuedClientPrompts.shift();
    handleClientMessage(JSON.stringify(next), true);
  };
  queuedClientPromptDrain = drainThisConnection;
  handleClientMessage = (raw, fromQueue = false) => {
    if (activeWs !== ws) return;
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    if (msg.type === "skills") {
      const profileData = readProfiles();
      if (msg.profileId && profileData.profiles.some(p => p.id === msg.profileId)) {
        profileData.activeProfileId = msg.profileId;
      }
      const activeProfile = getActiveProfile(profileData);
      sendSkillInit(send, activeProfile?.provider ?? msg.provider);
      return;
    }

    if (msg.type === "ask_user_question_response") {
      if (!pendingAskUserQuestion || msg.requestId !== pendingAskUserQuestion.requestId) {
        send({ type: "ask_user_question_error", requestId: msg.requestId ?? null, text: "This question has expired. Please retry the request." });
        return;
      }
      pendingAskUserQuestion.resolve(msg);
      return;
    }

    if (msg.type === "ask_user_question_cancel") {
      clearPendingAskUserQuestion("user cancelled clarification question");
      return;
    }

    if (msg.reset) {
      claudeTurnEpoch += 1;
      clearPendingAskUserQuestion("session reset");
      finalizeActiveAssistantHistory("stopped");
      // 派发会话一并作废——重置后是新话题，再接着上一轮就成了串台。
      // 必须赶在 clearActiveHistoryConversation() 把 id 置空之前取。
      // 这里不能用 normalizeHistoryId：它拿不到合法值时会造一个新 id，
      // 而前端多数 reset 只发 {reset:true}，那样清掉的是个随机键，等于没清。
      forgetDispatchSessions(historyIdOrNull(msg.conversationId) || activeHistoryConversationId);
      clearActiveHistoryConversation();
      clearSession();
      clearCodexThread();
      if (abortCtrl) { abortCtrl.abort(); abortCtrl = null; }
      claudeRuntime.close();
      claudeRuntimeSignature = null;
      claudeRuntimeConversationId = null;
      claudeTurnCompletionPending = false;
      claudeStopRequested = false;
      claudeRecoveryContext = null;
      claudePendingRecovery = null;
      claudeTaskWakeGraceUntil = 0;
      activeForegroundRequestId = null;
      activeForegroundConversationId = null;
      claudeAutoWakeOwner = null;
      clearTimeout(claudeAutoWakeOwnerTimer);
      claudeAutoWakeOwnerTimer = null;
      for (const timer of taskEventOwnerTimers.values()) clearTimeout(timer);
      taskEventOwnerTimers.clear();
      taskEventOwners.clear();
      queuedClientPrompts.length = 0;
      clientRequestStates.clear();
      detachedBuffer = [];
      clearTimeout(queuedClientPromptDrainTimer);
      queuedClientPromptDrainTimer = null;
      deliver({ type: "reset_complete" });
      return;
    }

    if (msg.setSession != null) {
      saveSession(String(msg.setSession));
      if (msg.conversationId) {
        const nextConversationId = normalizeHistoryId(msg.conversationId);
        // A generation still streaming into a different conversation owns
        // activeHistoryConversationId until it finalizes — viewing another
        // conversation must not redirect its in-flight output.
        const generatingElsewhere = activeHistoryTurnOpen
          && activeHistoryTurnConversationId !== nextConversationId;
        if (!generatingElsewhere) {
          activeHistoryConversationId = nextConversationId;
          updateActiveConversationSession(String(msg.setSession));
        }
      }
      return;
    }

    if (msg.stop) {
      const requestedStopId = getClientRequestId(msg);
      if (requestedStopId) {
        const queuedIndex = queuedClientPrompts.findIndex(item => getClientRequestId(item) === requestedStopId);
        if (queuedIndex >= 0) {
          queuedClientPrompts.splice(queuedIndex, 1);
          rememberClientRequest(requestedStopId, "stopped");
          deliver({ type: "stopped", userMessageId: requestedStopId });
          scheduleQueuedClientPromptDrain();
          return;
        }
        if (activeForegroundRequestId !== requestedStopId) {
          const known = clientRequestStates.get(requestedStopId);
          if (known) acknowledgeClientRequest(requestedStopId, known.state);
          return;
        }
      }
      clearPendingAskUserQuestion("generation stopped");
      const claudeTurnWasPending = claudeTurnCompletionPending;
      claudeTurnEpoch += 1;
      if (abortCtrl) {
        const stoppedRequestId = activeForegroundRequestId;
        const activeAbort = abortCtrl;
        abortCtrl = null;
        activeAbort.abort();
        send({ type: "stopped" });
        completeClientRequest("stopped", stoppedRequestId);
        finalizeActiveAssistantHistory("stopped");
        scheduleQueuedClientPromptDrain();
      } else if (claudeTurnWasPending) {
        claudeStopRequested = true;
        if (claudeRuntime.foregroundRunning) {
          claudeRuntime.interrupt().catch((error) => {
            send({ type: "error", text: String(error) });
            finishClaudeTurn();
          });
        } else {
          finishClaudeTurn();
        }
      } else if (claudeRuntime.foregroundRunning) {
        claudeRuntime.interrupt().catch((error) => {
          send({ type: "error", text: String(error) });
          finishClaudeTurn();
        });
      } else {
        send({ type: "stopped", userMessageId: requestedStopId ?? null });
        completeClientRequest("stopped", requestedStopId);
      }
      return;
    }

    // The frontend normally queues follow-ups. Keep this server-side guard so a
    // stale or third-party client can never turn a new message into an implicit Stop.
    const requestId = getClientRequestId(msg);
    const knownRequest = requestId ? clientRequestStates.get(requestId) : null;
    if (!fromQueue && knownRequest) {
      acknowledgeClientRequest(requestId, knownRequest.state);
      if (knownRequest.state === "queued") {
        const position = queuedClientPrompts.findIndex(item => getClientRequestId(item) === requestId) + 1;
        deliver({ type: "request_queued", reason: "busy", position: position || null, userMessageId: requestId });
      } else if (knownRequest.state === "running") {
        deliver({ type: "request_started", userMessageId: requestId });
      }
      return;
    }

    const activeRestartLease = getActiveRestartLease();
    if (activeRestartLease) {
      deliver({
        type: "request_retry",
        reason: "sidecar_restarting",
        userMessageId: requestId,
        retryAfterMs: Math.max(100, activeRestartLease.expiresAt - Date.now() + 50),
      });
      return;
    }

    const incomingProfileData = readProfiles();
    if (msg.profileId && incomingProfileData.profiles.some(p => p.id === msg.profileId)) {
      incomingProfileData.activeProfileId = msg.profileId;
    }
    const incomingDispatchProfile = msg.dispatchProvider
      ? resolveDispatchProfile(incomingProfileData, msg.dispatchProvider)
      : null;
    const incomingProvider = incomingDispatchProfile?.provider
      ?? getActiveProfile(incomingProfileData)?.provider
      ?? "claude";
    const crossesActiveClaudeTasks = incomingProvider === "codex" && claudeRuntime.taskIds.size > 0;
    if (shouldQueueClientPrompt() || crossesActiveClaudeTasks) {
      if (fromQueue) queuedClientPrompts.unshift(msg);
      else queuedClientPrompts.push(msg);
      rememberClientRequest(requestId, "queued");
      acknowledgeClientRequest(requestId, "queued");
      const position = queuedClientPrompts.findIndex(item => item === msg) + 1;
      deliver({
        type: "request_queued",
        reason: crossesActiveClaudeTasks ? "provider_switch_wait" : "busy",
        position: position || queuedClientPrompts.length,
        userMessageId: requestId,
      });
      return;
    }
    const requestConversationId = normalizeHistoryId(msg.conversationId);
    msg.conversationId = requestConversationId;
    startClientRequest(requestId, requestConversationId);
    finalizeActiveAssistantHistory("complete");
    beginServerConversationFromClient(msg);

    const schedulerRequest = hasSchedulerIntent(msg.prompt);

    // Build message content — text only, or images + text
    const content = [];
    const images = msg.images ?? (msg.image ? [msg.image] : []); // support both formats
    for (const img of images) {
      content.push({
        type: "image",
        source: { type: "base64", media_type: img.mediaType, data: img.data },
      });
    }
    content.push({ type: "text", text: msg.prompt });

    const userMsg = {
      type: "user",
      message: { role: "user", content },
      parent_tool_use_id: null,
      priority: "next",
    };

    const ac = new AbortController();
    const permissionMode = PERMISSION_MODES.has(msg.permissionMode)
      ? msg.permissionMode
      : DEFAULT_PERMISSION_MODE;
    const effort = EFFORT_LEVELS.has(msg.effort) ? msg.effort : "medium";
    const profileData = readProfiles();
    // activeProfileId 由客户端 localStorage 管理，随每条消息传入；服务端直接使用，无需持久化
    if (msg.profileId && profileData.profiles.some(p => p.id === msg.profileId)) {
      profileData.activeProfileId = msg.profileId;
    }
    const activeProfile = getActiveProfile(profileData);

    if (!msg.dispatchProvider && activeProfile && activeProfile.provider !== "claude" && activeProfile.provider !== "codex" && !activeProfile.apiKey) {
      send({ type: "error", text: `${activeProfile.name} 的 API Key 还没有配置，请先在账号设置里保存。` });
      send({ type: "done" });
      completeClientRequest("error", requestId);
      abortCtrl = null;
      scheduleQueuedClientPromptDrain();
      return;
    }
    if (!msg.dispatchProvider && activeProfile?.provider === "codex" && !isCodexAuthAvailable()) {
      send({ type: "error", text: "Codex 还没有登录，请先打开 Codex 客户端或运行 codex login 完成 ChatGPT 账号登录。" });
      send({ type: "done" });
      completeClientRequest("error", requestId);
      abortCtrl = null;
      scheduleQueuedClientPromptDrain();
      return;
    }
    if (!msg.dispatchProvider && activeProfile?.provider === "codex" && schedulerRequest) {
      send({ type: "error", text: "定时任务目前需要 Claude 会员通道的 scheduler 工具。请切换到 Claude 会员后再创建、查看或修改提醒任务。" });
      send({ type: "done" });
      completeClientRequest("error", requestId);
      abortCtrl = null;
      scheduleQueuedClientPromptDrain();
      return;
    }

    const resolvedCwd = resolveAllowedCwd(msg.cwd);

    // 用户通过 >厂商 明确指定时，不再让主模型二次判断；直接调用同一派发执行器，
    // 同时合成标准的 tool_use/tool_result 事件，复用现有编队卡与历史链路。
    if (msg.dispatchProvider) {
      const dispatchTurnEpoch = ++claudeTurnEpoch;
      const dispatchToolUseId = `dispatch_${crypto.randomUUID()}`;
      const dispatchReason = typeof msg.dispatchReason === "string" && msg.dispatchReason.trim()
        ? msg.dispatchReason.trim()
        : "用户通过 > 明确指定厂商";
      // 派发只送文字。前面那段按 msg.images 拼出来的多模态 content 走不到这条
      // 路径——与其把用户附的图静默丢掉让他以为对方看过了，不如直接说清楚。
      if (images.length > 0) {
        send({ type: "error", text: "派发给其他厂商时暂不支持图片，请去掉图片后重发，或者把这轮交给当前模型。" });
        send({ type: "done" });
        completeClientRequest("error", requestId);
        abortCtrl = null;
        scheduleQueuedClientPromptDrain();
        return;
      }
      // 同一条对话里再派给同一个厂商，就接着上一轮说
      const dispatchConvId = historyIdOrNull(msg.conversationId) || activeHistoryConversationId;
      const dispatchProfile = resolveDispatchProfile(profileData, msg.dispatchProvider);
      const dispatchProfileId = dispatchProfile?.id || null;
      // 同一家正在派发中就不续接：两个进程同时往一条 thread 里写，
      // 对方那边的历史会交错成谁也读不懂的样子
      const canResume = Boolean(dispatchConvId && dispatchProfileId)
        && !isDispatchInflight(dispatchConvId, dispatchProfileId);
      const resumeSessionId = canResume
        ? recallDispatchSession(dispatchConvId, dispatchProfileId)
        : null;
      const releaseDispatchInflight = markDispatchInflight(dispatchConvId, dispatchProfileId);
      const dispatchGeneration = dispatchGenerationOf(dispatchConvId);
      const dispatchInput = {
        provider: msg.dispatchProvider,
        task: msg.prompt,
        reason: dispatchReason,
        ...(resumeSessionId ? { resumed: true } : {}),
      };
      abortCtrl = ac;
      const isCurrentDispatchTurn = () => (
        dispatchTurnEpoch === claudeTurnEpoch
        && abortCtrl === ac
        && activeForegroundRequestId === requestId
      );
      send({
        type: "assistant",
        message: {
          role: "assistant",
          content: [{
            type: "tool_use",
            id: dispatchToolUseId,
            name: "dispatch_to_provider",
            input: dispatchInput,
          }],
        },
      });
      (async () => {
        try {
          const dispatchResult = await executeProviderDispatch({
            provider: msg.dispatchProvider,
            task: msg.prompt,
            cwd: resolvedCwd,
            permissionMode,
            profileData,
            abortController: ac,
            resumeSessionId,
            // 拿到 id 立刻记，不等本轮成功。用户中断时对方已经建立了上下文，
            // 这个 id 仍然有效——等 await 返回才记的话，中断抛异常就全丢了。
            // 但对话已被重置过就别写回去，否则「新对话」会接上旧话题
            onSession: (id) => {
              if (dispatchGenerationOf(dispatchConvId) !== dispatchGeneration) return;
              rememberDispatchSession(dispatchConvId, dispatchProfileId, id);
            },
            // 这条路径手里就有 tool_use_id，前端直接按 id 归位，不必再算 key
            onStep: (name, input) => {
              if (!isCurrentDispatchTurn()) return;
              try {
                send({ type: "dispatch_step", toolUseId: dispatchToolUseId, name, input });
              } catch { /* 连接已断则忽略 */ }
            },
          });
          if (!isCurrentDispatchTurn()) return;
          const resultText = JSON.stringify({ ok: true, reason: dispatchReason, ...dispatchResult });
          send({
            type: "user",
            message: {
              role: "user",
              content: [{
                type: "tool_result",
                tool_use_id: dispatchToolUseId,
                content: [{ type: "text", text: resultText }],
              }],
            },
          });
          send({
            type: "assistant",
            message: {
              role: "assistant",
              content: [{ type: "text", text: dispatchResult.output }],
            },
            dispatch: {
              provider: dispatchResult.provider,
              providerName: dispatchResult.providerName,
              model: dispatchResult.model,
            },
          });
          send({
            type: "result",
            subtype: "success",
            provider: dispatchResult.provider,
            model: dispatchResult.model,
            dispatched: true,
          });
          send({ type: "done" });
          completeClientRequest("complete", requestId);
        } catch (error) {
          // 只在「对方压根没认这条会话」时丢弃：那个 id 已经失效，留着的话之后
          // 每次都会拿同一个坏 id 去试，一直失败到重启为止。接上之后才出错的
          // （限流、超时、中断）thread 还好好的，下次接着用。
          if (resumeSessionId
            && error?.dispatchSessionEstablished === false
            && dispatchGenerationOf(dispatchConvId) === dispatchGeneration) {
            dropDispatchSession(dispatchConvId, dispatchProfileId);
          }
          if (!isCurrentDispatchTurn()) return;
          if (error?.name === "AbortError") {
            send({ type: "stopped" });
            completeClientRequest("stopped", requestId);
          } else {
            const errorText = String(error?.message || error);
            send({
              type: "user",
              message: {
                role: "user",
                content: [{
                  type: "tool_result",
                  tool_use_id: dispatchToolUseId,
                  is_error: true,
                  content: [{ type: "text", text: errorText }],
                }],
              },
            });
            send({ type: "error", text: errorText });
            send({ type: "done" });
            completeClientRequest("error", requestId);
          }
        } finally {
          releaseDispatchInflight();
          if (abortCtrl === ac) abortCtrl = null;
          scheduleQueuedClientPromptDrain();
        }
      })();
      return;
    }

    const webEnv = buildAgentEnv(profileData, effort, msg.model);
    webEnv.PWD = resolvedCwd; // 让 agent 报告的工作目录与实际 cwd 一致
    const options = {
      cwd: resolvedCwd,
      permissionMode,
      allowDangerouslySkipPermissions: permissionMode === "bypassPermissions",
      abortController: ac,
      includePartialMessages: true,
      effort,
      env: webEnv,
      mcpServers: {
        ...(DISPATCH_AUTO_ENABLED ? {
          dispatch: _buildDispatchMcpServer({
            cwd: resolvedCwd,
            permissionMode,
            profileData,
            conversationId: historyIdOrNull(msg.conversationId) || activeHistoryConversationId,
            // 用户按停止时，派出去的子进程也要跟着停
            getAbortSignal: () => ac.signal,
            sendStep: (payload) => { try { send({ type: "dispatch_step", ...payload }); } catch { /* 连接已断则忽略 */ } },
          }),
        } : {}),
      },
    };
    if (schedulerRequest) {
      options.mcpServers = {
        ...options.mcpServers,
        scheduler: _buildSchedulerMcpServer({
          sourceChannel: "web",
          sourcePeer: WEB_SCHEDULER_PEER,
          defaultOutputs: ["chat_history"],
        }),
      };
      options.systemPrompt = { type: "preset", preset: "claude_code", append: INKFELLOW_SCHEDULER_PROMPT };
      options.disallowedTools = ["Bash"];
    }
    if (sessionId) options.resume = sessionId;
    if (!activeProfile || activeProfile.provider === "claude") {
      if (msg.model) options.model = msg.model;
    }

    // ── Codex SDK 路径 ────────────────────────────────────────
    if (activeProfile?.provider === "codex") {
      // The two providers share one UI/history/Stop state. Once Claude has no
      // foreground or background work left, close its idle process before Codex
      // starts so a late auto-continuation cannot create a second stream.
      if (claudeRuntime.started) {
        claudeRuntime.close();
        claudeRuntimeSignature = null;
        claudeRuntimeConversationId = null;
      }
      const codexTurnEpoch = ++claudeTurnEpoch;
      abortCtrl = ac;
      const isCurrentCodexTurn = () => (
        codexTurnEpoch === claudeTurnEpoch
        && abortCtrl === ac
        && activeForegroundRequestId === requestId
      );
      (async () => {
        try {
          const codex = new Codex();
          const EFFORT_TO_REASONING = { low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "xhigh" };
          const threadOptions = {
            workingDirectory: resolvedCwd,
            approvalPolicy: "never",
            sandboxMode: codexSandboxMode(permissionMode),
            modelReasoningEffort: EFFORT_TO_REASONING[effort] || "medium",
            ...(msg.model ? { model: msg.model } : {}),
          };
          const thread = codexThreadId
            ? codex.resumeThread(codexThreadId, threadOptions)
            : codex.startThread(threadOptions);

          // 图片：base64 → 临时本地文件（codex-sdk 只支持 local_image）
          const imgList = msg.images ?? (msg.image ? [msg.image] : []);
          let input;
          if (imgList.length > 0) {
            const parts = [];
            for (const img of imgList) {
              const ext = (img.mediaType || "image/png").split("/")[1] || "png";
              const tmpPath = join(DATA_DIR, `codex-img-${Date.now()}-${crypto.randomBytes(3).toString("hex")}.${ext}`);
              writeFileSync(tmpPath, Buffer.from(img.data, "base64"));
              parts.push({ type: "local_image", path: tmpPath });
            }
            parts.push({ type: "text", text: msg.prompt });
            input = parts;
          } else {
            input = msg.prompt;
          }

          const { events } = await thread.runStreamed(input, { signal: ac.signal });
          if (!isCurrentCodexTurn()) return;
          let codexResultSent = false;
          for await (const ev of events) {
            if (!isCurrentCodexTurn()) return;
            if (ev.type === "thread.started") {
              saveCodexThread(ev.thread_id);
              send({ type: "session", sessionId: ev.thread_id });
            } else if (ev.type === "turn.started") {
              send({ type: "system", subtype: "status", status: "requesting" });
            } else if (ev.type === "item.started" || ev.type === "item.updated" || ev.type === "item.completed") {
              sendCodexItemEvent(send, ev.type, ev.item);
            } else if (ev.type === "turn.completed") {
              send({ type: "result", subtype: "success", usage: ev.usage ?? null, provider: "codex" });
              codexResultSent = true;
            } else if (ev.type === "turn.failed") {
              throw new Error(ev.error?.message || "Codex 请求失败");
            } else if (ev.type === "error") {
              throw new Error(ev.message || "Codex 请求失败");
            }
          }
          if (!isCurrentCodexTurn()) return;
          if (!codexResultSent) send({ type: "result", subtype: "success", provider: "codex" });
          send({ type: "done" });
          completeClientRequest("complete", requestId);
        } catch (err) {
          if (!isCurrentCodexTurn()) return;
          if (err?.name === "AbortError") {
            send({ type: "stopped" });
            completeClientRequest("stopped", requestId);
          } else {
            send({ type: "error", text: String(err) });
            send({ type: "done" });
            completeClientRequest("error", requestId);
          }
        } finally {
          if (abortCtrl === ac) abortCtrl = null;
          scheduleQueuedClientPromptDrain();
        }
      })();
      return;
    }

    const collectAskUserQuestionInput = async (input, context = {}) => {
      const answer = await waitForAskUserQuestionAnswer(input, context);
      const updatedInput = { ...input, questions: answer.questions };
      if (answer.response && Object.keys(answer.answers).length === 0) {
        updatedInput.response = answer.response;
      } else {
        updatedInput.answers = answer.answers;
      }
      return updatedInput;
    };

    options.hooks = {
      ...(options.hooks ?? {}),
      PreToolUse: [
        ...((options.hooks?.PreToolUse) ?? []),
        {
          matcher: ASK_USER_QUESTION_TOOL,
          hooks: [async (hookInput, toolUseID, hookContext = {}) => {
            if (hookInput?.tool_name !== ASK_USER_QUESTION_TOOL) return {};
            const existingInput = hookInput.tool_input && typeof hookInput.tool_input === "object"
              ? hookInput.tool_input
              : {};
            if (existingInput.answers || existingInput.response) {
              return {
                hookSpecificOutput: {
                  hookEventName: "PreToolUse",
                  permissionDecision: "allow",
                  updatedInput: existingInput,
                },
              };
            }
            const updatedInput = await collectAskUserQuestionInput(existingInput, {
              signal: hookContext.signal,
              toolUseID: hookInput.tool_use_id ?? toolUseID,
            });
            return {
              hookSpecificOutput: {
                hookEventName: "PreToolUse",
                permissionDecision: "allow",
                updatedInput,
              },
            };
          }],
        },
      ],
    };

    options.canUseTool = async (toolName, input, context = {}) => {
      if (toolName !== ASK_USER_QUESTION_TOOL) {
        console.warn(`[Web Agent] Permission escalation denied for tool: ${toolName} (mode: ${permissionMode})`);
        return {
          behavior: "deny",
          message: `此环境无法弹出「${toolName}」的人工授权确认。若这一步必不可少，请改用 ${ASK_USER_QUESTION_TOOL} 向用户说明并询问；若有不需要额外授权的替代方案，请直接采用。不要因此放弃整个任务。`,
        };
      }
      if (input?.answers || input?.response) {
        return {
          behavior: "allow",
          updatedInput: input,
          decisionClassification: "user_temporary",
        };
      }
      return {
        behavior: "allow",
        updatedInput: await collectAskUserQuestionInput(input, context),
        decisionClassification: "user_temporary",
      };
    };

    const buildRecoveryMsg = () => {
      const history = extractSessionTextHistory(sessionId);
      if (history.length === 0) return null;
      const historyText = history
        .map(turn => `${turn.role === "user" ? "用户" : "助手"}：${turn.text}`)
        .join("\n");
      const injected = `以下是本次对话此前的历史记录（供你延续上下文）：\n${historyText}\n\n用户：${msg.prompt}`;
      const recoveredContent = content
        .filter(block => block.type !== "text")
        .concat([{ type: "text", text: injected }]);
      return {
        type: "user",
        message: { role: "user", content: recoveredContent },
        parent_tool_use_id: null,
        priority: "next",
      };
    };

    const runtimeSignature = crypto.createHash("sha256").update(JSON.stringify({
      conversationId: activeHistoryConversationId,
      cwd: resolvedCwd,
      effort,
      provider: activeProfile?.provider ?? "claude",
      profileId: activeProfile?.id ?? null,
      baseUrl: activeProfile?.baseUrl ?? null,
      apiKey: activeProfile?.apiKey ?? null,
      opusModel: activeProfile?.opusModel ?? null,
      sonnetModel: activeProfile?.sonnetModel ?? null,
      haikuModel: activeProfile?.haikuModel ?? null,
      allowDangerouslySkipPermissions: permissionMode === "bypassPermissions",
      schedulerRequest,
    })).digest("hex");
    const turnConversationId = activeHistoryConversationId;
    const turnEpoch = ++claudeTurnEpoch;
    const isCurrentTurn = () => turnEpoch === claudeTurnEpoch && claudeTurnCompletionPending;

    claudeTurnCompletionPending = true;
    claudeStopRequested = false;
    claudeErrorHandled = false;
    claudeRecoveryContext = {
      attempted: false,
      buildMessage: buildRecoveryMsg,
      options,
      signature: runtimeSignature,
    };

    (async () => {
      try {
        if (!isCurrentTurn()) return;
        if (claudeRuntime.started && claudeRuntimeSignature !== runtimeSignature) {
          if (claudeRuntime.taskIds.size > 0) {
            send({
              type: "error",
              text: "当前对话仍有后台任务运行，暂不能切换工作目录、账号、推理强度、权限能力或调度模式。请等待任务完成，或重置/新建对话后再切换。",
            });
            finishClaudeTurn();
            return;
          }
          claudeRuntime.close();
          claudeRuntimeSignature = null;
          claudeRuntimeConversationId = null;
        }

        if (!claudeRuntime.started) {
          if (!isCurrentTurn()) return;
          claudeRuntime.start(options);
          claudeRuntimeSignature = runtimeSignature;
          claudeRuntimeConversationId = turnConversationId;
        } else {
          await claudeRuntime.query.setPermissionMode(permissionMode);
          if (!isCurrentTurn()) return;
          await claudeRuntime.query.setModel(msg.model || undefined);
          if (!isCurrentTurn()) return;
        }

        if (!isCurrentTurn()) return;
        claudeRuntime.send(userMsg);
      } catch (error) {
        if (!isCurrentTurn()) return;
        send({ type: "error", text: String(error) });
        finishClaudeTurn();
      }
    })();
    return;

  };
  ws.on("message", raw => handleClientMessage(raw, false));
  scheduleQueuedClientPromptDrain();

  ws.on("close", () => {
    clearInterval(pingTimer);
    if (activeWs === ws) {
      activeWs = null;
      if (queuedClientPromptDrain === drainThisConnection) queuedClientPromptDrain = null;
      // Do NOT abort or clear the pending question: the run keeps going in the
      // background and reattaches when the client reconnects.
      if (isAgentRunActive()) {
        console.log("[Web Agent] Client detached; run continues in background, events buffered until reconnect.");
      }
    }
  });
});

http.listen(PORT, HOST, () => {
  console.log(`claude-chat listening on ${HOST}:${PORT}`);
});
