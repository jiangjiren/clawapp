import test from "node:test";
import assert from "node:assert/strict";

import * as wire from "./providers/wire.js";
import * as codex from "./providers/codex.js";
import * as agy from "./providers/antigravity.js";

/* ══════════════════════════════════════════════════════════════════
   Wire 协议
   这些形状前端 handleEvent 直接依赖，改了就是破坏性变更。
   ══════════════════════════════════════════════════════════════════ */

test("wire: 定稿消息永远包成 assistant/role/content 三层", () => {
  assert.deepEqual(wire.assistantMessage([wire.textBlock("hi")]), {
    type: "assistant",
    message: { role: "assistant", content: [{ type: "text", text: "hi" }] },
  });
  // 单个块也接受，自动包成数组
  assert.deepEqual(wire.assistantMessage(wire.textBlock("hi")).message.content, [
    { type: "text", text: "hi" },
  ]);
});

test("wire: raw 为 null 时不写进块里", () => {
  assert.deepEqual(wire.textBlock("hi"), { type: "text", text: "hi" });
  assert.deepEqual(wire.textBlock("hi", { a: 1 }), { type: "text", text: "hi", raw: { a: 1 } });
  assert.deepEqual(wire.thinkingBlock("think"), { type: "thinking", thinking: "think" });
});

test("wire: toolSettled 是给 UI 落定用的，content 必须为空", () => {
  // 真正的结果在 assistantMessage 的 tool_result 块里。这条要是带上内容，
  // 历史里就会出现两份重复的工具输出。
  const ev = wire.toolSettled("t1");
  assert.equal(ev.type, "user");
  assert.deepEqual(ev.message.content, [
    { type: "tool_result", tool_use_id: "t1", content: "", is_error: false },
  ]);
});

test("wire: 流式事件都包在 stream_event 里，index 固定 0", () => {
  assert.deepEqual(wire.streamMessageStart(), {
    type: "stream_event",
    event: { type: "message_start" },
  });
  assert.deepEqual(wire.streamTextDelta("abc"), {
    type: "stream_event",
    event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "abc" } },
  });
  assert.equal(wire.streamTextStart().event.type, "content_block_start");
  assert.equal(wire.streamTextStop().event.type, "content_block_stop");
});

test("wire: providerBlock 把 provider 私有类型编进 type", () => {
  assert.deepEqual(wire.providerBlock("codex", "error", { r: 1 }, { message: "boom" }), {
    type: "codex_error",
    message: "boom",
    raw: { r: 1 },
  });
});

/* ══════════════════════════════════════════════════════════════════
   Codex
   ══════════════════════════════════════════════════════════════════ */

test("codex: 工具类 item 在 started 阶段分流到 mcp / server 两种事件", () => {
  const [mcp] = codex.itemEvents("item.started", {
    type: "mcp_tool_call", id: "m1", tool: "search", server: "srv", arguments: { q: "x" },
  });
  assert.equal(mcp.type, "mcp_tool_use");
  assert.equal(mcp.name, "search");
  assert.equal(mcp.server_name, "srv");
  assert.deepEqual(mcp.input, { q: "x" });

  const [bash] = codex.itemEvents("item.started", { type: "command_execution", id: "c1", command: "ls" });
  assert.equal(bash.type, "server_tool_use");
  assert.equal(bash.name, "Bash");
  assert.equal(bash.server_name, null);
  assert.deepEqual(bash.input, { command: "ls" });
  assert.equal(bash.provider, "codex");
});

test("codex: reasoning 在 started 阶段就定稿，agent_message 不在", () => {
  // reasoning 提前发是刻意的——思考过程要即时可见，不能等 completed。
  const started = codex.itemEvents("item.started", { type: "reasoning", text: "想一下" });
  assert.equal(started.length, 1);
  assert.equal(started[0].message.content[0].type, "thinking");

  assert.deepEqual(codex.itemEvents("item.started", { type: "agent_message", text: "hi" }), []);
});

