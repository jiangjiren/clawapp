/**
 * ══════════════════════════════════════════════════════════════════════
 * Wire Protocol —— 服务端发给前端的事件格式
 * ══════════════════════════════════════════════════════════════════════
 *
 * 这套格式一直存在，只是从来没写下来过：Claude SDK 的事件形状事实上成了
 * 标准，Codex 和 Antigravity 各自往上凑。凑错了没有任何报错——只有跑起来
 * 看见界面不对才知道。接第四家 provider 时，这个成本会原样再来一遍。
 *
 * 所以这里把它显式化成构造器。三家 provider 只允许通过这些函数产生事件，
 * 前端 handleEvent 只需要认这一套，不再跟某一家 SDK 的原生事件形状绑死。
 *
 * 协议分四类：
 *   1. 定稿消息 assistantMessage —— 进历史，前端据此重渲染
 *   2. 流式片段 stream*         —— 用于即时展示，main 同时记录事件供断线恢复
 *   3. 工具生命周期 *ToolUse / toolSettled / toolProgress
 *   4. 内容块 *Block            —— 装进 assistantMessage 的 content 数组
 */

// ── 内容块 ────────────────────────────────────────────────────────────
// 这些块会进历史（server.js 的 normalizeAssistantHistoryBlocks 读它们），
// raw 保留 provider 原始对象，供前端工具卡片展开细节用。

export function textBlock(text, raw = null) {
  return raw === null ? { type: "text", text } : { type: "text", text, raw };
}

export function thinkingBlock(thinking, raw = null) {
  return raw === null ? { type: "thinking", thinking } : { type: "thinking", thinking, raw };
}

export function toolResultBlock({ toolUseId = null, content = "", raw = null } = {}) {
  const block = { type: "tool_result", content };
  if (toolUseId !== null) block.tool_use_id = toolUseId;
  if (raw !== null) block.raw = raw;
  return block;
}

export function mcpToolResultBlock({ content = null, raw = null } = {}) {
  const block = { type: "mcp_tool_result", content };
  if (raw !== null) block.raw = raw;
  return block;
}

/** provider 有自己独有的块类型时走这里，前端按 `${provider}_${kind}` 兜底渲染。 */
export function providerBlock(provider, kind, raw = null, extra = {}) {
  const block = { type: `${provider}_${kind || "item"}`, ...extra };
  if (raw !== null) block.raw = raw;
  return block;
}

// ── 定稿消息 ──────────────────────────────────────────────────────────

/**
 * 一段定稿的 assistant 输出。每段文字/工具结果最终以 assistantMessage
 * 收尾，供 main 的历史投影生成完整内容；原始流式事件也保留在事件日志里。
 */
export function assistantMessage(blocks) {
  const content = Array.isArray(blocks) ? blocks : [blocks];
  return { type: "assistant", message: { role: "assistant", content } };
}

/**
 * 把前端的工具卡片从「执行中」落定成「已完成」。
 * 真正的结果已经在 assistantMessage 的 tool_result 块里了，
 * 这条只是让 UI 停止转圈。两条都发才能既有历史又有正确的 UI 状态。
 */
export function toolSettled(toolUseId, { isError = false } = {}) {
  return {
    type: "user",
    message: {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: toolUseId, content: "", is_error: isError }],
    },
  };
}

// ── 流式片段 ──────────────────────────────────────────────────────────
// 包一层 stream_event 是 Claude SDK 的原生形状，前端已按它实现，保持不变。
// index 固定 0：三家都只流式输出一个文本块，多块并行流式没有出现过。

const streamEvent = (event) => ({ type: "stream_event", event });

/** 工具跑完后重新开一段回复时发，前端据此清 spinner 并重置块表。 */
export const streamMessageStart = () => streamEvent({ type: "message_start" });

export const streamTextStart = (index = 0) => streamEvent({
  type: "content_block_start",
  index,
  content_block: { type: "text", text: "" },
});

export const streamTextDelta = (text, index = 0) => streamEvent({
  type: "content_block_delta",
  index,
  delta: { type: "text_delta", text },
});

export const streamTextStop = (index = 0) => streamEvent({ type: "content_block_stop", index });

// ── 工具生命周期 ──────────────────────────────────────────────────────

export function serverToolUse({ id = "", name = "tool", input = {}, provider, raw = null, serverName = null }) {
  return { type: "server_tool_use", id, name, server_name: serverName, input, provider, raw };
}

export function mcpToolUse({ id = "", name = "mcp", input = {}, provider, raw = null, serverName = null }) {
  return { type: "mcp_tool_use", id, name, server_name: serverName, input, provider, raw };
}

/** 工具还在跑时的中间态（命令输出增量、todo 列表变化等）。不进历史。 */
export function toolProgress({ provider, itemType = null, raw = null }) {
  return { type: "tool_progress", provider, itemType, raw };
}
