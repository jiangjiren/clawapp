import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const html = await readFile(new URL("./public/index.html", import.meta.url), "utf8");
function source(name) {
  const match = html.match(new RegExp(`(?:async )?function ${name}\\([^]*?^}`, "m"));
  assert.ok(match, `Missing function: ${name}`);
  return match[0];
}
const classes = () => ({ add() {}, remove() {}, toggle() {} });

test("聊天页面全部内联脚本可正常解析", () => {
  for (const match of html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)) {
    if (match[1].trim()) assert.doesNotThrow(() => new vm.Script(match[1]));
  }
});

test("发送消费草稿时清除旧快照，避免再次打开时重复恢复", () => {
  const c = vm.createContext({
    promptEl: { value: "send this", style: {} }, currentConvId: "a",
    conversationDrafts: new Map([["a", { text: "old snapshot" }]]),
    parseProviderDispatchText() { return null; }, selectedMentionNotes: new Map(), pendingImages: [],
    currentNoteFile: null, quotedText: null, selectedModel: "test", selectedPermissionMode: "plan", selectedEffort: "low",
    activeProfileId() { return "test"; }, clearMentionNotes() {}, clearImages() {}, syncComposerAction() {},
    quoteChip: { classList: classes() },
  });
  vm.runInContext(source("takeRequestDraft"), c);
  assert.equal(c.takeRequestDraft().text, "send this");
  assert.equal(c.conversationDrafts.has("a"), false);
  assert.equal(c.promptEl.value, "");
});

function switchFixture() {
  const context = vm.createContext({
    currentConvId: "original", conversationSwitchVersion: 0,
    currentSessionId: null, currentSessionProvider: null,
    convViewCache: new Map(), conversationDrafts: new Map(), convStaleIds: new Set(),
    sessionsRunning: new Set(), messageLog: [], followLatestMessage: true,
    messagesEl: { classList: classes(), innerHTML: "Original conversation", scrollTop: 0 },
    errors: [], finishes: [], draftsRestored: [], saves: [],
    closeSwitcher() {}, isBlankConversation() { return false; },
    saveCurrentConversation() { context.saves.push(context.currentConvId); },
    cacheCurrentConversationView() {}, hideAskUserQuestion() {}, forgetConversationLocally() {},
    restoreComposerDraft(id) { context.draftsRestored.push(id); },
    restoreConversationRuntime() {}, scrollBottom() {}, renderAssistantBlocks() {},
    addMessage(role, text) { context.messagesEl.innerHTML += text; return {}; },
    finishConversationSwitch(conv) { context.finishes.push(conv.id); },
    showInlineError(text) { context.errors.push(text); },
    requestAnimationFrame() {},
  });
  vm.runInContext(source("loadConversation"), context);
  return context;
}

test("历史响应乱序时，旧请求不能覆盖最后选择的对话", async () => {
  const c = switchFixture();
  let resolve;
  c.fetch = () => new Promise(done => { resolve = done; });
  const slow = c.loadConversation({ id: "slow" });
  assert.equal(c.currentConvId, "original", "加载时原会话继续接收事件");
  await c.loadConversation({ id: "fast", messages: [{ role: "user", text: "FAST" }] });
  resolve({ ok: true, json: async () => ({ id: "slow", messages: [{ role: "user", text: "SLOW" }] }) });
  await slow;
  assert.equal(c.currentConvId, "fast");
  assert.equal(c.messagesEl.innerHTML, "FAST");
  assert.deepEqual(c.finishes, ["fast"]);
  assert.deepEqual(c.saves, ["original"]);
});

test("加载失败保留当前会话，不能显示成空白历史", async () => {
  const c = switchFixture();
  c.fetch = async () => { throw new Error("offline"); };
  await c.loadConversation({ id: "unavailable" });
  assert.equal(c.currentConvId, "original");
  assert.equal(c.messagesEl.innerHTML, "Original conversation");
  assert.equal(c.errors.length, 1);
  assert.deepEqual(c.saves, []);
});

test("后台更新使视图失效后，重建历史仍恢复草稿及原阅读位置", async () => {
  const c = switchFixture();
  c.convViewCache.set("target", { html: "old", scrollTop: 240, followLatest: false });
  c.convStaleIds.add("target");
  c.fetch = async () => ({ ok: true, json: async () => ({ id: "target", messages: [{ role: "assistant", text: "new" }] }) });
  await c.loadConversation({ id: "target" });
  assert.equal(c.messagesEl.innerHTML, "new");
  assert.equal(c.messagesEl.scrollTop, 240);
  assert.equal(c.followLatestMessage, false);
  assert.deepEqual(c.draftsRestored, ["target"]);
});

