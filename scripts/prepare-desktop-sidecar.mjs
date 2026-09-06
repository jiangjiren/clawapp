import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { prepareHiddenConsole } from "../claude-chat/hidden-console.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.resolve(__dirname, "..");
const source = path.join(root, "claude-chat");
const targetRoot = path.join(root, "desktop-bundle");
const target = path.join(targetRoot, "claude-chat");
const nodeRuntimeTarget = path.join(
  root,
  "src-tauri",
  "bin",
  process.platform === "win32" ? "node.exe" : "node"
);

const excludedNames = new Set([
  ".env",
  "auth-profile.json",
  "session.json",
  "history.json",
  "data",
  "node_modules",
]);

function copyRecursive(from, to) {
  const stat = fs.statSync(from);
  const name = path.basename(from);
  if (excludedNames.has(name) || name.endsWith(".test.js")) {
    return;
  }

  if (stat.isDirectory()) {
    fs.mkdirSync(to, { recursive: true });
    for (const entry of fs.readdirSync(from)) {
      copyRecursive(path.join(from, entry), path.join(to, entry));
    }
    return;
  }

  if (stat.isFile()) {
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(from, to);
  }
}

function prepareNodeRuntime() {
  const nodeRuntimeSource = process.execPath;

  if (process.platform === "win32") {
    if (!nodeRuntimeSource.toLowerCase().endsWith("node.exe")) {
      throw new Error(`Cannot locate Windows node.exe from current runtime: ${nodeRuntimeSource}`);
    }
  }

  fs.mkdirSync(path.dirname(nodeRuntimeTarget), { recursive: true });
  fs.copyFileSync(nodeRuntimeSource, nodeRuntimeTarget);
  if (process.platform !== "win32") {
    fs.chmodSync(nodeRuntimeTarget, 0o755);
  }
  console.log(`[desktop] prepared Node runtime at ${path.relative(root, nodeRuntimeTarget)}`);
}

function installSidecarDependencies() {
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  const hasLockfile = fs.existsSync(path.join(target, "package-lock.json"));
  const args = hasLockfile ? ["ci", "--omit=dev"] : ["install", "--omit=dev"];

  console.log(`[desktop] installing claude-chat production dependencies: ${npm} ${args.join(" ")}`);
  const result = spawnSync(npm, args, {
    cwd: target,
    stdio: "inherit",
    shell: process.platform === "win32",
  });

  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`Failed to install claude-chat production dependencies (exit ${result.status})`);
  }
}

if (!fs.existsSync(source)) {
  throw new Error(`claude-chat source not found: ${source}`);
}

if (!fs.existsSync(path.join(source, "package.json"))) {
  throw new Error(`claude-chat package.json not found: ${source}`);
}

prepareNodeRuntime();

fs.rmSync(targetRoot, { recursive: true, force: true });
copyRecursive(source, target);
const hiddenConsole = prepareHiddenConsole();
if (hiddenConsole) {
  fs.copyFileSync(hiddenConsole, path.join(target, "native", "hidden-console.exe"));
}
installSidecarDependencies();

console.log(`[desktop] prepared claude-chat sidecar at ${path.relative(root, target)}`);
