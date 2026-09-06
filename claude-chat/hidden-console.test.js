import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnWithHiddenConsole } from "./hidden-console.js";

test("Windows launcher preserves pipes, arguments, cwd, env and exit code with hidden inherited console", {
  skip: process.platform !== "win32", timeout: 30000,
}, async () => {
  const folder = mkdtempSync(join(tmpdir(), "inkfellow console test "));
  try {
    const source = join(folder, "probe.cs");
    const binary = join(folder, "probe.exe");
    writeFileSync(source, `
using System;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
class Probe {
  [DllImport("kernel32.dll")] static extern IntPtr GetConsoleWindow();
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr window);
  static int Main(string[] args) {
    var console = GetConsoleWindow();
    Console.WriteLine("console:" + (console != IntPtr.Zero) + ":" + IsWindowVisible(console));
    if (args.Length == 1 && args[0] == "child") return 0;
    foreach (var arg in args) Console.WriteLine("arg:" + Convert.ToBase64String(Encoding.UTF8.GetBytes(arg)));
    Console.WriteLine("cwd:" + Environment.CurrentDirectory);
    Console.WriteLine("env:" + Environment.GetEnvironmentVariable("INK_CONSOLE_TEST"));
    Console.WriteLine("input:" + Console.ReadLine());
    Console.Error.WriteLine("stderr preserved");
    var info = new ProcessStartInfo(System.Reflection.Assembly.GetExecutingAssembly().Location, "child");
    info.UseShellExecute = false;
    info.RedirectStandardOutput = true;
    var child = Process.Start(info);
    Console.Write(child.StandardOutput.ReadToEnd());
    child.WaitForExit();
    return 17;
  }
}`);
    const compiler = join(process.env.SystemRoot, "Microsoft.NET", "Framework64", "v4.0.30319", "csc.exe");
    const build = spawnSync(compiler, ["/nologo", `/out:${binary}`, source], { windowsHide: true, encoding: "utf8" });
    assert.equal(build.status, 0, build.stdout + build.stderr);
    const args = ["", "two words", '中文 \"引号\"', "C:\\a b\\", "a\\\"b", "line1\nline2", "& %PATH% $() `"];
    const proc = spawnWithHiddenConsole(binary, args, { cwd: folder, env: { ...process.env, INK_CONSOLE_TEST: "present" } });
    let stdout = "", stderr = "";
    proc.stdout.on("data", chunk => { stdout += chunk; });
    proc.stderr.on("data", chunk => { stderr += chunk; });
    proc.stdin.end("pipe input\n");
    const code = await new Promise((resolve, reject) => { proc.once("error", reject); proc.once("close", resolve); });
    assert.equal(code, 17, stderr);
    assert.equal(stderr.trim(), "stderr preserved");
    assert.equal((stdout.match(/console:True:False/g) || []).length, 2, stdout);
    for (const arg of args) assert.ok(stdout.includes("arg:" + Buffer.from(arg).toString("base64") + "\r\n"), stdout);
    assert.ok(stdout.includes("cwd:" + folder), stdout);
    assert.ok(stdout.includes("env:present"), stdout);
    assert.ok(stdout.includes("input:pipe input"), stdout);
  } finally { rmSync(folder, { recursive: true, force: true }); }
});
