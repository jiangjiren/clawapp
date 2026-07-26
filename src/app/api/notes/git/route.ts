import { NextResponse } from "next/server";
import { execFile } from "child_process";
import { promisify } from "util";
import { readFile } from "fs/promises";
import path from "path";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const execFileAsync = promisify(execFile);
const DEFAULT_VAULT_PATH = path.join(process.cwd(), "vault");
const VAULT = path.resolve(process.env.VAULT_PATH?.trim() || DEFAULT_VAULT_PATH);
const GIT_PUSH_TARGET = process.env.NOTES_GIT_PUSH_TARGET?.trim() || "HEAD:main";
const GIT_COMMIT_USER_NAME = process.env.GIT_COMMIT_USER_NAME?.trim() || "Inkfellow Web";
const GIT_COMMIT_USER_EMAIL = process.env.GIT_COMMIT_USER_EMAIL?.trim() || "web-editor@inkfellow.local";

const BINARY_EXTENSIONS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".avif", ".svg",
  ".pdf", ".zip", ".tar", ".gz", ".mp4", ".mp3", ".base",
]);

async function git(args: string[], options: { trimStdout?: boolean } = {}) {
  const { stdout, stderr } = await execFileAsync("git", [
    "-C", VAULT,
    "-c", "core.quotepath=false",
    "-c", `user.name=${GIT_COMMIT_USER_NAME}`,
    "-c", `user.email=${GIT_COMMIT_USER_EMAIL}`,
    ...args,
  ], {
    timeout: 30_000,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    maxBuffer: 20 * 1024 * 1024,
  });
  return {
    stdout: options.trimStdout === false ? stdout : stdout.trim(),
    stderr: stderr.trim(),
  };
}

const sanitizeGitPath = (input: string) => {
  const normalized = path.posix.normalize(input.replace(/\\/g, "/").replace(/^\/+/, "").trim());
  if (!normalized || normalized === "." || normalized.includes("\0")) {
    throw new Error("Invalid file path.");
  }

  if (normalized.split("/").some((segment) => segment === ".." || segment === "")) {
    throw new Error("Path traversal is not allowed.");
  }

  return normalized;
};

const resolveVaultFile = (input: string) => {
  const cleanPath = sanitizeGitPath(input);
  const absolutePath = path.resolve(VAULT, cleanPath);
  const relativeFromVault = path.relative(VAULT, absolutePath);
  if (relativeFromVault.startsWith("..") || path.isAbsolute(relativeFromVault)) {
    throw new Error("Path traversal is not allowed.");
  }

  return { cleanPath, absolutePath };
};

const countLines = async (absolutePath: string) => {
  const content = await readFile(absolutePath);
  if (content.length === 0) return 0;

  let count = 1;
  for (const byte of content) {
    if (byte === 10) count += 1;
  }

  return count;
};

type FileStatus = {
  name: string;
  path: string;
  state: "modified" | "added" | "deleted" | "renamed";
  kind?: "file" | "folder";
};

export type DiffLine = {
  type: "add" | "remove" | "context" | "hunk";
  content: string;
};

export type FileDiff = {
  path: string;
  binary: boolean;
  lines: DiffLine[];
  addCount: number;
  removeCount: number;
};

