"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import styles from "./notes.module.css";

type FileStatus = {
  name: string;
  path: string;
  state: "modified" | "added" | "deleted" | "renamed";
  kind?: "file" | "folder";
};

type GitStatus = {
  files: FileStatus[];
  ahead: number;
  behind: number;
  lastSync: string | null;
  branch?: string | null;
};

type FileStats = Record<string, { added: number; removed: number }>;

type CommitRecord = {
  hash: string;
  message: string;
  author: string;
  date: string;
};

type DiffLine = {
  type: "add" | "remove" | "context" | "hunk";
  content: string;
};

type FileDiff = {
  path: string;
  binary: boolean;
  lines: DiffLine[];
  addCount: number;
  removeCount: number;
};

type ActionState = "idle" | "syncing";
type PaneState = "main" | "diff" | "history";

const STATE_LABEL: Record<FileStatus["state"], string> = {
  modified: "已修改",
  added:    "新笔记",
  deleted:  "已删除",
  renamed:  "重命名",
};

const STATE_DOT_CLASS: Record<FileStatus["state"], string> = {
  modified: styles.gitStateDotModified,
  added:    styles.gitStateDotAdded,
  deleted:  styles.gitStateDotDeleted,
  renamed:  styles.gitStateDotModified,
};

// Rollback confirmation details
const DISCARD_WARN: Record<FileStatus["state"], string> = {
  modified: "确定放弃修改并还原吗？本地改动将无法找回。",
  added:    "确定删除这篇本地新笔记吗？删除后不可撤销。",
  deleted:  "确定恢复这篇已删除的笔记吗？",
  renamed:  "确定还原重命名吗？",
};

const DISCARD_DONE: Record<FileStatus["state"], string> = {
  modified: "已还原 ✓",
  added:    "已删除 ✓",
  deleted:  "已恢复 ✓",
  renamed:  "已还原 ✓",
};

type Props = {
  onOpenFile?: (path: string) => void;
};

