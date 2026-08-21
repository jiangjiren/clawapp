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
import { join } from "node:path";
import * as wire from "./wire.js";

export const PROVIDER_ID = "antigravity";

const TOOL_OUTPUT_LIMIT = 20000;

let _binaryCache;

export function findBinary() {
  if (_binaryCache !== undefined) return _binaryCache;
  const candidates = [];
  if (process.env.AGY_BIN) candidates.push(process.env.AGY_BIN);
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

// 每个模型支持的档位并不一样，给错了 agy 直接拒绝启动：
//   gemini-3.1-pro   —— 只有 low / high，没有 medium
//   gemini-*-flash   —— 三档齐全，而且不带档位后缀时**必须**传 --effort
//   claude-*         —— 压根不吃 --effort，传了报 "effort is not supported"
//   gpt-oss-120b     —— 只有 medium
// 本想开机跑 `agy models` 现推一份，但那条命令在管道里会挂住不退出（实测 >2min），
// 不能放在启动路径上。所以写死一张表，再靠下面的 learn 函数按 agy 的报错自我修正。
const MODEL_EFFORTS = new Map([
  ["gemini-3.7-flash", new Set(["low", "medium", "high"])],
  ["gemini-3.6-flash", new Set(["low", "medium", "high"])],
  ["gemini-3.5-flash", new Set(["low", "medium", "high"])],
  ["gemini-3.1-pro", new Set(["low", "high"])],
  ["gpt-oss-120b", new Set(["medium"])],
  ["claude-opus-4-6-thinking", new Set()],
  ["claude-sonnet-4-6", new Set()],
]);

// agy 拒绝启动时会把真实档位写进错误里，例如
//   `--model gemini-3.1-pro requires --effort (available: low, high)`
//   `effort is not supported for model "claude-opus-4-6-thinking"`
// 上面那张表哪天过期了，就按它说的改，然后重试一次。
export function learnEffortsFromError(model, message) {
  if (!model || !message) return false;
  const before = MODEL_EFFORTS.get(model);
  if (/effort is not supported for model/i.test(message)) {
    if (before && before.size === 0) return false;
    MODEL_EFFORTS.set(model, new Set());
    return true;
  }
  const available = /available:\s*([a-z,\s]+)\)/i.exec(message);
  if (available) {
    const levels = new Set(available[1].split(",").map(part => part.trim()).filter(Boolean));
    if (!levels.size) return false;
    if (before && before.size === levels.size && [...levels].every(level => before.has(level))) return false;
    MODEL_EFFORTS.set(model, levels);
    return true;
  }
  return false;
}

/**
 * 这个模型这一轮该传什么 --effort，返回 null 表示这一项整个别传。
 */
export function effortForModel(model, effort) {
  const wanted = EFFORT[effort] || "medium";
  if (!model) return wanted;
  // 档位已经写死在模型名里，再传 --effort 会冲突
  if (/-(high|medium|low)$/.test(model)) return null;
  const supported = MODEL_EFFORTS.get(model);
  if (!supported) return wanted;        // 没见过的模型，照传让 agy 自己判
  if (supported.size === 0) return null; // claude-* 这类不接受档位
  if (supported.has(wanted)) return wanted;
  // 就近取。medium 缺失时优先往下走：high 更慢更费额度，不该由我们替用户升上去
  const order = wanted === "high"
    ? ["high", "medium", "low"]
    : wanted === "low"
    ? ["low", "medium", "high"]
    : ["low", "high", "medium"];
  return order.find(level => supported.has(level)) ?? null;
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
