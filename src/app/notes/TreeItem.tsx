"use client";

import { memo, useEffect, useRef, type CSSProperties, type ReactNode } from "react";
import type { NotesTreeNode } from "@/lib/notesTypes";
import {
  fileExtensionOf,
  fileKindOf,
  isImagePath,
  isPdfPath,
  stripNoteExtension,
  type FileKind,
  type TreeActionTarget,
} from "./noteFileUtils";
import styles from "./notes.module.css";

// 文件类型图标：形状先辨认，颜色只做二次提示（与桌面端同一套图形）
const FILE_KIND_SHAPES: Record<FileKind, ReactNode> = {
  doc: (
    <>
      <path d="M3 1h6l3 3v9H3V1z" />
      <path d="M9 1v3h3" />
    </>
  ),
  note: (
    <>
      <path d="M3 1h6l3 3v9H3V1z" />
      <path d="M9 1v3h3" />
      <path d="M5 8h4M5 10.5h2.5" />
    </>
  ),
  image: (
    <>
      <rect x="1.5" y="2.5" width="11" height="9" rx="1.5" />
      <circle cx="5" cy="5.75" r="0.9" />
      <path d="M2.2 10.2l2.8-2.8 2.4 2.4 1.8-1.8 2.6 2.6" />
    </>
  ),
  code: (
    <>
      <polyline points="4.5,3.8 1.6,7 4.5,10.2" />
      <polyline points="9.5,3.8 12.4,7 9.5,10.2" />
    </>
  ),
  pdf: (
    <>
      <path d="M2 2.5h4a1.8 1.8 0 0 1 1.8 1.8v7.2a1.4 1.4 0 0 0-1.4-1.4H2V2.5z" />
      <path d="M12 2.5H8a1.8 1.8 0 0 0-1.8 1.8v7.2a1.4 1.4 0 0 1 1.4-1.4H12V2.5z" />
    </>
  ),
  sheet: (
    <>
      <rect x="1.5" y="2.5" width="11" height="9" rx="1.5" />
      <path d="M1.5 5.6h11M5.4 5.6v5.9" />
    </>
  ),
  audio: (
    <>
      <path d="M5.6 9.4V3.3l6-1.1v6" />
      <circle cx="4.1" cy="9.9" r="1.6" />
      <circle cx="10.1" cy="8.8" r="1.6" />
    </>
  ),
  video: (
    <>
      <rect x="1.5" y="3" width="11" height="8" rx="1.5" />
      <path d="M6 5.7l3.1 1.9L6 9.5V5.7z" />
    </>
  ),
  archive: (
    <>
      <path d="M1.5 5h11v6.5a0.8 0.8 0 0 1-0.8 0.8H2.3a0.8 0.8 0 0 1-0.8-0.8V5z" />
      <path d="M2.6 2.2h8.8L12.5 5h-11L2.6 2.2z" />
      <path d="M6 7.6h2" />
    </>
  ),
};

const FILE_KIND_ICON_CLASS: Record<FileKind, string> = {
  doc: styles.fileIconDoc,
  note: styles.fileIconNote,
  image: styles.fileIconImage,
  code: styles.fileIconCode,
  pdf: styles.fileIconPdf,
  sheet: styles.fileIconSheet,
  audio: styles.fileIconAudio,
  video: styles.fileIconVideo,
  archive: styles.fileIconArchive,
};

const FILE_KIND_BADGE_CLASS: Record<FileKind, string> = {
  doc: styles.fileBadgeDoc,
  note: styles.fileBadgeNote,
  image: styles.fileBadgeImage,
  code: styles.fileBadgeCode,
  pdf: styles.fileBadgePdf,
  sheet: styles.fileBadgeSheet,
  audio: styles.fileBadgeAudio,
  video: styles.fileBadgeVideo,
  archive: styles.fileBadgeArchive,
};

function FileKindIcon({ kind }: { kind: FileKind }) {
  return (
    <svg
      className={`${styles.fileDot} ${FILE_KIND_ICON_CLASS[kind]}`}
      viewBox="0 0 14 14"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      style={{ width: "13px", height: "13px" }}
    >
      {FILE_KIND_SHAPES[kind]}
    </svg>
  );
}

