import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const HERE = new URL(".", import.meta.url);
const EXPECTED_CODEX_MODELS = {
  opusModel: "gpt-5.6-sol",
  sonnetModel: "gpt-5.6-terra",
  haikuModel: "gpt-5.6-luna",
};

test("Codex 服务端默认模型与前端模型说明保持为 GPT-5.6 三档", async () => {
  const [serverSource, frontendSource] = await Promise.all([
    readFile(new URL("server.js", HERE), "utf8"),
    readFile(new URL("public/index.html", HERE), "utf8"),
  ]);

  for (const [tier, model] of Object.entries(EXPECTED_CODEX_MODELS)) {
    assert.match(serverSource, new RegExp(`${tier}: "${model.replaceAll(".", "\\.")}"`));
    assert.match(frontendSource, new RegExp(`"${model.replaceAll(".", "\\.")}"`));
  }
});

test("Codex 没有可用的历史选择时默认回落到均衡档", async () => {
  const frontendSource = await readFile(new URL("public/index.html", HERE), "utf8");
  assert.match(frontendSource, /activeProfile\?\.sonnetModel \|\| options\[0\]\.model/);
});

test("额度展示只渲染接口实际返回的窗口", async () => {
  const frontendSource = await readFile(new URL("public/index.html", HERE), "utf8");
  assert.match(frontendSource, /\.filter\(item => item\.value\?\.usedPercent != null\)/);
  assert.match(frontendSource, /\.map\(item => renderLimitWindow\(item\.label, item\.value, item\.resetFormat\)\)/);
  assert.doesNotMatch(
    frontendSource,
    /const html = `\$\{renderLimitWindow\("5h"[\s\S]*renderLimitWindow\("周"/,
  );
});
