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
import { Codex } from "@openai/codex-sdk";
import * as scheduler from "./scheduler.js";
import { buildModelCandidates, runWithModelFallback } from "./model-fallback.js";
import { PersistentQueryRuntime } from "./agent-session.js";
import { z } from "zod";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = Number.parseInt(process.env.PORT || "8082", 10);
const HOST = process.env.HOST || "127.0.0.1";
const DEFAULT_CWD = resolve(process.env.VAULT_PATH || process.cwd());
const PERMISSION_MODES = new Set(["plan", "acceptEdits", "auto", "bypassPermissions"]);
const EFFORT_LEVELS = new Set(["low", "medium", "high", "xhigh", "max"]);
const DEFAULT_PERMISSION_MODE = PERMISSION_MODES.has(process.env.CLAUDE_PERMISSION_MODE)
  ? process.env.CLAUDE_PERMISSION_MODE
  : "auto";

// How long a query() stream can be silent before we consider it stalled.
// We use event-interval (not total duration) so long but active tasks (multi-tool,
// compaction, slow thinking) are never killed — only truly frozen streams are.
// 工具执行期间（assistant tool_use 之后、tool_result 之前）两个看门狗都会暂停：
// 工具可能合法地运行数小时，期间 SDK 本来就不产生事件。
const STREAM_STALL_MS = 180_000; // 3 min with no events → abort
const MAX_AGENT_RUN_MS = 8 * 60_000; // 单个 API 阶段（不含工具执行）的硬上限，兜底无限 api_retry
const ASK_USER_QUESTION_TOOL = "AskUserQuestion";
const USAGE_LIMIT_QUERY_TIMEOUT_MS = 12_000;
// 客户端断线后，生成中的 run 保留这么久等待重连领回，超时才真正 abort。
const RUN_GRACE_MS = 90_000;
const WS_HEARTBEAT_MS = 30_000;

const htmlPath   = join(__dirname, "public/index.html");
const AUTH_PROFILE_FILE = process.env.CLAUDE_CHAT_AUTH_PROFILE_FILE || join(__dirname, "auth-profile.json");
const WEB_SCHEDULER_PEER = `web:${PORT}`;