test("codex: updated 只对三类 item 发进度，其余静默", () => {
  for (const type of ["command_execution", "mcp_tool_call", "todo_list"]) {
    const [ev] = codex.itemEvents("item.updated", { type });
    assert.equal(ev.type, "tool_progress");
    assert.equal(ev.itemType, type);
  }
  assert.deepEqual(codex.itemEvents("item.updated", { type: "agent_message" }), []);
  assert.deepEqual(codex.itemEvents("item.updated", { type: "web_search" }), []);
});

test("codex: 空文本的 item 不产生事件（否则历史里多出空气泡）", () => {
  assert.deepEqual(codex.itemEvents("item.completed", { type: "agent_message", text: "" }), []);
  assert.deepEqual(codex.itemEvents("item.completed", { type: "reasoning" }), []);
  assert.deepEqual(codex.itemEvents("item.completed", null), []);
  assert.deepEqual(codex.itemEvents("item.unknown", { type: "agent_message", text: "hi" }), []);
});

test("codex: contentBlock 覆盖各 item 类型", () => {
  assert.equal(codex.contentBlock({ type: "agent_message", message: "from message 字段" }).text,
    "from message 字段");

  const cmd = codex.contentBlock({ type: "command_execution", aggregated_output: "out" });
  assert.equal(cmd.type, "tool_result");
  assert.equal(cmd.content, "out");

  // mcp 结果三级回退：result.content → result → error
  assert.equal(codex.contentBlock({ type: "mcp_tool_call", result: { content: "A" } }).content, "A");
  assert.equal(codex.contentBlock({ type: "mcp_tool_call", result: "B" }).content, "B");
  assert.equal(codex.contentBlock({ type: "mcp_tool_call", error: "C" }).content, "C");

  assert.deepEqual(
    { type: codex.contentBlock({ type: "error" }).type, msg: codex.contentBlock({ type: "error" }).message },
    { type: "codex_error", msg: "Codex item error" },
  );
  // 没见过的类型不丢，编成 codex_<type> 让前端兜底渲染
  assert.equal(codex.contentBlock({ type: "brand_new" }).type, "codex_brand_new");
});

test("codex: sandbox 模式跟着权限档位走", () => {
  assert.equal(codex.sandboxMode("plan"), "read-only");
  assert.equal(codex.sandboxMode("bypassPermissions"), "danger-full-access");
  assert.equal(codex.sandboxMode("auto"), "workspace-write");
  assert.equal(codex.sandboxMode(undefined), "workspace-write");
});

/* ══════════════════════════════════════════════════════════════════
   Antigravity（agy）
   ══════════════════════════════════════════════════════════════════ */

const stepUpdate = (step) => ({ event: "step_update", step_update: step });

/** 把一串 agy 事件喂给翻译器，收集所有产出。 */
function feed(translate, steps) {
  return steps.flatMap(step => translate(stepUpdate(step)));
}

test("agy: 文本按 step_index 累积，DONE 时定稿", () => {
  const t = agy.createTranslator();
  const out = feed(t, [
    { step_index: 0, step_type: "agent_response", text_delta: "你" },
    { step_index: 0, step_type: "agent_response", text_delta: "好" },
    { step_index: 0, step_type: "agent_response", state: "DONE" },
  ]);
  assert.deepEqual(out.map(e => e.event?.type ?? e.type), [
    "content_block_start", "content_block_delta", "content_block_delta", "content_block_stop", "assistant",
  ]);
  // 定稿文本是累积后的完整内容，不是最后一个 delta
  assert.equal(out.at(-1).message.content[0].text, "你好");
});

test("agy: 工具跑完后再出文本，必须先补一条 message_start", () => {
  // 这是最容易回归的一条：少了 message_start，前端 spinner 不清、块表不重置，
  // 第二段回复会拼进第一段里。
  const t = agy.createTranslator();
  feed(t, [{ step_index: 0, step_type: "tool", tool_name: "run_command", state: "ACTIVE", tool_info: {} }]);
  const out = feed(t, [{ step_index: 1, step_type: "agent_response", text_delta: "结果是" }]);
  assert.deepEqual(out.map(e => e.event.type), ["message_start", "content_block_start", "content_block_delta"]);
});

