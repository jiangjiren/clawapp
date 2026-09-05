/**
 * Antigravity provider（agy）—— Gemini 会员通道的事件归一化。
 *
 * 官方没出 Node SDK（Python 版只认 API key、不认 CLI 登录），所以这条链路是
 * 起 agy 子进程读 stream-json。它吐的是 step_update 事件流，带 step_index /
 * step_type / state，跟 Claude、Codex 都不一样。
 *
 * 这里的翻译器是**有状态的**：文本要按 step_index 累积、工具 id 要配对、
 * 「工具跑完后新起一段回复」要先补一条 message_start。所以是 factory，
 * 每轮对话建一个。返回事件数组而不是直接 send，是为了能喂录制的流做单测。
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, delimiter } from "node:path";
import * as wire from "./wire.js";

export const PROVIDER_ID = "antigravity";

const TOOL_OUTPUT_LIMIT = 20000;

let _binaryCache;

export function findBinary() {
  if (_binaryCache && existsSync(_binaryCache)) return _binaryCache;
  const candidates = [];
  if (process.env.AGY_BIN) candidates.push(process.env.AGY_BIN);
  candidates.push(...(process.env.PATH || "").split(delimiter).filter(Boolean).map(dir => join(dir, process.platform === "win32" ? "agy.exe" : "agy")));
  if (process.platform === "win32") {
    const localAppData = process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local");
    candidates.push(join(localAppData, "agy", "bin", "agy.exe"));
  } else {
    candidates.push(join(homedir(), ".local", "bin", "agy"));
    candidates.push("/usr/local/bin/agy");
  }
  _binaryCache = candidates.find(p => { try { return existsSync(p); } catch { return false; } }) ?? null;
  return _binaryCache;
}

/** 测试用：清掉二进制路径缓存。 */
export function _resetBinaryCache() { _binaryCache = undefined; }

// 登录状态没有可读的凭证文件（agy 把 token 收在自己的 store 里），只能退一步：
// 装了二进制 + 建过配置目录，就认为登录过。真没登录时第一轮会由 CLI 自己报错。
export function isAuthAvailable() {
  if (!findBinary()) return false;
  return existsSync(join(homedir(), ".gemini", "antigravity-cli"));
}

export function modeFlag(permissionMode) {
  if (permissionMode === "plan") return "plan";
  return "accept-edits";
}

// agy 只认三档，界面上的 xhigh/max 都压到 high
const EFFORT = { low: "low", medium: "medium", high: "high", xhigh: "high", max: "high" };

/* ── 模型目录 ────────────────────────────────────────────────
   有哪些模型、每个认哪些档位，唯一的真相源是 `agy models`。它一行一个组合：

     gemini-3.8-flash-high<TAB>Gemini 3.8 Flash (High)
     gemini-3.1-pro-low<TAB>Gemini 3.1 Pro (Low)
     claude-sonnet-4-6<TAB>Claude Sonnet 4.6 (Thinking)

   末尾的 -low/-medium/-high 是「模型 × 档位」的组合，剥掉它就是模型名，剥出
   来的那几个后缀合起来就是这个模型支持的档位；压根没后缀的（claude-* 那两个）
   表示它不吃 --effort，传了会报 "effort is not supported"。档位给错 agy 直接
   拒绝启动，所以这张表必须准。

   这条命令要起进程走一遍登录，实测 7 秒，不能放在启动路径上。所以 server 侧
   先用磁盘缓存把界面顶起来，再在后台刷新（见 server.js 的 getAgyModelCatalog），
   刷回来的结果调 setCatalog 灌进这里。

   下面这张兜底表是 2026-09-03 那天 `agy models` 的原样输出，只有「装了 agy
   但一次都没查成功过」时才用得上。模型升级不需要来改它——3.9 出来的时候
   刷新自己就带回来了，这张表旧一点只影响首次启动那几秒。

   （旧注释说这条命令在管道里会挂住不退出、只能写死一张表——那是早期版本的
   毛病。现在管道和文件重定向都是 7 秒正常退出，已复测。） */
