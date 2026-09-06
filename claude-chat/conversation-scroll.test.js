import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const html = await readFile(new URL("./public/index.html", import.meta.url), "utf8");

test("切换对话时消息区即时恢复原滚动位置", () => {
  const messagesRule = html.match(/#messages\s*\{([\s\S]*?)\}/)?.[1] ?? "";

  assert.match(messagesRule, /scroll-behavior:\s*auto\s*;/);
  assert.doesNotMatch(messagesRule, /scroll-behavior:\s*smooth\s*;/);
  assert.match(html, /scrollTop:\s*messagesEl\.scrollTop/);
  assert.match(html, /messagesEl\.scrollTop\s*=\s*cached\.scrollTop\s*\|\|\s*0/);
});
