// 每会话 append-only 事件日志（契约见 _design/p1-event-log.md）。
//
// 为什么存在：原来整个 history-<PORT>.json 常驻内存 + 几乎每个事件全量重写一遍
// （30MB 文件实测单次 ~125ms 硬阻塞事件循环）。这里改成一行一个事件追加写，
// 写入从 O(历史) 降到 O(事件)，常驻内存从 O(历史) 降到 O(会话数 × meta)。
//
// 更重要的是：有了单调递增的 seq，客户端断线/刷新后只要报一个游标就能补齐差量，
// 于是"这一轮还在不在"不再取决于某条 WebSocket 活着与否。
import {
  appendFileSync, closeSync, existsSync, fstatSync, mkdirSync, openSync,
  readFileSync, readSync, readdirSync, renameSync, rmSync, writeFileSync,
} from "node:fs";
import { join } from "node:path";
import crypto from "node:crypto";

// convId 直接用作目录名，必须严格校验，否则就是目录穿越
const CONV_ID_RE = /^[A-Za-z0-9_-]{4,128}$/;
const DEFAULT_READ_LIMIT = 2000;
const PROJECTION_CACHE_MAX = 8;

// 与 server.js 的 CLIENT_VISIBLE_SYSTEM_SUBTYPES 保持一致：
// 这些 system 事件要进 assistant 消息的 blocks，其余的只是传输层噪音。
const CLIENT_VISIBLE_SYSTEM_SUBTYPES = new Set([
  "task_started",
  "task_progress",
  "task_updated",
  "task_notification",
]);

const TERMINAL_TURN_STATUSES = new Set(["complete", "error", "stopped", "continued"]);

let rootDir = null;
const metaCache = new Map();                 // convId -> meta
const projectionCache = new Map();           // convId -> { lastSeq, conversation }

// ── 基础设施 ───────────────────────────────────────────────

export function configure({ dataDir, port } = {}) {
  const next = dataDir || process.env.CLAUDE_CHAT_DATA_DIR || null;
  if (!next) throw new Error("event-log 未配置 dataDir");
  const instance = port == null ? "" : String(port).trim();
  if (instance && !/^\d{2,6}$/.test(instance)) {
    throw new Error(`event-log 收到非法实例端口: ${JSON.stringify(port)}`);
  }
  // 同一部署目录会同时运行 8082 / 8083。旧 history 文件靠端口后缀隔离，
  // 事件目录也必须保留这层边界，否则两个账号会读到彼此的会话。
  rootDir = instance
    ? join(next, "conversations", instance)
    : join(next, "conversations");
  mkdirSync(rootDir, { recursive: true });
  metaCache.clear();
  projectionCache.clear();
  return rootDir;
}

function root() {
  if (!rootDir) configure({});
  return rootDir;
}

export function assertConvId(convId) {
  const id = typeof convId === "string" ? convId.trim() : "";
  if (!CONV_ID_RE.test(id)) throw new Error(`非法的 conversationId: ${JSON.stringify(convId)}`);
  return id;
}

/** 校验但不抛：调用方拿 null 走"未知会话"分支即可 */
export function normalizeConvId(convId) {
  const id = typeof convId === "string" ? convId.trim() : "";
  return CONV_ID_RE.test(id) ? id : null;
}

function convDir(convId) { return join(root(), assertConvId(convId)); }
function logPath(convId) { return join(convDir(convId), "events.ndjson"); }
function metaPath(convId) { return join(convDir(convId), "meta.json"); }

function clone(value) {
  if (value == null) return value;
  try { return structuredClone(value); } catch { }
  try { return JSON.parse(JSON.stringify(value)); } catch { return value; }
}

// ── meta ──────────────────────────────────────────────────

function emptyMeta(convId) {
  return {
    id: convId,
    title: "新对话",
    date: new Date().toISOString(),
    sessionId: null,
    sessionProvider: null,
    profileId: null,
    lastSeq: 0,
    messageCount: 0,
    turn: null,
  };
}

