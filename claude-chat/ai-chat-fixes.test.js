/**
 * AI 对话那批修复的回归测试。
 *
 * 这里刻意不写「源码里出现过某个字符串」那种断言——它在净化器逻辑写错时照样
 * 全绿，换个等价写法却会红，方向是反的。前端那几个函数用 vm 抽出来真跑，
 * 服务端起一个真进程去问。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import vm from "node:vm";

const html = await readFile(new URL("./public/index.html", import.meta.url), "utf8");

function source(name) {
  const match = html.match(new RegExp(`(?:async )?function ${name}\\([^]*?^}`, "m"));
  assert.ok(match, `Missing function: ${name}`);
  return match[0];
}

/* 净化那一段是常量 + hook + 入口三件套，整块抽出来才跑得起来。 */
const sanitizerModule = (() => {
  const start = html.indexOf("const MARKDOWN_ALLOWED_TAGS");
  const end = html.indexOf("\nfunction renderMarkdown(");
  assert.ok(start > 0 && end > start, "净化模块的边界没找到，代码结构可能变了");
  return html.slice(start, end);
})();

function makeSanitizerContext({ withPurify = true } = {}) {
  const context = vm.createContext({
    calls: [],
    hooks: [],
    escapeHtml: value => String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"),
  });
  if (withPurify) {
    context.DOMPurify = {
      sanitize(dirty, config) { context.calls.push({ dirty, config }); return "<sanitized/>"; },
      addHook(name, fn) { context.hooks.push({ name, fn }); },
    };
  }
  vm.runInContext(sanitizerModule, context);
  return context;
}

function fakeNode(tagName, attrs = {}) {
  return {
    tagName,
    attrs: { ...attrs },
    removed: false,
    getAttribute(name) { return name in this.attrs ? this.attrs[name] : null; },
    setAttribute(name, value) { this.attrs[name] = value; },
    removeAttribute(name) { delete this.attrs[name]; },
    remove() { this.removed = true; },
  };
}

test("模型输出交给 DOMPurify，标签白名单比它的默认 profile 更紧", () => {
  const c = makeSanitizerContext();
  c.sanitizeRenderedHtml("<p>hi</p>");

  assert.equal(c.calls.length, 1, "必须真的过一遍净化器");
  const { config } = c.calls[0];
  for (const tag of ["script", "style", "iframe", "object", "embed", "form", "button", "textarea", "svg", "math", "template", "noscript"]) {
    assert.ok(!config.ALLOWED_TAGS.includes(tag), `${tag} 不该在白名单里`);
  }
  for (const tag of ["p", "code", "pre", "table", "img", "a"]) {
    assert.ok(config.ALLOWED_TAGS.includes(tag), `${tag} 是正常 markdown 该有的`);
  }
  assert.ok(!config.ALLOWED_ATTR.some(attr => attr.toLowerCase().startsWith("on")),
    "事件属性一个都不能在白名单里");
  // 展开一次：数组来自 vm 的 realm，跟这边的 Array 不是同一个构造函数
  assert.deepEqual([...config.FORBID_ATTR], ["style"]);
  assert.equal(config.ALLOW_DATA_ATTR, false);
  assert.equal(config.ALLOW_ARIA_ATTR, false);
  assert.equal(config.SANITIZE_NAMED_PROPS, true, "要挡 DOM clobbering");
});

test("URL 白名单放行相对路径，挡掉 javascript: 和 data:text/html", () => {
  const c = makeSanitizerContext();
  c.sanitizeRenderedHtml("<p/>");
  const allowlist = c.calls[0].config.ALLOWED_URI_REGEXP;

  for (const ok of [
    "https://example.com", "http://127.0.0.1:8080/x", "mailto:a@b.c", "tel:123",
    "file:///C:/notes/x.md", "/relative", "./relative", "#anchor", "relative/path",
  ]) {
    assert.ok(allowlist.test(ok), `应放行：${ok}`);
  }
  for (const bad of [
    "javascript:alert(1)", "vbscript:msgbox(1)", "data:text/html;base64,PHNjcmlwdD4=",
  ]) {
    assert.ok(!allowlist.test(bad), `应挡掉：${bad}`);
  }
});

