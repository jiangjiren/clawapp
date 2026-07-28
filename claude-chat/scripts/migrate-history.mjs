#!/usr/bin/env node
/**
 * P1 历史数据迁移
 *
 * 把 data/history-<PORT>.json 里的全量 conversation 数组，反向拆成
 * data/conversations/<id>/events.ndjson + meta.json 的 append-only 事件日志。
 *
 * 契约：_design/p1-event-log.md 第 1 节（存储布局）/ 第 2 节（event-log 接口）/ 第 6 节（迁移脚本）
 *
 * 用法：
 *   node scripts/migrate-history.mjs --port 8082
 *   node scripts/migrate-history.mjs --port 8082 --dry-run
 *   node scripts/migrate-history.mjs --port 8082 --verify
 *   node scripts/migrate-history.mjs --file /path/to/history.json --force
 *
 * 结构上分两层：
 *   A. 纯函数层 conversationToEvents() —— 不依赖 core/event-log.js，可单独测试
 *   B. CLI 层 main() —— 动态 import core/event-log.js 落盘
 * event-log.js 用动态 import，是为了让本模块在 event-log 尚未就绪时仍可被
 * 测试文件 import（纯函数层不需要它）。
 */

import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
// 只取还原规则这一个纯函数：import event-log 本身没有副作用（configure 要显式调），
// 纯函数层的测试照样能独立跑。落盘用的 API 仍然走 main() 里的动态 import。
import { blockToSdkContent } from "../core/event-log.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLAUDE_CHAT_DIR = resolve(__dirname, "..");
const DEFAULT_DATA_DIR = resolve(CLAUDE_CHAT_DIR, "data");
const EVENT_LOG_MODULE = "../core/event-log.js";

/** 与 server.js normalizeHistoryId / 契约第 1 节一致，可直接作目录名 */
export const CONVERSATION_ID_RE = /^[A-Za-z0-9_-]{4,128}$/;

/** 契约第 1 节允许的 turn.status */
const TURN_STATUSES = new Set(["running", "complete", "error", "stopped", "continued"]);

// ────────────────────────────────────────────────────────────
// A. 纯函数层（无副作用、不依赖 event-log）
// ────────────────────────────────────────────────────────────

export function isValidConversationId(value) {
  return typeof value === "string" && CONVERSATION_ID_RE.test(value.trim());
}

/**
 * 逐个吐出顶层 JSON 数组里的元素文本，避免一次性 JSON.parse 30MB 建出巨大对象图。
 * 调用方对每段单独 JSON.parse，用完即弃，峰值内存 ≈ 文件字符串 + 单个会话。
 */
export function* iterateConversationChunks(text) {
  if (typeof text !== "string") return;
  let i = 0;
  while (i < text.length && text[i] !== "[") {
    if (!/\s/.test(text[i])) return; // 不是数组，直接放弃
    i++;
  }
  if (i >= text.length) return;
  i++;
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  for (; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === "\"") inString = false;
      continue;
    }
    if (ch === "\"") { inString = true; continue; }
    if (ch === "{" || ch === "[") {
      if (depth === 0) start = i;
      depth++;
      continue;
    }
    if (ch === "}" || ch === "]") {
      depth--;
      if (depth === 0 && start >= 0) {
        yield text.slice(start, i + 1);
        start = -1;
      } else if (depth < 0) {
        return; // 顶层数组结束
      }
    }
  }
}

function normalizeTurnStatus(value) {
  const status = typeof value === "string" ? value.trim() : "";
  return TURN_STATUSES.has(status) ? status : "complete";
}

/**
 * blocks[] → SDK assistant content[]。
 *
 * 复用 event-log 的 blockToSdkContent：还原规则只能有一份，两边各写一套迟早会漂移。
 * 关键点是优先取 block 顶层的归一化字段而不是 block.raw——老数据里存在
 * raw.text 带 U+FFFD 替换字符、而 block.text 干净的情况，用 raw 会把好数据迁坏。
 */
function blocksToContent(blocks) {
  return blocks.map(blockToSdkContent);
}

/**
 * 一条 assistant 消息 → 它应该产生的 kind:"sdk" payload 列表。
 * 优先级：原始 events[] > blocks[] 合成 > text 合成 > 空
 */