test("失效历史加载失败时回退本地视图并保留再次重试能力", async () => {
  const c = switchFixture();
  c.convViewCache.set("target", { html: "cached", messageLog: [], scrollTop: 180, followLatest: false });
  c.convStaleIds.add("target");
  c.fetch = async () => ({ ok: false });
  await c.loadConversation({ id: "target", messages: [{ role: "user", text: "stale summary" }] });
  assert.equal(c.messagesEl.innerHTML, "cached");
  assert.equal(c.messagesEl.scrollTop, 180);
  assert.equal(c.convStaleIds.has("target"), true);
});

test("没有服务端历史的未发送草稿仍可以重新打开", async () => {
  const c = switchFixture();
  c.conversationDrafts.set("draft", { text: "unsent" });
  c.fetch = async () => ({ ok: false });
  await c.loadConversation({ id: "draft" });
  assert.equal(c.currentConvId, "draft");
  assert.deepEqual(c.draftsRestored, ["draft"]);
  assert.equal(c.errors.length, 0);
});

test("图片、笔记和引用与文字一起按会话恢复，空会话清除附件", () => {
  const c = vm.createContext({
    conversationDrafts: new Map(), promptEl: { value: "Draft A" },
    pendingImages: [{ data: "image-A", previewUrl: "data:image/png;base64,AA", mediaType: "image/png" }],
    selectedMentionNotes: new Map([["a.md", { path: "a.md", title: "Note A" }]]),
    quotedText: "Quote A", quotedSection: "Section", quotedPrefix: "Prefix", quotedSuffix: "Suffix",
    quoteChip: { classList: classes() }, quoteTextEl: {}, quoteLinesEl: {},
    renderImageChip() {}, renderMentionChips() {}, hidePopup() {}, adjustPromptHeight() {},
  });
  vm.runInContext(["captureComposerDraft", "restoreComposerDraft", "hasComposerDraft"].map(source).join("\n"), c);
  const draft = c.captureComposerDraft();
  c.conversationDrafts.set("a", draft);
  c.restoreComposerDraft("b");
  assert.equal(c.promptEl.value, "");
  assert.equal(c.pendingImages.length, 0);
  assert.equal(c.selectedMentionNotes.size, 0);
  assert.equal(c.quotedText, null);
  c.restoreComposerDraft("a");
  assert.equal(c.promptEl.value, "Draft A");
  assert.equal(c.pendingImages[0].data, "image-A");
  assert.equal(c.selectedMentionNotes.get("a.md").title, "Note A");
  assert.equal(c.quotedSection, "Section");
  c.pendingImages[0].data = "changed";
  assert.equal(draft.images[0].data, "image-A", "恢复后的附件不修改已缓存快照");
  assert.ok(c.hasComposerDraft({ images: [{}] }));
  assert.ok(c.hasComposerDraft({ mentions: [{}] }));
  assert.ok(c.hasComposerDraft({ quote: { text: "quote" } }));
});

test("流式新增内容尊重暂停跟随，主动回到底部重新开启跟随", () => {
  const listeners = {};
  const c = vm.createContext({
    messagesEl: { scrollTop: 500, scrollHeight: 1000, clientHeight: 500, addEventListener(type, listener) { listeners[type] = listener; } },
    document: { getElementById() { return { hidden: true, addEventListener(type, listener) { listeners.jump = listener; } }; } },
    ResizeObserver: class { observe() {} },
    MutationObserver: class { observe() {} },
  });
  const start = html.indexOf("let followLatestMessage = true;");
  const end = html.indexOf("// ── Composer popup:", start);
  vm.runInContext(html.slice(start, end), c);
  c.messagesEl.scrollTop = 160;
  listeners.scroll();
  c.messagesEl.scrollHeight = 1300;
  c.scrollBottom();
  assert.equal(c.messagesEl.scrollTop, 160);
  listeners.jump();
  assert.equal(c.messagesEl.scrollTop, 1300);
  c.messagesEl.scrollHeight = 1500;
  c.scrollBottom();
  assert.equal(c.messagesEl.scrollTop, 1500);
});