const FALLBACK_CATALOG = [
  { model: "gemini-3.8-flash", label: "Gemini 3.8 Flash", efforts: ["low", "medium", "high"] },
  { model: "gemini-3.7-flash", label: "Gemini 3.7 Flash", efforts: ["low", "medium", "high"] },
  { model: "gemini-3.6-flash", label: "Gemini 3.6 Flash", efforts: ["low", "medium", "high"] },
  { model: "gemini-3.1-pro", label: "Gemini 3.1 Pro", efforts: ["low", "high"] },
  { model: "claude-sonnet-4-6", label: "Claude Sonnet 4.6 (Thinking)", efforts: [] },
  { model: "claude-opus-4-6-thinking", label: "Claude Opus 4.6 (Thinking)", efforts: [] },
  { model: "gpt-oss-120b", label: "GPT-OSS 120B", efforts: ["medium"] },
];

const EFFORT_SUFFIX = /-(low|medium|high)$/;
const EFFORT_ORDER = ["low", "medium", "high"];

let _catalog = null;                  // setCatalog 灌进来的那份，null = 还没查过
const _effortOverrides = new Map();   // learnEffortsFromError 从报错里学到的修正

/** 现在生效的模型目录，[{ model, label, efforts }]。 */
export function getCatalog() {
  return _catalog ?? FALLBACK_CATALOG;
}

/** 目录是不是查回来的（false = 还在用兜底表）。 */
export function hasLiveCatalog() {
  return _catalog !== null;
}

/** 换一份目录。查回来的是权威的，之前从报错里学的那些修正一并作废。 */
export function setCatalog(models) {
  const normalized = normalizeCatalog(models);
  if (!normalized) return false;
  _catalog = normalized;
  _effortOverrides.clear();
  return true;
}

/** 测试用：退回兜底表。 */
export function _resetCatalog() {
  _catalog = null;
  _effortOverrides.clear();
}

function normalizeCatalog(models) {
  if (!Array.isArray(models)) return null;
  const out = [];
  for (const raw of models) {
    const model = String(raw?.model ?? "").trim();
    if (!model) continue;
    const efforts = (Array.isArray(raw?.efforts) ? raw.efforts : [])
      .map(level => String(level).trim().toLowerCase())
      .filter(level => EFFORT_ORDER.includes(level));
    out.push({
      model,
      label: String(raw?.label ?? "").trim() || model,
      efforts: [...new Set(efforts)].sort((a, b) => EFFORT_ORDER.indexOf(a) - EFFORT_ORDER.indexOf(b)),
    });
  }
  return out.length ? out : null;
}

/**
 * `agy models` 的 stdout → [{ model, label, efforts }]，顺序照它给的（新的在前）。
 * 一行都认不出来时返回 null——那多半是没登录或者输出格式变了，宁可继续用旧目录。
 */
export function parseModelsList(stdout) {
  const byModel = new Map();
  for (const line of String(stdout ?? "").split(/\r?\n/)) {
    const tab = line.indexOf("\t");
    if (tab <= 0) continue;   // "Fetching available models..." 这类日志行没有 TAB
    const slug = line.slice(0, tab).trim();
    if (!slug || /\s/.test(slug)) continue;
    const rawLabel = line.slice(tab + 1).trim();
    const suffix = EFFORT_SUFFIX.exec(slug);
    const model = suffix ? slug.slice(0, -suffix[0].length) : slug;
    // 带档位的那几行 label 只差结尾一个括号，合并成一个模型时去掉它
    const label = suffix ? rawLabel.replace(/\s*\([^()]*\)\s*$/, "").trim() : rawLabel;
    const entry = byModel.get(model) ?? { model, label: "", efforts: [] };
    if (suffix) entry.efforts.push(suffix[1]);
    if (!entry.label && label) entry.label = label;
    byModel.set(model, entry);
  }
  return normalizeCatalog([...byModel.values()]);
}

// agy 拒绝启动时会把真实档位写进错误里，例如
//   `--model gemini-3.1-pro requires --effort (available: low, high)`
//   `effort is not supported for model "claude-opus-4-6-thinking"`
// 目录哪天跟不上了（比如缓存还没刷新就赶上一次升级），就按它说的改，然后重试一次。
export function learnEffortsFromError(model, message) {
  if (!model || !message) return false;
  const before = supportedEfforts(model);
  if (/effort is not supported for model/i.test(message)) {
    if (before && before.length === 0) return false;
    _effortOverrides.set(model, []);
    return true;
  }
  const available = /available:\s*([a-z,\s]+)\)/i.exec(message);
  if (available) {
    const levels = [...new Set(available[1].split(",").map(part => part.trim()).filter(Boolean))]
      .filter(level => EFFORT_ORDER.includes(level))
      .sort((a, b) => EFFORT_ORDER.indexOf(a) - EFFORT_ORDER.indexOf(b));
    if (!levels.length) return false;
    if (before && before.length === levels.length && levels.every(level => before.includes(level))) return false;
    _effortOverrides.set(model, levels);
    return true;
  }
  return false;
}