function assistantSdkPayloads(message) {
  const events = Array.isArray(message.events)
    ? message.events.filter(event => event && typeof event === "object")
    : [];
  if (events.length) return events;

  const blocks = Array.isArray(message.blocks) ? message.blocks.filter(Boolean) : [];
  if (blocks.length) {
    return [{ type: "assistant", message: { content: blocksToContent(blocks) } }];
  }

  const text = typeof message.text === "string" ? message.text : "";
  if (text) {
    return [{ type: "assistant", message: { content: [{ type: "text", text }] } }];
  }
  return [];
}

function firstUserText(messages) {
  for (const message of messages) {
    if (message?.role === "user" && typeof message.text === "string" && message.text.trim()) {
      return message.text;
    }
  }
  return "";
}

function latestTimestamp(messages) {
  let latest = null;
  for (const message of messages) {
    for (const value of [message?.updatedAt, message?.createdAt]) {
      if (typeof value === "string" && value && (!latest || value > latest)) latest = value;
    }
  }
  return latest;
}

function conversationMeta(source, messages) {
  const rawTitle = typeof source.title === "string" ? source.title.trim() : "";
  const title = rawTitle
    || String(firstUserText(messages)).replace(/[\n\r]+/g, " ").trim().slice(0, 60)
    || "新对话";
  return {
    id: typeof source.id === "string" ? source.id.trim() : "",
    title,
    date: (typeof source.date === "string" && source.date) ? source.date : latestTimestamp(messages),
    sessionId: source.sessionId ?? null,
    sessionProvider: source.sessionProvider ?? null,
    profileId: source.profileId ?? null,
  };
}

/**
 * 纯函数：把一个 history.json 里的 conversation 反向拆成事件序列。
 *
 * @returns {{ entries: Array<{kind: string, payload: object}>, meta: object }}
 *   entries 不含 seq/ts —— 那是 event-log.appendEvents 的职责。
 *   严格保持原 messages[] 顺序。
 */
export function conversationToEvents(conversation) {
  const source = conversation && typeof conversation === "object" ? conversation : {};
  const messages = Array.isArray(source.messages)
    ? source.messages.filter(message => message && typeof message === "object")
    : [];
  const entries = [];

  messages.forEach((message, index) => {
    if (message.role === "user") {
      const payload = {
        id: typeof message.id === "string" && message.id ? message.id : `user_migrated_${index}`,
        text: typeof message.text === "string" ? message.text : "",
        createdAt: message.createdAt ?? null,
      };
      if (Array.isArray(message.images) && message.images.length) payload.images = message.images;
      entries.push({ kind: "user", payload });
      return;
    }
    if (message.role !== "assistant") return; // 未知 role：不认识就不造事件

    for (const payload of assistantSdkPayloads(message)) {
      entries.push({ kind: "sdk", payload });
    }
    entries.push({
      kind: "turn",
      payload: {
        turnId: typeof message.id === "string" && message.id ? message.id : `turn_migrated_${index}`,
        status: normalizeTurnStatus(message.status),
        requestId: null,
        cost: message.cost ?? null,
      },
    });
  });

  return { entries, meta: conversationMeta(source, messages) };
}

// ────────────────────────────────────────────────────────────
// 校验（--verify / --dry-run 共用的比对口径）
// ────────────────────────────────────────────────────────────

function normText(value) {
  return typeof value === "string" ? value : "";
}

function normCost(value) {
  return value == null ? null : value;
}

function blockCount(value) {
  return Array.isArray(value) ? value.length : 0;
}

/**
 * 按 server.js 实时路径的规则，从 blocks 重算 message.text。
 * （见 core/event-log.js appendBlocks：text/refusal 且有 text 的块，用 \n\n 拼接）
 */
function textFromBlocks(message) {
  const blocks = Array.isArray(message?.blocks) ? message.blocks : [];
  return blocks
    .filter(block => (block?.type === "text" || block?.type === "refusal") && block.text)
    .map(block => block.text)
    .join("\n\n");
}

/**
 * 投影的正文是否忠实于源数据的 blocks。
 *
 * 实测 history-8082.json 里有 7/345 条带 blocks 的 assistant 消息，其 message.text
 * 与自己的 blocks 拼接结果就对不上（差 1~18 字符）——那是网页端整段 PUT 留下的：
 * 客户端的 assistantTxt 和 assistantBlocks 是两个独立累加器，会轻微漂移。
 *
 * 而 UI 只要 blocks 非空就按 blocks 渲染（loadConversation → renderAssistantBlocks），
 * 所以 blocks 才是用户一直看到的那份，message.text 只是个陈旧的边车字段。
 * 投影按 blocks 重算 == 忠实还原用户所见，这种情况记 note 而不是 diff。
 */
