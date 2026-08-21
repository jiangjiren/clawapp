/**
 * Codex provider —— OpenAI Codex SDK 的事件归一化。
 *
 * Codex 吐的是 thread item（agent_message / reasoning / command_execution /
 * mcp_tool_call / web_search / file_change / todo_list / error），带
 * item.started | item.updated | item.completed 三个生命周期阶段。
 * 这里把它们翻译成 wire.js 那套统一事件。
 *
 * 全部是纯函数：给定 item 就能算出该发什么，不读任何全局状态。
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import * as wire from "./wire.js";

export const PROVIDER_ID = "codex";

export function isAuthAvailable() {
  const authFile = join(homedir(), ".codex", "auth.json");
  if (!existsSync(authFile)) return false;
  try {
    const auth = JSON.parse(readFileSync(authFile, "utf8"));
    return !!(auth.tokens?.access_token || auth.OPENAI_API_KEY);
  } catch { return false; }
}

export function sandboxMode(permissionMode) {
  if (permissionMode === "plan") return "read-only";
  if (permissionMode === "bypassPermissions") return "danger-full-access";
  return "workspace-write";
}

export function itemText(item) {
  if (!item) return "";
  if (typeof item.text === "string") return item.text;
  if (typeof item.message === "string") return item.message;
  return "";
}

/** Codex 的 item.type 映射到前端工具卡片认识的名字。 */
export function toolName(item) {
  if (!item) return "tool";
  if (item.type === "command_execution") return "Bash";
  if (item.type === "mcp_tool_call") return item.tool || "mcp";
  if (item.type === "web_search") return "web_search";
  if (item.type === "file_change") return "apply_patch";
  return item.type || "tool";
}

export function toolInput(item) {
  if (!item) return {};
  if (item.type === "command_execution") return { command: item.command || "" };
  if (item.type === "mcp_tool_call") return item.arguments ?? {};
  if (item.type === "web_search") return { query: item.query || "" };
  if (item.type === "file_change") return { changes: item.changes || [], status: item.status };
  if (item.type === "todo_list") return { items: item.items || [] };
  return item;
}

/** 一个已完成的 item 对应的历史内容块；null 表示这个 item 不进历史。 */
export function contentBlock(item) {
  if (!item) return null;
  const raw = item;
  if (item.type === "agent_message") {
    const text = itemText(item);
    return text ? wire.textBlock(text, raw) : null;
  }
  if (item.type === "reasoning") {
    const thinking = itemText(item);
    return thinking ? wire.thinkingBlock(thinking, raw) : null;
  }
  if (item.type === "mcp_tool_call") {
    return wire.mcpToolResultBlock({
      content: item.result?.content ?? item.result ?? item.error ?? null,
      raw,
    });
  }
  if (item.type === "command_execution") {
    return wire.toolResultBlock({ content: item.aggregated_output || "", raw });
  }
  if (item.type === "error") {
    return wire.providerBlock(PROVIDER_ID, "error", raw, { message: item.message || "Codex item error" });
  }
  return wire.providerBlock(PROVIDER_ID, item.type, raw);
}

const TOOL_ITEM_TYPES = new Set(["command_execution", "mcp_tool_call", "web_search", "file_change"]);
const PROGRESS_ITEM_TYPES = new Set(["command_execution", "mcp_tool_call", "todo_list"]);

/**
 * 一条 Codex 生命周期事件该发给前端的 wire 事件列表（可能为空）。
 *
 * 之所以返回数组而不是直接 send：纯函数可以单测，喂一段录制的 item 流就能
 * 断言归一化结果。原先内联在 server.js 里时，这段逻辑只能靠人肉跑起来验证。
 */
export function itemEvents(eventType, item) {
  if (!item) return [];

  if (eventType === "item.started") {
    if (TOOL_ITEM_TYPES.has(item.type)) {
      const use = {
        id: item.id ?? "",
        name: toolName(item),
        serverName: item.server ?? null,
        input: toolInput(item),
        provider: PROVIDER_ID,
        raw: item,
      };
      return [item.type === "mcp_tool_call" ? wire.mcpToolUse(use) : wire.serverToolUse(use)];
    }
    if (item.type === "reasoning") {
      const block = contentBlock(item);
      return block ? [wire.assistantMessage([block])] : [];
    }
    return [];
  }

  if (eventType === "item.updated") {
    return PROGRESS_ITEM_TYPES.has(item.type)
      ? [wire.toolProgress({ provider: PROVIDER_ID, itemType: item.type, raw: item })]
      : [];
  }

  if (eventType === "item.completed") {
    const block = contentBlock(item);
    return block ? [wire.assistantMessage([block])] : [];
  }

  return [];
}
