import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertNoSyncConflicts, GitSyncConflictError, pullForSync } from "../src/lib/gitSyncSafety.mjs";

const exec = promisify(execFile);

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), "inkfellow-sync-test-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const git = cwd => async args => exec("git", ["-C", cwd, "-c", "user.name=Sync Test", "-c", "user.email=sync@example.invalid", ...args]);
  const remote = join(dir, "remote.git");
  const cloud = join(dir, "cloud");
  const local = join(dir, "local");
  await git(dir)(["init", "--bare", "--initial-branch=main", remote]);
  await git(dir)(["clone", remote, cloud]);
  await writeFile(join(cloud, "笔记.md"), "base\n");
  await git(cloud)(["add", "-A"]);
  await git(cloud)(["commit", "-m", "base"]);
  await git(cloud)(["push", "origin", "main"]);
  await git(dir)(["clone", remote, local]);
  await writeFile(join(cloud, "笔记.md"), "cloud change\n");
  await git(cloud)(["commit", "-am", "cloud"]);
  await git(cloud)(["push"]);
  return { local, git: git(local), remoteGit: git(remote) };
}

test("autostash conflict stops syncing even when pull reports success, and retry preserves the index", async t => {
  const { local, git, remoteGit } = await fixture(t);
  await writeFile(join(local, "笔记.md"), "local change\n");
  const before = (await remoteGit(["rev-parse", "main"])).stdout;
  let pullSucceeded = false;
  await assert.rejects(pullForSync(async args => {
    const result = await git(args);
    if (args[0] === "pull") pullSucceeded = true;
    return result;
  }), error => error instanceof GitSyncConflictError && error.paths.includes("笔记.md"));
  assert.equal(pullSucceeded, true);
  const unmerged = (await git(["ls-files", "-u"])).stdout;
  assert.notEqual(unmerged, "");
  await assert.rejects(assertNoSyncConflicts(git), GitSyncConflictError);
  await assert.rejects(pullForSync(git), GitSyncConflictError);
  assert.equal((await git(["ls-files", "-u"])).stdout, unmerged);
  const content = await readFile(join(local, "笔记.md"), "utf8");
  assert.match(content, /local change/);
  assert.match(content, /cloud change/);
  assert.equal((await remoteGit(["rev-parse", "main"])).stdout, before);
});

test("a clean pull preserves unrelated local edits and permits subsequent staging", async t => {
  const { local, git } = await fixture(t);
  await writeFile(join(local, "另一篇.md"), "new note\n");
  await pullForSync(git);
  await assertNoSyncConflicts(git);
  await git(["add", "-A"]);
  await git(["commit", "-m", "sync"]);
  assert.equal(await readFile(join(local, "笔记.md"), "utf8"), "cloud change\n");
  assert.equal(await readFile(join(local, "另一篇.md"), "utf8"), "new note\n");
});

test("nightly sync exits before staging or committing a conflict", async t => {
  const { local, git, remoteGit } = await fixture(t);
  await writeFile(join(local, "笔记.md"), "local change\n");
  const remoteHead = (await remoteGit(["rev-parse", "main"])).stdout;
  await assert.rejects(exec(process.execPath, ["scripts/nightly-sync.js", local]), error => {
    assert.equal(error.code, 1);
    assert.match(error.stdout, /同步已停止/);
    return true;
  });
  assert.notEqual((await git(["ls-files", "-u"])).stdout, "");
  assert.equal((await git(["rev-parse", "HEAD"])).stdout, remoteHead);
  assert.equal((await remoteGit(["rev-parse", "main"])).stdout, remoteHead);
});

test("a failed nightly pull leaves pending edits unstaged and uncommitted", async t => {
  const { local, git } = await fixture(t);
  await git(["remote", "set-url", "origin", join(local, "missing-remote.git")]);
  await writeFile(join(local, "笔记.md"), "local change\n");
  const before = (await git(["rev-parse", "HEAD"])).stdout;
  await assert.rejects(exec(process.execPath, ["scripts/nightly-sync.js", local]), error => error.code === 1);
  assert.equal((await git(["rev-parse", "HEAD"])).stdout, before);
  assert.equal((await git(["diff", "--cached", "--name-only"])).stdout, "");
  assert.equal(await readFile(join(local, "笔记.md"), "utf8"), "local change\n");
});