function projectionFaithfulToBlocks(original, projected) {
  const blocks = Array.isArray(original?.blocks) ? original.blocks : [];
  if (original?.role !== "assistant" || blocks.length === 0) return false;
  return normText(projected?.text) === textFromBlocks(original);
}

/**
 * 逐条比对 project() 的投影结果与原 conversation：role / text / blocks.length / cost / status。
 *
 * status 两边都按 normalizeTurnStatus 归一（原始数据里早期消息没有 status 字段）。
 *
 * 返回 { diffs, notes }：
 *   diffs —— 真差异，任何一条都应让 --verify 失败
 *   notes —— 已知的、由迁移规则本身导致的良性变化。目前只有一种：老客户端整段 PUT
 *            存下来的 assistant 消息只有 text、blocks 是 null/空，按契约要用 text 合成
 *            一条 sdk 事件兜底，投影回来就多出一个内容完全相同的 text block。
 */
export function diffConversation(original, projected) {
  const diffs = [];
  const notes = [];
  const before = Array.isArray(original?.messages) ? original.messages : [];
  const after = Array.isArray(projected?.messages) ? projected.messages : [];

  if (before.length !== after.length) {
    diffs.push(`messages.length ${before.length} → ${after.length}`);
  }
  const len = Math.min(before.length, after.length);
  for (let i = 0; i < len; i++) {
    const a = before[i] || {};
    const b = after[i] || {};
    if (a.role !== b.role) diffs.push(`#${i} role ${JSON.stringify(a.role)} → ${JSON.stringify(b.role)}`);
    const textEqual = normText(a.text) === normText(b.text);
    if (!textEqual) {
      const line = `#${i} text len ${normText(a.text).length} → ${normText(b.text).length}`;
      if (projectionFaithfulToBlocks(a, b)) {
        notes.push(`${line}（源 text 与自身 blocks 本就对不上，投影按 blocks 重算——UI 渲染的就是 blocks）`);
      } else {
        diffs.push(line);
      }
    }
    if (blockCount(a.blocks) !== blockCount(b.blocks)) {
      const isTextFallback = a.role === "assistant" && textEqual && normText(a.text) !== ""
        && blockCount(a.blocks) === 0 && blockCount(b.blocks) === 1;
      const line = `#${i} blocks.length ${blockCount(a.blocks)} → ${blockCount(b.blocks)}`;
      if (isTextFallback) notes.push(`${line}（text 兜底合成，正文一致）`);
      else diffs.push(line);
    }
    if (normCost(a.cost) !== normCost(b.cost)) {
      diffs.push(`#${i} cost ${JSON.stringify(normCost(a.cost))} → ${JSON.stringify(normCost(b.cost))}`);
    }
    if (a.role === "assistant" && normalizeTurnStatus(a.status) !== normalizeTurnStatus(b.status)) {
      diffs.push(`#${i} status ${JSON.stringify(a.status)} → ${JSON.stringify(b.status)}`);
    }
  }
  return { diffs, notes };
}

/** dry-run 用的结构自检：不需要 event-log，也不需要写盘 */
export function selfCheckEntries(conversation, entries) {
  const problems = [];
  const messages = Array.isArray(conversation?.messages)
    ? conversation.messages.filter(m => m && typeof m === "object")
    : [];
  const users = messages.filter(m => m.role === "user").length;
  const assistants = messages.filter(m => m.role === "assistant").length;
  const others = messages.length - users - assistants;
  const userEvents = entries.filter(e => e.kind === "user").length;
  const turnEvents = entries.filter(e => e.kind === "turn").length;
  const sdkEvents = entries.filter(e => e.kind === "sdk").length;

  if (userEvents !== users) problems.push(`user 事件 ${userEvents} ≠ user 消息 ${users}`);
  if (turnEvents !== assistants) problems.push(`turn 事件 ${turnEvents} ≠ assistant 消息 ${assistants}`);
  if (assistants > 0 && sdkEvents === 0) problems.push(`${assistants} 条 assistant 消息未产生任何 sdk 事件`);
  if (others > 0) problems.push(`${others} 条消息 role 非 user/assistant，已跳过`);
  return problems;
}

// ────────────────────────────────────────────────────────────
// B. CLI 层
// ────────────────────────────────────────────────────────────

const USAGE = `用法：node scripts/migrate-history.mjs --port <PORT> [选项]

  --port <n>     读 data/history-<n>.json（与 --file 二选一）
  --file <path>  直接指定源文件
  --dry-run      只做转换和结构自检，不写任何文件
  --verify       写盘后跑 project() 与原始数据逐条比对，有差异退出码 1
  --force        目标会话已有事件时也强制重迁（先删除再写）
  -h, --help     显示本帮助
`;