/** 这个模型认哪些档位，null = 目录里没有它。 */
function supportedEfforts(model) {
  if (_effortOverrides.has(model)) return _effortOverrides.get(model);
  return getCatalog().find(entry => entry.model === model)?.efforts ?? null;
}

/**
 * 这个模型这一轮该传什么 --effort，返回 null 表示这一项整个别传。
 */
export function effortForModel(model, effort) {
  const wanted = EFFORT[effort] || "medium";
  if (!model) return wanted;
  // 档位已经写死在模型名里，再传 --effort 会冲突
  if (EFFORT_SUFFIX.test(model)) return null;
  const supported = supportedEfforts(model);
  if (!supported) return wanted;          // 没见过的模型，照传让 agy 自己判
  if (supported.length === 0) return null; // claude-* 这类不接受档位
  if (supported.includes(wanted)) return wanted;
  // 就近取。medium 缺失时优先往下走：high 更慢更费额度，不该由我们替用户升上去
  const order = wanted === "high"
    ? ["high", "medium", "low"]
    : wanted === "low"
    ? ["low", "medium", "high"]
    : ["low", "high", "medium"];
  return order.find(level => supported.includes(level)) ?? null;
}

/* ── 模型菜单 ────────────────────────────────────────────────
   目录里同一个系列会同时挂着好几代（3.8 / 3.7 / 3.6 flash），菜单只放最新那个：
   旧版本留在目录里是为了让还选着它的对话继续能跑，不是让人重新去选。

   系列 key 把版本数字抹掉算——gemini-3.8-flash 和 gemini-3.7-flash 都归到
   gemini-#-flash，所以 3.9 出来时自动顶掉 3.8，这里不用改。

   下面这张表只管排序和一句话说明，认的是「哪一类模型」而不是具体版本，
   所以模型升级同样不用动它；匹配不上的新家族排在最后，照样进菜单。 */
const MENU_RULES = [
  [/-pro$/, "旗舰最强"],
  [/-flash$/, "快速通用"],
  [/^claude-opus/, "Claude 旗舰"],
  [/^claude-sonnet/, "Claude 均衡"],
];

// 目录里有、但不摆进菜单的。这几个能跑，只是平时用不上，摆出来只会让菜单变长。
// 注意只藏菜单，不动目录：还选着它的对话照常跑，档位选择器也照常认它。
const MENU_HIDDEN = [/^gpt-/];

function seriesKey(model) {
  return model.replace(/\d+/g, "#");
}

function versionOf(model) {
  return (model.match(/\d+/g) ?? []).map(Number);
}

function isNewer(a, b) {
  const left = versionOf(a);
  const right = versionOf(b);
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0);
    if (diff) return diff > 0;
  }
  return false;
}

/** 菜单上要显示的模型：每个系列只留最新的一个，带好展示用的名字和说明。 */
export function menuModels() {
  const latest = new Map();
  for (const entry of getCatalog()) {
    if (MENU_HIDDEN.some(pattern => pattern.test(entry.model))) continue;
    const key = seriesKey(entry.model);
    const prev = latest.get(key);
    if (!prev || isNewer(entry.model, prev.model)) latest.set(key, entry);
  }
  return [...latest.values()]
    .map((entry) => {
      const rank = MENU_RULES.findIndex(([pattern]) => pattern.test(entry.model));
      // 菜单上的名字：去掉结尾的 (Thinking) 之类，Claude 前缀也去掉，跟另外两家的菜单一样短
      const name = entry.label.replace(/\s*\([^()]*\)\s*$/, "").replace(/^Claude\s+/, "").trim() || entry.model;
      return {
        model: entry.model,
        label: name,
        name,
        desc: rank < 0 ? entry.label : MENU_RULES[rank][1],
        efforts: entry.efforts,
        rank: rank < 0 ? MENU_RULES.length : rank,
      };
    })
    .sort((a, b) => a.rank - b.rank)   // 稳定排序，同一档保持 agy 给的先后
    .map(({ rank, ...item }) => item);
}

