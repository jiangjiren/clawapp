import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
const status = vm.runInNewContext(readFileSync(new URL("public/account-status.js", import.meta.url), "utf8") + "; accountStatus");
test("Codex shows the reported plan and does not assume Plus", () => {
  assert.equal(status({ provider: "codex" }, { codexAuth: true }).text, "已登录");
  assert.equal(status({ provider: "codex" }, { codexAuth: true, limits: { codex: { planType: "pro" } } }).text, "已登录 · Pro");
});
test("expired credentials override the presence of a local login file", () => {
  assert.equal(status({ provider: "codex" }, { codexAuth: true, limits: { codex: { status: "expired" } } }).text, "登录已失效");
  assert.equal(status({ provider: "codex" }, { codexAuth: true, limits: { codex: { status: "error" } } }).text, "已登录");
});
test("Claude plan, missing auth, and Antigravity capability are distinct", () => {
  assert.equal(status({ provider: "claude" }, { claudeAuth: true, limits: { claude: { subscriptionType: "max_5x" } } }).text, "已登录 · Max 5x");
  assert.equal(status({ provider: "claude" }, { claudeAuth: false }).text, "未检测到登录");
  assert.equal(status({ provider: "antigravity" }, { agy: { ready: true } }).text, "CLI 可用");
});