export function parseArgs(argv) {
  const opts = { port: null, file: null, dryRun: false, verify: false, force: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--port") opts.port = argv[++i] ?? null;
    else if (arg.startsWith("--port=")) opts.port = arg.slice(7);
    else if (arg === "--file") opts.file = argv[++i] ?? null;
    else if (arg.startsWith("--file=")) opts.file = arg.slice(7);
    else if (arg === "--dry-run") opts.dryRun = true;
    else if (arg === "--verify") opts.verify = true;
    else if (arg === "--force") opts.force = true;
    else if (arg === "-h" || arg === "--help") opts.help = true;
    else throw new Error(`未知参数：${arg}`);
  }
  return opts;
}

async function loadEventLog(dataDir, port) {
  let mod;
  try {
    mod = await import(EVENT_LOG_MODULE);
  } catch (err) {
    const hint = `无法加载 ${EVENT_LOG_MODULE}（${err?.message || err}）。\n`
      + "  它由 P1 主线并行实现；未就绪时可先用 --dry-run 验证转换结果。";
    throw new Error(hint);
  }
  for (const name of ["ensureConversation", "appendEvents", "updateMeta", "getMeta"]) {
    if (typeof mod[name] !== "function") throw new Error(`core/event-log.js 缺少导出 ${name}()`);
  }
  if (typeof mod.configure === "function") {
    // configure 的具体签名以 event-log.js 实现为准；这里传最可能的两个键，失败不致命。
    try { mod.configure({ dataDir, port }); } catch { /* 用默认配置继续 */ }
  }
  return mod;
}

function formatBytes(n) {
  return `${(n / 1048576).toFixed(1)}MB`;
}

