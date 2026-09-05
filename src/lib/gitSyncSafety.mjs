/** Unmerged index entries must be checked before `git add` marks them resolved. */
export class GitSyncConflictError extends Error {
  /** @param {string[]} paths */
  constructor(paths) {
    super(`同步已停止：以下文件存在合并冲突，请处理后重试：\n${paths.join("\n")}\n本地改动与冲突现场已保留，尚未提交或推送。`);
    this.name = "GitSyncConflictError";
    this.paths = paths;
  }
}

/** @param {(args: string[]) => Promise<{stdout: string}>} git */
export async function assertNoSyncConflicts(git) {
  const { stdout } = await git(["ls-files", "--unmerged", "-z"]);
  const paths = [...new Set(stdout.split("\0").filter(Boolean).map(entry => entry.slice(entry.indexOf("\t") + 1)))];
  if (paths.length) throw new GitSyncConflictError(paths);
}

/** @param {(args: string[]) => Promise<{stdout: string, stderr: string}>} git */
export async function pullForSync(git) {
  await assertNoSyncConflicts(git);
  let result;
  try {
    result = await git(["pull", "--rebase", "--autostash"]);
  } catch (error) {
    // A failed rebase may also leave conflicts; report those before raw Git errors.
    await assertNoSyncConflicts(git);
    throw error;
  }
  // Applying autostash can conflict even when pull exits with status 0.
  await assertNoSyncConflicts(git);
  return result;
}
