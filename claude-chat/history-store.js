/**
 * ══════════════════════════════════════════════════════════════════════
 * 会话历史存储 —— 每会话一个 append-only 日志
 * ══════════════════════════════════════════════════════════════════════
 *
 * 原先所有会话挤在一个 history.json 里，落盘走 `writeHistory(readHistory())`
 * 全量重写。实测数据：18 个会话共 1MB，其中最大的单个会话 466KB——在那个会话里
 * 发一条消息，要重写整整 1MB。而且「读-改-写」在多会话并发时会互相覆盖，
 * 后写的赢，先写的那条消息就没了。
 *
 * 改成每会话一个 <id>.jsonl：
 *
 *   {"t":"meta","id":...,"title":...,"date":...,"sessionId":...}
 *   {"t":"msg","m":{...}}
 *   {"t":"msg","m":{...}}          ← 同 id 的消息后写的覆盖先写的
 *
 * 写入优先走 append 快路径：只把「这次真的变了」的消息追加到文件尾。流式回答
 * 时同一条 assistant 消息会被反复改写，所以允许同 id 多次出现，读的时候后者
 * 生效。冗余行堆到阈值就 compact（整份重写一次）。
 *
 * append 还顺带买到了崩溃安全：进程挂在写一半时，最多损坏最后一行，前面的内容
 * 完好；读取时跳过解析不了的行即可。全量重写做不到这一点。
 */

import {
  appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync,
  renameSync, unlinkSync, writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";

/** 冗余行超过有效行数的这个倍数就 compact。 */
const COMPACT_RATIO = 3;
/** 行数少于这个值时不值得 compact，省下的写盘还不够一次重写。 */
const COMPACT_MIN_LINES = 24;

function hashOf(value) {
  return createHash("sha1").update(value).digest("hex").slice(0, 16);
}

/**
 * 会话 id 转文件名。id 理论上已经过 normalizeHistoryId，但历史数据里混过
 * wechat_<uin> 这类外部来源，真出现路径分隔符会写到目录外去，所以这里再兜一道。
 */
export function fileNameFor(id) {
  const safe = String(id).replace(/[^A-Za-z0-9_-]/g, "_");
  // sanitize 改变了内容就补一段 id 哈希，避免两个不同 id 撞进同一个文件
  return safe === String(id) ? `${safe}.jsonl` : `${safe}-${hashOf(String(id))}.jsonl`;
}

/** 消息在日志里的身份。没有 id 的老数据退回按序号认，消息只增不删所以序号稳定。 */
function messageKey(message, index) {
  const id = message?.id;
  return id != null && String(id).trim() ? `id:${id}` : `idx:${index}`;
}

function parseLines(text) {
  const meta = {};
  const order = [];               // messageKey 的首次出现顺序
  const byKey = new Map();
  let lines = 0;
  let broken = 0;

  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    lines += 1;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      broken += 1;               // 崩溃截断的半行：跳过，前面的内容仍然有效
      continue;
    }
    if (entry?.t === "meta") {
      Object.assign(meta, entry);
      continue;
    }
    if (entry?.t === "msg" && entry.m && typeof entry.m === "object") {
      const key = entry.k ?? messageKey(entry.m, order.length);
      if (!byKey.has(key)) order.push(key);
      byKey.set(key, entry.m);    // 后写的覆盖先写的
    }
  }

  return { meta, order, byKey, lines, broken };
}

function conversationFrom(meta, order, byKey) {
  const { t, ...rest } = meta;
  return { ...rest, messages: order.map(key => byKey.get(key)) };
}