test("净化 hook：只留高亮和待办的 class，input 只准是只读复选框", () => {
  const c = makeSanitizerContext();
  c.ensurePurifyHooks();
  const hook = c.hooks.find(h => h.name === "afterSanitizeAttributes")?.fn;
  assert.ok(hook, "afterSanitizeAttributes hook 没装上");

  const highlighted = fakeNode("CODE", { class: "language-js" });
  hook(highlighted);
  assert.equal(highlighted.attrs.class, "language-js", "高亮用的 class 要留着");

  const disguised = fakeNode("SPAN", { class: "msg-text system-notice" });
  hook(disguised);
  assert.equal(disguised.attrs.class, undefined, "借页面样式伪装成系统提示的要摘掉");

  const checkbox = fakeNode("INPUT", { type: "checkbox" });
  hook(checkbox);
  assert.equal(checkbox.removed, false, "GFM 待办列表的复选框要留着");
  assert.equal(checkbox.attrs.disabled, "", "但必须是只读的");

  const textbox = fakeNode("INPUT", { type: "text" });
  hook(textbox);
  assert.equal(textbox.removed, true, "能打字的输入框不该出现在回答里");
});

test("DOMPurify 没加载出来时退回纯文本，不把原始 HTML 放进 innerHTML", () => {
  const c = makeSanitizerContext({ withPurify: false });
  const out = c.sanitizeRenderedHtml('<img src=x onerror="alert(1)">');
  assert.match(out, /^<pre/, "没有净化器时只能当纯文本显示");
  assert.ok(!/<img/i.test(out), "原始标签必须被转义掉");
});

test("对话没记过厂商时不猜——宁可不续接，也不能把会话 id 写进错的槽", () => {
  const context = vm.createContext({
    convModelPrefs: new Map([
      ["conv-codex", { profileId: "p_codex" }],
      ["conv-orphan", { profileId: "p_deleted" }],
      ["conv-legacy", { model: "claude-opus-5" }],   // 加账号隔离之前存的，没有 profileId
    ]),
    _profileData: {
      profiles: [
        { id: "p_codex", provider: "codex" },
        { id: "p_claude", provider: "claude" },
      ],
    },
  });
  vm.runInContext(source("conversationRememberedProvider"), context);

  assert.equal(context.conversationRememberedProvider("conv-codex"), "codex");
  assert.equal(context.conversationRememberedProvider("conv-orphan"), null, "账号已删的记录不算数");
  assert.equal(context.conversationRememberedProvider("conv-legacy"), null, "没记 profileId 的不能猜");
  assert.equal(context.conversationRememberedProvider("conv-never-seen"), null);
  assert.equal(context.conversationRememberedProvider(null), null);
});

// ── 服务端 ────────────────────────────────────────────────

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function reservePort() {
  const server = createServer();
  await new Promise((resolve, reject) => server.listen(0, "127.0.0.1", resolve).once("error", reject));
  const { port } = server.address();
  await new Promise(resolve => server.close(resolve));
  return port;
}

test("对话页自己发 CSP 头——Tauri 那份管不到跨源 iframe", { timeout: 15_000 }, async () => {
  const scratch = await mkdtemp(join(tmpdir(), "inkfellow-csp-"));
  const authFile = join(scratch, "auth-profile.json");
  const port = await reservePort();
  const token = "offline-csp-test-token";
  await writeFile(authFile, JSON.stringify({
    activeProfileId: "p_claude",
    profiles: [{ id: "p_claude", name: "probe", provider: "claude", apiKey: "", baseUrl: "" }],
  }), "utf8");

  const child = spawn(process.execPath, ["server.js"], {
    cwd: new URL(".", import.meta.url),
    env: {
      ...process.env,
      PORT: String(port),
      HOST: "127.0.0.1",
      DESKTOP_AGENT_TOKEN: token,
      CLAUDE_CHAT_DATA_DIR: scratch,
      CLAUDE_CHAT_AUTH_PROFILE_FILE: authFile,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", chunk => { output += chunk; });
  child.stderr.on("data", chunk => { output += chunk; });

  try {
    const deadline = Date.now() + 5000;
    while (!output.includes("claude-chat listening")) {
      if (child.exitCode != null) throw new Error(`sidecar exited early (${child.exitCode}): ${output}`);
      if (Date.now() >= deadline) throw new Error(`sidecar did not start: ${output}`);
      await delay(20);
    }

    const res = await fetch(`http://127.0.0.1:${port}/?token=${encodeURIComponent(token)}`);
    assert.equal(res.status, 200);
    const csp = res.headers.get("content-security-policy");
    assert.ok(csp, "页面必须带 CSP 头");
    assert.match(csp, /script-src-attr 'none'/, "内联事件属性要堵死");
    assert.match(csp, /object-src 'none'/);
    assert.match(csp, /base-uri 'none'/);
    // 全部前端逻辑内联在 index.html 里，script-src 还去不掉 unsafe-inline
    assert.match(csp, /script-src 'self' 'unsafe-inline'/);
    // 主窗口用 iframe 套着这一页，写死祖先就是赌它的源，赌错整页白屏
    assert.ok(!/frame-ancestors/.test(csp), "不该写 frame-ancestors");
    await res.text();
  } finally {
    child.kill();
    await delay(100);
    await rm(scratch, { recursive: true, force: true });
  }
});