const SCHEDULER_INTENT_RE = /分钟后|小时后|一会儿|稍后|稍候|等会|定时|每天|每周|每月|每小时|每隔|工作日|提醒|自动|取消任务|删除任务|查看任务|暂停任务|恢复任务/;
const INKFELLOW_SCHEDULER_PROMPT = `【inkfellow 定时任务规则】

当用户提到以下任一场景时，必须使用 scheduler MCP 工具处理，不能只用文字承诺：
- 定时、每天、每周、每月、每小时、工作日、提醒我、自动
- X分钟后、X小时后、一会儿、稍后、等会
- 查看任务、取消任务、删除任务、暂停任务、恢复任务
- 没收到、没推送、没生效、没执行、为什么没有提醒/推送

可用工具：
- create_schedule：创建全局循环或一次性任务
- list_schedules：查看所有全局任务
- delete_schedule：删除任务
- toggle_schedule：暂停或恢复任务

创建规则：
- 定时任务是全局的，创建后不依赖当前对话会话；sourceChannel/sourcePeer 只用于任务触发后的结果投递。
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
for (const name of [`session-${PORT}.json`, `history-${PORT}.json`,
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
const WECHAT_MAX_TEXT_CHARS = Number.parseInt(process.env.WECHAT_MAX_TEXT_CHARS || "1800", 10);
mkdirSync(WECHAT_MEDIA_DIR, { recursive: true });

const SCHEDULER_TROUBLESHOOT_RE = /没收到|没有收到|没推送|没有推送|没生效|不生效|未生效|没执行|没有执行|怎么.*没.*推送|怎么.*没.*提醒|有哪些.*任务|任务列表|列出.*任务|查看.*任务|查.*任务/;
const SCHEDULER_TIME_HINT_RE = /周[一二三四五六日天]|早上|上午|中午|下午|晚上|凌晨|今晚|明天|后天|下周|[0-2]?\d\s*[:：点]\s*(?:[0-5]?\d|半)?/;
const SCHEDULER_ACTION_HINT_RE = /提醒|推送|通知|复盘|叫我|任务/;

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

const CODEX_DEFAULT_MODELS = { opusModel: "gpt-5.5", sonnetModel: "gpt-5.4", haikuModel: "gpt-5.4-mini" };

const PROVIDER_PRESETS = {
  anthropic:  { baseUrl: "",                                    opusModel: "claude-opus-5",                   sonnetModel: "claude-sonnet-5",                  haikuModel: "claude-haiku-4-5-20251001" },
  deepseek:   { baseUrl: "https://api.deepseek.com/anthropic", opusModel: "deepseek-v4-pro[1m]",            sonnetModel: "deepseek-v4-pro[1m]",             haikuModel: "deepseek-v4-flash" },
  openrouter: { baseUrl: "https://openrouter.ai/api",          opusModel: "~anthropic/claude-opus-latest",   sonnetModel: "~anthropic/claude-sonnet-latest",  haikuModel: "~anthropic/claude-haiku-latest" },
  codex:      { baseUrl: "",                                    ...CODEX_DEFAULT_MODELS },
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

function clearAllSessions() {
  clearSession();
  clearCodexThread();
}

function setProviderSession(provider, id) {
  if (provider === "codex") {
    clearSession();
    saveCodexThread(id);
  } else {
    clearCodexThread();
    saveSession(id);
  }
}

function isPersistedCodexThread(id) {
  if (!id) return false;
  const sessionsDir = join(homedir(), ".codex", "sessions");
  try {
    return readdirSync(sessionsDir, { recursive: true })
      .some(entry => {
        const name = basename(String(entry));
        return name.startsWith("rollout-") && name.endsWith(`${id}.jsonl`);
      });
  } catch {
    return false;
  }
}

function resolveSessionProvider(provider, id) {
  if (provider === "codex" || provider === "claude") return provider;
  return isPersistedCodexThread(id) ? "codex" : "claude";
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
  };
}

/** 从旧格式迁移到新 profiles 格式 */
function migrateOldFormat(old) {
  const profiles = [];
  // Claude 始终存在
  profiles.push({ id: "p_claude", name: "Claude 会员", provider: "claude", apiKey: "", opusModel: "", sonnetModel: "", haikuModel: "", baseUrl: "" });

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
    });
  }

  if (isCodexAuthAvailable()) {
    profiles.push({ id: "p_codex", name: "Codex（GPT 会员）", provider: "codex", apiKey: "", baseUrl: "", ...CODEX_DEFAULT_MODELS });
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
    profiles.unshift({ id: "p_claude", name: "Claude 会员", provider: "claude", apiKey: "", opusModel: "", sonnetModel: "", haikuModel: "", baseUrl: "" });
  }
  // 注入或同步 Codex 会员 profile（强制覆盖模型字段，防止旧数据残留）
  const existingCodex = profiles.find(p => p.provider === "codex");
  if (isCodexAuthAvailable()) {
    if (existingCodex) {
      Object.assign(existingCodex, CODEX_DEFAULT_MODELS);
    } else {
      profiles.push({ id: "p_codex", name: "Codex（GPT 会员）", provider: "codex", apiKey: "", baseUrl: "", ...CODEX_DEFAULT_MODELS });
    }
  }
  // 会员账号（Claude、Codex）固定置顶，其余自定义 key 账号保持原有相对顺序
  const providerRank = { claude: 0, codex: 1 };
  profiles.sort((a, b) => (providerRank[a.provider] ?? 2) - (providerRank[b.provider] ?? 2));
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
      // 仅 custom provider 暴露 baseUrl（内置厂商不需要显示）
      ...(p.provider === "custom" ? { baseUrl: p.baseUrl } : {}),
    })),
  };
}

function getActiveProfile(data = readProfiles()) {
  return data.profiles.find(p => p.id === data.activeProfileId) ?? data.profiles[0] ?? null;
}

export function buildAgentEnv(profileData, effort, requestedModel) {
  const env = { ...process.env };
  for (const key of CLAUDE_COMPAT_ENV_KEYS) delete env[key];

  // 长驻 Query 的前台轮靠 system/session_state_changed state=idle 收尾。该事件自
  // SDK 0.2.83 起改为 opt-in，不开启就永远不发，回合结束不了、后续消息会一直排队。
  // 必须放在下面按 provider 提前 return 之前——放后面对 Claude 会员账号不生效，
  // 而那恰恰是最常用的通道。
  env.CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS = "1";

  const active = getActiveProfile(profileData);
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

function clampPercent(value) {
  if (!Number.isFinite(value)) return null;
  return Math.max(0, Math.min(100, Math.round(value)));
}

function normalizeUsageWindow(raw) {
  if (!raw || typeof raw !== "object") return null;
  const utilizationRaw = raw.utilization ?? raw.percent ?? raw.used_percent;
  const utilizationNum = typeof utilizationRaw === "number" ? utilizationRaw : Number(utilizationRaw);
  const usedPercent = clampPercent(utilizationNum <= 1 ? utilizationNum * 100 : utilizationNum);
  return {
    usedPercent,
    remainingPercent: usedPercent == null ? null : clampPercent(100 - usedPercent),
    resetAt: raw.resets_at ?? raw.resetsAt ?? raw.reset_at ?? null,
  };
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
      message: controller.signal.aborted ? "Claude 额度查询超时" : String(err?.message || err),
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
    return { ok: false, status: "unauthenticated", message: "Codex 未登录" };
  }
  try {
    const auth = JSON.parse(readFileSync(authFile, "utf8"));
    if (auth.auth_mode && auth.auth_mode !== "chatgpt") {
      return { ok: false, status: "unavailable", message: "Codex 当前不是 ChatGPT OAuth 登录模式" };
    }
    const accessToken = auth.tokens?.access_token;
    if (!accessToken) {
      return { ok: false, status: "unauthenticated", message: "Codex OAuth access_token 不存在" };
    }
    return { ok: true, accessToken, accountId: auth.tokens?.account_id ?? null };
  } catch (err) {
    return { ok: false, status: "error", message: `Codex auth.json 解析失败：${String(err?.message || err)}` };
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
        message: `Codex OAuth 已失效，请重新登录（HTTP ${resp.status}）`,
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
        message: `Codex 额度查询失败（HTTP ${resp.status}）：${text.slice(0, 300)}`,
        updatedAt: new Date().toISOString(),
      };
    }

    const body = await resp.json();
    const rateLimit = body?.rate_limit ?? null;
    return {
      provider: "codex",
      status: rateLimit ? "ok" : "unavailable",
      authenticated: true,
      available: !!rateLimit,
      planType: body?.plan_type ?? null,
      fiveHour: normalizeUsageWindow(rateLimit?.primary_window),
      week: normalizeUsageWindow(rateLimit?.secondary_window),
      updatedAt: new Date().toISOString(),
    };
  } catch (err) {
    return {
      provider: "codex",
      status: controller.signal.aborted ? "timeout" : "error",
      authenticated: true,
      available: false,
      message: controller.signal.aborted ? "Codex 额度查询超时" : String(err?.message || err),
      updatedAt: new Date().toISOString(),
    };
  } finally {
    clearTimeout(timeout);
  }
}

// ── Server-side history ────────────────────────────────────
const HISTORY_FILE = process.env.CLAUDE_CHAT_HISTORY_FILE || join(DATA_DIR, `history-${PORT}.json`);
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

function readHistory() {
  try {
    if (existsSync(HISTORY_FILE)) return JSON.parse(readFileSync(HISTORY_FILE, "utf8"));
  } catch { }
  return [];
}

function writeHistory(arr) {
  try { writeFileSync(HISTORY_FILE, JSON.stringify(arr), "utf8"); } catch { }
}

// ── Skills preload ─────────────────────────────────────────
// Read skill slugs from ~/.claude/skills/ directory (fast, no subprocess needed)
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

// 每个微信 sender 的对话历史（多轮上下文）和最近一次可用的会话投递 token。
// 结构 Map<sender, { turns: [{role, content}], lastAt: number, contextToken?: string }>
// 微信同样走 Claude Agent SDK query()，确保 cwd 始终是 VAULT_PATH。
const wechatSenderSessions = new Map();
const WECHAT_SESSION_TTL_MS = 30 * 60 * 1000; // 30 分钟无消息自动开启新对话
const WECHAT_MAX_HISTORY_TURNS = 10;           // 最多保留 10 轮（5 来 5 回）
const WECHAT_HISTORY_FILE = join(DATA_DIR, `wechat-history-${PORT}.json`);

function normalizeWechatSessionEntry(entry = {}) {
  const lastAt = Number(entry?.lastAt);
  const lastContextAtMs = Number(entry?.lastContextAtMs);
  return {
    turns: Array.isArray(entry?.turns) ? entry.turns : [],
    lastAt: Number.isFinite(lastAt) ? lastAt : 0,
    contextToken: typeof entry?.contextToken === "string" && entry.contextToken ? entry.contextToken : undefined,
    lastContextAtMs: Number.isFinite(lastContextAtMs) ? lastContextAtMs : undefined,
  };
}

function rememberWechatContext(sender, contextToken) {
  const cleanSender = String(sender || "").trim();
  if (!cleanSender || !contextToken) return;
  const current = normalizeWechatSessionEntry(wechatSenderSessions.get(cleanSender));
  wechatSenderSessions.set(cleanSender, {
    ...current,
    contextToken,
    lastContextAtMs: Date.now(),
  });
  saveWechatHistory();
}

// 启动时从文件恢复历史
try {
  if (existsSync(WECHAT_HISTORY_FILE)) {
    const raw = JSON.parse(readFileSync(WECHAT_HISTORY_FILE, "utf8"));
    for (const [sender, entry] of Object.entries(raw)) {
      wechatSenderSessions.set(sender, normalizeWechatSessionEntry(entry));
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

// ── WeChat 待补发队列 ─────────────────────────────────────
// ilink 网关的 context_token 有时效，用户长时间不发消息后定时任务的主动推送
// 会被网关拒绝（ret -2）。失败的消息进入此队列，等用户下次发消息拿到新
// context_token 时自动补发。
const WECHAT_PENDING_FILE = join(DATA_DIR, `wechat-pending-${PORT}.json`);
const WECHAT_PENDING_MAX_AGE_MS = 72 * 60 * 60 * 1000;
const WECHAT_PENDING_MAX_ITEMS = 20;

function readWechatPending() {
  if (!existsSync(WECHAT_PENDING_FILE)) return [];
  try {
    const items = JSON.parse(readFileSync(WECHAT_PENDING_FILE, "utf8"));
    return Array.isArray(items) ? items : [];
  } catch { return []; }
}

function writeWechatPending(items) {
  try { writeFileSync(WECHAT_PENDING_FILE, JSON.stringify(items, null, 2), "utf8"); } catch { }
}

function queueWechatPendingDelivery(peer, text) {
  const cleanPeer = String(peer || "").trim();
  if (!cleanPeer || !text) return;
  const now = Date.now();
  const items = readWechatPending().filter(it => now - (it.queuedAtMs || 0) <= WECHAT_PENDING_MAX_AGE_MS);
  items.push({ peer: cleanPeer, text, queuedAtMs: now });
  writeWechatPending(items.slice(-WECHAT_PENDING_MAX_ITEMS));
  console.log(`[WeChat Pending] Queued message for ${cleanPeer.slice(0, 12)}... (${items.length} in queue)`);
}

async function flushWechatPendingDeliveries(baseUrl, token, sender, contextToken) {
  const items = readWechatPending();
  if (items.length === 0) return;
  const now = Date.now();
  const keep = [];
  let flushed = 0;
  for (const item of items) {
    if (now - (item.queuedAtMs || 0) > WECHAT_PENDING_MAX_AGE_MS) continue;
    if (item.peer !== sender) { keep.push(item); continue; }
    const queuedAt = new Date(item.queuedAtMs).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" });
    try {
      await sendWechatMessage(baseUrl, token, sender, `📬 补发离线消息（原定 ${queuedAt}）\n\n${item.text}`, contextToken);
      flushed++;
    } catch (err) {
      console.warn(`[WeChat Pending] Flush to ${sender.slice(0, 12)}... failed, will retry later: ${err.message}`);
      keep.push(item);
    }
  }
  writeWechatPending(keep);
  if (flushed > 0) console.log(`[WeChat Pending] Flushed ${flushed} pending message(s) to ${sender.slice(0, 12)}...`);
}

function resolveWechatDeliveryTargets(peer) {
  const primary = String(peer || "").trim();
  const peers = primary ? [primary] : [];

  const stablePeers = [...wechatSenderSessions.keys()]
    .map(p => String(p || "").trim())
    .filter(p => p.endsWith("@im.wechat"));
  if (stablePeers.length === 1 && !peers.includes(stablePeers[0])) {
    peers.push(stablePeers[0]);
  }

  return peers.map(p => {
    const session = normalizeWechatSessionEntry(wechatSenderSessions.get(p));
    return { peer: p, contextToken: session.contextToken };
  });
}

function resolveWechatDeliveryPeers(peer) {
  return resolveWechatDeliveryTargets(peer).map(target => target.peer);
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
  const responseText = await res.text();
  if (!res.ok) {
    throw new Error(`WeChat Gateway HTTP ${res.status}: ${responseText.slice(0, 200)}`);
  }

  let data = {};
  if (responseText.trim()) {
    try {
      data = JSON.parse(responseText);
    } catch {
      throw new Error(`WeChat Gateway returned non-JSON response: ${responseText.slice(0, 200)}`);
    }
  }

  const code = data.ret ?? data.errcode ?? data.code;
  if (code !== undefined && Number(code) !== 0) {
    const message = data.errmsg || data.message || data.error || JSON.stringify(data).slice(0, 200);
    throw new Error(`WeChat Gateway API error ${code}: ${message}`);
  }
  return data;
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

async function sendWechatItem(baseUrl, token, toUser, item, contextToken = undefined, fromUserId = "") {
  const clientId = `inkfellow-wechat-${crypto.randomUUID()}`;
  await requestWechat(baseUrl, token, "ilink/bot/sendmessage", {
    msg: {
      from_user_id: fromUserId || "",
      to_user_id: toUser,
      client_id: clientId,
      message_type: 2, // MessageType.BOT
      message_state: 2, // MessageState.FINISH
      item_list: [item],
      context_token: contextToken || undefined,
    }
  });
}

function getWechatTextChunkSize() {
  return Number.isFinite(WECHAT_MAX_TEXT_CHARS) && WECHAT_MAX_TEXT_CHARS >= 500
    ? WECHAT_MAX_TEXT_CHARS
    : 1800;
}

function splitWechatText(text) {
  const maxChars = getWechatTextChunkSize();
  const safeMax = Math.max(200, maxChars - 24);
  const value = String(text ?? "");
  if (value.length <= maxChars) return [value];

  const chunks = [];
  let current = "";
  for (const line of value.split("\n")) {
    const candidate = current ? `${current}\n${line}` : line;
    if (candidate.length <= safeMax) {
      current = candidate;
      continue;
    }

    if (current) chunks.push(current);
    let rest = line;
    while (rest.length > safeMax) {
      chunks.push(rest.slice(0, safeMax));
      rest = rest.slice(safeMax);
    }
    current = rest;
  }
  if (current) chunks.push(current);
  return chunks;
}

async function sendWechatMessage(baseUrl, token, toUser, text, contextToken = undefined, fromUserId = "") {
  const chunks = splitWechatText(text);
  for (let i = 0; i < chunks.length; i++) {
    const chunkText = chunks.length > 1 ? `(${i + 1}/${chunks.length})\n${chunks[i]}` : chunks[i];
    await sendWechatItem(baseUrl, token, toUser, {
      type: WECHAT_MESSAGE_ITEM_TYPE.TEXT,
      text_item: { text: chunkText }
    }, contextToken, fromUserId);
  }
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
  const supportedImages = includeImageBlocks
    ? mediaFiles.filter(file =>
      file.kind === "image" &&
      Object.values(WECHAT_IMAGE_MIME_BY_EXT).includes(file.mime) &&
      file.size <= WECHAT_MAX_INLINE_IMAGE_BYTES
    )
    : [];
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
  rememberWechatContext(sender, contextToken);
  flushWechatPendingDeliveries(baseUrl, token, sender, contextToken).catch(err =>
    console.warn(`[WeChat Pending] Flush error: ${err.message}`)
  );

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
    const current = normalizeWechatSessionEntry(wechatSenderSessions.get(sender));
    wechatSenderSessions.set(sender, { ...current, turns: [], lastAt: Date.now() });
    saveWechatHistory();
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
  const text = String(prompt || "");
  return SCHEDULER_INTENT_RE.test(text)
    || SCHEDULER_TROUBLESHOOT_RE.test(text)
    || (SCHEDULER_TIME_HINT_RE.test(text) && SCHEDULER_ACTION_HINT_RE.test(text));
}

function _buildSchedulerMcpServer({ sourceChannel, sourcePeer, defaultOutputs = [] }) {
  const nowMs = Date.now();
  const nowStr = new Date(nowMs).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" });

  const createScheduleTool = tool(
    "create_schedule",
    "创建全局定时任务（循环或一次性）。sourceChannel 和 sourcePeer 仅用于结果投递，由系统固定注入，不需要传入。",
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
    "列出所有全局定时任务",
    {},
    async () => {
      const jobs = scheduler.listJobs();
      const summary = jobs.map(j => ({
        id: j.id,
        description: j.description,
        cronExpr: j.cronExpr || null,
        runAtMs: j.runAtMs || null,
        enabled: j.enabled,
        sourceChannel: j.sourceChannel || null,
        sourcePeer: j.sourcePeer || null,
        lastStatus: j.state?.lastStatus || null,
        lastRunAtMs: j.state?.lastRunAtMs || null,
      }));
      return { content: [{ type: "text", text: JSON.stringify(summary) }] };
    }
  );

  const deleteScheduleTool = tool(
    "delete_schedule",
    "删除指定 ID 的定时任务",
    { id: z.string().describe("要删除的任务 ID（从 list_schedules 获取）") },
    async ({ id }) => {
      const job = scheduler.listJobs().find(j => j.id === id);
      if (!job) {
        return { isError: true, content: [{ type: "text", text: "未找到可删除的定时任务" }] };
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
      if (!job) {
        return { isError: true, content: [{ type: "text", text: "未找到可操作的定时任务" }] };
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

async function runWechatClaudeCandidate({
  candidate,
  profileData,
  fullPrompt,
  mediaFiles,
  wechatCwd,
  abortSignal,
  extraMcpServers,
  wechatSystemPrompt,
  hasScheduler,
}) {
  const candidateProfiles = { ...profileData, activeProfileId: candidate.profileId };
  const agentEnv = buildAgentEnv(candidateProfiles, "medium", candidate.model);
  agentEnv.PWD = wechatCwd;
  const agentUserContent = buildWechatUserContent(fullPrompt, mediaFiles, {
    includeImageBlocks: candidate.provider !== "deepseek",
  });
  const userMsg = {
    type: "user",
    message: { role: "user", content: agentUserContent },
    parent_tool_use_id: null,
  };
  const queryAbortController = new AbortController();
  let stallTimer = null;
  let toolRunning = false;
  let stalled = false;
  let finalResponse = "";
  const onAbort = () => queryAbortController.abort();
  const resetStall = () => {
    clearTimeout(stallTimer);
    if (toolRunning) return;
    stallTimer = setTimeout(() => {
      stalled = true;
      queryAbortController.abort();
    }, STREAM_STALL_MS);
  };

  if (abortSignal.aborted) queryAbortController.abort();
  else abortSignal.addEventListener("abort", onAbort, { once: true });

  try {
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
        ...(candidate.provider === "claude" ? { model: candidate.model } : {}),
        ...(hasScheduler ? { disallowedTools: ["Bash"] } : {}),
      },
    });
    resetStall();
    for await (const ev of generator) {
      if (ev.type === "assistant") {
        const blocks = ev.message?.content || ev.content || [];
        if (Array.isArray(blocks) && blocks.some(block => block?.type === "tool_use")) toolRunning = true;
      } else if (ev.type === "user") {
        toolRunning = false;
      }
      resetStall();
      if (ev.type === "assistant") {
        const text = (ev.message?.content || ev.content || [])
          .filter(block => block.type === "text").map(block => block.text).join("");
        if (text) finalResponse = text;
      }
      if (ev.type === "result" && ev.subtype === "success" && ev.result) finalResponse = ev.result;
    }
    return finalResponse;
  } catch (error) {
    if (stalled && error?.name === "AbortError") {
      const stallError = new Error("AI 响应超时，请稍后重试。", { cause: error });
      stallError.code = "WECHAT_STALL_TIMEOUT";
      throw stallError;
    }
    throw error;
  } finally {
    clearTimeout(stallTimer);
    abortSignal.removeEventListener("abort", onAbort);
  }
}

async function runWechatCodexCandidate({ candidate, fullPrompt, mediaFiles, wechatCwd, abortSignal, wechatSystemPrompt }) {
  const codex = new Codex();
  const thread = codex.startThread({
    workingDirectory: wechatCwd,
    skipGitRepoCheck: true,
    approvalPolicy: "never",
    sandboxMode: "workspace-write",
    modelReasoningEffort: "medium",
    model: candidate.model,
    networkAccessEnabled: true,
    webSearchMode: "live",
  });
  const controller = new AbortController();
  let timedOut = false;
  let toolRunning = false;
  let stallTimer = null;
  const onAbort = () => controller.abort();
  const resetStall = () => {
    clearTimeout(stallTimer);
    if (toolRunning) return;
    stallTimer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, STREAM_STALL_MS);
  };
  if (abortSignal.aborted) controller.abort();
  else abortSignal.addEventListener("abort", onAbort, { once: true });

  const attachmentSummary = formatWechatMediaSummary(mediaFiles);
  const text = `${wechatSystemPrompt}\n\n${fullPrompt}${attachmentSummary ? `\n\n附件：\n${attachmentSummary}` : ""}`;
  const images = mediaFiles
    .filter(file => file.kind === "image" && file.filePath)
    .map(file => ({ type: "local_image", path: file.filePath }));
  const input = images.length > 0 ? [...images, { type: "text", text }] : text;

  try {
    const codexToolItems = new Set(["command_execution", "mcp_tool_call", "web_search", "file_change"]);
    const { events } = await thread.runStreamed(input, { signal: controller.signal });
    let finalResponse = "";
    resetStall();
    for await (const event of events) {
      if (event.type === "item.started" && codexToolItems.has(event.item?.type)) {
        toolRunning = true;
        clearTimeout(stallTimer);
      } else if (event.type === "item.completed" && codexToolItems.has(event.item?.type)) {
        toolRunning = false;
      }
      resetStall();
      if (event.type === "item.completed" && event.item?.type === "agent_message") {
        finalResponse = codexItemText(event.item) || finalResponse;
      } else if (event.type === "turn.failed") {
        throw new Error(event.error?.message || "Codex 请求失败");
      } else if (event.type === "error") {
        throw new Error(event.message || "Codex 请求失败");
      }
    }
    return finalResponse;
  } catch (error) {
    if (timedOut && error?.name === "AbortError") {
      const stallError = new Error("AI 响应超时，请稍后重试。", { cause: error });
      stallError.code = "WECHAT_STALL_TIMEOUT";
      throw stallError;
    }
    throw error;
  } finally {
    clearTimeout(stallTimer);
    abortSignal.removeEventListener("abort", onAbort);
  }
}

async function processWechatQuery(baseUrl, token, sender, prompt, contextToken, abortSignal, mediaFiles = []) {
  console.log(`[WeChat Agent] processWechatQuery starting for ${sender}...`);
  try {
    await sendWechatTyping(baseUrl, token, sender, 1, contextToken);

    const profileData = readProfiles();
    const active = getActiveProfile(profileData);
    console.log(`[WeChat Agent] Active profile: ${active ? active.name : "none"} (provider: ${active ? active.provider : "none"})`);

    // 取出该 sender 的对话历史，超时则清除重新开始
    const sessionEntry = normalizeWechatSessionEntry(wechatSenderSessions.get(sender));
    const isExpired = sessionEntry && (Date.now() - sessionEntry.lastAt >= WECHAT_SESSION_TTL_MS);
    if (isExpired) wechatSenderSessions.set(sender, { ...sessionEntry, turns: [] });
    const history = (!isExpired && sessionEntry?.turns) ? sessionEntry.turns : [];

    const hasScheduler = hasSchedulerIntent(prompt);
    const historyPrompt = summarizeWechatHistoryPrompt(prompt, mediaFiles);
    const wechatSystemPrompt = hasScheduler
      ? `${WECHAT_OUTPUT_PROMPT}\n\n${INKFELLOW_SCHEDULER_PROMPT}`
      : WECHAT_OUTPUT_PROMPT;

    const typingInterval = setInterval(() => {
      sendWechatTyping(baseUrl, token, sender, 1, contextToken);
    }, 6000);

    let finalResponse = "";
    try {
      const wechatCwd = resolveAllowedCwd("");
      let fullPrompt = prompt;
      if (history.length > 0) {
        const historyText = history.map(t => `${t.role === "user" ? "用户" : "助手"}：${t.content}`).join("\n");
        fullPrompt = `以下是本次对话的历史记录：\n${historyText}\n\n用户：${prompt}`;
      }
      const extraMcpServers = hasScheduler
        ? { scheduler: _buildSchedulerMcpServer({ sourceChannel: "wechat", sourcePeer: sender }) }
        : {};
      // Codex SDK 目前不能注入这个进程内的 scheduler MCP，涉及定时任务时跳过 Codex，
      // 其余场景仍可按动态配置把它作为 fallback。
      const candidates = buildModelCandidates(profileData, {
        excludedProviders: hasScheduler ? ["codex"] : [],
      });
      console.log(`[WeChat Agent] model chain: ${candidates.map(candidate => `${candidate.profileName}/${candidate.model}`).join(" -> ")}`);
      finalResponse = await runWithModelFallback(
        candidates,
        candidate => candidate.provider === "codex"
          ? runWechatCodexCandidate({ candidate, fullPrompt, mediaFiles, wechatCwd, abortSignal, wechatSystemPrompt })
          : runWechatClaudeCandidate({
            candidate,
            profileData,
            fullPrompt,
            mediaFiles,
            wechatCwd,
            abortSignal,
            extraMcpServers,
            wechatSystemPrompt,
            hasScheduler,
          }),
        { logPrefix: "WeChat Agent" },
      );
    } catch (err) {
      if (abortSignal.aborted) { console.warn(`[WeChat Agent] Aborted.`); return; }
      if (err?.code === "WECHAT_STALL_TIMEOUT") {
        console.warn("[WeChat Agent] Stream stalled, timed out after 3 min.");
        finalResponse = "⚠️ AI 响应超时，请稍后重试。";
      } else {
        console.error("[WeChat Agent] Error:", err);
        finalResponse = `⚠️ 助手发生错误: ${err.message}`;
      }
    } finally {
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
        const current = normalizeWechatSessionEntry(wechatSenderSessions.get(sender));
        wechatSenderSessions.set(sender, {
          ...current,
          turns: newTurns,
          lastAt: Date.now(),
          contextToken: contextToken || current.contextToken,
          lastContextAtMs: contextToken ? Date.now() : current.lastContextAtMs,
        });
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
  resolveWechatDeliveryTargets,
  resolveWechatDeliveryPeers,
  queueWechatPendingDelivery,
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

  if (url === "/api/usage-limits" && method === "GET") {
    (async () => {
      const [claude, codex] = await Promise.all([
        getClaudeSubscriptionLimits(),
        queryCodexSubscriptionLimits(),
      ]);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        updatedAt: new Date().toISOString(),
        providers: { claude, codex },
      }));
    })().catch((err) => {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: String(err?.message || err) }));
    });
    return;
  }

  // ── Claude subscription auth status ──────────────────────────
  // Run `claude auth status` — the only reliable way to check login state,
  // since credentials may be stored in the system keychain rather than a file.
  if (url === "/api/health/codex-auth" && method === "GET") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ authenticated: isCodexAuthAvailable() }));
    return;
  }

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
          if (profile.provider === "codex") {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Codex 会员账号由本机登录状态自动管理，不能手动添加" }));
            return;
          }
          if (profile.provider !== "claude" && !profile.apiKey) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "API Key 不能为空" }));
            return;
          }
          if (!profile.baseUrl && profile.provider !== "claude" && profile.provider !== "anthropic") {
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
          if (target.provider === "codex") {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Codex 会员账号由本机登录状态自动管理，不能编辑" }));
            return;
          }
          const updated = normalizeProfile({ ...target, ...payload.profile, id: target.id, provider: target.provider });
          if (updated.provider !== "claude" && !updated.apiKey) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "API Key 不能为空" }));
            return;
          }
          if (!updated.baseUrl && updated.provider !== "claude" && updated.provider !== "anthropic") {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Base URL 不能为空" }));
            return;
          }
          next = { ...current, profiles: current.profiles.map(p => p.id === id ? updated : p) };

        } else if (payload.action === "delete") {
          // 删除账号（不能删 Claude 会员 / 不能删到空）
          const id = String(payload.profileId ?? "");
          const target = current.profiles.find(p => p.id === id);
          if (!target || target.provider === "claude" || target.provider === "codex") {
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
        if (changed) clearAllSessions();

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
          const conv = JSON.parse(body);
          const history = readHistory();
          const idx = history.findIndex(h => h.id === conv.id);
          if (idx >= 0) {
            // 列表接口只返回摘要（无 messages），重命名等局部更新不应抹掉已存消息
            if (!("messages" in conv) && history[idx].messages) {
              conv.messages = history[idx].messages;
            }
            history[idx] = conv;
          } else {
            history.unshift(conv);
            if (history.length > MAX_SERVER_HISTORY) history.splice(MAX_SERVER_HISTORY);
          }
          writeHistory(history);
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

const wss = new WebSocketServer({ server: http });

// 心跳：探测半死连接。移动端 NAT/基站切换常常静默掐断 TCP，
// 服务端永远等不到 close 事件，run 也就一直挂着。两个周期没有 pong 即 terminate，
// terminate 会触发 close → run 进入宽限期而不是直接丢失。
const wsHeartbeat = setInterval(() => {
  for (const client of wss.clients) {
    if (client.isAlive === false) { client.terminate(); continue; }
    client.isAlive = false;
    client.ping();
  }
}, WS_HEARTBEAT_MS);
wss.on("close", () => clearInterval(wsHeartbeat));

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

// ── 断线宽限期 ─────────────────────────────────────────────
// 锁屏/切网/网络抖动导致 WS 断开时，不立即中止生成：把 run 挂为孤儿，
// 输出缓存在 buffer 里，客户端在宽限期内带 runId 重连即可无缝领回
//（包括断线期间已完成的完整回答）。宽限期内没人认领才真正 abort。
const orphanRuns = new Map(); // runId -> run

// ── 长驻 Claude 会话 ─────────────────────────────────────────
// 一条 query 跨多个回合复用，回合边界不再由 query 迭代结束划分，而是由
// system/session_state_changed state=idle 划分（该事件是 opt-in 的，见
// buildAgentEnv）。这样后台任务（system/task_*）能在前台轮结束后继续跑，
// 子代理事件也能带着 parent_tool_use_id 一并上来——squad cards UI 依赖这些。
//
// options 在 start() 时固化，所以 cwd/权限/模型等一变就得重启 runtime，
// 用 signature 判定。前台轮的事件路由目标是 claudeTurn，而不是 start() 时
// 捕获的那个 run——否则第二轮的事件会发给第一轮的连接。
let claudeTurn = null;          // { epoch, onEvent, finish, fail }
let claudeTurnEpoch = 0;
let claudeRuntimeSignature = null;

// 需要透传到前端的 system 事件：后台任务生命周期 + 子代理。其余 system 事件
// （尤其 session_state_changed）是服务端的回合控制信号，不该泄给 UI。
const CLIENT_VISIBLE_SYSTEM_SUBTYPES = new Set([
  "task_started",
  "task_progress",
  "task_updated",
  "task_notification",
]);

function claudeRuntimeSignatureOf(options) {
  return JSON.stringify({
    cwd: options.cwd,
    permissionMode: options.permissionMode,
    effort: options.effort,
    model: options.model ?? null,
    // resume 刻意不参与指纹：第一轮结束后 saveSession 会让第二轮带上
    // resume=sessionId，若计入指纹就会每轮重启 runtime，长驻等于白做。
    // 正在跑的会话本身就持有上下文；只有真需要重启时才用 resume 接回来。
    mcp: Object.keys(options.mcpServers ?? {}).sort(),
    systemPrompt: options.systemPrompt ?? null,
    // env 里只有这些会改变 agent 行为；整个 env 参与指纹会因无关变量频繁误重启
    env: {
      base: options.env?.ANTHROPIC_BASE_URL ?? null,
      model: options.env?.ANTHROPIC_MODEL ?? null,
      effort: options.env?.CLAUDE_CODE_EFFORT_LEVEL ?? null,
    },
  });
}

// 回合终止依赖 opt-in 的 session_state_changed/idle。上一次它静默失效时没有
// 任何报错、日志或测试失败，只有用户手动发第二条消息才暴露。看门狗把这种
// 失效变成可见信号：result 之后短时间内没等到 idle 就告警。纯观察，不改行为。
const TURN_IDLE_WATCHDOG_MS = 3_000;
let turnIdleWatchdog = null;

function armTurnIdleWatchdog() {
  clearTimeout(turnIdleWatchdog);
  if (!claudeTurn) return;
  const epoch = claudeTurn.epoch;
  turnIdleWatchdog = setTimeout(() => {
    turnIdleWatchdog = null;
    if (!claudeTurn || claudeTurn.epoch !== epoch) return; // 已换代 = 正常时序
    console.warn(
      `[Web Agent] result 后 ${TURN_IDLE_WATCHDOG_MS}ms 未收到 session_state_changed/idle：`
      + "本轮无法结束，后续消息将被排队。检查 SDK 是否仍支持 "
      + "CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS=1（见 buildAgentEnv）。"
    );
  }, TURN_IDLE_WATCHDOG_MS);
  turnIdleWatchdog.unref?.();
}

const claudeRuntime = new PersistentQueryRuntime({
  queryFactory: ({ prompt, options }) => query({ prompt, options }),
  onEvent: (ev) => {
    const turn = claudeTurn;
    if (!turn) return; // 无前台轮时到达的多是后台任务事件，由 UI 侧的活动条呈现
    turn.onEvent(ev);
    if (ev.type === "system" && ev.subtype === "session_state_changed" && ev.state === "idle") {
      clearTimeout(turnIdleWatchdog);
      turn.finish();
      return;
    }
    // origin 非空 = 后台任务的自动续写，不是用户轮的收尾，不进看门狗避免误报
    if (ev.type === "result" && !ev.origin) armTurnIdleWatchdog();
  },
  onError: (err) => { claudeTurn?.fail(err); },
  onClose: () => {
    claudeRuntimeSignature = null;
    claudeTurn?.fail(makeAbortError("会话已关闭"));
  },
});

function resetClaudeRuntime() {
  claudeTurnEpoch += 1;
  claudeTurn = null;
  clearTimeout(turnIdleWatchdog);
  claudeRuntimeSignature = null;
  claudeRuntimeAbort = null;
  if (claudeRuntime.started) claudeRuntime.close();
}

// 长驻 query 的 AbortController 属于 runtime 而不是某一轮：用每轮的 ac 会导致
// 第一轮结束时把整条会话一起 abort 掉。停止单轮走 interrupt()。
let claudeRuntimeAbort = null;

// 返回 true 表示已按"长驻会话"的方式停掉前台轮，调用方不要再 abort。
function interruptClaudeTurn() {
  if (!claudeRuntime.started || !claudeTurn) return false;
  claudeRuntime.interrupt().catch(err => {
    console.warn(`[Web Agent] interrupt 失败：${err?.message || err}`);
  });
  return true;
}

function createRun(runId, ws, ac) {
  return {
    id: runId,
    ac,
    ws,
    buffer: [],
    graceTimer: null,
    finished: false,
    pendingAskUserQuestion: null,
    send(obj) {
      // 所有事件带上 runId：客户端据此丢弃被新请求取代的旧 run 的迟到事件
      const tagged = { ...obj, runId: this.id };
      if (this.ws && this.ws.readyState === this.ws.OPEN) this.ws.send(JSON.stringify(tagged));
      else this.buffer.push(tagged);
    },
    detach() {
      this.ws = null;
      orphanRuns.set(this.id, this);
      clearTimeout(this.graceTimer);
      this.graceTimer = setTimeout(() => {
        orphanRuns.delete(this.id);
        if (this.pendingAskUserQuestion) {
          const pending = this.pendingAskUserQuestion;
          this.pendingAskUserQuestion = null;
          pending.cleanup?.();
          pending.reject(makeAbortError("连接已断开"));
        }
        if (!this.finished) {
          console.warn(`[Web Agent] Run ${this.id} 断线超过 ${RUN_GRACE_MS / 1000}s 未重连，中止生成。`);
          this.ac.abort();
        }
      }, RUN_GRACE_MS);
    },
    attach(newWs) {
      clearTimeout(this.graceTimer);
      this.graceTimer = null;
      orphanRuns.delete(this.id);
      this.ws = newWs;
      for (const obj of this.buffer.splice(0)) this.send(obj);
      // 断线期间未回答的澄清问题重新推给新页面
      if (this.pendingAskUserQuestion) {
        const p = this.pendingAskUserQuestion;
        this.send({ type: "ask_user_question", requestId: p.requestId, toolUseID: p.toolUseID ?? null, questions: p.questions });
      }
    },
    finish() {
      this.finished = true;
      if (this.ws) {
        clearTimeout(this.graceTimer);
        orphanRuns.delete(this.id);
      }
      // 已断线的 run：保留 buffer 到宽限期结束，等客户端重连领取完整结果
    },
  };
}

wss.on("connection", (ws) => {
  ws.isAlive = true;
  ws.on("pong", () => { ws.isAlive = true; });
  let activeRun = null;

  const send = (obj) => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
  };

  const clearPendingAskUserQuestion = (run, reason = "cancelled") => {
    if (!run?.pendingAskUserQuestion) return;
    const pending = run.pendingAskUserQuestion;
    run.pendingAskUserQuestion = null;
    pending.cleanup?.();
    pending.reject(makeAbortError(reason));
    run.send({ type: "ask_user_question_cancelled", requestId: pending.requestId, reason });
  };

  const waitForAskUserQuestionAnswer = (run, input, context = {}) => {
    const questions = normalizeAskUserQuestions(input);
    if (questions.length === 0) {
      return Promise.reject(new Error("AskUserQuestion 请求格式无效：缺少 questions/options"));
    }
    clearPendingAskUserQuestion(run, "新的澄清问题已替换上一条问题");

    const requestId = crypto.randomUUID();
    run.send({
      type: "ask_user_question",
      requestId,
      toolUseID: context.toolUseID ?? null,
      questions,
    });

    return new Promise((resolve, reject) => {
      const onAbort = () => {
        if (run.pendingAskUserQuestion?.requestId !== requestId) return;
        run.pendingAskUserQuestion = null;
        reject(makeAbortError("用户输入已取消"));
        run.send({ type: "ask_user_question_cancelled", requestId, reason: "aborted" });
      };
      const signal = context.signal;
      if (signal?.aborted) {
        reject(makeAbortError("用户输入已取消"));
        return;
      }
      signal?.addEventListener("abort", onAbort, { once: true });
      run.pendingAskUserQuestion = {
        requestId,
        questions,
        toolUseID: context.toolUseID ?? null,
        cleanup: () => signal?.removeEventListener("abort", onAbort),
        reject,
        resolve: (payload = {}) => {
          if (run.pendingAskUserQuestion?.requestId !== requestId) return;
          run.pendingAskUserQuestion = null;
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
            reject(new Error("未收到有效回答"));
            return;
          }
          resolve({ questions, answers, response });
        },
      };
    });
  };

  // Send the persisted default first; the browser sends a profile-specific refresh
  // after it loads its local activeProfileId.
  sendSkillInit(send, getActiveProfile(readProfiles())?.provider);

  ws.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    // 应用层心跳：浏览器无法主动发 WS ping 帧，用消息模拟，
    // 让客户端能主动探测出"半死连接"（readyState 仍是 OPEN 但实际已断）。
    if (msg.type === "ping") {
      send({ type: "pong" });
      return;
    }

    // 断线重连后领回生成中的 run：补发断线期间缓存的全部事件
    if (msg.resumeRun != null) {
      const run = orphanRuns.get(String(msg.resumeRun));
      if (run) {
        if (activeRun && activeRun !== run && !activeRun.finished) activeRun.ac.abort();
        activeRun = run;
        run.attach(ws);
        console.log(`[Web Agent] Run ${run.id} 已被重连客户端领回（补发 ${run.finished ? "已完成" : "进行中"}）。`);
      } else {
        send({ type: "run_not_found", runId: String(msg.resumeRun) });
      }
      return;
    }

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
      if (!activeRun?.pendingAskUserQuestion || msg.requestId !== activeRun.pendingAskUserQuestion.requestId) {
        send({ type: "ask_user_question_error", requestId: msg.requestId ?? null, text: "这个问题已过期，请重新发起请求。" });
        return;
      }
      activeRun.pendingAskUserQuestion.resolve(msg);
      return;
    }

    if (msg.type === "ask_user_question_cancel") {
      clearPendingAskUserQuestion(activeRun, "用户取消了澄清问题");
      return;
    }

    if (msg.reset) {
      clearPendingAskUserQuestion(activeRun, "会话已重置");
      clearAllSessions();
      // 重置是要丢弃整条会话，长驻 runtime 必须一起关掉，否则下一条消息会
      // 复用旧 session 的上下文。
      resetClaudeRuntime();
      if (activeRun && !activeRun.finished) activeRun.ac.abort();
      activeRun = null;
      return;
    }

    if (msg.setSession != null) {
      const id = String(msg.setSession);
      const provider = resolveSessionProvider(msg.sessionProvider, id);
      setProviderSession(provider, id);
      send({ type: "session", sessionId: id, provider });
      return;
    }

    if (msg.stop) {
      clearPendingAskUserQuestion(activeRun, "用户停止了生成");
      // Claude 走长驻会话：只中断本轮，保留 query 供后续消息复用。
      // Codex 仍是每请求一条流，只能 abort。
      if (interruptClaudeTurn()) { activeRun = null; return; }
      if (activeRun && !activeRun.finished) { activeRun.ac.abort(); activeRun = null; }
      else send({ type: "stopped" });
      return;
    }

    // Cancel any in-flight query before starting a new one
    clearPendingAskUserQuestion(activeRun, "新的请求已开始");
    if (!interruptClaudeTurn() && activeRun && !activeRun.finished) activeRun.ac.abort();
    activeRun = null;

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
    };

    const ac = new AbortController();
    // runId 由客户端生成并随消息带上，断线重连时凭它领回本次生成
    const runId = typeof msg.runId === "string" && msg.runId ? msg.runId.slice(0, 64) : crypto.randomUUID();
    const run = createRun(runId, ws, ac);
    activeRun = run;
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

    if (activeProfile && activeProfile.provider !== "claude" && activeProfile.provider !== "codex" && !activeProfile.apiKey) {
      send({ type: "error", text: `${activeProfile.name} 的 API Key 还没有配置，请先在账号设置里保存。` });
      send({ type: "done" });
      run.finish(); activeRun = null;
      return;
    }
    if (activeProfile?.provider === "codex" && !isCodexAuthAvailable()) {
      send({ type: "error", text: "Codex 还没有登录，请先打开 Codex 客户端或运行 codex login 完成 ChatGPT 账号登录。" });
      send({ type: "done" });
      run.finish(); activeRun = null;
      return;
    }
    if (activeProfile?.provider === "codex" && schedulerRequest) {
      send({ type: "error", text: "定时任务目前需要 Claude 会员通道的 scheduler 工具。请切换到 Claude 会员后再创建、查看或修改提醒任务。" });
      send({ type: "done" });
      run.finish(); activeRun = null;
      return;
    }

    const resolvedCwd = resolveAllowedCwd(msg.cwd);
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
    };
    if (schedulerRequest) {
      options.mcpServers = {
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
      (async () => {
        const send = (obj) => run.send(obj); // 断线时进 buffer，重连后补发
        let stallTimer = null;
        let hardTimer = null;
        let isTimeoutAbort = false;
        let toolRunning = false; // 命令/工具执行期间无事件是正常的，可能持续数小时
        const tempImagePaths = [];
        const resetStall = () => {
          clearTimeout(stallTimer);
          if (toolRunning) return;
          stallTimer = setTimeout(() => {
            isTimeoutAbort = true;
            ac.abort();
          }, STREAM_STALL_MS);
        };
        const resetHardTimer = () => {
          clearTimeout(hardTimer);
          if (toolRunning) return;
          hardTimer = setTimeout(() => {
            isTimeoutAbort = true;
            ac.abort();
          }, MAX_AGENT_RUN_MS);
        };
        const CODEX_TOOL_ITEMS = new Set(["command_execution", "mcp_tool_call", "web_search", "file_change"]);
        resetHardTimer();
        try {
          const codex = new Codex();
          const EFFORT_TO_REASONING = { low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "xhigh" };
          const threadOptions = {
            workingDirectory: resolvedCwd,
            skipGitRepoCheck: true,
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
              const subtype = (img.mediaType || "image/png").split("/")[1] || "png";
              const ext = subtype.toLowerCase().split(/[;+]/)[0].replace(/[^a-z0-9]/g, "").slice(0, 12) || "png";
              const tmpPath = join(DATA_DIR, `codex-img-${Date.now()}-${crypto.randomBytes(3).toString("hex")}.${ext}`);
              writeFileSync(tmpPath, Buffer.from(img.data, "base64"));
              tempImagePaths.push(tmpPath);
              parts.push({ type: "local_image", path: tmpPath });
            }
            parts.push({ type: "text", text: msg.prompt });
            input = parts;
          } else {
            input = msg.prompt;
          }

          resetStall();
          const { events } = await thread.runStreamed(input, { signal: ac.signal });
          let codexResultSent = false;
          for await (const ev of events) {
            if (ev.type === "item.started" && CODEX_TOOL_ITEMS.has(ev.item?.type)) {
              toolRunning = true;
              clearTimeout(stallTimer);
              clearTimeout(hardTimer);
            } else if (ev.type === "item.completed" && CODEX_TOOL_ITEMS.has(ev.item?.type)) {
              toolRunning = false;
              resetHardTimer();
            }
            resetStall();
            if (ev.type === "thread.started") {
              saveCodexThread(ev.thread_id);
              send({ type: "session", sessionId: ev.thread_id, provider: "codex" });
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
          if (!codexResultSent) send({ type: "result", subtype: "success", provider: "codex" });
          send({ type: "done" });
        } catch (err) {
          if (err?.name === "AbortError") {
            if (isTimeoutAbort) {
              send({ type: "error", text: "Codex 响应超时，请稍后重新发送消息。" });
              send({ type: "done" });
            } else {
              send({ type: "stopped" });
            }
          } else {
            send({ type: "error", text: String(err) });
            send({ type: "done" });
          }
        } finally {
          clearTimeout(stallTimer);
          clearTimeout(hardTimer);
          for (const tempPath of tempImagePaths) {
            try { unlinkSync(tempPath); } catch { }
          }
          run.finish();
          if (activeRun === run) activeRun = null;
        }
      })();
      return;
    }

    (async () => {
      const send = (obj) => run.send(obj); // 断线时进 buffer，重连后补发
      let stallTimer = null;
      let hardTimer = null;
      let isStallAbort = false;
      let isHardAbort = false;
      let waitingForUserInput = false;
      let toolRunning = false; // 工具执行期间 SDK 无事件是正常的，可能持续数小时
      // Stall watchdog: resets on each SDK event. Catches truly frozen streams.
      const resetStall = () => {
        clearTimeout(stallTimer);
        if (waitingForUserInput || toolRunning) return;
        // 长驻会话下只中断本轮；abort 会连整条 query 一起杀掉
        stallTimer = setTimeout(() => {
          isStallAbort = true;
          if (!interruptClaudeTurn()) ac.abort();
        }, STREAM_STALL_MS);
      };
      const resetHardTimer = () => {
        clearTimeout(hardTimer);
        if (waitingForUserInput || toolRunning) return;
        hardTimer = setTimeout(() => {
          isHardAbort = true;
          if (!interruptClaudeTurn()) ac.abort();
        }, MAX_AGENT_RUN_MS);
      };
      // 工具开始执行（assistant 消息带 tool_use）→ 两个看门狗全部暂停；
      // tool_result 回来（user 消息）→ 重新计时。硬上限因此只约束 API 阶段
      //（无限 api_retry 兜底），不会误杀跑几十个小时的长任务。
      const updateToolState = (ev) => {
        if (ev.type === "assistant") {
          const blocks = ev.message?.content;
          if (Array.isArray(blocks) && blocks.some(b => b?.type === "tool_use")) {
            toolRunning = true;
            clearTimeout(stallTimer);
            clearTimeout(hardTimer);
          }
        } else if (ev.type === "user" && toolRunning) {
          toolRunning = false;
          resetStall();
          resetHardTimer();
        }
      };
      const pauseForUserInput = () => {
        waitingForUserInput = true;
        clearTimeout(stallTimer);
        clearTimeout(hardTimer);
      };
      const resumeAfterUserInput = () => {
        waitingForUserInput = false;
        if (!ac.signal.aborted) {
          resetStall();
          resetHardTimer();
        }
      };
      // Hard cap: api_retry loops reset the stall timer indefinitely; this ensures
      // the request always terminates even when the SDK retries for minutes on end.
      resetHardTimer();

      const collectAskUserQuestionInput = async (input, context = {}) => {
        pauseForUserInput();
        try {
          const answer = await waitForAskUserQuestionAnswer(run, input, context);
          const updatedInput = {
            ...input,
            questions: answer.questions,
          };
          if (answer.response && Object.keys(answer.answers).length === 0) {
            updatedInput.response = answer.response;
          } else {
            updatedInput.answers = answer.answers;
          }
          return updatedInput;
        } finally {
          resumeAfterUserInput();
        }
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
          return {
            behavior: "deny",
            message: `Web UI 当前只处理 ${ASK_USER_QUESTION_TOOL} 澄清问题，不会自动批准 ${toolName}。请切换到合适的权限模式后重试。`,
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

      // 把一个前台轮跑到 idle。runtime 是模块级长驻的：签名没变就复用同一条
      // query，只把新消息推进去；变了才重启。回合的结束信号是 idle，不是
      // query 迭代结束——后者在长驻模式下只有会话彻底关闭时才会发生。
      const runQuery = (promptMsg, queryOptions) => new Promise((resolve, reject) => {
        const signature = claudeRuntimeSignatureOf(queryOptions);
        if (!claudeRuntime.started || claudeRuntimeSignature !== signature) {
          if (claudeRuntime.started) claudeRuntime.close();
          // 用 runtime 自己的 controller，不要用本轮的 ac——否则第一轮收尾时
          // 会把整条长驻会话一起 abort 掉。
          claudeRuntimeAbort = new AbortController();
          claudeRuntime.start({ ...queryOptions, abortController: claudeRuntimeAbort });
          claudeRuntimeSignature = signature;
        }

        const epoch = ++claudeTurnEpoch;
        let settled = false;
        const settle = (fn, arg) => {
          if (settled) return;
          settled = true;
          if (claudeTurn?.epoch === epoch) claudeTurn = null;
          fn(arg);
        };

        claudeTurn = {
          epoch,
          onEvent: (ev) => { try { handleClaudeEvent(ev); } catch (err) { settle(reject, err); } },
          finish: () => settle(resolve, undefined),
          fail: (err) => settle(reject, err),
        };

        try {
          claudeRuntime.send(promptMsg);
        } catch (err) {
          settle(reject, err);
        }
      });

      // 单条事件的处理：从原来的 for-await 循环体搬过来，语义不变，
      // 只是循环里的 continue 变成了 return。
      const handleClaudeEvent = (ev) => {
        updateToolState(ev);
        // api_retry means the SDK is in a backoff loop — don't reset the stall
        // timer here or it will keep resetting indefinitely while the WebSocket
        // sits idle and the browser receives nothing. Real progress resets it.
        if (!(ev.type === "system" && ev.subtype === "api_retry")) resetStall();
        if (ev.type === "system" && ev.subtype === "init") {
          saveSession(ev.session_id);
          send({ type: "session", sessionId: ev.session_id, provider: "claude" });
          // ev.skills = skill slugs only; ev.slash_commands = skills + built-in names
          const skillsFromSdk = Array.isArray(ev.skills) && ev.skills.length > 0
            ? ev.skills
            : (Array.isArray(ev.slash_commands) ? ev.slash_commands : []);
          if (skillsFromSdk.length > 0) cachedSkillsByProvider["claude"] = skillsFromSdk; // keep cache fresh
          send({
            type: "system",
            subtype: "init",
            slash_commands: skillsFromSdk,
            skills: skillsFromSdk,
          });
          return;
        }
        // Forward retry/status events so the frontend can show progress instead of silently spinning
        if (ev.type === "system" && (ev.subtype === "api_retry" || ev.subtype === "status")) {
          send(ev);
          return;
        }
        // 后台任务与子代理生命周期事件要透传给前端（squad cards 依赖），
        // 其余 system 事件（含 session_state_changed）留在服务端做回合控制。
        if (ev.type === "system" && CLIENT_VISIBLE_SYSTEM_SUBTYPES.has(ev.subtype)) {
          send(ev);
          return;
        }
        if (ev.type !== "system") send(ev);
      };

      const isThinkingSignatureError = (err) => {
        const s = String(err);
        return s.includes("signature") && s.includes("thinking");
      };

      // Rebuild the request as a fresh (no-resume) query that carries the prior
      // conversation as injected text — preserving context while shedding the
      // corrupted thinking blocks. Mirrors the WeChat path's history injection.
      const buildRecoveryMsg = () => {
        const history = extractSessionTextHistory(sessionId);
        if (history.length === 0) return null;
        const historyText = history
          .map(t => `${t.role === "user" ? "用户" : "助手"}：${t.text}`)
          .join("\n");
        const injected = `以下是本次对话此前的历史记录（供你延续上下文）：\n${historyText}\n\n用户：${msg.prompt}`;
        const recoveredContent = content
          .filter(b => b.type !== "text")        // keep any images
          .concat([{ type: "text", text: injected }]);
        return { type: "user", message: { role: "user", content: recoveredContent }, parent_tool_use_id: null };
      };

      try {
        resetStall();
        try {
          await runQuery(userMsg, options);
        } catch (err) {
          // Thinking-signature 400 on resume: the session's thinking blocks are
          // unverifiable after an interruption. Recover by replaying the turn on a
          // fresh session with text-injected history, instead of losing all context.
          if (!isThinkingSignatureError(err) || ac.signal.aborted) throw err;
          const recoveryMsg = buildRecoveryMsg();
          clearSession(); // abandon the corrupted session; the retry starts a clean one
          if (!recoveryMsg) throw err; // nothing to inject → surface the original error
          console.warn("[Web Agent] Thinking-signature error; recovering with text-injected history.");
          const recoveryOptions = { ...options };
          delete recoveryOptions.resume; // start fresh; history is carried in the prompt
          resetStall();
          await runQuery(recoveryMsg, recoveryOptions);
        }
        send({ type: "done" });
      } catch (err) {
        if (err?.name === "AbortError") {
          if (isStallAbort) {
            send({ type: "error", text: "AI 长时间无响应（3 分钟内无任何进展），已中断，请重新发送消息。" });
            send({ type: "done" });
          } else if (isHardAbort) {
            send({ type: "error", text: "本次请求在 API 阶段耗时过长（可能在反复重试），已中断，请稍后重新发送消息。" });
            send({ type: "done" });
          } else {
            send({ type: "stopped" });
          }
        } else {
          send({ type: "error", text: String(err) });
          send({ type: "done" });
        }
      } finally {
        clearTimeout(stallTimer);
        clearTimeout(hardTimer);
        clearPendingAskUserQuestion(run, "请求已结束");
        run.finish();
        if (activeRun === run) activeRun = null;
      }
    })();
  });

  ws.on("close", () => {
    if (activeRun && !activeRun.finished) {
      // 断线不立即中止生成：进入宽限期，等客户端带 runId 重连领回
      activeRun.detach();
    }
    activeRun = null;
  });
});

http.listen(PORT, HOST, () => {
  console.log(`claude-chat listening on ${HOST}:${PORT}`);
});
