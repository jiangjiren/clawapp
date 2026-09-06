import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
let launcher;

export function prepareHiddenConsole() {
  if (process.platform !== "win32") return null;
  if (launcher) return launcher;
  const bundled = join(here, "native", "hidden-console.exe");
  if (existsSync(bundled)) return (launcher = bundled);
  const source = join(here, "native", "hidden-console.cs");
  const hash = createHash("sha256").update(readFileSync(source)).digest("hex").slice(0, 16);
  const directory = join(tmpdir(), "inkfellow-hidden-console", hash);
  const output = join(directory, "hidden-console.exe");
  if (!existsSync(output)) {
    mkdirSync(directory, { recursive: true });
    const pending = join(directory, `hidden-console-${process.pid}.exe`);
    const compiler = join(process.env.SystemRoot || "C:\\Windows", "Microsoft.NET", "Framework64", "v4.0.30319", "csc.exe");
    const result = spawnSync(compiler, ["/nologo", "/target:exe", "/optimize+", `/out:${pending}`, source],
      { windowsHide: true, encoding: "utf8" });
    if (result.error || result.status !== 0) {
      throw new Error(`无法准备隐藏控制台：${result.error?.message || result.stdout || result.stderr}`);
    }
    try { renameSync(pending, output); }
    catch (error) {
      if (!existsSync(output)) throw error;
      unlinkSync(pending);
    }
  }
  launcher = output;
  return launcher;
}

export function spawnWithHiddenConsole(binary, args, options = {}) {
  const executable = prepareHiddenConsole();
  return spawn(executable || binary, executable ? [binary, ...args] : args, {
    ...options,
    windowsHide: true,
  });
}