function readMetaFromDisk(convId) {
  const file = metaPath(convId);
  if (!existsSync(file)) return null;
  // events.ndjson 是权威，meta.json 只是可重建的索引。进程可能恰好在
  // appendFileSync 成功、writeMeta 尚未执行时被 kill；重启后若继续相信旧
  // meta.lastSeq，下一条事件就会复用已经落盘的 seq。
  const actualLastSeq = scanLastSeq(convId);
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    return { ...emptyMeta(convId), ...parsed, id: convId, lastSeq: actualLastSeq };
  } catch {
    // meta 坏了不能让整个会话读不出来：lastSeq 从日志重算，其余走默认值
    return { ...emptyMeta(convId), lastSeq: actualLastSeq };
  }
}

// 原子写：先写临时文件再 rename，避免断电/被 kill 时留下半截 meta
function writeMeta(convId, meta) {
  const dir = convDir(convId);
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, `.meta.json.${process.pid}.tmp`);
  writeFileSync(tmp, JSON.stringify(meta), "utf8");
  renameSync(tmp, metaPath(convId));
  metaCache.set(convId, meta);
  return meta;
}

export function getMeta(convId) {
  const id = normalizeConvId(convId);
  if (!id) return null;
  if (metaCache.has(id)) return metaCache.get(id);
  if (!existsSync(convDir(id))) return null;
  const meta = readMetaFromDisk(id) ?? { ...emptyMeta(id), lastSeq: scanLastSeq(id) };
  metaCache.set(id, meta);
  return meta;
}

export function ensureConversation(convId, { title } = {}) {
  const id = assertConvId(convId);
  const existing = getMeta(id);
  if (existing) {
    // 目录/日志可能在崩溃后存在而 meta 尚未创建。ensure 的承诺是返回时
    // 会话布局完整，因此顺手把重建出的 meta 补回磁盘。
    if (!existsSync(metaPath(id))) return writeMeta(id, existing);
    return existing;
  }
  mkdirSync(convDir(id), { recursive: true });
  const meta = emptyMeta(id);
  if (title) meta.title = String(title).replace(/[\n\r]+/g, " ").trim().slice(0, 60) || "新对话";
  return writeMeta(id, meta);
}

export function updateMeta(convId, patch = {}) {
  const id = assertConvId(convId);
  const current = getMeta(id) ?? ensureConversation(id);
  // lastSeq 只由 appendEvent 维护，外部 patch 不得覆盖，否则游标会错乱
  const { lastSeq: _ignored, ...safe } = patch;
  const next = { ...current, ...safe, id };
  return writeMeta(id, next);
}

// ── 日志读写 ───────────────────────────────────────────────

// 逐行解析；最后一行可能是被 kill 打断的半截 JSON，跳过而不是抛异常
function* iterateEntries(convId) {
  const file = logPath(convId);
  if (!existsSync(file)) return;
  const raw = readFileSync(file, "utf8");
  let start = 0;
  while (start < raw.length) {
    let end = raw.indexOf("\n", start);
    if (end === -1) end = raw.length;
    const line = raw.slice(start, end).trim();
    start = end + 1;
    if (!line) continue;
    let parsed;
    try { parsed = JSON.parse(line); } catch { continue; }
    if (parsed && typeof parsed.seq === "number") yield parsed;
  }
}

function scanLastSeq(convId) {
  let last = 0;
  for (const entry of iterateEntries(convId)) {
    if (entry.seq > last) last = entry.seq;
  }
  return last;
}

// appendFileSync 会从当前 EOF 继续写。若 EOF 是一次崩溃留下的半截 JSON 且
// 没有换行，直接追加会把下一条好记录也粘坏；只读最后一个字节即可决定是否
// 先补分隔符，不能为此在每条事件上重读整个日志。
function logNeedsSeparator(convId) {
  const file = logPath(convId);
  if (!existsSync(file)) return false;
  let fd;
  try {
    fd = openSync(file, "r");
    const size = fstatSync(fd).size;
    if (size === 0) return false;
    const byte = Buffer.allocUnsafe(1);
    readSync(fd, byte, 0, 1, size - 1);
    return byte[0] !== 0x0a;
  } finally {
    if (fd != null) closeSync(fd);
  }
}