export function createHistoryStore({ dir }) {
  mkdirSync(dir, { recursive: true });

  // 每个会话上次落盘后的样子：用来算出这次哪几条真的变了。
  // key → 该条消息序列化后的哈希；meta 单独存一个哈希。
  const snapshots = new Map();   // conversationId → { file, metaHash, hashes: Map, lines: number }

  function pathFor(id) {
    return join(dir, fileNameFor(id));
  }

  function metaLineOf(conv) {
    const { messages, ...rest } = conv;
    return JSON.stringify({ t: "meta", ...rest });
  }

  /** 整份重写。用在首次落盘、compact，以及快路径判断不划算的时候。 */
  function rewrite(conv) {
    const id = conv.id;
    const messages = Array.isArray(conv.messages) ? conv.messages : [];
    const metaLine = metaLineOf(conv);
    const hashes = new Map();
    const parts = [metaLine];

    messages.forEach((message, index) => {
      const key = messageKey(message, index);
      const payload = JSON.stringify(message);
      hashes.set(key, hashOf(payload));
      parts.push(`{"t":"msg","k":${JSON.stringify(key)},"m":${payload}}`);
    });

    const file = pathFor(id);
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, `${parts.join("\n")}\n`, "utf8");
    renameSync(tmp, file);        // 重写走 tmp+rename，中途挂掉不会留下半份文件
    snapshots.set(id, { file, metaHash: hashOf(metaLine), hashes, lines: parts.length });
  }

  /**
   * 落盘一个会话。没变就什么都不做，变了优先 append 增量。
   * 返回实际发生的动作，测试和调用方据此判断是否真写了盘。
   */
  function save(conv) {
    if (!conv?.id) return "skipped";
    const id = conv.id;
    const snapshot = snapshots.get(id);
    if (!snapshot || !existsSync(snapshot.file)) {
      rewrite(conv);
      return "rewrite";
    }

    const messages = Array.isArray(conv.messages) ? conv.messages : [];
    const metaLine = metaLineOf(conv);
    const metaHash = hashOf(metaLine);
    const appended = [];
    const nextHashes = new Map();

    if (metaHash !== snapshot.metaHash) appended.push(metaLine);

    messages.forEach((message, index) => {
      const key = messageKey(message, index);
      const payload = JSON.stringify(message);
      const hash = hashOf(payload);
      nextHashes.set(key, hash);
      if (snapshot.hashes.get(key) !== hash) {
        appended.push(`{"t":"msg","k":${JSON.stringify(key)},"m":${payload}}`);
      }
    });

    // 消息被删掉过（历史清理之类）——append 表达不了删除，只能整份重写
    if (nextHashes.size < snapshot.hashes.size) {
      rewrite(conv);
      return "rewrite";
    }
    if (appended.length === 0) return "unchanged";

    const nextLines = snapshot.lines + appended.length;
    // 冗余堆太多了，与其继续追加不如趁现在重写一次
    if (nextLines >= COMPACT_MIN_LINES && nextLines > (nextHashes.size + 1) * COMPACT_RATIO) {
      rewrite(conv);
      return "compact";
    }

    appendFileSync(snapshot.file, `${appended.join("\n")}\n`, "utf8");
    snapshot.metaHash = metaHash;
    snapshot.hashes = nextHashes;
    snapshot.lines = nextLines;
    return "append";
  }

  /** 落盘一批会话，返回真正写了盘的会话数。 */
  function saveAll(conversations) {
    let written = 0;
    for (const conv of conversations ?? []) {
      const action = save(conv);
      if (action !== "unchanged" && action !== "skipped") written += 1;
    }
    return written;
  }

  /* 刻意不提供「这批就是全部，其余删掉」的接口。调用方内存里那份历史被
     条数上限截断过，不是磁盘该有的全集——按它做差集删除，用户只是多开了
     几个新对话，最老的分片就被 unlink 了。删除必须是显式的单条 remove。 */

  function remove(id) {
    const snapshot = snapshots.get(id);
    const file = snapshot?.file ?? pathFor(id);
    snapshots.delete(id);
    try { unlinkSync(file); return true; } catch { return false; }
  }

  /** 扫目录读回全部会话，按时间倒序——跟旧的 history.json 顺序一致。 */
  function load() {
    const out = [];
    let files;
    try { files = readdirSync(dir); } catch { return out; }

    for (const name of files) {
      if (!name.endsWith(".jsonl")) continue;
      const file = join(dir, name);
      let text;
      try { text = readFileSync(file, "utf8"); } catch { continue; }
      const { meta, order, byKey, lines } = parseLines(text);
      if (!meta.id) continue;              // meta 都没有的文件不认，宁可漏读不要造假数据
      const conv = conversationFrom(meta, order, byKey);
      out.push(conv);
      snapshots.set(conv.id, {
        file,
        metaHash: hashOf(metaLineOf(conv)),
        hashes: new Map(order.map(key => [key, hashOf(JSON.stringify(byKey.get(key)))])),
        lines,
      });
      // 读到的行数明显多于有效条数，说明上次退出前攒了一堆冗余，顺手压一次
      if (lines >= COMPACT_MIN_LINES && lines > (order.length + 1) * COMPACT_RATIO) rewrite(conv);
    }

    return out.sort((a, b) => (Date.parse(b?.date ?? "") || 0) - (Date.parse(a?.date ?? "") || 0));
  }

  /**
   * 把旧的单文件 history.json 拆成分片。只在分片目录还空着的时候做一次，
   * 迁移完把旧文件改名留底，不删——真出问题时还能手工捞回来。
   */
  function migrateFrom(legacyFile) {
    if (!legacyFile || !existsSync(legacyFile)) return 0;
    let parsed;
    try { parsed = JSON.parse(readFileSync(legacyFile, "utf8")); } catch { return 0; }
    if (!Array.isArray(parsed) || parsed.length === 0) return 0;

    let migrated = 0;
    for (const conv of parsed) {
      if (!conv?.id) continue;
      rewrite(conv);
      migrated += 1;
    }
    try { renameSync(legacyFile, `${legacyFile}.migrated`); } catch { }
    return migrated;
  }

  /**
   * 把 legacy 单文件里分片还没有的会话补进来，已有的一律不碰——磁盘上那份
   * 通常比 legacy 更新。
   *
   * 需要它是因为 legacy 文件不是一次性的：server 每次启动都会把 data/ 下的
   * history-<PORT>.json 残留重新合并成一份 history.json。migrateFrom 只在
   * 分片目录空着时跑一次，之后那些合并结果就再没人读了——真出现分片没见过的
   * 会话就会被静默丢掉。这个函数每次启动跑一遍，靠"只补缺失"保证幂等。
   */
  function mergeFrom(legacyFile) {
    if (!legacyFile || !existsSync(legacyFile)) return 0;
    let parsed;
    try { parsed = JSON.parse(readFileSync(legacyFile, "utf8")); } catch { return 0; }
    if (!Array.isArray(parsed)) return 0;

    let added = 0;
    for (const conv of parsed) {
      if (!conv?.id) continue;
      if (snapshots.has(conv.id) || existsSync(pathFor(conv.id))) continue;
      rewrite(conv);
      added += 1;
    }
    return added;
  }

  function isEmpty() {
    try { return readdirSync(dir).filter(name => name.endsWith(".jsonl")).length === 0; }
    catch { return true; }
  }

  return { load, save, saveAll, remove, migrateFrom, mergeFrom, isEmpty, pathFor };
}