test("agy: 本轮第一段文本前不发 message_start", () => {
  const t = agy.createTranslator();
  const out = feed(t, [{ step_index: 0, step_type: "agent_response", text_delta: "开头" }]);
  assert.deepEqual(out.map(e => e.event.type), ["content_block_start", "content_block_delta"]);
});

test("agy: 工具 ACTIVE 重复来只发一次 tool_use", () => {
  const t = agy.createTranslator();
  const out = feed(t, [
    { step_index: 2, step_type: "tool", tool_name: "view_file", state: "ACTIVE", tool_info: {} },
    { step_index: 2, step_type: "tool", tool_name: "view_file", state: "ACTIVE", tool_info: {} },
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0].type, "server_tool_use");
  assert.equal(out[0].name, "Read");        // view_file → Read 别名
  assert.equal(out[0].id, "agy_2");
  assert.equal(out[0].provider, "antigravity");
});

test("agy: 工具 DONE 发两条——进历史的结果 + 让 UI 落定的信号", () => {
  const t = agy.createTranslator();
  feed(t, [{ step_index: 3, step_type: "tool", tool_name: "run_command", state: "ACTIVE", tool_info: {} }]);
  const out = feed(t, [
    { step_index: 3, step_type: "tool", state: "DONE", tool_info: { output: "hello" } },
  ]);
  assert.deepEqual(out.map(e => e.type), ["assistant", "user"]);
  const block = out[0].message.content[0];
  assert.equal(block.type, "tool_result");
  assert.equal(block.tool_use_id, "agy_3");   // 跟 ACTIVE 阶段的 id 配上
  assert.equal(block.content, "hello");
  assert.equal(out[1].message.content[0].tool_use_id, "agy_3");
});

test("agy: 没见过 ACTIVE 的工具直接 DONE 也能配出 id", () => {
  const t = agy.createTranslator();
  const out = feed(t, [{ step_index: 9, step_type: "tool", state: "DONE", tool_info: { output: "x" } }]);
  assert.equal(out[0].message.content[0].tool_use_id, "agy_9");
});

test("agy: 超长工具输出截断并标注", () => {
  const t = agy.createTranslator();
  const [msg] = feed(t, [
    { step_index: 0, step_type: "tool", state: "DONE", tool_info: { output: "x".repeat(20050) } },
  ]);
  const content = msg.message.content[0].content;
  assert.ok(content.length < 20050);
  assert.ok(content.endsWith("（输出已截断）"));
});

test("agy: 非 step_update 事件与畸形输入一律静默", () => {
  const t = agy.createTranslator();
  assert.deepEqual(t(null), []);
  assert.deepEqual(t("nope"), []);
  assert.deepEqual(t({ event: "something_else" }), []);
  assert.deepEqual(t({ event: "step_update" }), []);
  assert.deepEqual(t(stepUpdate({ step_type: "unknown_kind" })), []);
});

test("agy: 工具参数补小写别名，原字段保留", () => {
  assert.deepEqual(
    agy.toolInput({ parameters: { AbsolutePath: "/a/b.md", Extra: 1 } }),
    { AbsolutePath: "/a/b.md", Extra: 1, file_path: "/a/b.md" },
  );
  // 已有小写键时不覆盖
  assert.equal(agy.toolInput({ parameters: { Command: "ls", command: "keep" } }).command, "keep");
  // 别名值不是字符串就不映射
  assert.equal(agy.toolInput({ parameters: { Query: 123 } }).query, undefined);
  assert.deepEqual(agy.toolInput(null), {});
  assert.deepEqual(agy.toolInput({ parameters: "not an object" }), {});
});

test("agy: 工具输出非字符串时转 JSON", () => {
  assert.equal(agy.toolOutput({ output: { a: 1 } }), '{"a":1}');
  assert.equal(agy.toolOutput({ output: null }), "");
  assert.equal(agy.toolOutput(null), "");
  const circular = {}; circular.self = circular;
  assert.equal(typeof agy.toolOutput({ output: circular }), "string");
});

