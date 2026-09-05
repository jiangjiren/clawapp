import { execFile, spawn, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import * as provider from "./providers/antigravity.js";

const exec = promisify(execFile);
const children = new Set();
function kill(proc) {
  if (!proc.pid) return;
  try {
    if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(proc.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
    else process.kill(-proc.pid, "SIGKILL");
  } catch { try { proc.kill("SIGKILL"); } catch { /* Already exited. */ } }
}
process.once("exit", () => { for (const proc of children) kill(proc); });
for (const [signal, code] of [["SIGINT", 130], ["SIGTERM", 143]]) {
  process.once(signal, () => { for (const proc of children) kill(proc); process.exit(code); });
}

let catalogRequest = null;
let checkedAt = 0;
let health = { installed: false, ready: false, message: "尚未检测 Antigravity CLI" };
export async function getCatalog({ force = false } = {}) {
  if (catalogRequest) return catalogRequest;
  if (!force && Date.now() - checkedAt < (health.ready ? 6 * 3600_000 : 60_000)) return catalogSnapshot();
  catalogRequest = (async () => {
    const binary = provider.findBinary();
    health = { installed: !!binary, ready: false, message: "请安装 Antigravity CLI，并在服务运行用户下登录；可用 AGY_BIN 指定路径。" };
    try {
      if (!binary) return catalogSnapshot();
      const options = { timeout: 45_000, maxBuffer: 1024 * 1024, windowsHide: true, env: { ...process.env, NO_COLOR: "1" } };
      const help = await exec(binary, ["--help"], options);
      if (!["--output-format", "--mode", "--effort"].every(flag => (help.stdout + help.stderr).includes(flag))) {
        health.message = "Antigravity CLI 版本不支持流式接口，请运行 agy update 后重试。";
        return catalogSnapshot();
      }
      const { stdout } = await exec(binary, ["models"], options);
      const models = provider.parseModelsList(stdout);
      if (!models?.length) throw new Error("CLI 未返回可用模型，请先运行 agy 完成登录。");
      provider.setCatalog(models);
      health = { installed: true, ready: true, message: "CLI 可用，已读取模型目录" };
    } catch (err) {
      health.message = String(err.stderr || err.message).slice(0, 600);
    } finally { checkedAt = Date.now(); }
    return catalogSnapshot();
  })().finally(() => { catalogRequest = null; });
  return catalogRequest;
}
export function catalogSnapshot() {
  return { ...health, live: provider.hasLiveCatalog(), models: provider.menuModels(), efforts: Object.fromEntries(provider.getCatalog().map(m => [m.model, m.efforts])) };
}

let usageRequest = null;
let usageCheckedAt = 0;
let usage = { status: "idle", available: false };
export function getUsage() {
  if (!usageRequest && Date.now() - usageCheckedAt > 240_000) {
    usage = { ...usage, status: usage.available ? "ok" : "loading" };
    usageRequest = (async () => {
      try {
        const state = await getCatalog();
        if (!state.ready) throw new Error(state.message);
        const { stdout } = await exec(provider.findBinary(), ["-p", "/usage", "--output-format", "json"], {
          timeout: 45_000, maxBuffer: 1024 * 1024, windowsHide: true, env: { ...process.env, NO_COLOR: "1" },
        });
        const groups = provider.parseUsage(stdout);
        if (!groups) throw new Error("CLI 未返回可查询的额度");
        usage = { status: "ok", available: true, groups, updatedAt: new Date().toISOString() };
      } catch (err) {
        usage = { ...usage, status: "error", message: String(err.stderr || err.message).slice(0, 600) };
      } finally { usageCheckedAt = Date.now(); usageRequest = null; }
    })();
  }
  return usage;
}

export function resolveModel(requested) {
  const fallback = provider.menuModels()[0]?.model;
  if (provider.getCatalog().some(entry => entry.model === requested)) return requested;
  return provider.successorFor(requested || "") || fallback;
}

// Each invocation owns its child and temporary files. Resume IDs come from the
// conversation's event log, never a process-global "most recent" CLI session.
export async function runAntigravity({ prompt, images = [], cwd, model, effort, permissionMode, resumeConversationId, signal, onEvent, onSession }) {
  signal?.throwIfAborted();
  const status = await getCatalog();
  signal?.throwIfAborted();
  if (!status.ready) throw new Error(status.message);
  const tempDir = mkdtempSync(join(tmpdir(), "claw-agy-"));
  try {
    let text = String(prompt || "");
    const paths = images.map((img, i) => {
      const ext = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif" }[img.mediaType] || "png";
      const path = join(tempDir, `image-${i}.${ext}`);
      writeFileSync(path, Buffer.from(img.data, "base64"), { mode: 0o600 });
      return path;
    });
    if (paths.length) text = `请先读取用户附图：\n${paths.join("\n")}\n\n${text}`;
    if (Buffer.byteLength(text) > 12000) {
      const path = join(tempDir, "prompt.md");
      writeFileSync(path, text, { mode: 0o600 });
      text = `用户的完整输入位于 ${path}，请先读取全文，再完成请求。`;
    }
    const args = ["-p", text, "--output-format", "stream-json", "--mode", provider.modeFlag(permissionMode), "--print-timeout", process.env.AGY_PRINT_TIMEOUT || "24h", "--add-dir", cwd];
    // Only the user's explicit unrestricted mode may auto-approve all tools.
    // Other modes retain the CLI sandbox; plan also limits the agent to planning.
    if (permissionMode === "bypassPermissions") args.push("--dangerously-skip-permissions");
    else args.push("--sandbox");
    if (paths.length || text.includes(tempDir)) args.push("--add-dir", tempDir);
    if (model) args.push("--model", model);
    const mappedEffort = provider.effortForModel(model, effort);
    if (mappedEffort) args.push("--effort", mappedEffort);
    if (resumeConversationId) args.push("--conversation", resumeConversationId);
    return await new Promise((resolve, reject) => {
      const proc = spawn(provider.findBinary(), args, { cwd, detached: process.platform !== "win32", windowsHide: true, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, PWD: cwd, NO_COLOR: "1", TERM: "dumb" } });
      children.add(proc);
      let buffer = "", stderr = "", result = null, conversationId = resumeConversationId, failure = null;
      const abort = () => kill(proc);
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
      function parse(line) {
        if (!line.trim()) return;
        let ev;
        try { ev = JSON.parse(line); } catch { return; }
        const id = ev.init?.conversation_id || ev.result?.conversation_id || ev.step_update?.conversation_id;
        if (id && id !== conversationId) { conversationId = id; onSession?.(id); }
        if (ev.event === "result") result = ev.result;
        onEvent?.(ev);
      }
      proc.stdout.setEncoding("utf8");
      proc.stdout.on("data", chunk => {
        try {
          buffer += chunk;
          let idx;
          while ((idx = buffer.indexOf("\n")) >= 0) { parse(buffer.slice(0, idx)); buffer = buffer.slice(idx + 1); }
          if (buffer.length > 8 * 1024 * 1024) throw new Error("Antigravity 事件超过大小限制");
        } catch (err) { failure = err; kill(proc); }
      });
      proc.stderr.setEncoding("utf8");
      proc.stderr.on("data", chunk => { stderr = (stderr + chunk).slice(-16000); });
      proc.on("error", err => { failure = err; });
      proc.on("close", code => {
        children.delete(proc);
        signal?.removeEventListener("abort", abort);
        try {
          if (signal?.aborted) throw Object.assign(new Error("Antigravity 请求已取消"), { name: "AbortError" });
          if (failure) throw failure;
          parse(buffer);
          if (code !== 0 || result?.status !== "SUCCESS") throw new Error(String(result?.error || stderr.trim() || result?.response || `Antigravity 未正常完成（退出码 ${code}）`));
          resolve({ conversationId, text: result.response || "", usage: result.usage || null });
        } catch (err) { reject(err); }
      });
    });
  } finally { rmSync(tempDir, { recursive: true, force: true }); }
}
