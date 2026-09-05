#!/usr/bin/env node
/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/no-unused-vars */
/**
 * Nightly auto-sync for inkfellow vaults.
 * Usage: node nightly-sync.js <vault-path>
 * Cron:  0 0 * * * /path/to/node /path/to/clawapp/scripts/nightly-sync.js /path/to/vault
 *
 * Flow: pull → stage → check changes → AI commit message → commit → push
 */

"use strict";

const { execFile } = require("child_process");
const { promisify } = require("util");
const { readFile } = require("fs/promises");
const path = require("path");

const execFileAsync = promisify(execFile);

const APP_DIR   = path.resolve(__dirname, "..");
const VAULT     = path.resolve(process.argv[2] || path.join(APP_DIR, "vault"));
const PUSH_TARGET       = process.env.NOTES_GIT_PUSH_TARGET?.trim()    || "HEAD:main";
const COMMIT_USER_NAME  = process.env.GIT_COMMIT_USER_NAME?.trim()     || "Inkfellow Nightly";
const COMMIT_USER_EMAIL = process.env.GIT_COMMIT_USER_EMAIL?.trim()    || "nightly@inkfellow.local";

const log = (msg) =>
  console.log(`[nightly-sync] ${new Date().toISOString()}  ${msg}`);

// ── git helper ────────────────────────────────────────────────────
async function git(args) {
  const { stdout, stderr } = await execFileAsync(
    "git",
    [
      "-C", VAULT,
      "-c", "core.quotepath=false",
      "-c", `user.name=${COMMIT_USER_NAME}`,
      "-c", `user.email=${COMMIT_USER_EMAIL}`,
      ...args,
    ],
    {
      timeout: 60_000,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      maxBuffer: 20 * 1024 * 1024,
    }
  );
  return { stdout: stdout.trim(), stderr: stderr.trim() };
}

// ── fallback message (no AI) ──────────────────────────────────────
function fallbackMessage(files) {
  const today = new Date().toLocaleDateString("zh-CN", {
    month: "long",
    day:   "numeric",
  });
  if (files.length === 0) return `每日备份 · ${today}`;
  const stripExt = (p) =>
    p.split("/").pop()?.replace(/\.(md|html?)$/i, "") || p;
  if (files.length === 1) {
    const label =
      files[0].state === "added"   ? "新增" :
      files[0].state === "deleted" ? "删除" : "编辑";
    return `${today} · ${label}了《${stripExt(files[0].path)}》`;
  }
  return `${today} · 编辑了 ${files.length} 篇笔记`;
}

// ── AI commit message (mirrors ai-log/route.ts logic) ────────────
async function getAiMessage(files) {
  try {
    const profilePath = path.join(APP_DIR, "claude-chat", "auth-profile.json");
    const raw         = await readFile(profilePath, "utf-8");
    const profileData = JSON.parse(raw);

    const activeId = profileData?.activeProfileId;
    let profile    = profileData?.profiles?.find((p) => p.id === activeId);
    if (!profile?.apiKey) {
      profile = profileData?.profiles?.find((p) => p.apiKey);
    }
    if (!profile?.apiKey) return null;

    const { stdout: diffOut } = await git(["diff", "--cached"]);
    const truncatedDiff = diffOut.slice(0, 4500);

    const systemPrompt = `你是一个专业的个人笔记与知识管理专家。请根据以下 Git 变更差异（git diff）生成一条极简、温润、苹果风的笔记同步日志。

设计原则：
1. 最多 80 字，必须是中文，严禁废话。
2. 去除所有开发技术噪音：绝对不要包含 git 命令、Markdown 标记、类名、哈希值、分支名或文件名后缀（如 .md）。
3. 语气要温暖、专注、生活化。多用整理、重写、添加、修正等有温度的词。
4. 描述变化本身（今天编辑了什么），不要断言完成或评价质量。
5. 如果改动极其微小，一句话概括即可（如：微调了部分段落的措辞与排版）。`;

    let endpoint, modelName;
    if (profile.provider === "deepseek") {
      endpoint  = "https://api.deepseek.com/v1/chat/completions";
      modelName = "deepseek-chat";
    } else if (profile.provider === "openrouter") {
      endpoint  = "https://openrouter.ai/api/v1/chat/completions";
      const raw = profile.haikuModel || profile.sonnetModel || "";
      modelName = raw.replace(/^~/, "") || "google/gemini-2.5-flash";
    } else {
      return null;
    }

    const res = await fetch(endpoint, {
      method:  "POST",
      headers: {
        "Content-Type":  "application/json",
        "Authorization": `Bearer ${profile.apiKey}`,
      },
      body:   JSON.stringify({
        model:       modelName,
        messages:    [
          { role: "system", content: systemPrompt },
          { role: "user",   content: `这是当前的变更差异内容：\n\n${truncatedDiff}` },
        ],
        temperature: 0.3,
        max_tokens:  100,
      }),
      signal: AbortSignal.timeout(15_000),
    });

    if (!res.ok) throw new Error(`API ${res.status}`);
    const data = await res.json();
    let msg = data?.choices?.[0]?.message?.content?.trim();
    if (msg) {
      msg = msg.replace(/^["'「『](.*)["'」』]$/, "$1").trim();
      return msg;
    }
    return null;
  } catch (err) {
    log(`AI message failed: ${err.message}`);
    return null;
  }
}

// ── main ──────────────────────────────────────────────────────────
async function main() {
  const { assertNoSyncConflicts, pullForSync } = await import("../src/lib/gitSyncSafety.mjs");
  log(`vault: ${VAULT}`);

  // verify git repo
  try {
    await git(["rev-parse", "--git-dir"]);
  } catch {
    log("Not a git repo, skipping.");
    return;
  }

  // 1. pull latest
  log("Pulling latest...");
  const { stdout: pullOutput } = await pullForSync(git);
  log(`Pull: ${pullOutput || "already up to date"}`);

  // 2. stage everything
  await assertNoSyncConflicts(git);
  await git(["add", "-A"]);

  // 3. check for staged changes
  const { stdout: staged } = await git(["diff", "--cached", "--name-only"]);
  if (!staged) {
    log("Nothing to sync today, done.");
    return;
  }

  // 4. parse changed files for message context
  const { stdout: porcelain } = await git(["status", "--porcelain", "-uall"]);
  const files = porcelain.split("\n").filter(Boolean).map((line) => {
    const code     = line.slice(0, 2).trim();
    const rawPath  = line.slice(3).trim().replace(/^"(.*)"$/, "$1");
    const filePath = rawPath.includes(" -> ") ? rawPath.split(" -> ")[1] : rawPath;
    const clean    = filePath.replace(/\/$/, "");
    const state    =
      (code === "??" || code === "A" || code.startsWith("A")) ? "added"   :
      (code === "D"  || code === "DD")                        ? "deleted" :
      (code === "R"  || code.startsWith("R"))                 ? "renamed" : "modified";
    return { path: clean, state };
  });
  log(`${files.length} file(s) changed`);

  // 5. commit message: AI first, fallback to template
  log("Generating commit message...");
  const aiMsg  = await getAiMessage(files);
  const message = aiMsg || fallbackMessage(files);
  log(`Message (${aiMsg ? "AI" : "fallback"}): ${message}`);

  // 6. commit + push
  await git(["commit", "-m", message]);
  log("Committed.");

  const { stdout: pushOut, stderr: pushErr } = await git(["push", "origin", PUSH_TARGET]);
  log(`Push: ${pushOut || pushErr || "success"}`);
  log("Done.");
}

main().catch((err) => {
  log(`Fatal: ${err.message}`);
  process.exit(1);
});