export function appendEvent(convId, kind, payload) {
  return appendEvents(convId, [{ kind, payload }])[0];
}

export function appendEvents(convId, entries) {
  const id = assertConvId(convId);
  const list = Array.isArray(entries) ? entries.filter(Boolean) : [];
  if (list.length === 0) return [];

  const meta = getMeta(id) ?? ensureConversation(id);
  let seq = meta.lastSeq;
  const ts = Date.now();
  const written = [];
  let lines = "";

  for (const entry of list) {
    seq += 1;
    const record = { seq, ts, kind: entry.kind, payload: entry.payload ?? null };
    lines += `${JSON.stringify(record)}\n`;
    written.push({ seq, ts });
  }

  mkdirSync(convDir(id), { recursive: true });
  if (logNeedsSeparator(id)) lines = `\n${lines}`;
  // 单次 I/O 追加：seq 必须先落盘再被发出去，保证"客户端见过的 seq 一定已持久化"
  appendFileSync(logPath(id), lines, "utf8");

  const patch = { lastSeq: seq, date: new Date(ts).toISOString() };
  // turn 事件顺带把当前轮次快照刷进 meta，重连时服务端据此回答"还在跑吗"
  for (const entry of list) {
    if (entry.kind !== "turn" || !entry.payload) continue;
    patch.turn = {
      turnId: entry.payload.turnId ?? null,
      status: entry.payload.status ?? null,
      requestId: entry.payload.requestId ?? null,
    };
  }
  // session 事件带来的 sessionId 也要落 meta，否则重开会话接不回 SDK session
  for (const entry of list) {
    if (entry.kind !== "sdk" || entry.payload?.type !== "session") continue;
    if (entry.payload.sessionId) patch.sessionId = entry.payload.sessionId;
    if (entry.payload.provider) patch.sessionProvider = entry.payload.provider;
  }
  // 首条 user 事件定标题
  if ((meta.title === "新对话" || !meta.title)) {
    const firstUser = list.find(entry => entry.kind === "user" && entry.payload?.text);
    if (firstUser) {
      patch.title = String(firstUser.payload.text).replace(/[\n\r]+/g, " ").trim().slice(0, 60) || "新对话";
    }
  }

  writeMeta(id, { ...meta, ...patch });
  projectionCache.delete(id);
  return written;
}

export function readEventsSince(convId, sinceSeq = 0, { limit = DEFAULT_READ_LIMIT } = {}) {
  const id = normalizeConvId(convId);
  if (!id || !existsSync(convDir(id))) return { events: [], lastSeq: 0, truncated: false };
  const from = Number.isFinite(sinceSeq) && sinceSeq > 0 ? sinceSeq : 0;
  const lastSeq = getMeta(id)?.lastSeq ?? 0;
  const events = [];
  let truncated = false;
  for (const entry of iterateEntries(id)) {
    if (entry.seq <= from) continue;
    if (events.length >= limit) { truncated = true; break; }
    events.push(entry);
  }
  return { events, lastSeq, truncated };
}

// ── 投影：事件日志 → 今天 history.json 里那种 conversation 对象 ──
//
// 这几个函数是从 server.js 的 normalizeAssistantHistoryBlocks /
// assistantHistoryBlockKey / appendRunHistoryBlocks / persistRunEvent /
// finalizeRunHistory 原样搬过来的，只是把"写进 run 持有的对象"改成
// "写进本次重放的局部状态"。行为必须与实时路径完全一致，否则重连补齐
// 出来的界面会和一路连着看到的不一样。

function normalizeAssistantBlocks(content) {
  const items = Array.isArray(content) ? content : (content ? [content] : []);
  return items.filter(Boolean).map(item => {
    const raw = clone(item);
    if (item.type === "thinking") {
      return { type: "thinking", thinking: item.thinking ?? "", signature: item.signature ?? null, raw };
    }
    if (item.type === "text") {
      return { type: "text", text: item.text ?? "", citations: item.citations ?? null, raw };
    }
    if (item.type === "tool_use" || item.type === "server_tool_use" || item.type === "mcp_tool_use") {
      return {
        type: item.type,
        id: item.id ?? "",
        name: item.name ?? "tool",
        serverName: item.server_name ?? item.serverName ?? null,
        input: item.input ?? {},
        raw,
      };
    }
    return raw && typeof raw === "object" && !Array.isArray(raw)
      ? { ...raw, type: item.type || "unknown", raw }
      : { type: item.type || "unknown", raw };
  });
}