function TreeActionMenu({
  target,
  onCreateNote,
  onCreateFolder,
  onImport,
  onRename,
  onDelete,
  onDownload,
}: {
  target: TreeActionTarget;
  onCreateNote: (folder: string) => void;
  onCreateFolder: (folder: string) => void;
  onImport: (folder: string) => void;
  onRename: (target: TreeActionTarget) => void;
  onDelete: (target: TreeActionTarget) => void;
  onDownload: (path: string) => void;
}) {
  const isFolder = target.kind === "folder";
  const canDownload = target.kind === "file" && (isPdfPath(target.path) || isImagePath(target.path));

  return (
    <div className={styles.treeActionMenu} role="menu" onClick={(event) => event.stopPropagation()}>
      {isFolder ? (
        <>
          <button type="button" className={styles.treeActionItem} role="menuitem" onClick={() => onCreateNote(target.path)}>新建笔记</button>
          <button type="button" className={styles.treeActionItem} role="menuitem" onClick={() => onCreateFolder(target.path)}>新建文件夹</button>
          <button type="button" className={styles.treeActionItem} role="menuitem" onClick={() => onImport(target.path)}>导入文件</button>
          <div className={styles.moreMenuDivider} role="separator" />
        </>
      ) : null}
      {canDownload ? (
        <button type="button" className={styles.treeActionItem} role="menuitem" onClick={() => onDownload(target.path)}>下载</button>
      ) : null}
      <button type="button" className={styles.treeActionItem} role="menuitem" onClick={() => onRename(target)}>重命名</button>
      <button type="button" className={`${styles.treeActionItem} ${styles.moreMenuItemDanger}`} role="menuitem" onClick={() => onDelete(target)}>删除</button>
    </div>
  );
}

type TreeItemProps = {
  node: NotesTreeNode;
  level: number;
  activePath: string | null;
  expandedFolders: Set<string>;
  searchQuery: string;
  activeMenuPath: string | null;
  isMobileViewport: boolean;
  renamingTarget: TreeActionTarget | null;
  renameValue: string;
  renameError: string | null;
  onToggle: (path: string) => void;
  onSelect: (path: string) => void;
  onOpenMenu: (target: TreeActionTarget) => void;
  onCloseMenu: () => void;
  onCreateNote: (folder: string) => void;
  onCreateFolder: (folder: string) => void;
  onImport: (folder: string) => void;
  onRename: (target: TreeActionTarget) => void;
  onDelete: (target: TreeActionTarget) => void;
  onDownload: (path: string) => void;
  onRenameValueChange: (val: string) => void;
  onRenameCommit: () => Promise<void>;
  onRenameCancel: () => void;
};

