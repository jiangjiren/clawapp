/**
 * 厂商名称和额度面板的文案约定。
 *
 * 这几条跟「AI 对话那批修复」无关，是账号面板那一轮改动留下的，原先误放在
 * ai-chat-fixes.test.js 里。文案本身没有可执行的逻辑，源码断言是这里能做到的
 * 最好的一档——但至少别混在别的主题里。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const html = await readFile(new URL("./public/index.html", import.meta.url), "utf8");
const server = await readFile(new URL("./server.js", import.meta.url), "utf8");

test("Codex 会员文案改为 ChatGPT，且保留用户自定义账号名", () => {
  assert.match(server, /const CODEX_PROFILE_NAME = "ChatGPT 会员"/);
  assert.match(server, /normalizeCodexProfileName/);
  assert.match(server, /LEGACY_CODEX_PROFILE_NAMES/);
  assert.doesNotMatch(server, /name: "Codex（GPT 会员）"/);
  assert.doesNotMatch(server, /name: "GPT（Codex 会员）"/);
});

test("会员额度使用用户可读的窗口名称并带独立说明行", () => {
  assert.match(html, /codex: "ChatGPT"/);
  assert.match(html, /auth-limit-summary/);
  assert.match(html, /额度剩余：/);
  assert.match(html, /label === "5h" \? "5小时"/);
  assert.match(html, /label === "周" \? "7天"/);
  assert.match(html, /后重置/);
});