test("agy: 工具名走别名表，未知名原样透出", () => {
  assert.equal(agy.toolName({ tool_name: "replace_file_content" }), "Edit");
  assert.equal(agy.toolName({ tool_info: { name: "search_web" } }), "WebSearch");
  assert.equal(agy.toolName({ tool_name: "brand_new_tool" }), "brand_new_tool");
  assert.equal(agy.toolName(null), "tool");
});

test("agy: effort 按模型能力就近取，medium 缺失时往下走", () => {
  // gemini-3.1-pro 只有 low/high：要 medium 时不能替用户升到 high（更慢更费额度）
  assert.equal(agy.effortForModel("gemini-3.1-pro", "medium"), "low");
  assert.equal(agy.effortForModel("gemini-3.1-pro", "high"), "high");
  assert.equal(agy.effortForModel("gemini-3.8-flash", "max"), "high");   // max 压到 high
  assert.equal(agy.effortForModel("claude-sonnet-4-6", "high"), null);   // 不吃 --effort
  assert.equal(agy.effortForModel("gemini-3.8-flash-high", "low"), null); // 档位已写死在名字里
  assert.equal(agy.effortForModel("never-seen-model", "low"), "low");     // 没见过就照传
  assert.equal(agy.effortForModel(null, "xhigh"), "high");
});

test("agy: 按 agy 的报错自我修正档位表", () => {
  const model = "test-model-for-learning";
  assert.equal(agy.effortForModel(model, "medium"), "medium");

  assert.equal(agy.learnEffortsFromError(model, "requires --effort (available: low, high)"), true);
  assert.equal(agy.effortForModel(model, "medium"), "low");
  // 同样的报错再来一次，表没变化就返回 false，避免无谓重试
  assert.equal(agy.learnEffortsFromError(model, "requires --effort (available: low, high)"), false);

  assert.equal(agy.learnEffortsFromError(model, 'effort is not supported for model "x"'), true);
  assert.equal(agy.effortForModel(model, "high"), null);
  assert.equal(agy.learnEffortsFromError(model, 'effort is not supported for model "x"'), false);

  assert.equal(agy.learnEffortsFromError(null, "whatever"), false);
  assert.equal(agy.learnEffortsFromError(model, "看不懂的报错"), false);
  agy._resetCatalog();
});

/* ══════════════════════════════════════════════════════════════════
   Antigravity 模型目录（`agy models` → 菜单 + 档位表）
   ══════════════════════════════════════════════════════════════════ */

// 真实的 `agy models` stdout，包含它开头那行没有 TAB 的日志
const AGY_MODELS_STDOUT = [
  "Fetching available models...",
  "gemini-3.8-flash-high\tGemini 3.8 Flash (High)",
  "gemini-3.8-flash-medium\tGemini 3.8 Flash (Medium)",
  "gemini-3.8-flash-low\tGemini 3.8 Flash (Low)",
  "gemini-3.7-flash-high\tGemini 3.7 Flash (High)",
  "gemini-3.7-flash-medium\tGemini 3.7 Flash (Medium)",
  "gemini-3.7-flash-low\tGemini 3.7 Flash (Low)",
  "gemini-3.1-pro-high\tGemini 3.1 Pro (High)",
  "gemini-3.1-pro-low\tGemini 3.1 Pro (Low)",
  "claude-sonnet-4-6\tClaude Sonnet 4.6 (Thinking)",
  "claude-opus-4-6-thinking\tClaude Opus 4.6 (Thinking)",
  "gpt-oss-120b-medium\tGPT-OSS 120B (Medium)",
  "",
].join("\n");