function TreeItem({
  node,
  level,
  activePath,
  expandedFolders,
  searchQuery,
  activeMenuPath,
  isMobileViewport,
  renamingTarget,
  renameValue,
  renameError,
  onToggle,
  onSelect,
  onOpenMenu,
  onCloseMenu,
  onCreateNote,
  onCreateFolder,
  onImport,
  onRename,
  onDelete,
  onDownload,
  onRenameValueChange,
  onRenameCommit,
  onRenameCancel,
}: TreeItemProps) {
  const isRenaming = renamingTarget?.path === node.path;
  const inlineInputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (isRenaming && inlineInputRef.current) {
      inlineInputRef.current.focus();
      inlineInputRef.current.select();
    }
  }, [isRenaming]);

  if (node.type === "file") {
    const isActive = node.path === activePath;
    const ext = fileExtensionOf(node.name);
    const kind = fileKindOf(ext);
    // md 是默认格式，不加角标；其余扩展名统一「标题 + 角标」，不在标题里重复
    const showBadge = ext !== "" && ext !== "md";
    const label = showBadge ? node.name.replace(/\.[^.]+$/, "") : stripNoteExtension(node.name);
    const fileExt = node.name.match(/\.[^.]+$/)?.[0] ?? "";
    const target: TreeActionTarget = { kind: "file", name: node.name, path: node.path };
    return (
      <div
        className={`${styles.treeNodeWrap} ${isRenaming ? styles.treeNodeWrapRenaming : ""}`}
        style={{ "--level": level } as CSSProperties}
        onContextMenu={(event) => {
          if (isRenaming) return;
          event.preventDefault();
          onOpenMenu(target);
        }}
      >
        {isRenaming ? (
          <>
            <div className={styles.treeRenameWrap}>
              <FileKindIcon kind={kind} />
              <input
                ref={inlineInputRef}
                className={styles.treeRenameInput}
                value={renameValue}
                onChange={(e) => { onRenameValueChange(e.target.value); }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") { e.preventDefault(); void onRenameCommit(); }
                  if (e.key === "Escape") { e.preventDefault(); onRenameCancel(); }
                }}
                onBlur={() => void onRenameCommit()}
                autoComplete="off"
                spellCheck={false}
                aria-label="重命名"
              />
              {fileExt ? <span className={styles.renameExtension}>{fileExt}</span> : null}
            </div>
            {renameError ? <span className={styles.treeRenameError}>{renameError}</span> : null}
          </>
        ) : (
          <>
            <button
              type="button"
              className={`${styles.treeFile} ${isActive ? styles.treeFileActive : ""}`}
              onClick={() => onSelect(node.path)}
              title={node.path}
            >
              <FileKindIcon kind={kind} />
              <span className={styles.treeLabel}>{label}</span>
              {showBadge ? (
                <span className={`${styles.fileTypeBadge} ${FILE_KIND_BADGE_CLASS[kind]}`}>{ext}</span>
              ) : null}
            </button>
            <button
              type="button"
              className={styles.treeNodeMore}
              onClick={(event) => {
                event.stopPropagation();
                onOpenMenu(target);
              }}
              aria-label={`${node.name} 的操作`}
              title="更多操作"
            >
              <svg viewBox="0 0 24 24" width="15" height="15" fill="currentColor" aria-hidden="true">
                <circle cx="5" cy="12" r="1.5" />
                <circle cx="12" cy="12" r="1.5" />
                <circle cx="19" cy="12" r="1.5" />
              </svg>
            </button>
            {!isMobileViewport && activeMenuPath === node.path ? (
              <TreeActionMenu
                target={target}
                onCreateNote={(folder) => { onCloseMenu(); onCreateNote(folder); }}
                onCreateFolder={(folder) => { onCloseMenu(); onCreateFolder(folder); }}
                onImport={(folder) => { onCloseMenu(); onImport(folder); }}
                onRename={(menuTarget) => { onCloseMenu(); onRename(menuTarget); }}
                onDelete={(menuTarget) => { onCloseMenu(); onDelete(menuTarget); }}
                onDownload={(path) => { onCloseMenu(); onDownload(path); }}
              />
            ) : null}
          </>
        )}
      </div>
    );
  }

  const isExpanded = searchQuery ? true : expandedFolders.has(node.path);
  const target: TreeActionTarget = { kind: "folder", name: node.name, path: node.path };
  return (
    <div className={styles.treeGroup}>
      {node.path ? (
        <div
          className={`${styles.treeNodeWrap} ${isRenaming ? styles.treeNodeWrapRenaming : ""}`}
          style={{ "--level": level } as CSSProperties}
          onContextMenu={(event) => {
            if (isRenaming) return;
            event.preventDefault();
            onOpenMenu(target);
          }}
        >
          {isRenaming ? (
            <>
              <div className={styles.treeRenameWrap}>
                <span className={`${styles.chevron} ${isExpanded ? styles.chevronOpen : ""}`} aria-hidden="true">›</span>
                <svg className={styles.folderGlyph} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ width: "16px", height: "16px", color: "var(--notes-accent)" }}>
                  {isExpanded ? (
                    <>
                      <path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.93a2 2 0 0 1-1.66-.9l-.82-1.2A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2z" fill="var(--notes-accent-bg)" />
                      <path d="M2 10h20" />
                    </>
                  ) : (
                    <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" fill="var(--notes-accent-bg)" />
                  )}
                </svg>
                <input
                  ref={inlineInputRef}
                  className={styles.treeRenameInput}
                  value={renameValue}
                  onChange={(e) => { onRenameValueChange(e.target.value); }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") { e.preventDefault(); void onRenameCommit(); }
                    if (e.key === "Escape") { e.preventDefault(); onRenameCancel(); }
                  }}
                  onBlur={() => void onRenameCommit()}
                  autoComplete="off"
                  spellCheck={false}
                  aria-label="重命名"
                />
              </div>
              {renameError ? <span className={styles.treeRenameError}>{renameError}</span> : null}
            </>
          ) : (
            <>
              <button
                type="button"
                className={styles.treeFolder}
                onClick={() => onToggle(node.path)}
                title={node.path}
              >
                <span className={`${styles.chevron} ${isExpanded ? styles.chevronOpen : ""}`} aria-hidden="true">
                  ›
                </span>
                <svg className={styles.folderGlyph} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ width: "16px", height: "16px", color: "var(--notes-accent)" }}>
                  {isExpanded ? (
                    <>
                      <path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.93a2 2 0 0 1-1.66-.9l-.82-1.2A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2z" fill="var(--notes-accent-bg)" />
                      <path d="M2 10h20" />
                    </>
                  ) : (
                    <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" fill="var(--notes-accent-bg)" />
                  )}
                </svg>
                <span className={styles.treeLabel}>{node.name}</span>
              </button>
              <button
                type="button"
                className={styles.treeNodeMore}
                onClick={(event) => {
                  event.stopPropagation();
                  onOpenMenu(target);
                }}
                aria-label={`${node.name} 的操作`}
                title="更多操作"
              >
                <svg viewBox="0 0 24 24" width="15" height="15" fill="currentColor" aria-hidden="true">
                  <circle cx="5" cy="12" r="1.5" />
                  <circle cx="12" cy="12" r="1.5" />
                  <circle cx="19" cy="12" r="1.5" />
                </svg>
              </button>
              {!isMobileViewport && activeMenuPath === node.path ? (
                <TreeActionMenu
                  target={target}
                  onCreateNote={(folder) => { onCloseMenu(); onCreateNote(folder); }}
                  onCreateFolder={(folder) => { onCloseMenu(); onCreateFolder(folder); }}
                  onImport={(folder) => { onCloseMenu(); onImport(folder); }}
                  onRename={(menuTarget) => { onCloseMenu(); onRename(menuTarget); }}
                  onDelete={(menuTarget) => { onCloseMenu(); onDelete(menuTarget); }}
                  onDownload={(path) => { onCloseMenu(); onDownload(path); }}
                />
              ) : null}
            </>
          )}
        </div>
      ) : null}

      {isExpanded || !node.path ? (
        <div className={styles.treeChildren}>
          {node.children.map((child) => (
            <MemoTreeItem
              key={`${child.type}:${child.path}`}
              node={child}
              level={node.path ? level + 1 : level}
              activePath={activePath}
              expandedFolders={expandedFolders}
              searchQuery={searchQuery}
              activeMenuPath={activeMenuPath}
              isMobileViewport={isMobileViewport}
              renamingTarget={renamingTarget}
              renameValue={renameValue}
              renameError={renameError}
              onToggle={onToggle}
              onSelect={onSelect}
              onOpenMenu={onOpenMenu}
              onCloseMenu={onCloseMenu}
              onCreateNote={onCreateNote}
              onCreateFolder={onCreateFolder}
              onImport={onImport}
              onRename={onRename}
              onDelete={onDelete}
              onDownload={onDownload}
              onRenameValueChange={onRenameValueChange}
              onRenameCommit={onRenameCommit}
              onRenameCancel={onRenameCancel}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

// memo：父组件（NotesExplorer）状态变化频繁，文件树只在树数据 / 选中态 /
// 重命名态变化时才需要重渲染。回调 props 已在调用侧用 useCallback 稳定。
const MemoTreeItem = memo(TreeItem);

export default MemoTreeItem;