/**
 * 这个模型下线之后该顶上来的是谁——同系列里最新的那个，没有就 null。
 * 用在两处：用户之前选的模型从目录里消失了（gemini-3.5-flash 那样），以及
 * 对话历史里存着旧模型名。比一律退回默认更接近他当初的选择。
 */
export function successorFor(model) {
  if (!model) return null;
  const key = seriesKey(model);
  let best = null;
  for (const entry of getCatalog()) {
    if (entry.model === model) return null;          // 还在目录里，不用换
    if (seriesKey(entry.model) !== key) continue;
    if (!best || isNewer(entry.model, best)) best = entry.model;
  }
  // 只往上换。目录还没刷新就赶上一次升级时，请求里的版本会比目录里的都新，
  // 那种情况要原样放行让 agy 自己判，绝不能把用户选的新模型悄悄降回旧的。
  return best && isNewer(best, model) ? best : null;
}

// agy 的参数名是 PascalCase 的一套（AbsolutePath / TargetFile / …），
// 前端工具卡片取的是 file_path / command / query 这几个键，对不上就只能
// 把整个 JSON 摊在卡片上。这里补一份小写别名，原字段保留不动。
const PARAM_ALIAS = {
  AbsolutePath: "file_path",
  TargetFile: "file_path",
  DirectoryPath: "file_path",
  FilePath: "file_path",
  NotebookPath: "file_path",
  Command: "command",
  CommandLine: "command",
  Query: "query",
  SearchQuery: "query",
  SearchTerm: "query",
  Url: "url",
  URL: "url",
};

export function toolInput(info) {
  if (!info || typeof info !== "object") return {};
  const params = info.parameters;
  if (!params || typeof params !== "object") return {};
  const out = { ...params };
  for (const [from, to] of Object.entries(PARAM_ALIAS)) {
    if (out[to] === undefined && typeof params[from] === "string") out[to] = params[from];
  }
  return out;
}

export function toolOutput(info) {
  if (!info || typeof info !== "object") return "";
  const out = info.output;
  if (typeof out === "string") return out;
  if (out == null) return "";
  try { return JSON.stringify(out); } catch { return String(out); }
}

// agy 的工具名是自己一套（view_file / run_command / …），前端的工具卡片按名字
// 认图标和中文名，所以映射到已有的那套名字，让 Gemini 的步骤流和另外两家长一样。
const TOOL_ALIAS = {
  view_file: "Read",
  read_url_content: "WebFetch",
  search_web: "WebSearch",
  grep_search: "Grep",
  find_by_name: "Glob",
  list_dir: "Glob",
  run_command: "Bash",
  write_to_file: "Write",
  replace_file_content: "Edit",
  multi_replace_file_content: "Edit",
  sed_file: "Edit",
  notebook_edit: "NotebookEdit",
};

export function toolName(step) {
  const raw = step?.tool_name || step?.tool_info?.name || "tool";
  return TOOL_ALIAS[raw] || raw;
}

/**
 * 建一个流式翻译器。translate(agyEvent) 返回该发给前端的 wire 事件数组。
 */