function blockKey(block) {
  const id = block?.id || block?.raw?.id || block?.raw?.call_id || block?.raw?.tool_use_id;
  return id ? `${block.type || "unknown"}:${id}` : "";
}

/**
 * 把一个已存档的 block 还原成 SDK content 项，供"手上只有整段快照、没有事件流"
 * 的场景（老客户端整段 PUT、历史迁移）重建日志用。
 *
 * 优先用 block 顶层的归一化字段，只有拿不到归一形式时才回退 raw：
 * raw 是当年落盘的原始副本，实测老数据里存在 raw.text 带 U+FFFD 替换字符、
 * 而 block.text 是干净的情况（流式分片拼接时留下的）。block.text 才是 UI
 * 一直在渲染的那份，必须以它为准，否则迁移会把好数据换成坏数据。
 */
export function blockToSdkContent(block) {
  if (!block || typeof block !== "object") return block;
  if (block.type === "text") {
    return { type: "text", text: block.text ?? "", ...(block.citations ? { citations: block.citations } : {}) };
  }
  if (block.type === "thinking") {
    return { type: "thinking", thinking: block.thinking ?? "", signature: block.signature ?? null };
  }
  if (block.type === "tool_use" || block.type === "server_tool_use" || block.type === "mcp_tool_use") {
    return {
      type: block.type,
      id: block.id ?? "",
      name: block.name ?? "tool",
      ...(block.serverName ? { server_name: block.serverName } : {}),
      input: block.input ?? {},
    };
  }
  // sdk_event 这类没有归一形式，raw 本身就是原始事件
  return block.raw ?? block;
}

function createProjectionState(convId) {
  return {
    id: convId,
    messages: [],
    current: null,       // 对应 run.historyAssistantMessage
    last: null,          // 对应 run.lastHistoryAssistantMessage
    sessionId: null,
    sessionProvider: null,
    profileId: null,
    title: null,
    date: null,
    currentTurnId: null,
  };
}

function ensureAssistant(state, ts) {
  if (state.current) return state.current;
  const message = {
    id: state.currentTurnId || `assistant_${crypto.randomUUID()}`,
    role: "assistant",
    text: "",
    blocks: [],
    raw: [],
    events: [],
    cost: null,
    status: "running",
    createdAt: new Date(ts).toISOString(),
  };
  state.messages.push(message);
  state.current = message;
  return message;
}

function appendBlocks(state, blocks, event, ts) {
  if (!blocks?.length) return;
  const message = ensureAssistant(state, ts);
  for (const block of clone(blocks)) {
    const key = blockKey(block);
    const existingIndex = key
      ? message.blocks.findIndex(existing => blockKey(existing) === key)
      : -1;
    if (existingIndex >= 0) message.blocks[existingIndex] = block;
    else message.blocks.push(block);
  }
  if (event) message.events.push(clone(event));
  if (event?.message) message.raw.push(clone(event.message));
  message.text = message.blocks
    .filter(block => (block.type === "text" || block.type === "refusal") && block.text)
    .map(block => block.text)
    .join("\n\n");
  message.updatedAt = new Date(ts).toISOString();
  state.date = message.updatedAt;
}

function finalize(state, status = "complete", cost = null, ts = Date.now()) {
  const message = state.current;
  if (!message) return;
  message.status = status;
  message.updatedAt = new Date(ts).toISOString();
  if (cost != null) message.cost = cost;
  state.last = message;
  state.current = null;
}