test("agy: 解析 `agy models`，档位后缀合并成模型的能力表", () => {
  const catalog = agy.parseModelsList(AGY_MODELS_STDOUT);
  const byModel = Object.fromEntries(catalog.map(entry => [entry.model, entry]));

  // 三行 -high/-medium/-low 合并成一个模型，label 去掉档位括号
  assert.deepEqual(byModel["gemini-3.8-flash"].efforts, ["low", "medium", "high"]);
  assert.equal(byModel["gemini-3.8-flash"].label, "Gemini 3.8 Flash");
  // pro 只有两档，不能凭空补出 medium
  assert.deepEqual(byModel["gemini-3.1-pro"].efforts, ["low", "high"]);
  // 没有档位后缀 = 不吃 --effort，label 里的 (Thinking) 不是档位，要留着
  assert.deepEqual(byModel["claude-sonnet-4-6"].efforts, []);
  assert.equal(byModel["claude-sonnet-4-6"].label, "Claude Sonnet 4.6 (Thinking)");
  assert.deepEqual(byModel["gpt-oss-120b"].efforts, ["medium"]);
  // 开头那行日志没有 TAB，不能被当成模型
  assert.equal(catalog.length, 6);

  // 认不出来时返回 null，让调用方留着旧目录而不是把菜单清空
  assert.equal(agy.parseModelsList("Fetching available models...\nsome error"), null);
  assert.equal(agy.parseModelsList(""), null);
  assert.equal(agy.parseModelsList(null), null);
});

test("agy: 目录换新之后，档位表和菜单跟着走", () => {
  assert.equal(agy.hasLiveCatalog(), false);
  assert.equal(agy.setCatalog(agy.parseModelsList(AGY_MODELS_STDOUT)), true);
  assert.equal(agy.hasLiveCatalog(), true);

  // 目录里没有 3.6 了（这份输出没列它），档位查询要落到「没见过」而不是老表里的值
  assert.equal(agy.effortForModel("gemini-3.8-flash", "medium"), "medium");
  assert.equal(agy.effortForModel("gemini-3.1-pro", "medium"), "low");

  // 空目录不能把好目录顶掉
  assert.equal(agy.setCatalog([]), false);
  assert.equal(agy.setCatalog(null), false);
  assert.equal(agy.effortForModel("gemini-3.8-flash", "medium"), "medium");

  agy._resetCatalog();
  assert.equal(agy.hasLiveCatalog(), false);
});

test("agy: 菜单每个系列只留最新的一个", () => {
  agy.setCatalog(agy.parseModelsList(AGY_MODELS_STDOUT));
  const menu = agy.menuModels();
  const models = menu.map(item => item.model);

  // 3.8 顶掉 3.7：同一个系列不该在菜单里出现两代
  // gpt-oss 平时用不上，藏起来——但它还在目录里，选着它的对话照样能跑
  assert.deepEqual(models, [
    "gemini-3.1-pro",
    "gemini-3.8-flash",
    "claude-opus-4-6-thinking",
    "claude-sonnet-4-6",
  ]);
  assert.equal(agy.effortForModel("gpt-oss-120b", "high"), "medium");
  // 菜单上的名字去掉了结尾括号和 Claude 前缀
  assert.equal(menu.find(item => item.model === "claude-opus-4-6-thinking").name, "Opus 4.6");
  assert.equal(menu.find(item => item.model === "gemini-3.8-flash").name, "Gemini 3.8 Flash");
  assert.equal(menu.find(item => item.model === "gemini-3.1-pro").desc, "旗舰最强");
  // 档位一起带过去，前端不用再查第二张表
  assert.deepEqual(menu.find(item => item.model === "gemini-3.1-pro").efforts, ["low", "high"]);

  agy._resetCatalog();
});

test("agy: 下线的模型顺着系列升到最新", () => {
  agy.setCatalog(agy.parseModelsList(AGY_MODELS_STDOUT));

  // 3.5 已经从 agy 那边撤了，用户还选着它 → 升到同系列最新的 3.8
  assert.equal(agy.successorFor("gemini-3.5-flash"), "gemini-3.8-flash");
  // 3.7 还在目录里（只是不在菜单上），不该被换掉
  assert.equal(agy.successorFor("gemini-3.7-flash"), null);
  assert.equal(agy.successorFor("gemini-3.8-flash"), null);
  // 别家的模型名没有同系列可换，交给调用方退回默认
  assert.equal(agy.successorFor("claude-opus-5"), null);
  assert.equal(agy.successorFor(""), null);
  // 只往上换：目录还没刷新就赶上一次升级时，请求里的版本比目录里的都新，
  // 这时候必须原样放行，不能把用户选的新模型悄悄降回旧的
  assert.equal(agy.successorFor("gemini-3.9-flash"), null);

  agy._resetCatalog();
});