export function createTranslator() {
  const texts = new Map();        // step_index → 累积的文本
  const openedText = new Set();   // 已经发过 content_block_start 的文本 step
  const toolIds = new Map();      // step_index → 前端用来配对的工具 id
  let streamed = false;           // 本轮是否已经开过流式块

  const openTextBlock = (idx, out) => {
    if (openedText.has(idx)) return;
    // 工具跑完后的新一段回复：先 message_start，前端据此清掉 spinner 并重置块表
    if (streamed) out.push(wire.streamMessageStart());
    out.push(wire.streamTextStart());
    openedText.add(idx);
    streamed = true;
  };

  return function translate(ev) {
    const out = [];
    if (!ev || typeof ev !== "object") return out;
    if (ev.event !== "step_update") return out;
    const step = ev.step_update;
    if (!step) return out;
    const idx = step.step_index ?? 0;

    if (step.step_type === "agent_response") {
      const delta = typeof step.text_delta === "string" ? step.text_delta : "";
      if (delta) {
        openTextBlock(idx, out);
        texts.set(idx, (texts.get(idx) || "") + delta);
        out.push(wire.streamTextDelta(delta));
      }
      if (step.state === "DONE") {
        const text = (texts.get(idx) || "").trim();
        if (openedText.has(idx)) out.push(wire.streamTextStop());
        // 定稿：前端拿这条重渲染，历史也只认这条
        if (text) out.push(wire.assistantMessage([wire.textBlock(text)]));
        texts.delete(idx);
        openedText.delete(idx);
      }
      return out;
    }

    if (step.step_type === "tool") {
      if (step.state === "DONE") {
        const id = toolIds.get(idx) || `agy_${idx}`;
        toolIds.delete(idx);
        const output = toolOutput(step.tool_info);
        const content = output.length > TOOL_OUTPUT_LIMIT
          ? `${output.slice(0, TOOL_OUTPUT_LIMIT)}\n…（输出已截断）`
          : output;
        out.push(wire.assistantMessage([
          wire.toolResultBlock({ toolUseId: id, content, raw: step }),
        ]));
        out.push(wire.toolSettled(id));
        return out;
      }
      if (toolIds.has(idx)) return out;   // ACTIVE 可能来多次
      const id = `agy_${idx}`;
      toolIds.set(idx, id);
      out.push(wire.serverToolUse({
        id,
        name: toolName(step),
        input: toolInput(step.tool_info),
        provider: PROVIDER_ID,
        raw: step,
      }));
      streamed = true;
      return out;
    }

    return out;
  };
}

/* ── 用量额度 ──────────────────────────────────────────────
   `agy -p "/usage" --output-format json` 是 CLI 的只读快捷路径：不起 agent
   轮次、不花额度、不留会话，直接回一份结构化配额。这是官方唯一给出来的
   非交互查法——直连 v1internal:retrieveUserQuota* 会 403，服务端要认
   Antigravity 客户端标识，我们伪造不出来。

   回来的形状（截取）：
     command.data.groups[] = { name, buckets[] }
     bucket = { id: "gemini-weekly", window: "weekly"|"5h",
                remaining_fraction: 0.87, reset_time: "2026-…Z" }

   两组配额是各自独立的池子：Gemini 那两个模型烧一组，Claude/GPT 那两个烧
   另一组。所以不能合并成一个数字，前端要分两行显示。 */

const USAGE_GROUP_LABEL = { gemini: "Gemini", "3p": "Claude/GPT" };

// bucket id 长这样：gemini-weekly / gemini-5h / 3p-weekly / 3p-5h
function usageGroupKey(buckets) {
  for (const bucket of buckets) {
    const id = String(bucket?.id ?? "");
    const dash = id.lastIndexOf("-");
    if (dash > 0) return id.slice(0, dash);
  }
  return null;
}

function usageWindow(bucket) {
  if (!bucket) return null;
  if (bucket.remaining_fraction == null || bucket.remaining_fraction === "") return null;
  const fraction = Number(bucket.remaining_fraction);
  if (!Number.isFinite(fraction)) return null;
  const remainingPercent = Math.max(0, Math.min(100, Math.round(fraction * 100)));
  return {
    usedPercent: 100 - remainingPercent,
    remainingPercent,
    resetAt: bucket.reset_time || null,
  };
}

/**
 * 把 `/usage` 的 stdout 解析成分组配额，读不出来返回 null。
 * agy 正常只吐一行 JSON，但它偶尔会在前面掺日志，所以逐行找最后一个能解析的对象。
 */
export function parseUsage(stdout) {
  let payload = null;
  for (const line of String(stdout ?? "").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed?.command?.data?.groups) payload = parsed;
    } catch { /* 半行日志，跳过 */ }
  }
  const rawGroups = payload?.command?.data?.groups;
  if (!Array.isArray(rawGroups)) return null;

  const groups = [];
  for (const group of rawGroups) {
    const buckets = Array.isArray(group?.buckets) ? group.buckets : [];
    const key = usageGroupKey(buckets);
    const fiveHour = usageWindow(buckets.find(b => b?.window === "5h"));
    const week = usageWindow(buckets.find(b => b?.window === "weekly"));
    if (!fiveHour && !week) continue;
    groups.push({
      key: key ?? String(group?.name ?? ""),
      label: USAGE_GROUP_LABEL[key] ?? String(group?.name ?? key ?? ""),
      fiveHour,
      week,
    });
  }
  return groups.length ? groups : null;
}