// 与 server.js 的 persistRunEvent 逐分支对齐
function applySdkEvent(state, event, ts) {
  if (!event?.type) return;

  if (event.type === "session") {
    if (event.sessionId) state.sessionId = event.sessionId;
    if (event.provider) state.sessionProvider = event.provider;
    return;
  }
  if (event.type === "assistant") {
    appendBlocks(state, normalizeAssistantBlocks(event.message?.content ?? event.content), event, ts);
    return;
  }
  if (event.type === "server_tool_use" || event.type === "mcp_tool_use" || event.type === "tool_use") {
    appendBlocks(state, normalizeAssistantBlocks([event]), event, ts);
    return;
  }
  if (event.type?.includes("tool_result") || event.type === "tool_progress"
    || (event.type === "system" && CLIENT_VISIBLE_SYSTEM_SUBTYPES.has(event.subtype))) {
    // 后台任务可能跨轮次才回来：此时本轮 assistant 消息已 finalize，
    // 要临时挂回上一条消息上追加，而不是凭空开一条新的 assistant 消息。
    const reuse = !state.current && state.last;
    if (reuse) state.current = state.last;
    appendBlocks(state, [{ type: "sdk_event", eventType: event.subtype || event.type, raw: clone(event) }], event, ts);
    if (reuse) state.current = null;
    return;
  }
  if (event.type === "result") {
    finalize(state, event.subtype === "success" || !event.is_error ? "complete" : "error",
      event.total_cost_usd ?? null, ts);
    return;
  }
  if (event.type === "error") {
    appendBlocks(state, [{ type: "sdk_event", eventType: "error", raw: clone(event) }], event, ts);
    finalize(state, "error", null, ts);
    return;
  }
  if (event.type === "done") { finalize(state, "complete", null, ts); return; }
  if (event.type === "stopped") { finalize(state, "stopped", null, ts); }
}

export function project(convId) {
  const id = normalizeConvId(convId);
  if (!id || !existsSync(convDir(id))) return null;

  const meta = getMeta(id);
  const cached = projectionCache.get(id);
  if (cached && cached.lastSeq === meta?.lastSeq) {
    // Map 的迭代顺序就是淘汰顺序；命中后挪到末尾才是真正的 LRU。
    projectionCache.delete(id);
    projectionCache.set(id, cached);
    return clone(cached.conversation);
  }

  const state = createProjectionState(id);
  for (const entry of iterateEntries(id)) {
    const ts = entry.ts ?? Date.now();
    if (entry.kind === "user") {
      const payload = entry.payload ?? {};
      // 同一条 user 消息可能因重发被写两次，按 id 去重（与 beginRunHistory 一致）
      if (payload.id && state.messages.some(m => m.id === payload.id)) continue;
      state.messages.push({
        id: payload.id ?? `user_${crypto.randomUUID()}`,
        role: "user",
        text: payload.text ?? "",
        ...(Array.isArray(payload.images) && payload.images.length ? { images: clone(payload.images) } : {}),
        cost: null,
        createdAt: payload.createdAt ?? new Date(ts).toISOString(),
      });
      if (!state.title && payload.text) {
        state.title = String(payload.text).replace(/[\n\r]+/g, " ").trim().slice(0, 60);
      }
      state.date = new Date(ts).toISOString();
      continue;
    }
    if (entry.kind === "sdk") { applySdkEvent(state, entry.payload, ts); continue; }
    if (entry.kind === "turn") {
      const payload = entry.payload ?? {};
      const status = String(payload.status ?? "");
      if (status === "running") {
        state.currentTurnId = payload.turnId ?? null;
        if (state.current && payload.turnId) state.current.id = payload.turnId;
        continue;
      }
      if (TERMINAL_TURN_STATUSES.has(status)) {
        const target = state.current ?? state.last;
        if (target && payload.turnId) target.id = payload.turnId;
        finalize(state, status, payload.cost ?? null, ts);
        state.currentTurnId = null;
      }
    }
  }

  const conversation = {
    id,
    title: state.title || meta?.title || "新对话",
    date: state.date || meta?.date || new Date().toISOString(),
    sessionId: state.sessionId ?? meta?.sessionId ?? null,
    sessionProvider: state.sessionProvider ?? meta?.sessionProvider ?? null,
    profileId: meta?.profileId ?? null,
    messages: state.messages,
  };

  projectionCache.set(id, { lastSeq: meta?.lastSeq ?? 0, conversation });
  if (projectionCache.size > PROJECTION_CACHE_MAX) {
    projectionCache.delete(projectionCache.keys().next().value);
  }
  return clone(conversation);
}

