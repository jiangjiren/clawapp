import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { WebSocket } from "ws";

test("Antigravity WebSocket turns persist, resume by conversation, recover, and stop", { timeout: 20000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "claw-agy-integration-"));
  const binary = join(dir, "agy");
  const log = join(dir, "calls.jsonl");
  mkdirSync(join(dir, "vault"));
  writeFileSync(binary, `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
if(args.includes('--help')) {console.log('--output-format --mode --effort');process.exit(0);}
if(args[0]==='models') {console.log('gemini-3.1-pro-low\\tGemini Pro (Low)');process.exit(0);}
fs.appendFileSync(${JSON.stringify(log)},JSON.stringify(args)+'\\n');
const prompt=args[args.indexOf('-p')+1];
const emit=e=>console.log(JSON.stringify(e));
emit({event:'init',init:{conversation_id:args.includes('--conversation')?args[args.indexOf('--conversation')+1]:'session-'+prompt}});
if(prompt==='hang') {setInterval(()=>{},1000);}
else {
emit({event:'step_update',step_update:{step_index:0,step_type:'agent_response',state:'DONE',text_delta:'Reply '+prompt}});
emit({event:'result',result:{status:'SUCCESS',response:'Reply '+prompt}});
}
`, { mode: 0o700 });
  const reservation = createServer();
  reservation.listen(0, "127.0.0.1");
  await once(reservation, "listening");
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  const proc = spawn(process.execPath, ["server.js"], {
    cwd: new URL(".", import.meta.url),
    env: { ...process.env, HOME: dir, PORT: String(port), HOST: "127.0.0.1", VAULT_PATH: join(dir, "vault"), CLAUDE_CHAT_DATA_DIR: join(dir, "data"), CLAUDE_CHAT_AUTH_PROFILE_FILE: join(dir, "profiles.json"), AGY_BIN: binary },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  proc.stdout.on("data", chunk => { output += chunk; });
  proc.stderr.on("data", chunk => { output += chunk; });
  const sockets = [];
  const base = `http://127.0.0.1:${port}`;
  async function connect() {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    sockets.push(ws);
    await once(ws, "open");
    return ws;
  }
  async function sendUntil(ws, payload, type) {
    const events = [];
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { ws.off("message", receive); reject(new Error(`Missing ${type}: ${JSON.stringify(events)}\n${output}`)); }, 5000);
      function receive(raw) {
        const ev = JSON.parse(raw);
        events.push(ev);
        if (ev.type === type) { clearTimeout(timer); ws.off("message", receive); resolve(events); }
      }
      ws.on("message", receive);
      ws.send(JSON.stringify(payload));
    });
  }
  try {
    for (let i = 0; i < 100; i++) {
      try { if ((await fetch(base + "/api/profiles")).status) break; } catch { /* Starting. */ }
      if (proc.exitCode !== null) throw new Error(output);
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.equal((await (await fetch(base + "/api/agy/models")).json()).ready, true);
    const ws = await connect();
    let n = 0;
    const turn = (conversationId, prompt) => ({ conversationId, prompt, profileId: "p_antigravity", model: "gemini-3.1-pro", permissionMode: "plan", userMessageId: `user-${++n}` });
    const first = await sendUntil(ws, turn("conv-a", "first"), "done");
    assert.ok(!first.some(e => e.type === "error"), JSON.stringify(first));
    assert.ok(first.some(e => e.type === "assistant"));
    const history = await (await fetch(base + "/api/history/conv-a")).json();
    assert.equal(history.sessionProvider, "antigravity");
    assert.equal(history.profileId, "p_antigravity");
    assert.ok(JSON.stringify(history).includes("Reply first"));
    await sendUntil(ws, turn("conv-a", "second"), "done");
    await sendUntil(ws, turn("conv-b", "other"), "done");
    const calls = readFileSync(log, "utf8").trim().split("\n").map(JSON.parse);
    assert.ok(!calls[0].includes("--conversation"));
    assert.equal(calls[1][calls[1].indexOf("--conversation") + 1], "session-first");
    assert.ok(!calls[2].includes("--conversation"));
    await sendUntil(ws, turn("conv-c", "hang"), "session");
    ws.close();
    const reconnected = await connect();
    const synced = await sendUntil(reconnected, { type: "hello", conversationId: "conv-c", lastSeq: 0 }, "sync");
    assert.ok(JSON.stringify(synced).includes("session-hang"));
    await sendUntil(reconnected, { stop: true }, "stopped");
    const stopped = await (await fetch(base + "/api/history/conv-c")).json();
    assert.equal(stopped.sessionProvider, "antigravity");
  } finally {
    for (const ws of sockets) ws.terminate();
    proc.kill("SIGTERM");
    await once(proc, "close");
    rmSync(dir, { recursive: true, force: true });
  }
});
