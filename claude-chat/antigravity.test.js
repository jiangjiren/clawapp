import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import * as provider from "./providers/antigravity.js";
import { getCatalog, runAntigravity } from "./antigravity-runtime.js";

test("model catalog merges efforts, keeps the latest menu version and maps effort safely", () => {
  const catalog = provider.parseModelsList("Fetching...\ngemini-3.1-pro-high\tGemini Pro (High)\ngemini-3.1-pro-low\tGemini Pro (Low)\nclaude-sonnet-4-6\tClaude Sonnet\n");
  provider.setCatalog(catalog);
  assert.equal(catalog.length, 2);
  assert.equal(provider.effortForModel("gemini-3.1-pro", "medium"), "low");
  assert.equal(provider.effortForModel("gemini-3.1-pro", "max"), "high");
  assert.equal(provider.effortForModel("claude-sonnet-4-6", "high"), null);
  assert.equal(provider.parseModelsList("Login required"), null);
  provider._resetCatalog();
});

test("text and tool steps produce persistent messages and settle the matching tool", () => {
  const translate = provider.createTranslator();
  const step = data => translate({ event: "step_update", step_update: data });
  const text = step({ step_index: 0, step_type: "agent_response", text_delta: "你好", state: "ACTIVE" });
  assert.ok(text.some(e => e.event?.delta?.text === "你好"));
  assert.equal(step({ step_index: 0, step_type: "agent_response", state: "DONE" }).at(-1).message.content[0].text, "你好");
  const tool = { step_index: 1, step_type: "tool", tool_name: "view_file", state: "ACTIVE", tool_info: { parameters: { AbsolutePath: "/tmp/test.md" } } };
  const start = step(tool)[0];
  assert.equal(start.name, "Read");
  assert.equal(start.input.file_path, "/tmp/test.md");
  assert.deepEqual(step(tool), []);
  const done = step({ ...tool, state: "DONE", tool_info: { output: "file text" } });
  assert.equal(done[0].message.content[0].tool_use_id, start.id);
  assert.equal(done[1].message.content[0].tool_use_id, start.id);
});

test("usage keeps independent pools and ignores missing percentages", () => {
  const groups = provider.parseUsage(JSON.stringify({ command: { data: { groups: [
    { buckets: [{ id: "gemini-5h", window: "5h", remaining_fraction: 0.75 }] },
    { buckets: [{ id: "3p-weekly", window: "weekly", remaining_fraction: 0.2 }] },
    { buckets: [{ id: "gemini-5h", window: "5h", remaining_fraction: null }] },
  ] } } }));
  assert.equal(groups.length, 2);
  assert.equal(groups[0].fiveHour.remainingPercent, 75);
  assert.equal(groups[1].week.usedPercent, 80);
});

test("CLI runner resumes explicitly, parses final lines, rejects incomplete runs, and aborts", async () => {
  const dir = mkdtempSync(join(tmpdir(), "claw-agy-test-"));
  const binary = join(dir, "agy");
  const original = process.env.AGY_BIN;
  writeFileSync(binary, `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
if(args.includes('--help')) { console.log('--output-format --mode --effort'); process.exit(0); }
if(args[0]==='models') { console.log('gemini-3.1-pro-low\\tGemini Pro (Low)'); process.exit(0); }
fs.writeFileSync(${JSON.stringify(join(dir, "args.json"))}, JSON.stringify(args));
const prompt=args[args.indexOf('-p')+1];
if(prompt==='hang') {setInterval(()=>{},1000);}
else if(prompt==='empty') { process.exit(0); }
else if(prompt==='fail') { process.stdout.write(JSON.stringify({event:'result',result:{status:'ERROR',error:'quota exhausted'}})); }
else { console.log(JSON.stringify({event:'init',init:{conversation_id:'session-one'}})); process.stdout.write(JSON.stringify({event:'result',result:{status:'SUCCESS',response:'OK'}})); }
`, { mode: 0o700 });
  process.env.AGY_BIN = binary;
  provider._resetBinaryCache();
  try {
    assert.equal((await getCatalog({ force: true })).ready, true);
    const options = { prompt: "hello", cwd: dir, model: "gemini-3.1-pro", effort: "medium", permissionMode: "plan", resumeConversationId: "old-session" };
    const sessions = [];
    assert.equal((await runAntigravity({ ...options, onSession: id => sessions.push(id) })).text, "OK");
    assert.deepEqual(sessions, ["session-one"]);
    const args = JSON.parse(readFileSync(join(dir, "args.json")));
    assert.equal(args[args.indexOf("--conversation") + 1], "old-session");
    assert.ok(args.includes("--sandbox"));
    assert.ok(!args.includes("--dangerously-skip-permissions"));
    assert.equal(args[args.indexOf("--effort") + 1], "low");
    await assert.rejects(runAntigravity({ ...options, prompt: "empty" }), /未正常完成/);
    await assert.rejects(runAntigravity({ ...options, prompt: "fail" }), /quota exhausted/);
    await assert.rejects(runAntigravity({ ...options, prompt: "hang", signal: AbortSignal.timeout(150) }), { name: "AbortError" });
    await assert.rejects(runAntigravity({ ...options, signal: AbortSignal.abort() }), { name: "AbortError" });
  } finally {
    if (original === undefined) delete process.env.AGY_BIN; else process.env.AGY_BIN = original;
    provider._resetBinaryCache();
    provider._resetCatalog();
    rmSync(dir, { recursive: true, force: true });
  }
});