function formatLastSync(iso: string | null) {
  if (!iso) return null;
  const diffMin = Math.round((Date.now() - new Date(iso).getTime()) / 60_000);
  if (diffMin < 1)  return "刚刚";
  if (diffMin < 60) return `${diffMin} 分钟前`;
  const diffH = Math.round(diffMin / 60);
  if (diffH < 24)   return `${diffH} 小时前`;
  return new Date(iso).toLocaleDateString("zh-CN", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

const stripNoteExtension = (value: string) => value.replace(/\.(md|html?)$/i, "");

// 文件夹条目要和新笔记区分开，否则一律显示成「新笔记」
const stateLabelOf = (file: FileStatus) =>
  file.kind === "folder" && file.state === "added" ? "新文件夹" : STATE_LABEL[file.state];

const formatParentPath = (filePath: string) =>
  filePath.includes("/") ? filePath.split("/").slice(0, -1).join(" / ") : null;

export default function NotesGit({ onOpenFile }: Props) {
  const [status, setStatus]           = useState<GitStatus | null>(null);
  const [actionState, setActionState] = useState<ActionState>("idle");
  const [message, setMessage]         = useState("");
  const [isEditingMessage, setIsEditingMessage] = useState(false);
  const [feedback, setFeedback]       = useState<string | null>(null);
  const [isError, setIsError]         = useState(false);
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const [fileStats, setFileStats]     = useState<FileStats>({});
  const [discardingPath, setDiscardingPath] = useState<string | null>(null);
  const [isDiscarding, setIsDiscarding]     = useState(false);

  // iOS-style Navigation Pane State: "main", "diff", or "history"
  const [selectedPane, setSelectedPane] = useState<PaneState>("main");

  // History data
  const [history, setHistory]               = useState<CommitRecord[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);

  // Diff stack data
  const [selectedDiffFile, setSelectedDiffFile] = useState<FileStatus | null>(null);
  const [diff, setDiff]                         = useState<FileDiff | null>(null);
  const [diffLoading, setDiffLoading]           = useState(false);
  const [diffError, setDiffError]               = useState<string | null>(null);
  const [confirmingDiffDiscard, setConfirmingDiffDiscard] = useState(false);

  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const diffRequestRef = useRef(0);
  const listContainerRef = useRef<HTMLDivElement>(null);
  const listItemRefs = useRef<Map<string, HTMLLIElement>>(new Map());

  // 弹窗打开时，确保列表项往上滚动，让弹窗完整显示在容器内
  useEffect(() => {
    if (!discardingPath) return;
    const container = listContainerRef.current;
    const item = listItemRefs.current.get(discardingPath);
    if (!container || !item) return;
    const POPOVER_HEIGHT = 130;
    const containerRect = container.getBoundingClientRect();
    const itemRect = item.getBoundingClientRect();
    const spaceBelow = containerRect.bottom - itemRect.bottom;
    if (spaceBelow < POPOVER_HEIGHT) {
      container.scrollBy({ top: POPOVER_HEIGHT - spaceBelow + 8, behavior: "smooth" });
    }
  }, [discardingPath]);

  const fetchStatus = useCallback(async () => {
    try {
      const res = await fetch("/api/notes/git", { cache: "no-store" });
      const data = (await res.json()) as GitStatus & { error?: string };
      if (data.error) throw new Error(data.error);
      setStatus(data);
    } catch {
      setStatus(null);
    }
  }, []);

  const fetchStats = useCallback(async () => {
    try {
      const res = await fetch("/api/notes/git?stats=true", { cache: "no-store" });
      const data = (await res.json()) as { stats?: FileStats };
      setFileStats(data.stats ?? {});
    } catch {
      setFileStats({});
    }
  }, []);

  const fetchHistory = useCallback(async () => {
    setHistoryLoading(true);
    try {
      const res = await fetch("/api/notes/git?history=true", { cache: "no-store" });
      const data = (await res.json()) as { history?: CommitRecord[] };
      setHistory(data.history ?? []);
    } catch {
      setHistory([]);
    } finally {
      setHistoryLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchStatus();
    void fetchStats();
    intervalRef.current = setInterval(() => {
      void fetchStatus();
      void fetchStats();
    }, 30_000);
    return () => { if (intervalRef.current) clearInterval(intervalRef.current); };
  }, [fetchStatus, fetchStats]);

  // Load history when timeline pane slides in
  useEffect(() => {
    if (selectedPane === "history") void fetchHistory();
  }, [selectedPane, fetchHistory]);

  const showFeedback = (text: string, error = false) => {
    setFeedback(text);
    setIsError(error);
    setTimeout(() => setFeedback(null), 5000);
  };

  const discard = async (filePath: string, fileState: FileStatus["state"]) => {
    setIsDiscarding(true);
    try {
      const res = await fetch("/api/notes/git", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "discard", path: filePath }),
      });
      const data = (await res.json()) as { ok?: boolean; error?: string };
      if (data.error) throw new Error(data.error);
      showFeedback(DISCARD_DONE[fileState]);
      setDiscardingPath(null);
      if (selectedDiffFile?.path === filePath) {
        setSelectedDiffFile(null);
        setDiff(null);
        setDiffError(null);
        setConfirmingDiffDiscard(false);
        setSelectedPane("main");
      }
      await fetchStatus();
      await fetchStats();
    } catch (err) {
      showFeedback(err instanceof Error ? err.message : "操作失败", true);
    } finally {
      setIsDiscarding(false);
    }
  };

  const openDiff = useCallback(async (file: FileStatus) => {
    const requestId = diffRequestRef.current + 1;
    diffRequestRef.current = requestId;
    setSelectedDiffFile(file);
    setDiff(null);
    setDiffError(null);
    setDiffLoading(true);
    setConfirmingDiffDiscard(false);
    setSelectedPane("diff");

    try {
      const params = new URLSearchParams({ diff: file.path });
      const res = await fetch(`/api/notes/git?${params.toString()}`, { cache: "no-store" });
      const data = (await res.json()) as FileDiff & { error?: string };
      if (data.error) throw new Error(data.error);
      if (diffRequestRef.current === requestId) {
        setDiff(data);
      }
    } catch (err) {
      if (diffRequestRef.current === requestId) {
        setDiffError(err instanceof Error ? err.message : "改动加载失败");
      }
    } finally {
      if (diffRequestRef.current === requestId) {
        setDiffLoading(false);
      }
    }
  }, []);

  const closeDiff = () => {
    diffRequestRef.current += 1;
    setSelectedDiffFile(null);
    setDiff(null);
    setDiffError(null);
    setDiffLoading(false);
    setConfirmingDiffDiscard(false);
    setSelectedPane("main");
  };

  // Smart Sync: Pull updates, call AI for commit log (if blank), commit, and Push
  const handleSmartSync = async () => {
    setActionState("syncing");
    let finalMessage = message.trim();
    
    try {
      // Step 1: Pre-pull remote updates to prevent upstream conflicts
      showFeedback("检查并获取云端版本…");
      const pullRes = await fetch("/api/notes/git", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "pull" }),
      });
      const pullData = await pullRes.json();
      if (pullData.error) throw new Error(pullData.error);

      // Step 2: Auto-generate commit message via AI if none custom entered
      if (!finalMessage) {
        showFeedback("正在通过 AI 提炼本次同步摘要…");
        try {
          const aiRes = await fetch("/api/notes/git/ai-log", { method: "POST" });
          const aiData = await aiRes.json();
          if (aiData.message) {
            finalMessage = aiData.message;
          } else if (aiData.fallback) {
            finalMessage = aiData.fallback;
          }
        } catch {
          // Robust inline fallback
          finalMessage = `同步笔记于 ${new Date().toLocaleDateString("zh-CN")}`;
        }
      }

      // Step 3: Commit and Push to Cloud
      showFeedback(`正在保存：「${finalMessage}」到云端…`);
      const pushRes = await fetch("/api/notes/git", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "push", message: finalMessage }),
      });
      const pushData = await pushRes.json();
      if (pushData.error) throw new Error(pushData.error);

      showFeedback("云端同步成功 ✓");
      setMessage("");
      setIsEditingMessage(false);
      await fetchStatus();
      await fetchStats();
    } catch (err) {
      showFeedback(err instanceof Error ? err.message : "同步失败", true);
    } finally {
      setActionState("idle");
    }
  };

  const isBusy    = actionState !== "idle";
  const hasChanges = (status?.files.length ?? 0) > 0;
  const isSynced   = !hasChanges && (status?.ahead ?? 0) === 0 && (status?.behind ?? 0) === 0;

  const statusLabel = status === null
    ? "正在检查云端…"
    : isSynced
      ? "已是最新版本"
      : `${status.files.length} 篇笔记待同步`;

  // 分支、云端状态、上次同步合成一行副标题，底部只留操作
  const statusSubLabel = [
    status && status.behind > 0 ? "云端有新更新" : null,
    status?.branch ?? null,
    status?.lastSync ? `上次同步 ${formatLastSync(status.lastSync)}` : null,
  ].filter(Boolean).join(" · ");

  return (
    <div className={styles.gitPanel} style={{ position: "relative" }}>
      <div className={`${styles.gitStack}${selectedPane !== "main" ? ` ${styles.gitStackShowingDetail}` : ""}`}>
        
        {/* ── Slide 1: Main Sync List Panel ── */}
        <div className={styles.gitStackPane}>
          {/* ── Status Header ── */}
          <div className={styles.gitStatusBar}>
            <div className={styles.gitStatusLeft}>
              <span
                className={`${styles.gitStatusDot} ${isBusy ? styles.gitStatusDotPulsing : ""}`}
                data-ok={status !== null && isSynced ? "true" : undefined}
              />
              <div className={styles.gitStatusText}>
                <div className={styles.gitStatusLabel}>{statusLabel}</div>
                {statusSubLabel && (
                  <div className={styles.gitStatusSubLabel}>{statusSubLabel}</div>
                )}
              </div>
            </div>
            <div className={styles.gitHeaderActions}>
              <button
                type="button"
                className={styles.gitHistoryBtn}
                onClick={() => setSelectedPane("history")}
              >
                <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
                  <circle cx="6" cy="6" r="4.5" stroke="currentColor" strokeWidth="1.2"/>
                  <path d="M6 3.5V6l1.8 1.8" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"/>
                </svg>
                版本记录
              </button>
              <button
                type="button"
                className={styles.gitRefresh}
                onClick={fetchStatus}
                disabled={isBusy}
                title="重新检查"
                aria-label="重新检查"
              >
                ↺
              </button>
            </div>
          </div>

          {/* ── File Change List ── */}
          <div className={styles.gitFileListContainer} ref={listContainerRef}>
            {hasChanges && status && (
              <div className={styles.gitFileList}>
                <ul>
                  {status.files.map((f) => {
                    const parentPath = formatParentPath(f.path);
                    const isConfirming = discardingPath === f.path;
                    const isFolder = f.kind === "folder";

                    return (
                      <li
                        key={f.path}
                        ref={(el) => { if (el) listItemRefs.current.set(f.path, el); else listItemRefs.current.delete(f.path); }}
                        className={`${styles.gitFileItem} ${isConfirming ? styles.gitFileItemConfirming : ""}`}
                      >
                        <div className={styles.gitFileRowContent}>
                          {/* Status Dot */}
                          <span className={`${styles.gitStateDot} ${STATE_DOT_CLASS[f.state]}`} title={stateLabelOf(f)} />

                          {/* File Path info */}
                          <div className={styles.gitFileInfo}>
                            {isFolder ? (
                              <span className={styles.gitFileName} title={f.path}>
                                {f.name}
                              </span>
                            ) : (
                              <button
                                type="button"
                                className={styles.gitFileNameBtn}
                                title="查看改动详情"
                                onClick={() => void openDiff(f)}
                              >
                                {stripNoteExtension(f.name)}
                              </button>
                            )}
                            {(isFolder || parentPath) && (
                              <span className={styles.gitFileSubLine}>
                                {isFolder && <span className={styles.gitFileKindTag}>文件夹</span>}
                                {parentPath && <span className={styles.gitFilePath}>{parentPath}</span>}
                              </span>
                            )}
                          </div>

                          {/* 静默态显示变更类型，悬停时让位给操作按钮 */}
                          <span className={styles.gitFileState}>{stateLabelOf(f)}</span>

                          {/* Hover Actions Panel */}
                          <div className={styles.gitHoverActions}>
                            {!isFolder && f.state !== "deleted" && onOpenFile && (
                              <button
                                type="button"
                                className={styles.gitCircleBtn}
                                title="打开文件"
                                onClick={() => onOpenFile(f.path)}
                              >
                                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                                  <path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z"/>
                                  <polyline points="14 2 14 8 20 8"/>
                                </svg>
                              </button>
                            )}
                            <button
                              type="button"
                              className={`${styles.gitCircleBtn} ${styles.gitCircleBtnDanger}`}
                              title="撤销/还原"
                              onClick={() => setDiscardingPath(f.path)}
                            >
                              ↩
                            </button>
                          </div>
                        </div>

                        {/* Inline Popover Confirmation Bubble */}
                        {isConfirming && (
                          <div className={styles.gitPopover}>
                            <div className={styles.gitPopoverHeader}>警告</div>
                            <div className={styles.gitPopoverText}>
                              {isFolder ? "确定删除这个新建文件夹吗？删除后不可撤销。" : DISCARD_WARN[f.state]}
                            </div>
                            <div className={styles.gitPopoverBtns}>
                              <button
                                type="button"
                                className={styles.gitPopoverCancel}
                                onClick={() => setDiscardingPath(null)}
                                disabled={isDiscarding}
                              >
                                取消
                              </button>
                              <button
                                type="button"
                                className={styles.gitPopoverConfirm}
                                onClick={() => void discard(f.path, f.state)}
                                disabled={isDiscarding}
                              >
                                {isDiscarding ? "…" : "确定还原"}
                              </button>
                            </div>
                          </div>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </div>
            )}

            {!hasChanges && status !== null && (
              <div className={styles.gitEmptyState}>
                <div className={styles.gitEmptyIcon}>🥛</div>
                <div className={styles.gitEmptyTitle}>一片纯净</div>
                <div className={styles.gitEmptyDesc}>所有想法已同步到云端</div>
              </div>
            )}
          </div>

          {/* ── Status Feedback ── */}
          {feedback && (
            <div className={`${styles.gitFeedback}${isError ? ` ${styles.gitFeedbackError}` : ""}`}>
              {feedback}
            </div>
          )}

          {/* ── Sticky bottom: message + sync button ── */}
          <div className={styles.gitBottomBar}>
          {/* ── Message customization area ── */}
          {hasChanges && (
            <div className={styles.gitMessageBar}>
              {isEditingMessage ? (
                <div className={styles.gitMessageEdit}>
                  <input
                    className={styles.gitNoteInput}
                    type="text"
                    placeholder="这次写了些什么？（手动覆盖 AI 日志）"
                    value={message}
                    onChange={(e) => setMessage(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter" && !isBusy) void handleSmartSync(); }}
                    disabled={isBusy}
                    maxLength={80}
                  />
                  <button
                    type="button"
                    className={styles.gitMsgDoneBtn}
                    onClick={() => setIsEditingMessage(false)}
                    title="确定"
                  >
                    ✓
                  </button>
                </div>
              ) : (
                <div className={styles.gitMessageDisplay}>
                  <span className={styles.gitMessageLabel}>
                    {message ? `自定义日志: ${message}` : "✨ 同步日志：由 AI 提取自动总结"}
                  </span>
                  <button
                    type="button"
                    className={styles.gitMsgEditBtn}
                    onClick={() => setIsEditingMessage(true)}
                    title="自定义日志"
                  >
                    ✏️ 修改
                  </button>
                </div>
              )}
            </div>
          )}

          {/* ── Bottom Smart Sync Bar ── */}
          <div className={styles.gitActions}>
            <button
              type="button"
              className={`${styles.gitButton} ${styles.gitButtonPrimary} ${styles.gitButtonFull} ${isSynced ? styles.gitButtonDisabled : ""}`}
              onClick={handleSmartSync}
              disabled={isBusy || (isSynced && status !== null)}
            >
              {actionState === "syncing" ? (
                <>
                  <span className={styles.gitSpinner} />
                  <span>智能同步中…</span>
                </>
              ) : isSynced && status !== null ? (
                <span>✓ 已同步到最新</span>
              ) : (
                <>
                  <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
                    <path d="M7 11V3M7 3L4 6M7 3L10 6" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/>
                  </svg>
                  <span>立即同步到云端</span>
                </>
              )}
            </button>
          </div>
          </div>{/* end gitBottomBar */}
        </div>

        {/* ── Slide 2: iOS-style Sliding Secondary Detail Pane (Diff or Version Timeline) ── */}
        <div className={`${styles.gitStackPane} ${styles.gitDiffPane}`} aria-hidden={selectedPane === "main"}>
          
          {/* Pane A: Diff Viewer detail */}
          {selectedPane === "diff" && selectedDiffFile && (
            <>
              <header className={styles.gitDiffHeader}>
                <button
                  type="button"
                  className={styles.gitDiffBack}
                  onClick={closeDiff}
                  aria-label="返回"
                >
                  ‹
                </button>
                <div className={styles.gitDiffHeaderText}>
                  <strong title={selectedDiffFile.path}>{stripNoteExtension(selectedDiffFile.name)}</strong>
                  {formatParentPath(selectedDiffFile.path) && (
                    <span>{formatParentPath(selectedDiffFile.path)}</span>
                  )}
                </div>
              </header>

              <div className={styles.gitDiffSummary}>
                <span className={styles.gitDiffStateTitle}>
                  {STATE_LABEL[selectedDiffFile.state]}
                </span>
                {(diff?.addCount || diff?.removeCount) ? (
                  <span className={styles.gitDiffStats}>
                    {diff.addCount > 0 && <span className={styles.gitDiffAdd}>+{diff.addCount}行</span>}
                    {diff.removeCount > 0 && <span className={styles.gitDiffRemove}>-{diff.removeCount}行</span>}
                  </span>
                ) : null}
              </div>

              <div className={styles.gitDiffContent}>
                {diffLoading ? (
                  <div className={styles.gitDiffState}>正在对比差异…</div>
                ) : diffError ? (
                  <div className={`${styles.gitDiffState} ${styles.gitDiffStateError}`}>
                    <span>{diffError}</span>
                    <button type="button" onClick={() => void openDiff(selectedDiffFile)}>重试</button>
                  </div>
                ) : diff?.binary ? (
                  <div className={styles.gitDiffState}>二进制文件，不支持预览文本差异。</div>
                ) : diff && diff.lines.length > 0 ? (
                  <div className={styles.gitDiffLines}>
                    {diff.lines.map((line, index) => {
                      const className = [
                        styles.gitDiffLine,
                        line.type === "add" ? styles.gitDiffLineAdd : "",
                        line.type === "remove" ? styles.gitDiffLineRemove : "",
                        line.type === "hunk" ? styles.gitDiffLineHunk : "",
                      ].filter(Boolean).join(" ");
                      return (
                        <div key={`${line.type}-${index}-${line.content}`} className={className}>
                          {line.type === "hunk" ? (
                            <span className={styles.gitDiffHunkLabel}>{line.content}</span>
                          ) : (
                            <>
                              <span className={styles.gitDiffMarker}>
                                {line.type === "add" ? "+" : line.type === "remove" ? "-" : ""}
                              </span>
                              <span className={styles.gitDiffText}>{line.content || " "}</span>
                            </>
                          )}
                        </div>
                      );
                    })}
                  </div>
                ) : diff ? (
                  <div className={styles.gitDiffState}>没有文本内容变动。</div>
                ) : null}
              </div>

              <footer className={styles.gitDiffFooter}>
                {confirmingDiffDiscard ? (
                  <div className={styles.gitDiffDiscardConfirmCard}>
                    <span className={styles.gitDiffDiscardConfirmText}>{DISCARD_WARN[selectedDiffFile.state]}</span>
                    <div className={styles.gitDiscardBtns}>
                      <button
                        type="button"
                        className={styles.gitDiscardCancel}
                        onClick={() => setConfirmingDiffDiscard(false)}
                        disabled={isDiscarding}
                      >取消</button>
                      <button
                        type="button"
                        className={styles.gitDiscardOk}
                        onClick={() => void discard(selectedDiffFile.path, selectedDiffFile.state)}
                        disabled={isDiscarding}
                      >{isDiscarding ? "…" : "确定还原"}</button>
                    </div>
                  </div>
                ) : (
                  <div className={styles.gitDiffNormalFooter}>
                    {selectedDiffFile.state !== "deleted" && onOpenFile ? (
                      <button
                        type="button"
                        className={styles.gitDiffFooterBtn}
                        onClick={() => onOpenFile(selectedDiffFile.path)}
                      >
                        打开此笔记
                      </button>
                    ) : null}
                    <button
                      type="button"
                      className={`${styles.gitDiffFooterBtn} ${styles.gitDiffFooterDanger}`}
                      onClick={() => setConfirmingDiffDiscard(true)}
                    >
                      还原此文件
                    </button>
                  </div>
                )}
              </footer>
            </>
          )}

          {/* Pane B: Version History Timeline detail */}
          {selectedPane === "history" && (
            <>
              <header className={styles.gitDiffHeader}>
                <button
                  type="button"
                  className={styles.gitDiffBack}
                  onClick={() => setSelectedPane("main")}
                  aria-label="返回"
                >
                  ‹
                </button>
                <div className={styles.gitDiffHeaderText}>
                  <strong>版本记录</strong>
                  <span>云端与本地的所有提交历史</span>
                </div>
              </header>

              <div className={styles.gitDiffContent} style={{ padding: "4px 18px 16px" }}>
                {historyLoading ? (
                  <div className={styles.gitDiffState}>正在载入版本历史…</div>
                ) : history.length === 0 ? (
                  <div className={styles.gitDiffState}>暂无版本同步记录</div>
                ) : (
                  <div className={styles.gitTimelineWrapper}>
                    {history.map((c, index) => (
                      <div key={c.hash} className={styles.gitTimelineItem}>
                        {/* Visual timeline node */}
                        <div className={styles.gitTimelineNodeWrap}>
                          <div className={styles.gitTimelineNode} />
                          {index < history.length - 1 && <div className={styles.gitTimelineLine} />}
                        </div>
                        
                        {/* Version Card */}
                        <div className={styles.gitTimelineCard}>
                          <div className={styles.gitTimelineCardHeader}>
                            <span className={styles.gitCommitHash}>{c.hash}</span>
                            <span className={styles.gitCommitDate}>{c.date}</span>
                          </div>
                          <div className={styles.gitCommitMsg} title={c.message}>
                            {c.message}
                          </div>
                          <div className={styles.gitCommitAuthor}>
                            by {c.author}
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </>
          )}

        </div>
      </div>
    </div>
  );
}