test("agy: 没查过目录时用兜底表，不至于菜单空掉", () => {
  agy._resetCatalog();
  const menu = agy.menuModels();
  assert.ok(menu.length >= 4);
  assert.ok(menu.every(item => item.model && item.name && item.desc));
  // 兜底表里同系列也只露最新的一个
  assert.equal(menu.filter(item => /-flash$/.test(item.model)).length, 1);
  // 藏起来的那些兜底时也不该冒出来
  assert.equal(menu.filter(item => /^gpt-/.test(item.model)).length, 0);
});

test("agy: 权限档位映射", () => {
  assert.equal(agy.modeFlag("plan"), "plan");
  assert.equal(agy.modeFlag("auto"), "accept-edits");
  assert.equal(agy.modeFlag("bypassPermissions"), "accept-edits");
});

/* ══════════════════════════════════════════════════════════════════
   Antigravity 用量额度
   ══════════════════════════════════════════════════════════════════ */

// 真实的 `agy -p "/usage" --output-format json` 回包，删掉了跟配额无关的字段
const AGY_USAGE_JSON = JSON.stringify({
  conversation_id: "",
  status: "SUCCESS",
  response: "Gemini Models\tWeekly Limit Remaining\t88%\t2026-08-29T07:42:01Z\n",
  command: {
    name: "usage",
    data: {
      description: "Within each group, models share a weekly limit and a 5-hour limit.",
      groups: [
        {
          name: "Gemini Models",
          buckets: [
            { id: "gemini-weekly", name: "Weekly Limit Remaining", window: "weekly", remaining_fraction: 0.875411331653595, reset_time: "2026-08-29T07:42:01Z" },
            { id: "gemini-5h", name: "Five Hour Limit Remaining", window: "5h", remaining_fraction: 0.9194384217262268, reset_time: "2026-08-27T13:00:43Z" },
          ],
        },
        {
          name: "Claude and GPT models",
          buckets: [
            { id: "3p-weekly", name: "Weekly Limit Remaining", window: "weekly", remaining_fraction: 0.7754247784614563, reset_time: "2026-09-01T03:19:13Z" },
            { id: "3p-5h", name: "Five Hour Limit Remaining", window: "5h", remaining_fraction: 1, reset_time: "2026-08-27T17:45:26Z" },
          ],
        },
      ],
    },
  },
});

test("agy 用量: 两组配额各自成行，百分比按剩余算", () => {
  const groups = agy.parseUsage(AGY_USAGE_JSON);
  assert.equal(groups.length, 2);
  assert.deepEqual(groups[0], {
    key: "gemini",
    label: "Gemini",
    fiveHour: { usedPercent: 8, remainingPercent: 92, resetAt: "2026-08-27T13:00:43Z" },
    week: { usedPercent: 12, remainingPercent: 88, resetAt: "2026-08-29T07:42:01Z" },
  });
  assert.equal(groups[1].key, "3p");
  assert.equal(groups[1].label, "Claude/GPT");
  assert.equal(groups[1].fiveHour.remainingPercent, 100);
  assert.equal(groups[1].week.remainingPercent, 78);
});

test("agy 用量: 前面掺了日志行也能捞出那行 JSON", () => {
  const noisy = `ERROR: logging before google.Init: I0827 doRefreshQuota\n{"broken":\n${AGY_USAGE_JSON}`;
  assert.equal(agy.parseUsage(noisy)?.length, 2);
});

test("agy 用量: 解析不出配额时返回 null，不返回空壳", () => {
  assert.equal(agy.parseUsage(""), null);
  assert.equal(agy.parseUsage("not json at all"), null);
  // 起了 agent 轮次的回包（命令没被短路）——没有 command.data.groups
  assert.equal(agy.parseUsage(JSON.stringify({ status: "SUCCESS", response: "我不知道" })), null);
  // groups 在但每组都缺可用窗口
  assert.equal(agy.parseUsage(JSON.stringify({
    command: { data: { groups: [{ name: "Gemini Models", buckets: [{ id: "gemini-weekly", window: "weekly" }] }] } },
  })), null);
});