function parseDiff(raw: string): DiffLine[] {
  const lines: DiffLine[] = [];
  for (const line of raw.split("\n")) {
    // skip --- +++ diff headers
    if (line.startsWith("--- ") || line.startsWith("+++ ") || line.startsWith("diff ") || line.startsWith("index ")) continue;
    if (line.startsWith("\\")) continue;
    if (line.startsWith("@@")) {
      // human-friendly hunk header: show line range
      const match = line.match(/@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      if (match) {
        lines.push({ type: "hunk", content: `第 ${match[2]} 行` });
      }
      continue;
    }
    if (line.startsWith("+")) {
      lines.push({ type: "add", content: line.slice(1) });
    } else if (line.startsWith("-")) {
      lines.push({ type: "remove", content: line.slice(1) });
    } else {
      lines.push({ type: "context", content: line.slice(1) });
    }
  }
  return lines;
}

// GET — status list, diff, stats, or history
export async function GET(req: Request) {
  const url = new URL(req.url);
  const diffPath = url.searchParams.get("diff");

  // ── Per-file add/remove counts (numstat) ───────────────────
  if (url.searchParams.get("stats") === "true") {
    try {
      await git(["rev-parse", "--git-dir"]);
      const stats: Record<string, { added: number; removed: number }> = {};

      // 已追踪文件的改动行数（对比 HEAD）
      const { stdout: trackedStats } = await git(["diff", "--numstat", "HEAD"]);
      for (const line of trackedStats.split("\n").filter(Boolean)) {
        const parts = line.split("\t");
        if (parts.length < 3) continue;
        const added   = parseInt(parts[0] ?? "0", 10) || 0;
        const removed = parseInt(parts[1] ?? "0", 10) || 0;
        const filePath = parts[2] ?? "";
        if (filePath) stats[filePath] = { added, removed };
      }

      // 新增未追踪文件/目录的行数（git diff 不会显示这些）
      const { stdout: untrackedOut } = await git(["ls-files", "--others", "--exclude-standard"]);
      for (const filePath of untrackedOut.split("\n").filter(Boolean)) {
        if (filePath in stats) continue;
        try {
          const { absolutePath } = resolveVaultFile(filePath);
          const ext = path.extname(filePath).toLowerCase();
          const lineCount = BINARY_EXTENSIONS.has(ext) ? 0 : await countLines(absolutePath);
          // 目录级 key（去掉文件名，用目录路径匹配）
          const dir = filePath.includes("/")
            ? filePath.split("/").slice(0, -1).join("/")
            : "";
          stats[filePath] = { added: lineCount, removed: 0 };
          if (dir) {
            stats[dir] = {
              added: (stats[dir]?.added ?? 0) + lineCount,
              removed: stats[dir]?.removed ?? 0,
            };
          }
        } catch { /* skip unreadable */ }
      }

      return NextResponse.json({ stats });
    } catch {
      return NextResponse.json({ stats: {} });
    }
  }

  // ── Commit history ─────────────────────────────────────────
  if (url.searchParams.get("history") === "true") {
    try {
      await git(["rev-parse", "--git-dir"]);
      // Use a safe separator that won't appear in messages
      const { stdout } = await git(
        ["log", "--pretty=format:%H\x1f%s\x1f%an\x1f%cd", "--date=format:%Y-%m-%d %H:%M", "-30"],
      );
      const history = stdout
        .split("\n")
        .filter(Boolean)
        .map((line) => {
          const [hash, message, author, date] = line.split("\x1f");
          return {
            hash:    (hash ?? "").slice(0, 7),
            message: message ?? "",
            author:  author ?? "",
            date:    date ?? "",
          };
        });
      return NextResponse.json({ history });
    } catch {
      return NextResponse.json({ history: [] });
    }
  }

  // ── Single file changed check (lightweight) ───────────────
  const checkPath = url.searchParams.get("check");
  if (checkPath) {
    try {
      await git(["rev-parse", "--git-dir"]);
      const { cleanPath } = resolveVaultFile(checkPath);
      const { stdout } = await git(["status", "--porcelain", "--", cleanPath], { trimStdout: false });
      return NextResponse.json({ changed: stdout.trim().length > 0 });
    } catch {
      return NextResponse.json({ changed: false });
    }
  }

  // ── Single file diff ───────────────────────────────────────
  if (diffPath) {
    try {
      await git(["rev-parse", "--git-dir"]);
      const { cleanPath: cleanDiffPath, absolutePath } = resolveVaultFile(diffPath);

      const ext = path.extname(cleanDiffPath).toLowerCase();
      if (BINARY_EXTENSIONS.has(ext)) {
        return NextResponse.json({ path: cleanDiffPath, binary: true, lines: [], addCount: 0, removeCount: 0 } satisfies FileDiff);
      }

      // figure out status of this file
      const { stdout: statusLine } = await git(["status", "--porcelain", "--", cleanDiffPath], { trimStdout: false });
      const code = statusLine.slice(0, 2).trim();

      let lines: DiffLine[] = [];
      let raw = "";

      if (code === "??" || code === "A" || code.startsWith("A")) {
        // untracked / brand-new file — show full content as added
        const content = await readFile(absolutePath, "utf-8").catch(() => "");
        lines = content.split("\n").map((l) => ({ type: "add" as const, content: l }));
        // trim trailing empty line
        if (lines.at(-1)?.content === "") lines.pop();
      } else if (code === "D") {
        // deleted — show last committed content as removed
        const { stdout } = await git(["show", `HEAD:${cleanDiffPath}`]);
        lines = stdout.split("\n").map((l) => ({ type: "remove" as const, content: l }));
        if (lines.at(-1)?.content === "") lines.pop();
      } else {
        // modified / renamed — standard diff vs HEAD
        const { stdout } = await git(["diff", "HEAD", "--", cleanDiffPath]);
        raw = stdout;
        if (!raw) {
          // might be staged only
          const { stdout: staged } = await git(["diff", "--cached", "--", cleanDiffPath]);
          raw = staged;
        }
        lines = parseDiff(raw);
      }

      const addCount = lines.filter((l) => l.type === "add").length;
      const removeCount = lines.filter((l) => l.type === "remove").length;

      return NextResponse.json({ path: cleanDiffPath, binary: false, lines, addCount, removeCount } satisfies FileDiff);
    } catch (err) {
      console.error("Git API Error (diff):", err);
      const msg = err instanceof Error ? err.message : String(err);
      return NextResponse.json({ error: msg }, { status: 500 });
    }
  }

  // ── Status list ────────────────────────────────────────────
  try {
    await git(["rev-parse", "--git-dir"]);

    // -uall：展开所有未追踪目录，逐一列出文件（默认只显示目录名）
    const { stdout: statusOut } = await git(["status", "--porcelain", "-uall"], { trimStdout: false });
    const rawEntries = statusOut
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const code = line.slice(0, 2).trim();
        const rawPath = line.slice(3).trim().replace(/^"(.*)"$/, "$1");
        const filePath = rawPath.includes(" -> ") ? rawPath.split(" -> ")[1] : rawPath;
        // git 对未追踪目录会在路径末尾加 "/"，pop() 会得到空字符串，先去掉斜杠
        const cleanPath = filePath.replace(/\/$/, "");
        const name = cleanPath.split("/").pop() || cleanPath;

        let state: FileStatus["state"] = "modified";
        if (code === "??" || code === "A" || code.startsWith("A")) state = "added";
        else if (code === "D" || code === "DD") state = "deleted";
        else if (code === "R" || code.startsWith("R")) state = "renamed";

        return { name, path: cleanPath, state };
      });

    // 新建的空文件夹靠 .gitkeep 占位才能被 git 跟踪。展示时把「仅含 .gitkeep」
    // 的文件夹折叠成一个文件夹条目（显示文件夹名而非 .gitkeep）；若该文件夹下
    // 已有真实笔记，则丢弃 .gitkeep 条目，由真实笔记代表该文件夹，避免冗余。
    const foldersWithRealFiles = new Set(
      rawEntries
        .filter((e) => e.name !== ".gitkeep" && e.path.includes("/"))
        .map((e) => e.path.slice(0, e.path.lastIndexOf("/"))),
    );

    const files: FileStatus[] = [];
    for (const e of rawEntries) {
      if (e.name === ".gitkeep" && e.path.includes("/")) {
        const folderPath = e.path.slice(0, e.path.lastIndexOf("/"));
        if (foldersWithRealFiles.has(folderPath)) continue; // 文件夹已有真实笔记，隐藏占位
        files.push({
          name: folderPath.split("/").pop() || folderPath,
          path: folderPath,
          state: e.state,
          kind: "folder",
        });
        continue;
      }
      files.push({ ...e, kind: "file" });
    }

    let ahead = 0;
    let behind = 0;
    try {
      const { stdout: revOut } = await git(["rev-list", "--left-right", "--count", "@{upstream}...HEAD"]);
      const parts = revOut.split(/\s+/);
      behind = parseInt(parts[0] ?? "0", 10) || 0;
      ahead = parseInt(parts[1] ?? "0", 10) || 0;
    } catch { /* no upstream */ }

    let lastSync: string | null = null;
    try {
      const { stdout } = await git(["log", "-1", "--format=%cd", "--date=iso-strict", "HEAD"]);
      if (stdout) lastSync = stdout;
    } catch { /* empty repo */ }

    // 面板副标题要展示当前分支；游离 HEAD 没有分支名，按缺省处理
    let branch: string | null = null;
    try {
      const { stdout } = await git(["rev-parse", "--abbrev-ref", "HEAD"]);
      if (stdout && stdout !== "HEAD") branch = stdout;
    } catch { /* empty repo */ }

    return NextResponse.json({ files, ahead, behind, lastSync, branch });
  } catch (err) {
    console.error("Git API Error (status):", err);
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

async function hasRemote() {
  try {
    const { stdout } = await git(["remote"]);
    const remotes = stdout.split(/\s+/).filter(Boolean);
    return remotes.includes("origin");
  } catch {
    return false;
  }
}

// POST — pull, push, or discard
export async function POST(req: Request) {
  try {
    const body = (await req.json()) as { action: "pull" | "push" | "discard"; message?: string; path?: string };
    const remoteExists = await hasRemote();

    if (body.action === "pull") {
      if (!remoteExists) {
        return NextResponse.json({ ok: true, output: "未配置远程仓库，跳过拉取。" });
      }
      const { stdout, stderr } = await git(["pull", "--rebase", "--autostash"]);
      return NextResponse.json({ ok: true, output: stdout || stderr });
    }

    if (body.action === "push") {
      if (!remoteExists) {
        return NextResponse.json({ error: "未配置远程仓库，无法上传。请先为笔记本配置远程 Git 仓库（如通过 git remote add origin <url>）。" }, { status: 400 });
      }
      const message = body.message?.trim() || `更新笔记 ${new Date().toLocaleDateString("zh-CN")}`;
      await git(["add", "-A"]);

      const { stdout: diffOut } = await git(["diff", "--cached", "--name-only"]);
      if (!diffOut) {
        try {
          const { stdout, stderr } = await git(["push", "origin", GIT_PUSH_TARGET]);
          return NextResponse.json({ ok: true, output: stdout || stderr || "已上传" });
        } catch {
          return NextResponse.json({ ok: true, output: "没有新内容需要上传" });
        }
      }

      await git(["commit", "-m", message]);
      const { stdout, stderr } = await git(["push", "origin", GIT_PUSH_TARGET]);
      return NextResponse.json({ ok: true, output: stdout || stderr || "上传成功" });
    }

    if (body.action === "discard") {
      const filePath = body.path;
      if (!filePath) {
        return NextResponse.json({ error: "无效的文件路径" }, { status: 400 });
      }
      const { cleanPath } = resolveVaultFile(filePath);
      // 判断是未追踪新文件还是已追踪文件
      const { stdout: statusLine } = await git(["status", "--porcelain", "--", cleanPath], { trimStdout: false });
      if (!statusLine.trim()) {
        return NextResponse.json({ error: "该文件没有待撤销的改动" }, { status: 400 });
      }
      const code = statusLine.slice(0, 2).trim();
      if (code === "??") {
        // 未追踪的新文件 → 直接删除
        await git(["clean", "-fd", "--", cleanPath]);
      } else {
        // 已追踪文件（修改/删除/重命名）→ 从 HEAD 恢复
        await git(["checkout", "HEAD", "--", cleanPath]);
      }
      return NextResponse.json({ ok: true });
    }

    return NextResponse.json({ error: "未知操作" }, { status: 400 });
  } catch (err) {
    console.error("Git API Error (POST):", err);
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