async function main(argv) {
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (err) {
    process.stderr.write(`${err.message}\n\n${USAGE}`);
    return 2;
  }
  if (opts.help) {
    process.stdout.write(USAGE);
    return 0;
  }

  const port = opts.port ? String(opts.port).trim() : "";
  if (!opts.file && !/^\d{2,6}$/.test(port)) {
    process.stderr.write(`缺少 --port（或 --file）\n\n${USAGE}`);
    return 2;
  }
  const sourceFile = opts.file ? resolve(process.cwd(), opts.file) : resolve(DEFAULT_DATA_DIR, `history-${port}.json`);
  if (!existsSync(sourceFile)) {
    process.stderr.write(`源文件不存在：${sourceFile}\n`);
    return 2;
  }
  const dataDir = dirname(sourceFile);
  const backupFile = `${sourceFile}.pre-p1.bak`;

  const started = Date.now();
  const size = statSync(sourceFile).size;
  process.stdout.write(`源文件 ${sourceFile} (${formatBytes(size)})${opts.dryRun ? "  [dry-run]" : ""}\n`);

  const verificationDir = opts.dryRun && opts.verify
    ? mkdtempSync(resolve(tmpdir(), "claude-chat-migrate-verify-"))
    : null;
  const eventLog = opts.dryRun && !opts.verify
    ? null
    : await loadEventLog(verificationDir ?? dataDir, port);
  if (opts.verify && eventLog && typeof eventLog.project !== "function") {
    throw new Error("core/event-log.js 缺少导出 project()，无法 --verify");
  }

  const text = readFileSync(sourceFile, "utf8");
  const stats = {
    conversations: 0, migrated: 0, skipped: 0, invalid: 0,
    messages: 0, events: 0, userEvents: 0, sdkEvents: 0, turnEvents: 0,
    warnings: 0, diffs: 0, notes: 0,
  };

  const reportVerification = (convId, conversation) => {
    const projected = eventLog.project(convId);
    const { diffs, notes } = projected
      ? diffConversation(conversation, projected)
      : { diffs: ["project() 返回 null"], notes: [] };
    stats.notes += notes.length;
    if (notes.length) {
      process.stdout.write(`[note] ${convId} ${notes.length} 处良性变化：${notes[0]}\n`);
    }
    if (diffs.length) {
      stats.diffs += diffs.length;
      process.stdout.write(`[diff] ${convId}\n`);
      for (const d of diffs.slice(0, 20)) process.stdout.write(`       ${d}\n`);
      if (diffs.length > 20) process.stdout.write(`       …还有 ${diffs.length - 20} 条差异\n`);
    }
  };

  for (const chunk of iterateConversationChunks(text)) {
    let conversation;
    try {
      conversation = JSON.parse(chunk);
    } catch (err) {
      stats.invalid++;
      process.stdout.write(`[bad] 无法解析的 conversation 片段：${err.message}\n`);
      continue;
    }
    stats.conversations++;

    const { entries, meta } = conversationToEvents(conversation);
    const messageCount = Array.isArray(conversation.messages) ? conversation.messages.length : 0;
    stats.messages += messageCount;

    if (!isValidConversationId(meta.id)) {
      stats.invalid++;
      process.stdout.write(`[skip] 非法会话 id ${JSON.stringify(meta.id)}（不匹配 ${CONVERSATION_ID_RE}），跳过\n`);
      continue;
    }
    const convId = meta.id;

    const problems = selfCheckEntries(conversation, entries);
    for (const problem of problems) {
      stats.warnings++;
      process.stdout.write(`[warn] ${convId} ${problem}\n`);
    }

    stats.events += entries.length;
    stats.userEvents += entries.filter(e => e.kind === "user").length;
    stats.sdkEvents += entries.filter(e => e.kind === "sdk").length;
    stats.turnEvents += entries.filter(e => e.kind === "turn").length;

    if (opts.dryRun) {
      stats.migrated++;
      process.stdout.write(`[dry] ${convId} ${messageCount} → ${entries.length}\n`);
      if (opts.verify) {
        eventLog.ensureConversation(convId, { title: meta.title });
        if (entries.length) eventLog.appendEvents(convId, entries);
        eventLog.updateMeta(convId, { ...meta, messageCount });
        reportVerification(convId, conversation);
        eventLog.deleteConversation(convId);
      }
      continue;
    }

    // 幂等：目标已有事件就跳过，除非 --force
    const existing = eventLog.getMeta(convId);
    if (existing && Number(existing.lastSeq) > 0) {
      if (!opts.force) {
        stats.skipped++;
        process.stdout.write(`[skip] ${convId} 已迁移（lastSeq=${existing.lastSeq}）\n`);
        if (opts.verify) reportVerification(convId, conversation);
        continue;
      }
      if (typeof eventLog.deleteConversation === "function") eventLog.deleteConversation(convId);
      else {
        stats.skipped++;
        process.stdout.write(`[skip] ${convId} 已迁移且 event-log 未提供 deleteConversation()，--force 无法安全重写\n`);
        continue;
      }
    }

    eventLog.ensureConversation(convId, { title: meta.title });
    if (entries.length) eventLog.appendEvents(convId, entries);
    eventLog.updateMeta(convId, { ...meta, messageCount });
    stats.migrated++;
    process.stdout.write(`[ok] ${convId} ${messageCount} → ${entries.length}\n`);

    if (opts.verify) {
      reportVerification(convId, conversation);
    }
  }

  // 原文件不删不改：成功后复制（不是重命名）一份留档
  if (!opts.dryRun && stats.migrated > 0) {
    if (existsSync(backupFile)) {
      process.stdout.write(`[bak] 已存在，保留不覆盖：${backupFile}\n`);
    } else {
      copyFileSync(sourceFile, backupFile);
      process.stdout.write(`[bak] ${backupFile}\n`);
    }
  }

  if (verificationDir) rmSync(verificationDir, { recursive: true, force: true });

  const elapsed = Date.now() - started;
  const peakRss = Math.round(process.memoryUsage().rss / 1048576);
  process.stdout.write(
    `\n会话 ${stats.conversations}（迁移 ${stats.migrated} / 跳过 ${stats.skipped} / 非法 ${stats.invalid}）`
    + `  消息 ${stats.messages}  事件 ${stats.events}`
    + `（user ${stats.userEvents} / sdk ${stats.sdkEvents} / turn ${stats.turnEvents}）\n`
    + `告警 ${stats.warnings}  良性变化 ${stats.notes}  差异 ${stats.diffs}  耗时 ${elapsed}ms  RSS ${peakRss}MB\n`
  );
  if (stats.diffs > 0) {
    process.stderr.write("--verify 发现差异，退出码 1\n");
    return 1;
  }
  return 0;
}

const invokedDirectly = process.argv[1]
  && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));

if (invokedDirectly) {
  main(process.argv.slice(2))
    .then(code => { process.exitCode = code; })
    .catch(err => {
      process.stderr.write(`${err?.stack || err}\n`);
      process.exitCode = 1;
    });
}

export { main };