// ── 会话集合操作 ───────────────────────────────────────────

export function listConversations() {
  const dir = root();
  if (!existsSync(dir)) return [];
  const out = [];
  for (const name of readdirSync(dir)) {
    if (!CONV_ID_RE.test(name)) continue;
    // 列表页只需要摘要。不能调用 getMeta() 把所有会话塞进常驻缓存；
    // 某个摘要损坏时才走一次完整恢复。
    let meta = null;
    try {
      const parsed = JSON.parse(readFileSync(metaPath(name), "utf8"));
      meta = { ...emptyMeta(name), ...parsed, id: name };
    } catch {
      meta = getMeta(name);
    }
    if (!meta) continue;
    out.push({
      id: meta.id,
      title: meta.title,
      date: meta.date,
      messageCount: meta.messageCount ?? 0,
    });
  }
  out.sort((a, b) => String(b.date).localeCompare(String(a.date)));
  return out;
}

export function deleteConversation(convId) {
  const id = normalizeConvId(convId);
  if (!id || !existsSync(convDir(id))) return false;
  rmSync(convDir(id), { recursive: true, force: true });
  metaCache.delete(id);
  projectionCache.delete(id);
  return true;
}

/**
 * 用一个完整 conversation 对象覆盖会话。
 * 供 PUT /api/history/:id 的兼容路径和迁移脚本使用——它们手上是"整段快照"
 * 而不是事件流，所以只能重建日志。
 */
export function replaceFromConversation(conversation) {
  const id = assertConvId(conversation?.id);
  const entries = [];
  for (const [index, message] of (conversation.messages ?? []).entries()) {
    if (!message) continue;
    if (message.role === "user") {
      entries.push({
        kind: "user",
        payload: {
          id: message.id ?? `user_migrated_${index}`,
          text: message.text ?? "",
          createdAt: message.createdAt ?? null,
          ...(Array.isArray(message.images) && message.images.length ? { images: message.images } : {}),
        },
      });
      continue;
    }
    if (message.role !== "assistant") continue;
    if (Array.isArray(message.events) && message.events.length > 0) {
      for (const event of message.events) entries.push({ kind: "sdk", payload: event });
    } else if (Array.isArray(message.blocks) && message.blocks.length > 0) {
      entries.push({
        kind: "sdk",
        payload: { type: "assistant", message: { content: message.blocks.map(blockToSdkContent) } },
      });
    } else if (message.text) {
      entries.push({
        kind: "sdk",
        payload: { type: "assistant", message: { content: [{ type: "text", text: message.text }] } },
      });
    }
    entries.push({
      kind: "turn",
      payload: {
        turnId: message.id ?? `turn_migrated_${index}`,
        status: message.status === "running" || TERMINAL_TURN_STATUSES.has(message.status)
          ? message.status
          : "complete",
        requestId: null,
        cost: message.cost ?? null,
      },
    });
  }

  // entries 构造成功之后再删除旧目录，避免畸形输入在转换阶段把原会话抹掉。
  rmSync(convDir(id), { recursive: true, force: true });
  metaCache.delete(id);
  projectionCache.delete(id);
  ensureConversation(id, { title: conversation.title });
  if (entries.length > 0) appendEvents(id, entries);

  return updateMeta(id, {
    title: conversation.title ?? undefined,
    date: conversation.date ?? undefined,
    sessionId: conversation.sessionId ?? null,
    sessionProvider: conversation.sessionProvider ?? null,
    profileId: conversation.profileId ?? null,
    messageCount: (conversation.messages ?? []).length,
  });
}

/** 供 server.js 在追加事件后同步 messageCount，列表页才不用做投影 */
export function refreshMessageCount(convId) {
  const id = normalizeConvId(convId);
  if (!id) return null;
  const conv = project(id);
  if (!conv) return null;
  return updateMeta(id, { messageCount: conv.messages.length, title: conv.title, date: conv.date });
}
