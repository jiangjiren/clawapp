"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react";
import { flushSync } from "react-dom";
import type {
  NotesDirectoryNode,
  NotesFileNode,
  NotesFileResponse,
  NotesSearchHit,
  NotesSearchResponse,
  NotesTreeNode,
  NotesTreeResponse,
} from "@/lib/notesTypes";
import { extractHeadings, type TocEntry } from "@/lib/noteToc";
import dynamic from "next/dynamic";
import NotesHtml, { type NotesHtmlHandle } from "./NotesHtml";
import NotesMarkdown from "./NotesMarkdown";
import { NoteTabs, useNoteTabs } from "./NoteTabs";
import NotesGit from "./NotesGit";
import NotesDashboard from "./NotesDashboard";
import TreeItem from "./TreeItem";
import QuickSwitcher from "./QuickSwitcher";
import { isImagePath, isPdfPath, stripNoteExtension, type TreeActionTarget } from "./noteFileUtils";
import styles from "./notes.module.css";
import type { NotesEditorHandle } from "./NotesEditor";

// CodeMirror 不支持 SSR，动态加载
const NotesEditor = dynamic(() => import("./NotesEditor"), { ssr: false });

type LoadState = "idle" | "loading" | "ready" | "error";

const PANEL_WIDTH_KEY = "inkfellow-notes-panel-width-v1";
const PANEL_VISIBLE_KEY = "inkfellow-notes-panel-visible-v1";
const TOC_SECTION_KEY = "inkfellow-notes-toc-section-open-v1";
const SIDEBAR_VISIBLE_KEY = "inkfellow-notes-sidebar-visible-v1";
const SIDEBAR_WIDTH_KEY = "inkfellow-notes-sidebar-width-v1";
const NOTE_SCROLL_STORAGE_PREFIX = "inkfellow-notes-scroll-v1:";
const LAST_FILE_KEY = "inkfellow-notes-last-file-v1";
// 快速记录（草稿）默认落盘的文件夹，可在草稿顶部「存到…」切换并记忆
const CAPTURE_FOLDER_KEY = "inkfellow-capture-folder-v1";
const DEFAULT_CAPTURE_FOLDER = "灵感箱";

const pad2 = (n: number) => String(n).padStart(2, "0");
const captureStamp = (d = new Date()) =>
  `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}-${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}`;

const DEFAULT_ASSISTANT_PANEL_WIDTH = 520;
const MIN_ASSISTANT_PANEL_WIDTH = 340;
const MAX_ASSISTANT_PANEL_WIDTH = 900;
const DEFAULT_SIDEBAR_WIDTH = 280;
const MIN_SIDEBAR_WIDTH = 180;
const MAX_SIDEBAR_WIDTH = 400;

type NotesShellStyle = CSSProperties & {
  "--assistant-panel-width": string;
  "--sidebar-width": string;
  "--keyboard-height": string;
};

type ShareInfo = {
  token: string | null;
  url: string | null;
};

type ShareState = "idle" | "loading" | "ready" | "creating" | "copying" | "revoking" | "error";
type ScrollSnapshot =
  | { target: "reader"; top: number; left: number }
  | { target: "window"; top: number; left: number };

type LoadNoteOptions = {
  preserveScroll?: boolean;
  restoreStoredScroll?: boolean;
  silent?: boolean;
  updateHistory?: boolean;
};

type NavHistoryEntry = {
  path: string;
  hash: string | null;
};

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max);

const isSearchQueryReady = (value: string) => {
  const trimmed = value.trim();
  return trimmed.length >= 2 || /[^\u0000-\u007f]/.test(trimmed);
};
const getParentFolder = (filePath: string) => filePath.includes("/") ? filePath.split("/").slice(0, -1).join("/") : "";
const normalizeNavigationHash = (hash?: string | null) => {
  const value = hash?.trim() ?? "";
  if (!value) return null;
  return value.startsWith("#") ? value : `#${value}`;
};

const resolveRelativeVaultPath = (base: string, relativePath: string) => {
  const output = base ? base.split("/") : [];
  const segments = relativePath.replace(/\\/g, "/").replace(/^\.\//, "").split("/");
  for (const segment of segments) {
    if (segment === "..") output.pop();
    else if (segment && segment !== ".") output.push(segment);
  }
  return output.join("/");
};

const resolveHtmlLinkTarget = (
  rawHref: string,
  currentPath: string,
  files: NotesFileNode[],
): { path: string; hash: string | null } | null => {
  const hashIndex = rawHref.indexOf("#");
  const pathAndQuery = hashIndex === -1 ? rawHref : rawHref.slice(0, hashIndex);
  const queryIndex = pathAndQuery.indexOf("?");
  const encodedPath = queryIndex === -1 ? pathAndQuery : pathAndQuery.slice(0, queryIndex);
  if (!encodedPath) return null;

  const decodedPath = decodeLoose(encodedPath).replace(/\\/g, "/");
  const resolved = decodedPath.startsWith("/")
    ? resolveRelativeVaultPath("", decodedPath.replace(/^\/+/, ""))
    : resolveRelativeVaultPath(getParentFolder(currentPath), decodedPath);
  const candidates = [resolved];
  if (!/\.[^/]+$/.test(resolved)) {
    candidates.push(`${resolved}.md`, `${resolved}.html`, `${resolved}.htm`);
  }

  const exact = files.find((file) => candidates.includes(file.path));
  const matched = exact ?? files.find((file) =>
    candidates.some((candidate) => file.path.toLocaleLowerCase() === candidate.toLocaleLowerCase()),
  );
  if (!matched) return null;

  const fragment = hashIndex === -1 ? null : decodeLoose(rawHref.slice(hashIndex + 1));
  return {
    path: matched.path,
    hash: fragment === null ? null : normalizeNavigationHash(fragment),
  };
};

const sanitizeEntryName = (value: string) => value.trim().replace(/[/\\:*?"<>|]/g, "-");
const replaceMovedPath = (currentPath: string, oldPath: string, nextPath: string, kind: TreeActionTarget["kind"]) => {
  if (kind === "file") {
    return currentPath === oldPath ? nextPath : currentPath;
  }
  if (currentPath === oldPath) {
    return nextPath;
  }
  return currentPath.startsWith(`${oldPath}/`) ? `${nextPath}${currentPath.slice(oldPath.length)}` : currentPath;
};

const decodeLoose = (value: string) => {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
};

const getFilenameFromPath = (value: string | null | undefined, fallback: string) => {
  const filename = value?.split("/").pop();
  return filename ? decodeLoose(filename) : fallback;
};

const normalizeIndexKey = (value: string) =>
  decodeLoose(value)
    .replace(/\\/g, "/")
    .replace(/^\/+/, "")
    .replace(/\.(md|html?)$/i, "")
    .trim()
    .toLocaleLowerCase();

const collectFiles = (node: NotesTreeNode): NotesFileNode[] => {
  if (node.type === "file") {
    return [node];
  }

  return node.children.flatMap((child) => collectFiles(child));
};

const getAncestorFolders = (filePath: string) => {
  const parts = filePath.split("/");
  const folders: string[] = [];
  for (let index = 1; index < parts.length; index += 1) {
    folders.push(parts.slice(0, index).join("/"));
  }
  return folders;
};

// ── 新建免命名：占位名 + 首行自动改名 ─────────────────────
const UNTITLED_NAME = "无标题";

/** 去掉 YAML front matter：自动命名只看正文，不该把 title: 之类的元数据当首行 */
const stripFrontMatter = (content: string) => {
  if (!content.startsWith("---")) return content;
  const firstNewline = content.indexOf("\n");
  if (firstNewline === -1) return content;
  const rest = content.slice(firstNewline + 1);
  const closing = /^---[ \t]*\r?$/m.exec(rest);
  if (!closing) return content;
  const after = rest.slice(closing.index + closing[0].length);
  return after.startsWith("\n") ? after.slice(1) : after;
};

/** 正文首个非空行 → 文件名：去掉 markdown 记号与文件系统非法字符，截断 60 字 */
const titleFromContent = (content: string) => {
  const line = stripFrontMatter(content)
    .split("\n")
    .map((rawLine) => rawLine.trim())
    .find((rawLine) => rawLine && rawLine !== "---");
  if (!line) return "";
  return line
    .replace(/^#{1,6}\s*/, "")
    .replace(/^[-*+>]\s*/, "")
    .replace(/[\\/:*?"<>|]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 60);
};

/** 同目录内不冲突的占位名：无标题、无标题 2… */
const uniqueUntitledName = (files: NotesFileNode[], folder: string) => {
  const taken = new Set(
    files
      .filter((file) => getParentFolder(file.path) === folder)
      .map((file) => file.name.replace(/\.[^./]+$/, "").toLowerCase()),
  );
  if (!taken.has(UNTITLED_NAME.toLowerCase())) return UNTITLED_NAME;
  for (let index = 2; index < 1000; index += 1) {
    const candidate = `${UNTITLED_NAME} ${index}`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
  return `${UNTITLED_NAME} ${Date.now()}`;
};

/** 图片查看器翻页队列：只在同一目录内、按文件树顺序 */
type ImageViewerNavigation = {
  total: number;
  index: number;
  previous: NotesFileNode | null;
  next: NotesFileNode | null;
};

const findPreferredInitialFile = (files: NotesFileNode[]) => {
  try {
    const last = window.localStorage.getItem(LAST_FILE_KEY);
    if (last && files.some((f) => f.path === last)) return last;
  } catch { /* ignore */ }
  return null;
};

const getNoteScrollStorageKey = (path: string) => `${NOTE_SCROLL_STORAGE_PREFIX}${path}`;

const isScrollSnapshot = (value: unknown): value is ScrollSnapshot => {
  if (!value || typeof value !== "object") {
    return false;
  }
  const snapshot = value as Partial<ScrollSnapshot>;
  return (snapshot.target === "reader" || snapshot.target === "window") &&
    typeof snapshot.top === "number" &&
    typeof snapshot.left === "number";
};

const readStoredScrollSnapshot = (path: string): ScrollSnapshot | null => {
  try {
    const raw = window.sessionStorage.getItem(getNoteScrollStorageKey(path));
    if (!raw) {
      return null;
    }
    const parsed: unknown = JSON.parse(raw);
    return isScrollSnapshot(parsed) ? parsed : null;
  } catch {
    return null;
  }
};

const writeStoredScrollSnapshot = (path: string, snapshot: ScrollSnapshot) => {
  try {
    window.sessionStorage.setItem(getNoteScrollStorageKey(path), JSON.stringify(snapshot));
  } catch { /* ignore storage failures */ }
};

/** 递归收集所有文件夹路径（含根，用空字符串表示） */
const collectFolders = (node: NotesTreeNode, result: string[] = []): string[] => {
  if (node.type === "directory") {
    result.push(node.path); // 根目录 path 为 ""
    for (const child of node.children) {
      collectFolders(child, result);
    }
  }
  return result;
};

const filterTree = (node: NotesTreeNode, query: string): NotesTreeNode | null => {
  if (!query) {
    return node;
  }

  const normalizedQuery = query.toLocaleLowerCase();
  if (node.type === "file") {
    return node.name.toLocaleLowerCase().includes(normalizedQuery) ||
      node.path.toLocaleLowerCase().includes(normalizedQuery)
      ? node
      : null;
  }

  const children = node.children
    .map((child) => filterTree(child, query))
    .filter((child): child is NotesTreeNode => Boolean(child));

  if (children.length > 0 || node.name.toLocaleLowerCase().includes(normalizedQuery)) {
    return {
      ...node,
      children,
    };
  }

  return null;
};

function ArticleToc({
  headings,
  activeSlug,
  onSelect,
  variant = "panel",
  collapsed = false,
  onToggleCollapsed,
}: {
  headings: TocEntry[];
  activeSlug: string;
  onSelect: (slug: string) => void;
  // "panel"：移动端 sheet / 通用；"section"：桌面左栏可折叠手风琴段
  variant?: "panel" | "section";
  collapsed?: boolean;
  onToggleCollapsed?: () => void;
}) {
  const minLevel = headings.length > 0 ? Math.min(...headings.map((h) => h.level)) : 0;
  const isSection = variant === "section";

  const list =
    headings.length > 0 ? (
      <ul className={styles.articleTocList}>
        {headings.map((heading, index) => (
          <li key={`${heading.slug}-${index}`}>
            <button
              type="button"
              className={`${styles.articleTocLink} ${heading.level > minLevel ? styles.articleTocLinkSub : ""} ${activeSlug === heading.slug ? styles.articleTocLinkActive : ""}`}
              onClick={() => onSelect(heading.slug)}
            >
              {heading.text}
            </button>
          </li>
        ))}
      </ul>
    ) : (
      <p className={styles.articleTocEmpty}>当前文章没有可显示的目录。</p>
    );

  if (isSection) {
    return (
      <nav className={styles.tocSection} aria-label="当前文章目录">
        <button
          type="button"
          className={styles.tocSectionHeader}
          onClick={onToggleCollapsed}
          aria-expanded={!collapsed}
        >
          <svg
            className={`${styles.tocSectionChevron} ${collapsed ? styles.tocSectionChevronCollapsed : ""}`}
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <polyline points="6 9 12 15 18 9" />
          </svg>
          <span>大纲</span>
        </button>
        {!collapsed ? <div className={styles.tocSectionBody}>{list}</div> : null}
      </nav>
    );
  }

  return (
    <nav className={styles.articleToc} aria-label="当前文章目录">
      <div className={styles.articleTocHeader}>
        <span>当前文章</span>
        <strong>目录</strong>
      </div>
      {list}
    </nav>
  );
}

function FolderPicker({
  id,
  tree,
  value,
  onChange,
  tabIndex,
}: {
  id?: string;
  tree: NotesDirectoryNode | null;
  value: string;
  onChange: (path: string) => void;
  tabIndex?: number;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const containerRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const selectedRef = useRef<HTMLButtonElement>(null);

  const folders = useMemo(() => (tree ? collectFolders(tree) : [""]), [tree]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return q ? folders.filter((f) => f.toLowerCase().includes(q)) : folders;
  }, [folders, search]);

  const showSearch = folders.length > 8;

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
        setSearch("");
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    if (showSearch) {
      setTimeout(() => searchRef.current?.focus(), 30);
    } else {
      setTimeout(() => selectedRef.current?.scrollIntoView({ block: "nearest" }), 30);
    }
  }, [open, showSearch]);

  const segments = value ? value.split("/") : [];
  const leafName = segments.length > 0 ? segments[segments.length - 1] : null;
  const parentPath = segments.length > 1 ? segments.slice(0, -1).join(" / ") : null;

  return (
    <div ref={containerRef} className={styles.folderPicker}>
      <button
        id={id}
        type="button"
        className={`${styles.folderPickerTrigger} ${open ? styles.folderPickerTriggerOpen : ""}`}
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-haspopup="listbox"
        tabIndex={tabIndex}
      >
        <svg className={styles.folderPickerIcon} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
        </svg>
        <span className={styles.folderPickerLabel}>
          {!value ? (
            <span className={styles.folderPickerLeaf}>根目录</span>
          ) : (
            <>
              {parentPath && <span className={styles.folderPickerParent}>{parentPath} /&nbsp;</span>}
              <span className={styles.folderPickerLeaf}>{leafName}</span>
            </>
          )}
        </span>
        <svg className={`${styles.folderPickerChevron} ${open ? styles.folderPickerChevronOpen : ""}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>

      {open && (
        <div className={styles.folderPickerPopover} role="listbox" aria-label="选择文件夹位置">
          {showSearch && (
            <div className={styles.folderPickerSearchWrap}>
              <svg className={styles.folderPickerSearchIcon} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <circle cx="11" cy="11" r="8" />
                <line x1="21" y1="21" x2="16.65" y2="16.65" />
              </svg>
              <input
                ref={searchRef}
                type="text"
                className={styles.folderPickerSearchInput}
                placeholder="搜索文件夹…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Escape") { setOpen(false); setSearch(""); }
                }}
              />
            </div>
          )}
          <div className={styles.folderPickerList}>
            {filtered.length === 0 ? (
              <div className={styles.folderPickerEmpty}>无匹配文件夹</div>
            ) : filtered.map((folder) => {
              const level = folder ? folder.split("/").length : 0;
              const name = folder ? folder.split("/").pop()! : "根目录";
              const isSelected = folder === value;
              return (
                <button
                  key={folder}
                  ref={isSelected ? selectedRef : null}
                  type="button"
                  role="option"
                  aria-selected={isSelected}
                  className={`${styles.folderPickerItem} ${isSelected ? styles.folderPickerItemSelected : ""}`}
                  style={{ "--fp-level": level } as CSSProperties}
                  onClick={() => { onChange(folder); setOpen(false); setSearch(""); }}
                >
                  <svg className={styles.folderPickerItemIcon} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
                  </svg>
                  <span>{name}</span>
                  {isSelected && (
                    <svg className={styles.folderPickerItemCheck} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <polyline points="20 6 9 17 4 12" />
                    </svg>
                  )}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

interface TauriWindow {
  __TAURI__?: {
    core?: {
      invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
    };
  };
  __TAURI_INTERNALS__?: {
    invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
  };
}

export default function NotesExplorer() {
  const [tree, setTree] = useState<NotesDirectoryNode | null>(null);
  const [wikiAliases, setWikiAliases] = useState<Map<string, string[]>>(new Map());
  const [vaultPath, setVaultPath] = useState<string | null>(null);
  const [mounted, setMounted] = useState(false);
  const [vaultMenuOpen, setVaultMenuOpen] = useState(false);
  const vaultMenuRef = useRef<HTMLDivElement | null>(null);
  const vaultButtonRef = useRef<HTMLButtonElement | null>(null);
  const [recentVaults, setRecentVaults] = useState<string[]>([]);

  useEffect(() => {
    setMounted(true);
  }, []);

  const tauriWin = typeof window !== "undefined" ? (window as unknown as TauriWindow) : null;
  const isTauri = !!tauriWin && (tauriWin.__TAURI__ !== undefined || tauriWin.__TAURI_INTERNALS__ !== undefined);
  const showTauri = mounted && isTauri;

  // Track recent vaults in localStorage
  useEffect(() => {
    if (vaultPath) {
      try {
        const stored = localStorage.getItem("recent_vaults");
        const list: string[] = stored ? JSON.parse(stored) : [];
        const newList = [vaultPath, ...list.filter((p) => p !== vaultPath)].slice(0, 5);
        setRecentVaults(newList);
        localStorage.setItem("recent_vaults", JSON.stringify(newList));
      } catch { /* ignore */ }
    }
  }, [vaultPath]);

  // Click outside vault menu close
  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (
        vaultMenuOpen &&
        vaultMenuRef.current &&
        !vaultMenuRef.current.contains(e.target as Node) &&
        vaultButtonRef.current &&
        !vaultButtonRef.current.contains(e.target as Node)
      ) {
        setVaultMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [vaultMenuOpen]);

  const handleChooseVault = useCallback(async () => {
    if (isTauri && tauriWin) {
      try {
        const invoke = tauriWin.__TAURI_INTERNALS__?.invoke || tauriWin.__TAURI__?.core?.invoke;
        if (invoke) {
          const path = await invoke("select_and_set_vault_cmd") as string;
          setVaultPath(path);
          setVaultMenuOpen(false);
        }
      } catch (e) {
        console.error("Failed to select vault:", e);
      }
    }
  }, [isTauri, tauriWin]);

  const handleSwitchToVault = useCallback(async (path: string) => {
    setVaultMenuOpen(false);
    if (isTauri && tauriWin && path !== vaultPath) {
      try {
        const invoke = tauriWin.__TAURI_INTERNALS__?.invoke || tauriWin.__TAURI__?.core?.invoke;
        if (invoke) {
          await invoke("set_vault_path_cmd", { path });
        }
      } catch (e) {
        console.error("Failed to switch vault:", e);
      }
    }
  }, [isTauri, tauriWin, vaultPath]);

  useEffect(() => {
    if (isTauri && tauriWin) {
      const invoke = tauriWin.__TAURI_INTERNALS__?.invoke || tauriWin.__TAURI__?.core?.invoke;
      if (invoke) {
        invoke("get_vault_path_cmd").then((path: unknown) => {
          setVaultPath(path as string);
        }).catch(() => {});
      }
    }
  }, [isTauri, tauriWin]);

  const vaultName = useMemo(() => {
    if (!vaultPath) return "未指定笔记本";
    const segments = vaultPath.split(/[/\\]/).filter(Boolean);
    return segments[segments.length - 1] || vaultPath;
  }, [vaultPath]);

  const getDisplayPath = useCallback((p: string | null) => {
    if (!p) return "";
    const len = p.length;
    if (len > 30) {
      return p.slice(0, 10) + "..." + p.slice(len - 17);
    }
    return p;
  }, []);

  // 当前文件树的结构指纹，用于轮询比对，只在增/删/改名时才刷新
  const treeRevRef = useRef<string | null>(null);
  const [activePath, setActivePath] = useState<string | null>(null);
  // 轻量多标签：只是「已打开路径」的书签列表，文档状态仍由下方单例逻辑持有
  const { tabs, ensureTab, removeTab: removeTabEntry, mapTabs, pruneTabs } = useNoteTabs();
  const [note, setNote] = useState<NotesFileResponse | null>(null);
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(new Set());
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<NotesSearchHit[]>([]);
  const [searchState, setSearchState] = useState<LoadState>("idle");
  const [searchError, setSearchError] = useState<string | null>(null);
  const [activeSearchIndex, setActiveSearchIndex] = useState(-1);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const [treeState, setTreeState] = useState<LoadState>("idle");
  const [noteState, setNoteState] = useState<LoadState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [isMobileViewport, setIsMobileViewport] = useState(false);
  const [sidebarVisible, setSidebarVisible] = useState(true);
  // 侧栏悬浮：隐藏时鼠标移到左缘以覆盖层唤出（fixed，不回流），移开滑出
  const [sidebarPeek, setSidebarPeek] = useState<"closed" | "open" | "closing">("closed");
  const sidebarPeekTimersRef = useRef<{ hide: number | null; close: number | null }>({ hide: null, close: null });
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const [mobileAssistantSheet, setMobileAssistantSheet] = useState<'closed' | 'expanded'>('closed');
  const mobileAssistantPanelOpen = mobileAssistantSheet === 'expanded';
  const mobileOverlayOpenTime = useRef(0);
  // 移动端底部 sheet 的跟手拖拽状态（用 ref 直接改样式，避免每帧 re-render）
  const assistantPanelRef = useRef<HTMLElement>(null);
  const sheetDragRef = useRef<{
    active: boolean; startY: number; baseY: number; panelH: number;
    lastY: number; lastT: number; velocity: number; moved: number;
  } | null>(null);
  const [assistantPanelVisible, setAssistantPanelVisible] = useState(false);
  // 面板内（设置/历史）是否正显示为满铺子页面：此时唯一的"返回"控件应是子页面自己的返回按钮，
  // 收起整个面板的按钮需要让位，避免两个"返回"叠在同一个左上角
  const [isChildOverlayOpen, setIsChildOverlayOpen] = useState(false);
  // 大纲已从右侧面板迁出：桌面端常驻左栏（可折叠），移动端用底部 sheet 唤出
  const [tocSectionOpen, setTocSectionOpen] = useState(true);
  const [mobileTocOpen, setMobileTocOpen] = useState(false);
  const [gitPanelOpen, setGitPanelOpen] = useState(false);
  const [assistantPanelWidth, setAssistantPanelWidth] = useState(DEFAULT_ASSISTANT_PANEL_WIDTH);
  const [isResizingAssistantPanel, setIsResizingAssistantPanel] = useState(false);
  const [sidebarWidth, setSidebarWidth] = useState(DEFAULT_SIDEBAR_WIDTH);
  const [isResizingSidebar, setIsResizingSidebar] = useState(false);
  const [shareModalOpen, setShareModalOpen] = useState(false);
  const [shareState, setShareState] = useState<ShareState>("idle");
  const [shareToken, setShareToken] = useState<string | null>(null);
  const [shareUrl, setShareUrl] = useState<string | null>(null);
  const [selectionRect, setSelectionRect] = useState<DOMRect | null>(null);

  useEffect(() => {
    const handleSelectionChange = () => {
      const selection = window.getSelection();
      if (selection && selection.rangeCount > 0 && !selection.isCollapsed) {
        const text = selection.toString().trim();
        if (text.length > 0) {
          const range = selection.getRangeAt(0);
          const rect = range.getBoundingClientRect();
          setSelectionRect(rect);
        } else {
          setSelectionRect(null);
        }
      } else {
        setSelectionRect(null);
      }
    };
    document.addEventListener("selectionchange", handleSelectionChange);
    return () => document.removeEventListener("selectionchange", handleSelectionChange);
  }, []);
  const [shareMessage, setShareMessage] = useState<string | null>(null);
  const [globalCreateMenuOpen, setGlobalCreateMenuOpen] = useState(false);
  const globalCreateMenuRef = useRef<HTMLDivElement>(null);
  const globalCreateButtonRef = useRef<HTMLButtonElement>(null);
  const [treeMenuTarget, setTreeMenuTarget] = useState<TreeActionTarget | null>(null);
  const [treeSheetTarget, setTreeSheetTarget] = useState<TreeActionTarget | null>(null);
  const [renameTarget, setRenameTarget] = useState<TreeActionTarget | null>(null);
  const [renameName, setRenameName] = useState("");
  const [renameError, setRenameError] = useState<string | null>(null);
  const renameInProgressRef = useRef(false);
  const [deleteTarget, setDeleteTarget] = useState<TreeActionTarget | null>(null);
  const [importFolder, setImportFolder] = useState("");
  const [importLoading, setImportLoading] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  // 分批导入进度：total=总数, done=已处理数；importFailed=失败清单（全部跑完后展示）
  const [importProgress, setImportProgress] = useState<{ total: number; done: number } | null>(null);
  const [importFailed, setImportFailed] = useState<Array<{ name: string; reason: string }>>([]);
  const importInputRef = useRef<HTMLInputElement>(null);
  // ── ⋯ 更多菜单 ───────────────────────────────────────
  const [moreMenuOpen, setMoreMenuOpen] = useState(false);
  const moreMenuRef = useRef<HTMLDivElement>(null);
  const moreButtonRef = useRef<HTMLButtonElement>(null);
  // ── 删除确认条 ───────────────────────────────────────
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [deleteLoading, setDeleteLoading] = useState(false);
  const [newNoteOpen, setNewNoteOpen] = useState(false);
  // 新建后尚未命名的笔记：文件名跟随正文首行，用户手动改名或切走即退出
  const [autoTitlePath, setAutoTitlePath] = useState<string | null>(null);
  const autoTitlePathRef = useRef<string | null>(null);
  const [quickSwitcherOpen, setQuickSwitcherOpen] = useState(false);
  const [newNoteTitle, setNewNoteTitle] = useState("");
  const [newNoteFolder, setNewNoteFolder] = useState("");
  const [newNoteError, setNewNoteError] = useState<string | null>(null);
  const [newNoteLoading, setNewNoteLoading] = useState(false);
  const newNoteTitleRef = useRef<HTMLInputElement>(null);
  // ── 新建文件夹 ────────────────────────────────────────
  const [newFolderOpen, setNewFolderOpen] = useState(false);
  const [newFolderName, setNewFolderName] = useState("");
  const [newFolderParent, setNewFolderParent] = useState("");
  const [newFolderError, setNewFolderError] = useState<string | null>(null);
  const [newFolderLoading, setNewFolderLoading] = useState(false);
  const newFolderNameRef = useRef<HTMLInputElement>(null);
  // inline new-folder sub-form inside new-note dialog
  const [inlineFolderOpen, setInlineFolderOpen] = useState(false);
  const [inlineFolderName, setInlineFolderName] = useState("");
  const [inlineFolderError, setInlineFolderError] = useState<string | null>(null);
  const [inlineFolderLoading, setInlineFolderLoading] = useState(false);
  const inlineFolderInputRef = useRef<HTMLInputElement>(null);

  // ── 编辑模式 ──────────────────────────────────────────
  const [isEditing, setIsEditing] = useState(false);
  // ── 快速记录（草稿态）：进编辑器先写、敲第一个字才落盘 ──
  const [isDraft, setIsDraft] = useState(false);
  const [captureFolder, setCaptureFolder] = useState(DEFAULT_CAPTURE_FOLDER);
  const isDraftRef = useRef(false);
  const captureFolderRef = useRef(DEFAULT_CAPTURE_FOLDER);
  const draftCreatedPathRef = useRef<string | null>(null);
  const draftCreatingRef = useRef(false); // PUT 正在进行中，防止竞态自动保存
  const skipNextFlushRef = useRef(false); // 删除后 goHome 时跳过 flush（文件已不存在）
  // 草稿首次落盘会让 note.path 从 null 变为新路径，需跳过「切换笔记退出编辑」那一次
  const keepEditingOnCommitRef = useRef(false);
  const [editContent, setEditContent] = useState("");
  const [savedFlash, setSavedFlash] = useState(false); // 「已保存」短暂提示
  const [editorMinHeight, setEditorMinHeight] = useState(0); // 占位高度，防 scroll 被钳制
  const [hasGitChanges, setHasGitChanges] = useState(false); // 当前文件有未提交改动
  const [globalGitPending, setGlobalGitPending] = useState<number | null>(null); // 全局待同步数
  const editorFocusRef = useRef<NotesEditorHandle>(null);
  const autoSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingHashRef = useRef<string | null>(null);
  const activePathRef = useRef<string | null>(null);
  // loadNote 切换窗口内为 true：loading 骨架/内容替换会把 scrollTop 钳制到 0，
  // 此时的 scroll 事件不能写滚动快照，否则会覆盖旧文件的真实阅读位置
  const suppressScrollSaveRef = useRef(false);
  const noteUpdatedAtRef = useRef<string | null>(null);
  const claudeFrameRef = useRef<HTMLIFrameElement>(null);
  const htmlPreviewRef = useRef<NotesHtmlHandle>(null);
  // iframe 是否已 load 完：load 前 postMessage 会丢，提问先暂存到 pending，就绪后补投
  const claudeFrameReadyRef = useRef(false);
  const pendingClaudeAskRef = useRef<string | null>(null);
  const readerRef = useRef<HTMLElement>(null);
  const isSilentReloadRef = useRef(false);
  const syncTocRef = useRef<(() => void) | null>(null);
  const [activeTocSlug, setActiveTocSlug] = useState("");
  const [htmlToc, setHtmlToc] = useState<{ path: string; entries: TocEntry[] }>({
    path: "",
    entries: [],
  });
  const [isScrolled, setIsScrolled] = useState(false);
  const [aiStatus, setAiStatus] = useState<"idle" | "thinking" | "done">("idle");
  const aiStatusTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [keyboardHeight, setKeyboardHeight] = useState(0);

  // ── 导航历史（前进/后退）─────────────────────────────
  const navHistoryRef = useRef<NavHistoryEntry[]>([]);
  const navCursorRef = useRef<number>(-1);
  const [navCanGoBack, setNavCanGoBack] = useState(false);
  const [navCanGoForward, setNavCanGoForward] = useState(false);

  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      if (
        event.origin !== window.location.origin
        || event.source !== claudeFrameRef.current?.contentWindow
      ) return;
      if (event.data?.type === "open-git-tab") {
        setGitPanelOpen(true);
        return;
      }
      if (event.data?.type === "chat-overlay-state") {
        setIsChildOverlayOpen(!!event.data.open);
        return;
      }
      if (event.data && event.data.type === "ai-generating-state") {
        const isGenerating = event.data.isGenerating;
        if (isGenerating) {
           setAiStatus("thinking");
           if (aiStatusTimerRef.current) clearTimeout(aiStatusTimerRef.current);
        } else {
           setAiStatus((prev) => {
             if (prev === "thinking") {
               if (navigator.vibrate) navigator.vibrate(50);
               if (aiStatusTimerRef.current) clearTimeout(aiStatusTimerRef.current);
               aiStatusTimerRef.current = setTimeout(() => {
                 setAiStatus((current) => current === "done" ? "idle" : current);
               }, 6000); // Wait 6 seconds before idle
               return "done";
             }
             return "idle";
           });
        }
      }
    };
    window.addEventListener("message", handleMessage);
    return () => {
      window.removeEventListener("message", handleMessage);
      if (aiStatusTimerRef.current) clearTimeout(aiStatusTimerRef.current);
    };
  }, []);

  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const handler = () => {
      const kh = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
      setKeyboardHeight(kh);
    };
    vv.addEventListener("resize", handler, { passive: true });
    vv.addEventListener("scroll", handler, { passive: true });
    handler();
    return () => {
      vv.removeEventListener("resize", handler);
      vv.removeEventListener("scroll", handler);
    };
  }, []);

  useEffect(() => {
    activePathRef.current = activePath;
    if (activePath) {
      try { window.localStorage.setItem(LAST_FILE_KEY, activePath); } catch { /* ignore */ }
    }
  }, [activePath]);

  // 任何途径打开的文件（文件树、搜索、wiki 链接、草稿落盘…）都自动收进标签
  useEffect(() => {
    if (activePath) {
      ensureTab(activePath);
    }
  }, [activePath, ensureTab]);

  useEffect(() => {
    if (!activePath) return;
    claudeFrameRef.current?.contentWindow?.postMessage(
      { type: "note-context", filePath: activePath },
      window.location.origin,
    );
  }, [activePath]);

  useEffect(() => {
    setShareModalOpen(false);
    setShareState("idle");
    setShareToken(null);
    setShareUrl(null);
    setShareMessage(null);
  }, [note?.path]);

  const files = useMemo(() => (tree ? collectFiles(tree) : []), [tree]);

  // 文件树每次刷新后清理失效标签（外部删除/首次恢复 localStorage 里的旧标签）。
  // 保留 activePath：新建/草稿落盘的文件可能先于文件树刷新出现。
  useEffect(() => {
    if (treeState !== "ready") return;
    const existing = new Set(files.map((file) => file.path));
    pruneTabs((path) => existing.has(path) || path === activePathRef.current);
  }, [files, treeState, pruneTabs]);

  const refreshWikiIndex = useCallback(async () => {
    try {
      const response = await fetch("/api/notes/wiki/index", { cache: "no-store" });
      if (!response.ok) return;
      const payload = (await response.json()) as { entries?: Array<{ path: string; aliases: string[] }> };
      setWikiAliases(new Map((payload.entries ?? []).map((entry) => [entry.path, entry.aliases])));
    } catch {
      // Alias resolution is additive; filename/path links continue working if this request fails.
    }
  }, []);

  useEffect(() => {
    if (files.length > 0) void refreshWikiIndex();
  }, [files, refreshWikiIndex]);

  const noteIndex = useMemo(() => {
    const index = new Map<string, string>();

    // 第一趟只登记真实路径/文件名：保证真实笔记名优先于任何别名（与 Obsidian 一致），
    // 否则遍历靠前的笔记的别名会遮蔽后面笔记的真实文件名。
    for (const file of files) {
      const keys = [file.path, stripNoteExtension(file.path), stripNoteExtension(file.name)];
      for (const key of keys) {
        const normalizedKey = normalizeIndexKey(key);
        if (normalizedKey && !index.has(normalizedKey)) {
          index.set(normalizedKey, file.path);
        }
      }
    }

    // 第二趟登记别名，只填补尚未被真实文件名占用的键。
    for (const file of files) {
      for (const alias of wikiAliases.get(file.path) ?? []) {
        const normalizedAlias = normalizeIndexKey(alias);
        if (normalizedAlias && !index.has(normalizedAlias)) {
          index.set(normalizedAlias, file.path);
        }
      }
    }

    return index;
  }, [files, wikiAliases]);

  const noteNames = useMemo(() => {
    const markdownFiles = files.filter((file) => /\.md$/i.test(file.path));
    const basenameCounts = new Map<string, number>();

    for (const file of markdownFiles) {
      const key = stripNoteExtension(file.name).normalize("NFKC").toLocaleLowerCase();
      basenameCounts.set(key, (basenameCounts.get(key) ?? 0) + 1);
    }

    return markdownFiles.flatMap((file) => {
      const basename = stripNoteExtension(file.name);
      const key = basename.normalize("NFKC").toLocaleLowerCase();
      // 同名笔记使用相对路径消歧；普通笔记仍保持简洁文件名。
      const primaryName = (basenameCounts.get(key) ?? 0) > 1
        ? stripNoteExtension(file.path)
        : basename;
      return [primaryName, ...(wikiAliases.get(file.path) ?? [])];
    });
  }, [files, wikiAliases]);

  const normalizedSearchQuery = searchQuery.trim();
  const shouldSearchNotes = isSearchQueryReady(normalizedSearchQuery);
  const visibleTree = useMemo(
    () => (tree ? filterTree(tree, normalizedSearchQuery) : null),
    [tree, normalizedSearchQuery],
  );

  useEffect(() => {
    if (!shouldSearchNotes) {
      return;
    }

    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      try {
        const params = new URLSearchParams({ q: normalizedSearchQuery });
        const response = await fetch(`/api/notes/search?${params.toString()}`, {
          cache: "no-store",
          signal: controller.signal,
        });
        if (!response.ok) {
          const body = (await response.json().catch(() => null)) as { error?: string } | null;
          throw new Error(body?.error ?? `搜索失败：${response.status}`);
        }

        const payload = (await response.json()) as NotesSearchResponse;
        setSearchResults(payload.hits);
        setSearchState("ready");
        setSearchError(null);
        setActiveSearchIndex(payload.hits.length > 0 ? 0 : -1);
      } catch (searchRequestError) {
        if (controller.signal.aborted) {
          return;
        }
        setSearchResults([]);
        setSearchState("error");
        setSearchError(searchRequestError instanceof Error ? searchRequestError.message : "搜索失败");
        setActiveSearchIndex(-1);
      }
    }, 220);

    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [normalizedSearchQuery, searchQuery, shouldSearchNotes]);

  useEffect(() => {
    if (activeSearchIndex < 0) {
      return;
    }
    document
      .getElementById(`notes-search-result-${activeSearchIndex}`)
      ?.scrollIntoView({ block: "nearest" });
  }, [activeSearchIndex]);

  // fix: 避免草稿态每次按键都重新遍历文件树
  const captureFolderOptions = useMemo(() => {
    const folders = tree ? collectFolders(tree) : [""];
    if (!folders.includes(captureFolder)) folders.unshift(captureFolder);
    return folders;
  }, [tree, captureFolder]);

  const articleTocEntries = useMemo(() => {
    if (!note) return [];
    if (/\.html?$/i.test(note.path)) {
      return htmlToc.path === note.path ? htmlToc.entries : [];
    }
    return extractHeadings(note.content);
  }, [htmlToc, note]);

  useEffect(() => {
    setActiveTocSlug(articleTocEntries[0]?.slug ?? "");
  }, [articleTocEntries]);

  useEffect(() => {
    if (articleTocEntries.length === 0) {
      return;
    }
    if (/\.html?$/i.test(note?.path ?? "")) {
      // HTML 标题位于 iframe 文档中，由 NotesHtml 按外层 reader 的滚动位置同步。
      syncTocRef.current = null;
      return;
    }

    const reader = readerRef.current;
    if (!reader) {
      return;
    }

    const syncActiveHeading = () => {
      // 桌面端：reader 自身滚动（overflow: auto，scrollTop 递增）
      // 移动端：reader 是 overflow: visible，由 window 滚动，reader.scrollTop 永远为 0
      const readerScrollable = getComputedStyle(reader).overflowY !== "visible";
      const scrollTop = readerScrollable ? reader.scrollTop : window.scrollY;
      const viewHeight = readerScrollable ? reader.clientHeight : window.innerHeight;

      // 视口高度为 0 时跳过（隐藏/未渲染）
      if (viewHeight === 0) return;

      const threshold = scrollTop + viewHeight * 0.22;
      let current = articleTocEntries[0]?.slug ?? "";
      const readerTop = reader.getBoundingClientRect().top;

      for (const heading of articleTocEntries) {
        const element = document.getElementById(heading.slug);
        if (!element) continue;

        const top = element.getBoundingClientRect().top - readerTop + scrollTop;
        if (top <= threshold) {
          current = heading.slug;
        }
      }

      setActiveTocSlug(current);
    };

    syncTocRef.current = syncActiveHeading;
    // 同时监听 reader 和 window —— 两者只有一个会实际触发（取决于是桌面还是移动端布局）
    reader.addEventListener("scroll", syncActiveHeading, { passive: true });
    window.addEventListener("scroll", syncActiveHeading, { passive: true });
    const timeout = window.setTimeout(syncActiveHeading, 80);
    return () => {
      reader.removeEventListener("scroll", syncActiveHeading);
      window.removeEventListener("scroll", syncActiveHeading);
      window.clearTimeout(timeout);
      syncTocRef.current = null;
    };
  }, [articleTocEntries, note?.path]);

  useEffect(() => {
    // 底部抽屉（手机式）适用条件：窄屏，或任意竖屏（平板/桌面竖屏都跟手机一致）。
    // 横屏且足够宽时才走桌面右侧栏布局。
    const mediaQuery = window.matchMedia("(max-width: 900px), (orientation: portrait)");
    const syncViewport = () => {
      const isMobile = mediaQuery.matches;
      setIsMobileViewport(isMobile);
      if (!isMobile) {
        setMobileSidebarOpen(false);
        setMobileAssistantSheet('closed');
      }
    };

    syncViewport();
    mediaQuery.addEventListener("change", syncViewport);

    return () => {
      mediaQuery.removeEventListener("change", syncViewport);
    };
  }, []);

  useEffect(() => {
    const savedWidth = Number(window.localStorage.getItem(PANEL_WIDTH_KEY));
    if (Number.isFinite(savedWidth)) {
      setAssistantPanelWidth(clamp(savedWidth, MIN_ASSISTANT_PANEL_WIDTH, MAX_ASSISTANT_PANEL_WIDTH));
    }

    const savedVisibility = window.localStorage.getItem(PANEL_VISIBLE_KEY);
    if (savedVisibility === "true") {
      setAssistantPanelVisible(true);
    } else if (savedVisibility === "false") {
      setAssistantPanelVisible(false);
    }

    const savedTocSection = window.localStorage.getItem(TOC_SECTION_KEY);
    if (savedTocSection === "false") {
      setTocSectionOpen(false);
    }

    const savedSidebarVisibility = window.localStorage.getItem(SIDEBAR_VISIBLE_KEY);
    if (savedSidebarVisibility === "false") {
      setSidebarVisible(false);
    }

    const savedSidebarWidth = Number(window.localStorage.getItem(SIDEBAR_WIDTH_KEY));
    if (Number.isFinite(savedSidebarWidth) && savedSidebarWidth > 0) {
      setSidebarWidth(clamp(savedSidebarWidth, MIN_SIDEBAR_WIDTH, MAX_SIDEBAR_WIDTH));
    }
  }, []);

  useEffect(() => {
    isDraftRef.current = isDraft;
  }, [isDraft]);

  useEffect(() => {
    captureFolderRef.current = captureFolder;
  }, [captureFolder]);

  useEffect(() => {
    try {
      const saved = window.localStorage.getItem(CAPTURE_FOLDER_KEY);
      if (saved !== null) {
        setCaptureFolder(saved);
        captureFolderRef.current = saved;
      }
    } catch { /* ignore */ }
  }, []);

  useEffect(() => {
    window.localStorage.setItem(PANEL_WIDTH_KEY, String(assistantPanelWidth));
  }, [assistantPanelWidth]);

  useEffect(() => {
    window.localStorage.setItem(SIDEBAR_WIDTH_KEY, String(sidebarWidth));
  }, [sidebarWidth]);

  useEffect(() => {
    window.localStorage.setItem(PANEL_VISIBLE_KEY, String(assistantPanelVisible));
  }, [assistantPanelVisible]);

  useEffect(() => {
    window.localStorage.setItem(TOC_SECTION_KEY, String(tocSectionOpen));
  }, [tocSectionOpen]);

  useEffect(() => {
    window.localStorage.setItem(SIDEBAR_VISIBLE_KEY, String(sidebarVisible));
  }, [sidebarVisible]);

  // ── 侧栏悬浮开合 ──────────────────────────────────────
  const clearSidebarPeekTimers = useCallback(() => {
    const timers = sidebarPeekTimersRef.current;
    if (timers.hide) { window.clearTimeout(timers.hide); timers.hide = null; }
    if (timers.close) { window.clearTimeout(timers.close); timers.close = null; }
  }, []);

  const openSidebarPeek = useCallback(() => {
    clearSidebarPeekTimers();
    setSidebarPeek("open");
  }, [clearSidebarPeekTimers]);

  const scheduleSidebarPeekClose = useCallback(() => {
    clearSidebarPeekTimers();
    sidebarPeekTimersRef.current.hide = window.setTimeout(() => {
      // 先以覆盖层滑出（不回流），动画结束后再摘掉 peek 态
      setSidebarPeek("closing");
      sidebarPeekTimersRef.current.close = window.setTimeout(() => setSidebarPeek("closed"), 360);
    }, 260);
  }, [clearSidebarPeekTimers]);

  // 侧栏恢复常驻或切到移动端时，清掉悬浮态
  useEffect(() => {
    if (isMobileViewport || sidebarVisible) {
      clearSidebarPeekTimers();
      setSidebarPeek("closed");
    }
  }, [isMobileViewport, sidebarVisible, clearSidebarPeekTimers]);

  useEffect(() => {
    if (!isMobileViewport || (!mobileSidebarOpen && mobileAssistantSheet !== 'expanded')) {
      return;
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setMobileSidebarOpen(false);
        setMobileAssistantSheet('closed');
      }
    };

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", handleKeyDown);

    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [isMobileViewport, mobileSidebarOpen, mobileAssistantSheet]);

  useEffect(() => {
    if (!shareModalOpen && !deleteConfirmOpen && !moreMenuOpen && !renameTarget && !treeMenuTarget && !treeSheetTarget && !globalCreateMenuOpen && !importError) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setShareModalOpen(false);
        setDeleteConfirmOpen(false);
        setDeleteTarget(null);
        setMoreMenuOpen(false);
        renameInProgressRef.current = true;
        setRenameTarget(null);
        setRenameError(null);
        setTreeMenuTarget(null);
        setTreeSheetTarget(null);
        setGlobalCreateMenuOpen(false);
        setImportError(null);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [shareModalOpen, deleteConfirmOpen, moreMenuOpen, renameTarget, treeMenuTarget, treeSheetTarget, globalCreateMenuOpen, importError]);

  useEffect(() => {
    if (!isResizingAssistantPanel) {
      return;
    }

    const handlePointerMove = (event: PointerEvent) => {
      const availableWidth = window.innerWidth - event.clientX;
      setAssistantPanelWidth(clamp(availableWidth, MIN_ASSISTANT_PANEL_WIDTH, MAX_ASSISTANT_PANEL_WIDTH));
    };

    const stopResizing = () => {
      setIsResizingAssistantPanel(false);
    };

    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", stopResizing);
    window.addEventListener("pointercancel", stopResizing);

    return () => {
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", stopResizing);
      window.removeEventListener("pointercancel", stopResizing);
    };
  }, [isResizingAssistantPanel]);

  useEffect(() => {
    if (!isResizingSidebar) {
      return;
    }

    const handlePointerMove = (event: PointerEvent) => {
      setSidebarWidth(clamp(event.clientX, MIN_SIDEBAR_WIDTH, MAX_SIDEBAR_WIDTH));
    };

    const stopResizing = () => {
      setIsResizingSidebar(false);
    };

    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", stopResizing);
    window.addEventListener("pointercancel", stopResizing);

    return () => {
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", stopResizing);
      window.removeEventListener("pointercancel", stopResizing);
    };
  }, [isResizingSidebar]);

  const openAncestors = useCallback((filePath: string) => {
    setExpandedFolders((current) => {
      const next = new Set(current);
      getAncestorFolders(filePath).forEach((folder) => next.add(folder));
      return next;
    });
  }, []);

  const getReaderScrollSnapshot = useCallback((): ScrollSnapshot | null => {
    const reader = readerRef.current;
    if (!reader) {
      return null;
    }

    const readerScrollable = getComputedStyle(reader).overflowY !== "visible";
    return readerScrollable
      ? { target: "reader", top: reader.scrollTop, left: reader.scrollLeft }
      : { target: "window", top: window.scrollY, left: window.scrollX };
  }, []);

  const restoreReaderScroll = useCallback((snapshot: ScrollSnapshot) => {
    if (snapshot.target === "reader") {
      readerRef.current?.scrollTo({
        top: snapshot.top,
        left: snapshot.left,
        behavior: "auto",
      });
    } else {
      window.scrollTo({
        top: snapshot.top,
        left: snapshot.left,
        behavior: "auto",
      });
    }
    syncTocRef.current?.();
  }, []);

  const saveCurrentScrollSnapshot = useCallback((path = activePathRef.current) => {
    if (!path) {
      return;
    }
    const snapshot = getReaderScrollSnapshot();
    if (snapshot) {
      writeStoredScrollSnapshot(path, snapshot);
    }
  }, [getReaderScrollSnapshot]);

  useEffect(() => {
    const reader = readerRef.current;
    if (!reader) {
      return;
    }

    let frame = 0;
    const handleScroll = () => {
      const readerScrollable = getComputedStyle(reader).overflowY !== "visible";
      const scrollTop = readerScrollable ? reader.scrollTop : window.scrollY;
      setIsScrolled(scrollTop > 10);

      if (frame) {
        return;
      }
      frame = window.requestAnimationFrame(() => {
        frame = 0;
        if (!suppressScrollSaveRef.current) {
          saveCurrentScrollSnapshot();
        }
      });
    };

    reader.addEventListener("scroll", handleScroll, { passive: true });
    window.addEventListener("scroll", handleScroll, { passive: true });

    // Run once initially to set the state correctly
    handleScroll();

    return () => {
      if (frame) {
        window.cancelAnimationFrame(frame);
      }
      reader.removeEventListener("scroll", handleScroll);
      window.removeEventListener("scroll", handleScroll);
    };
  }, [saveCurrentScrollSnapshot]);

  const pushNavHistory = useCallback((path: string, hash?: string | null) => {
    const hist = navHistoryRef.current;
    const cur = navCursorRef.current;
    const entry = { path, hash: normalizeNavigationHash(hash) };
    const current = hist[cur];
    if (current?.path !== entry.path || current.hash !== entry.hash) {
      const next = hist.slice(0, cur + 1);
      next.push(entry);
      if (next.length > 200) next.shift();
      navHistoryRef.current = next;
      navCursorRef.current = next.length - 1;
      setNavCanGoBack(navCursorRef.current > 0);
      setNavCanGoForward(false);
    }
  }, []);

  // ref 与 state 同步：ref 给异步流程读最新值，state 给编辑器空态提示做渲染
  const setAutoTitleTarget = useCallback((path: string | null) => {
    autoTitlePathRef.current = path;
    setAutoTitlePath(path);
  }, []);

  const loadNote = useCallback(
    async (path: string, hash?: string | null, options: LoadNoteOptions = {}) => {
      // 切到别的笔记就不再自动命名，避免旧笔记在后台被莫名改名。
      // 只认用户发起的切换：自动改名后 SSE 可能拿着旧路径补一次静默重载，
      // 那是文件改名的回声，不是用户切走。
      if (!options.silent && autoTitlePathRef.current && autoTitlePathRef.current !== path) {
        setAutoTitleTarget(null);
      }
      // 进入切换窗口：暂停滚动快照写入，直到新内容提交并恢复滚动位置。
      // loading 骨架/内容替换会把 scrollTop 钳制到 0，此时的 scroll 事件
      // 若照常写快照，会把 0 记到旧文件名下，覆盖真实阅读位置。
      suppressScrollSaveRef.current = true;

      // PDF / 图片：不拉文本，直接交给原生预览（见下方渲染分支）
      if (isPdfPath(path) || isImagePath(path)) {
        setError(null);
        pendingHashRef.current = null;
        noteUpdatedAtRef.current = null; // 让 2s 文本轮询对 PDF 直接跳过
        activePathRef.current = path; // 同步认领，防止内容替换钳制 scrollTop 时把快照写到旧文件
        setNote(null);
        setActivePath(path);
        openAncestors(path);
        setNoteState("ready");
        if (options.updateHistory !== false) {
          const nextUrl = new URL(window.location.href);
          nextUrl.searchParams.set("file", path);
          nextUrl.hash = "";
          window.history.replaceState(null, "", nextUrl);
          pushNavHistory(path, null);
        }
        suppressScrollSaveRef.current = false;
        return;
      }

      if (!options.silent) {
        setNoteState("loading");
      }
      setError(null);
      pendingHashRef.current = hash ?? null;

      try {
        const params = new URLSearchParams({ path });
        const response = await fetch(`/api/notes/file?${params.toString()}`, {
          cache: "no-store",
          // 超时保护：静默重载依赖 isReloadingRef 串行化，挂死的请求会永久阻塞后续刷新
          signal: AbortSignal.timeout(15000),
        });

        if (!response.ok) {
          const body = (await response.json().catch(() => null)) as { error?: string } | null;
          throw new Error(body?.error ?? `Failed to load note: ${response.status}`);
        }

        const payload = (await response.json()) as NotesFileResponse;
        noteUpdatedAtRef.current = payload.updatedAt;

        if (options.updateHistory !== false) {
          const nextUrl = new URL(window.location.href);
          nextUrl.searchParams.set("file", payload.path);
          nextUrl.hash = normalizeNavigationHash(hash) ?? "";
          window.history.replaceState(null, "", nextUrl);
          pushNavHistory(payload.path, hash);
        }

        let scrollSnapshot: ScrollSnapshot | null = null;
        if (options.preserveScroll) {
          scrollSnapshot = getReaderScrollSnapshot();
        } else if (options.restoreStoredScroll && !hash) {
          // 无快照的文件（从未滚动过）落到顶部，避免继承上一篇的滚动位置
          scrollSnapshot = readStoredScrollSnapshot(payload.path);
          if (!scrollSnapshot) {
            const current = getReaderScrollSnapshot();
            scrollSnapshot = current ? { ...current, top: 0, left: 0 } : null;
          }
        }
        const commitNote = () => {
          // 同步认领路径：内容替换会让浏览器钳制 scrollTop 并触发 scroll 事件，
          // 若此时 ref 仍指向旧文件，钳制后的位置会覆盖旧文件的滚动快照
          activePathRef.current = payload.path;
          setNote(payload);
          setActivePath(payload.path);
          openAncestors(payload.path);
          setNoteState("ready");
        };

        if (scrollSnapshot) {
          flushSync(commitNote);
          restoreReaderScroll(scrollSnapshot);
          writeStoredScrollSnapshot(payload.path, scrollSnapshot);
        } else {
          commitNote();
        }
      } catch (loadError) {
        if (!options.silent) {
          setNote(null);
          setNoteState("error");
        }
        setError(loadError instanceof Error ? loadError.message : "Failed to load note.");
      } finally {
        suppressScrollSaveRef.current = false;
      }
    },
    [getReaderScrollSnapshot, openAncestors, pushNavHistory, restoreReaderScroll, setAutoTitleTarget],
  );

  const refreshTree = useCallback(async () => {
    const treeRes = await fetch("/api/notes/tree", { cache: "no-store" });
    if (!treeRes.ok) {
      const data = (await treeRes.json().catch(() => ({}))) as { error?: string };
      throw new Error(data.error ?? "刷新文件树失败");
    }
    const payload = (await treeRes.json()) as NotesTreeResponse;
    setTree(payload.root);
    treeRevRef.current = payload.rev;
    return payload;
  }, []);

  // ── 图片查看器翻页 ────────────────────────────────────
  // 只在同一目录内翻，顺序跟文件树一致，跨目录不串门
  const imageViewerNav = useMemo<ImageViewerNavigation | null>(() => {
    if (!activePath || !isImagePath(activePath)) return null;
    const folder = getParentFolder(activePath).toLowerCase();
    const items = files.filter(
      (file) => isImagePath(file.path) && getParentFolder(file.path).toLowerCase() === folder,
    );
    const normalized = activePath.toLowerCase();
    const index = items.findIndex((file) => file.path.toLowerCase() === normalized);
    return {
      total: items.length,
      index,
      previous: index > 0 ? items[index - 1] : null,
      next: index >= 0 && index < items.length - 1 ? items[index + 1] : null,
    };
  }, [activePath, files]);

  // 连点互斥：上一张还没落定就再按，会让标签映射和 activePath 打架
  const imageViewerLoadingRef = useRef(false);

  const navigateImageViewer = useCallback(async (direction: "previous" | "next") => {
    if (imageViewerLoadingRef.current) return;
    const target = direction === "previous" ? imageViewerNav?.previous : imageViewerNav?.next;
    if (!target) return;
    const from = activePathRef.current;
    imageViewerLoadingRef.current = true;
    try {
      // 替换当前标签而不是新开：先把旧路径就地映射掉，标签才不会越翻越多
      if (from && from !== target.path) mapTabs((path) => (path === from ? target.path : path));
      await loadNote(target.path);
    } finally {
      imageViewerLoadingRef.current = false;
    }
  }, [imageViewerNav, loadNote, mapTabs]);

  /** ← / → 翻页：只在图片查看器里生效，输入框内与任何对话框打开时不接管 */
  useEffect(() => {
    if (!imageViewerNav) return;
    if (newNoteOpen || newFolderOpen || quickSwitcherOpen || shareModalOpen) return;
    if (renameTarget || deleteTarget || treeSheetTarget) return;

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      const target = event.target instanceof HTMLElement ? event.target : null;
      if (target?.closest("input, textarea, select, [contenteditable='true']")) return;
      const direction = event.key === "ArrowLeft" ? "previous" : "next";
      if (!(direction === "previous" ? imageViewerNav.previous : imageViewerNav.next)) return;
      event.preventDefault();
      void navigateImageViewer(direction);
    };

    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [
    imageViewerNav,
    navigateImageViewer,
    newNoteOpen,
    newFolderOpen,
    quickSwitcherOpen,
    shareModalOpen,
    renameTarget,
    deleteTarget,
    treeSheetTarget,
  ]);

  // ── 选中文字 → 自动发送到 Claude 引用框 ──────────────────────
  const hasReaderSelectionRef = useRef(false);
  useEffect(() => {
    const handlePointerUp = () => {
      setTimeout(() => {
        const sel = window.getSelection();
        if (!sel || sel.isCollapsed) return;
        const text = sel.toString().trim();
        if (text.length < 2) return;
        const reader = readerRef.current;
        if (!reader) return;
        try {
          const range = sel.getRangeAt(0);
          if (!reader.contains(range.commonAncestorContainer)) return;

          // Nearest heading before selection for semantic location
          const headings = Array.from(reader.querySelectorAll("h1,h2,h3,h4,h5,h6"));
          let section: string | null = null;
          for (const h of headings) {
            if (h.compareDocumentPosition(range.startContainer) & Node.DOCUMENT_POSITION_FOLLOWING) {
              section = h.textContent?.trim() ?? null;
            }
          }

          // W3C TextQuoteSelector: short prefix/suffix to unambiguously anchor the selection
          let prefix = "";
          let suffix = "";
          try {
            const preRange = document.createRange();
            preRange.setStart(reader, 0);
            preRange.setEnd(range.startContainer, range.startOffset);
            prefix = preRange.toString().replace(/\s+/g, " ").slice(-30).trimStart();

            const postRange = document.createRange();
            postRange.setStart(range.endContainer, range.endOffset);
            postRange.setEnd(reader, reader.childNodes.length);
            suffix = postRange.toString().replace(/\s+/g, " ").slice(0, 30).trimEnd();
          } catch { /* ignore */ }

          hasReaderSelectionRef.current = true;
          claudeFrameRef.current?.contentWindow?.postMessage(
            { type: "note-selection", text, section, prefix, suffix },
            window.location.origin,
          );
        } catch { /* ignore */ }
      }, 10);
    };

    const handleSelectionChange = () => {
      if (!hasReaderSelectionRef.current) return;
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed || !sel.toString().trim()) {
        hasReaderSelectionRef.current = false;
        claudeFrameRef.current?.contentWindow?.postMessage(
          { type: "note-selection-clear" },
          window.location.origin,
        );
      }
    };

    document.addEventListener("pointerup", handlePointerUp);
    document.addEventListener("selectionchange", handleSelectionChange);
    return () => {
      document.removeEventListener("pointerup", handlePointerUp);
      document.removeEventListener("selectionchange", handleSelectionChange);
    };
  }, []);

  // SSE 监听服务端文件变动，替代 2s 轮询；activePath 切换时自动重连。
  // EventSource 收到 HTTP 错误响应（部署重启窗口的 502、鉴权过期的 401 等）会永久
  // 关闭且不再自动重试，必须自行管理重连；另用服务端 20s 的 ping 事件做活性看门狗，
  // 兜住休眠/切网后协议层探测不到的半死连接。
  const isReloadingRef = useRef(false);
  useEffect(() => {
    if (!activePath || isPdfPath(activePath) || isImagePath(activePath)) return;

    let es: EventSource | null = null;
    let disposed = false;
    let pending = false;
    let retryDelay = 1000;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let watchdogTimer: ReturnType<typeof setTimeout> | null = null;

    const runReload = async () => {
      // 重载进行中：标记 pending，结束后再补一次，避免并发写入被丢
      if (isReloadingRef.current) { pending = true; return; }
      isReloadingRef.current = true;
      isSilentReloadRef.current = true;
      try {
        await loadNote(activePath, null, { preserveScroll: true, silent: true, updateHistory: false });
        const r = await fetch(`/api/notes/git?check=${encodeURIComponent(activePath)}`);
        const data = r.ok ? (await r.json() as { changed: boolean }) : null;
        if (data != null) setHasGitChanges(data.changed);
      } catch {
        // 瞬时失败（网络抖动/服务重启窗口）会把这次变更永久丢掉，3s 后补一次
        if (!disposed) setTimeout(() => { void runReload(); }, 3000);
      } finally {
        isReloadingRef.current = false;
        setTimeout(() => { isSilentReloadRef.current = false; }, 400);
        if (pending) { pending = false; void runReload(); }
      }
    };

    // 服务端每 20s 一个 ping；65s 内无任何消息（容忍丢 2 个 ping）视为连接半死，强制重建
    const armWatchdog = () => {
      if (watchdogTimer) clearTimeout(watchdogTimer);
      watchdogTimer = setTimeout(() => scheduleReconnect(0), 65000);
    };

    const scheduleReconnect = (delay = retryDelay) => {
      if (disposed) return;
      es?.close();
      es = null;
      if (retryTimer) clearTimeout(retryTimer);
      retryTimer = setTimeout(connect, delay);
      retryDelay = Math.min(retryDelay * 2, 30000);
    };

    const connect = () => {
      if (disposed) return;
      es = new EventSource(`/api/notes/watch?path=${encodeURIComponent(activePath)}`);
      armWatchdog();
      es.addEventListener("open", () => {
        retryDelay = 1000;
        armWatchdog();
        // 每次连接建立都补一次重载，兜住 watcher 挂载前错过的改动
        // （含初次 loadNote 与服务端 fs.watch 生效之间的窗口）
        void runReload();
      });
      es.addEventListener("change", () => { armWatchdog(); void runReload(); });
      es.addEventListener("ping", () => armWatchdog());
      es.addEventListener("error", () => {
        // CLOSED 表示浏览器已放弃自动重连（收到 HTTP 错误响应），需手动重建；
        // CONNECTING 则是浏览器在自动重连，交给看门狗兜底即可
        if (es?.readyState === EventSource.CLOSED) scheduleReconnect();
      });
    };

    // 标签页回到前台时补一次重载并重置看门狗，立即覆盖休眠/后台期间错过的改动
    const handleVisible = () => {
      if (document.visibilityState !== "visible") return;
      armWatchdog();
      void runReload();
    };
    document.addEventListener("visibilitychange", handleVisible);

    connect();

    return () => {
      disposed = true;
      if (retryTimer) clearTimeout(retryTimer);
      if (watchdogTimer) clearTimeout(watchdogTimer);
      es?.close();
      document.removeEventListener("visibilitychange", handleVisible);
      isReloadingRef.current = false;
    };
  }, [activePath, loadNote]);

  // 监听 markdown 区域的 DOM 变动，SSE 静默重载时高亮发生变化的段落
  useEffect(() => {
    const reader = readerRef.current;
    if (!reader) return;

    const BLOCK_TAGS = new Set(["P", "H1", "H2", "H3", "H4", "H5", "H6", "LI", "BLOCKQUOTE", "PRE", "TD", "TH"]);

    const observer = new MutationObserver((mutations) => {
      if (!isSilentReloadRef.current) return;
      const flashed = new Set<Element>();
      for (const m of mutations) {
        const nodes = m.type === "childList" ? [...m.addedNodes] : [m.target];
        for (const node of nodes) {
          let el: Element | null = node.nodeType === Node.ELEMENT_NODE
            ? (node as Element)
            : (node as Text).parentElement;
          if (!el?.closest("[data-markdown-content]")) continue;
          while (el) {
            if (BLOCK_TAGS.has(el.tagName)) {
              if (!flashed.has(el)) {
                flashed.add(el);
                el.classList.add(styles.diffFlash);
                const target = el;
                el.addEventListener("animationend", () => target.classList.remove(styles.diffFlash), { once: true });
              }
              break;
            }
            if (!el.closest("[data-markdown-content]")) break;
            el = el.parentElement;
          }
        }
      }
    });

    observer.observe(reader, { childList: true, subtree: true, characterData: true });
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function loadTree() {
      setTreeState("loading");
      setError(null);

      try {
        const response = await fetch("/api/notes/tree", { cache: "no-store" });
        if (!response.ok) {
          const body = (await response.json().catch(() => null)) as { error?: string } | null;
          throw new Error(body?.error ?? `Failed to load file tree: ${response.status}`);
        }

        const payload = (await response.json()) as NotesTreeResponse;
        if (cancelled) {
          return;
        }

        const allFiles = collectFiles(payload.root);
        const url = new URL(window.location.href);
        const requestedFile = url.searchParams.get("file");
        // Only restore the last-opened note on reload/back-forward.
        // When the user explicitly navigates to the root URL, show the dashboard.
        const navType = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined;
        const isRestore = !navType || navType.type === "reload" || navType.type === "back_forward";
        const initialFile = requestedFile && allFiles.some((file) => file.path === requestedFile)
          ? requestedFile
          : isRestore ? findPreferredInitialFile(allFiles) : null;

        setTree(payload.root);
        treeRevRef.current = payload.rev;
        setExpandedFolders(new Set(initialFile ? getAncestorFolders(initialFile) : []));
        setTreeState("ready");
        // 如果有要恢复的文件，提前把 noteState 设为 "loading"，
        // 确保 React 在 await loadNote 之前的那帧渲染里不会显示 Dashboard。
        if (initialFile) {
          setNoteState("loading");
          await loadNote(initialFile, url.hash || null, { restoreStoredScroll: !url.hash });
        }
      } catch (loadError) {
        if (cancelled) {
          return;
        }
        setTreeState("error");
        setError(loadError instanceof Error ? loadError.message : "Failed to load notes.");
      }
    }

    // 页面打开时立即加载本地内容（不等待网络）
    void loadTree();

    // 同时在后台静默 pull — 8 秒超时，失败无感知
    const autoSync = async () => {
      try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 8_000);
        const res = await fetch("/api/notes/git", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ action: "pull" }),
          signal: ctrl.signal,
          cache: "no-store",
        });
        clearTimeout(timer);
        if (!cancelled) {
          const data = (await res.json()) as { ok?: boolean; output?: string };
          // 有新内容（非"Already up to date"）时静默刷新文件树
          if (data.ok && data.output && !/already up to date/i.test(data.output)) {
            void loadTree();
          }
        }
      } catch { /* 网络失败/超时 — 静默忽略 */ }
    };
    void autoSync();

    return () => {
      cancelled = true;
    };
  }, [loadNote]);

  // 轻量轮询：覆盖「非 UI 发起」的文件变更（Agent 写盘、手动改、git pull、
  // 其他标签页/设备）。比对结构指纹 rev，仅在增/删/改名时才 setTree，不打断
  // 展开/选中状态；标签页隐藏时暂停，切回/聚焦时立即刷新一次。
  useEffect(() => {
    let stopped = false;

    const refreshTree = async () => {
      if (document.visibilityState !== "visible") return;
      try {
        const res = await fetch("/api/notes/tree", { cache: "no-store" });
        if (!res.ok || stopped) return;
        const payload = (await res.json()) as NotesTreeResponse;
        if (stopped) return;
        // 指纹未变（无增删改名）→ 跳过，避免无谓的重渲染
        if (payload.rev === treeRevRef.current) return;
        treeRevRef.current = payload.rev;
        setTree(payload.root);
      } catch { /* 网络抖动 — 静默忽略，下次轮询再试 */ }
    };

    const interval = setInterval(() => { void refreshTree(); }, 5_000);
    const onVisible = () => { if (document.visibilityState === "visible") void refreshTree(); };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);

    return () => {
      stopped = true;
      clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onVisible);
    };
  }, []);

  useEffect(() => {
    if (noteState !== "ready") {
      return;
    }

    const pendingHash = pendingHashRef.current;
    if (!pendingHash) {
      return;
    }

    pendingHashRef.current = null;
    window.requestAnimationFrame(() => {
      if (/\.html?$/i.test(note?.path ?? "")) {
        htmlPreviewRef.current?.scrollToFragment(pendingHash, {
          behavior: "auto",
          recordHistory: false,
        });
        return;
      }
      const targetId = decodeLoose(pendingHash.replace(/^#/, ""));
      document.getElementById(targetId)?.scrollIntoView({ block: "start" });
    });
  }, [noteState, note?.path]);

  // 计算是否有未保存修改
  const isDirty = isEditing && note !== null && editContent !== note.content;

  /** 进入编辑模式 */
  const handleEditStart = useCallback(() => {
    if (!note || /\.html?$/i.test(note.path)) return;
    // 用当前 reader.scrollHeight 做占位，防止切换后内容高度骤降导致 scrollTop 被钳制
    setEditorMinHeight(readerRef.current?.scrollHeight ?? 0);
    setEditContent(note.content);
    setIsEditing(true);
  }, [note]);

  /**
   * 保存成功后把占位名换成正文首行。
   * 改名冲突（重名等）静默跳过，下次保存再试——写标题的过程中弹错比不改名更烦。
   */
  const maybeAutoTitle = useCallback(async (savedPath: string, content: string) => {
    if (!autoTitlePathRef.current || autoTitlePathRef.current !== savedPath) return;
    if (activePathRef.current !== savedPath) return;

    const title = titleFromContent(content);
    if (!title || title === UNTITLED_NAME) return;
    const extension = savedPath.match(/\.[^./]+$/)?.[0] ?? ".md";
    const nextName = `${title}${extension}`;
    if (nextName === (savedPath.split("/").pop() ?? "")) return;

    let renamed: { oldPath: string; path: string } | null = null;
    try {
      const res = await fetch("/api/notes/file", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "rename", path: savedPath, name: nextName }),
      });
      if (res.ok) renamed = (await res.json()) as { oldPath: string; path: string };
    } catch { /* 网络抖动同样静默跳过 */ }
    if (!renamed) return;
    // 请求往返期间用户可能已经切走，这时别把状态改到别的笔记头上
    if (activePathRef.current !== savedPath) return;

    const { oldPath, path: nextPath } = renamed;
    activePathRef.current = nextPath;
    setAutoTitleTarget(nextPath);
    mapTabs((path) => (path === oldPath ? nextPath : path));

    const snapshot = readStoredScrollSnapshot(oldPath);
    if (snapshot) {
      writeStoredScrollSnapshot(nextPath, snapshot);
      try { window.sessionStorage.removeItem(getNoteScrollStorageKey(oldPath)); } catch { /* ignore */ }
    }

    // 只是换了文件名，不算「切换笔记」，别把用户踢出编辑态
    keepEditingOnCommitRef.current = true;
    setNote((prev) => (prev ? { ...prev, path: nextPath, name: nextName } : prev));
    setActivePath(nextPath);

    const nextUrl = new URL(window.location.href);
    nextUrl.searchParams.set("file", nextPath);
    window.history.replaceState(null, "", nextUrl);
    try { window.localStorage.setItem(LAST_FILE_KEY, nextPath); } catch { /* ignore */ }

    try {
      await refreshTree();
      openAncestors(nextPath);
    } catch { /* 树刷新失败不影响已经落定的改名 */ }
  }, [mapTabs, openAncestors, refreshTree, setAutoTitleTarget]);

  /** 保存（⌘S 或切换前 flush 时使用） */
  const handleSave = useCallback(async (notePath?: string, content?: string) => {
    const path = notePath ?? activePath;
    const body = content ?? editContent;
    if (!path) return;
    const res = await fetch("/api/notes/file", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path, content: body }),
    });
    if (!res.ok) throw new Error("保存失败");
    const saved = (await res.json()) as { updatedAt: string; content: string; aliases?: string[] };
    setNote((prev) => prev ? { ...prev, content: saved.content, updatedAt: saved.updatedAt } : prev);
    if (saved.aliases) {
      setWikiAliases((prev) => {
        const next = new Map(prev);
        next.set(path, saved.aliases ?? []);
        return next;
      });
    }
    noteUpdatedAtRef.current = saved.updatedAt;
    setSavedFlash(true);
    setTimeout(() => setSavedFlash(false), 1600);
    setHasGitChanges(true);
    await maybeAutoTitle(path, body);
  }, [activePath, editContent, maybeAutoTitle]);

  /** 草稿首次输入 → 真正落盘到 captureFolder，随后转为普通笔记编辑 */
  const createDraftFile = useCallback(async (initialContent: string) => {
    const folder = (captureFolderRef.current ?? DEFAULT_CAPTURE_FOLDER).trim();
    const path = folder ? `${folder}/${captureStamp()}.md` : `${captureStamp()}.md`;
    // 同步认领路径，使随后的防抖自动保存（读 activePathRef）打到这个文件
    draftCreatedPathRef.current = path;
    activePathRef.current = path;
    draftCreatingRef.current = true;
    try {
      const res = await fetch("/api/notes/file", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        // createMarkdownNote 会递归创建父目录（含「灵感箱」），无需单独建文件夹
        body: JSON.stringify({ path, content: initialContent }),
      });
      if (!res.ok) throw new Error("创建失败");
      const saved = (await res.json()) as NotesFileResponse;
      noteUpdatedAtRef.current = saved.updatedAt;
      keepEditingOnCommitRef.current = true; // 让随后的 note.path 变化保持在编辑态
      setNote({ ...saved, content: saved.content ?? initialContent });
      setActivePath(path);
      setHasGitChanges(true);
      // 刷新文件树，让新灵感出现在侧栏
      const treeRes = await fetch("/api/notes/tree", { cache: "no-store" });
      if (treeRes.ok) {
        const payload = (await treeRes.json()) as NotesTreeResponse;
        setTree(payload.root);
        treeRevRef.current = payload.rev;
        openAncestors(path);
      }
    } catch {
      // 落盘失败：退回草稿态，让用户可重试（内容仍在编辑器里）
      draftCreatedPathRef.current = null;
      activePathRef.current = null; // fix: 防止后续自动保存打到不存在的路径
      isDraftRef.current = true;
      setIsDraft(true);
    } finally {
      draftCreatingRef.current = false;
    }
  }, [openAncestors]);

  /** Editor onChange — 更新状态 + 防抖自动保存 */
  const handleEditorChange = useCallback((value: string) => {
    setEditContent(value);
    // 草稿态：空白时不落盘；敲下第一个非空字符才创建文件并转为普通编辑
    if (isDraftRef.current) {
      if (!draftCreatedPathRef.current && value.trim()) {
        isDraftRef.current = false;
        setIsDraft(false);
        void createDraftFile(value);
      }
      return;
    }
    // fix: 文件创建请求正在进行中，等落盘完成再走自动保存分支
    if (draftCreatingRef.current) return;
    if (autoSaveTimerRef.current) clearTimeout(autoSaveTimerRef.current);
    autoSaveTimerRef.current = setTimeout(async () => {
      const path = activePathRef.current;
      if (!path) return;
      try {
        const res = await fetch("/api/notes/file", {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ path, content: value }),
        });
        if (!res.ok) return;
        const saved = (await res.json()) as { updatedAt: string; content: string; aliases?: string[] };
        setNote((prev) => prev ? { ...prev, content: saved.content, updatedAt: saved.updatedAt } : prev);
        if (saved.aliases) {
          setWikiAliases((prev) => {
            const next = new Map(prev);
            next.set(path, saved.aliases ?? []);
            return next;
          });
        }
        noteUpdatedAtRef.current = saved.updatedAt;
        setSavedFlash(true);
        setTimeout(() => setSavedFlash(false), 1600);
        setHasGitChanges(true);
        await maybeAutoTitle(path, value);
      } catch { /* 网络错误静默忽略 */ }
    }, 1500);
  }, [createDraftFile, maybeAutoTitle]); // 其余皆 ref / setter，稳定

  /** 切换阅读 / 编辑模式 */
  const handleEditToggle = useCallback(async () => {
    if (!isEditing) {
      handleEditStart();
      return;
    }
    // 退出编辑：取消 pending auto-save，有未保存内容先 flush
    if (autoSaveTimerRef.current) {
      clearTimeout(autoSaveTimerRef.current);
      autoSaveTimerRef.current = null;
    }
    if (isDirty) await handleSave();
    setIsEditing(false);
  }, [isEditing, isDirty, handleSave, handleEditStart]);

  /** 双击正文进入编辑模式（点链接/交互元素时不触发；.html 笔记不可编辑） */
  const handleReaderDoubleClick = useCallback((e: React.MouseEvent<HTMLElement>) => {
    if (isEditing || !note || /\.html?$/i.test(note.path)) return;
    if ((e.target as HTMLElement).closest("a, button, input, textarea, select, [contenteditable]")) return;
    handleEditStart();
  }, [isEditing, note, handleEditStart]);

  /** 切换笔记前自动保存未提交的修改 */
  const flushEditBeforeSwitch = useCallback(async () => {
    if (skipNextFlushRef.current) {
      skipNextFlushRef.current = false;
      return;
    }
    if (!isEditing) return;
    if (autoSaveTimerRef.current) {
      clearTimeout(autoSaveTimerRef.current);
      autoSaveTimerRef.current = null;
    }
    if (isDirty && activePath) {
      await handleSave(activePath, editContent);
      return;
    }
    // fix: 草稿已落盘（note state 尚未更新）但有未保存内容时也执行 flush
    if (!draftCreatingRef.current && draftCreatedPathRef.current && editContent.trim()) {
      await handleSave(draftCreatedPathRef.current, editContent);
    }
  }, [isEditing, isDirty, activePath, editContent, handleSave]);

  /** 退出编辑模式当 note 切换时，清理 pending auto-save */
  useEffect(() => {
    // 草稿首次落盘（null → 新路径）不算「切换笔记」，保持编辑态不被打断
    if (keepEditingOnCommitRef.current) {
      keepEditingOnCommitRef.current = false;
      return;
    }
    if (autoSaveTimerRef.current) {
      clearTimeout(autoSaveTimerRef.current);
      autoSaveTimerRef.current = null;
    }
    setIsEditing(false);
  }, [note?.path]);

  /** 快速记录灵感：零摩擦进编辑器，敲第一个字才落盘（见 createDraftFile） */
  const handleQuickCapture = useCallback(() => {
    void flushEditBeforeSwitch().then(() => {
      // fix: 直接用 captureFolderRef（已在 mount 时从 localStorage 初始化，并随时同步）
      const folder = captureFolderRef.current;
      setCaptureFolder(folder);
      captureFolderRef.current = folder;
      draftCreatedPathRef.current = null;
      noteUpdatedAtRef.current = null;
      activePathRef.current = null;
      setAutoTitleTarget(null);
      if (autoSaveTimerRef.current) {
        clearTimeout(autoSaveTimerRef.current);
        autoSaveTimerRef.current = null;
      }
      setNote(null);
      setActivePath(null);
      setEditContent("");
      setEditorMinHeight(0);
      setNoteState("ready");
      isDraftRef.current = true;
      setIsDraft(true);
      setIsEditing(true);
      if (isMobileViewport) {
        setMobileSidebarOpen(false);
        setMobileAssistantSheet('closed');
      }
    });
  }, [flushEditBeforeSwitch, isMobileViewport, setAutoTitleTarget]);

  /** 切换「存到…」目标文件夹，并记忆为下次默认 */
  const handleCaptureFolderChange = useCallback((folder: string) => {
    setCaptureFolder(folder);
    captureFolderRef.current = folder;
    try {
      window.localStorage.setItem(CAPTURE_FOLDER_KEY, folder);
    } catch { /* ignore */ }
  }, []);

  /** 回首页：清空当前文章/草稿，本次会话（含刷新）不再被自动恢复弹回 */
  const goHome = useCallback(() => {
    void flushEditBeforeSwitch().then(() => {
      if (autoSaveTimerRef.current) {
        clearTimeout(autoSaveTimerRef.current);
        autoSaveTimerRef.current = null;
      }
      isDraftRef.current = false;
      draftCreatedPathRef.current = null;
      setIsDraft(false);
      setIsEditing(false);
      setEditContent("");
      setNote(null);
      setActivePath(null);
      activePathRef.current = null;
      noteUpdatedAtRef.current = null;
      pendingHashRef.current = null;
      setAutoTitleTarget(null);
      setNoteState("ready");
      setGitPanelOpen(false);
      try {
        window.localStorage.removeItem(LAST_FILE_KEY);
      } catch { /* ignore */ }
      const nextUrl = new URL(window.location.href);
      nextUrl.searchParams.delete("file");
      nextUrl.hash = "";
      window.history.replaceState(null, "", nextUrl);
      if (isMobileViewport) {
        setMobileSidebarOpen(false);
        setMobileAssistantSheet('closed');
      }
    });
  }, [flushEditBeforeSwitch, isMobileViewport, setAutoTitleTarget]);

  // 全局 Git 状态轮询 — 为侧边栏底部状态条和移动端 badge 提供数据
  useEffect(() => {
    const poll = async () => {
      try {
        const res = await fetch("/api/notes/git", { cache: "no-store" });
        const data = (await res.json()) as { files?: unknown[]; error?: string };
        if (!data.error) setGlobalGitPending(data.files?.length ?? 0);
      } catch { /* silent */ }
    };
    void poll();
    const id = setInterval(() => void poll(), 30_000);
    return () => clearInterval(id);
  }, []);

  /** 当前文件切换时检查 git 状态，更新「未同步」指示点 */
  useEffect(() => {
    setHasGitChanges(false);
    const p = note?.path;
    if (!p || /\.html?$/i.test(p)) return;
    let cancelled = false;
    fetch(`/api/notes/git?check=${encodeURIComponent(p)}`)
      .then((r) => r.ok ? r.json() : null)
      .then((data: { changed: boolean } | null) => {
        if (!cancelled && data) setHasGitChanges(data.changed);
      })
      .catch(() => { /* silent */ });
    return () => { cancelled = true; };
  }, [note?.path]);

  /** ⌘S 立即保存（取消 pending debounce，直接 flush） */
  useEffect(() => {
    if (!isEditing) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "s") {
        e.preventDefault();
        if (autoSaveTimerRef.current) {
          clearTimeout(autoSaveTimerRef.current);
          autoSaveTimerRef.current = null;
        }
        void handleSave();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [isEditing, handleSave]);

  /**
   * 新建笔记：不弹窗问名字。先落一个同目录内不冲突的占位名，
   * 正文首行写完后由 maybeAutoTitle 改成真名。
   */
  const createBlankNote = useCallback(async (folder?: string) => {
    const targetFolder = folder ?? (activePathRef.current ? getParentFolder(activePathRef.current) : "");
    const filePath = targetFolder
      ? `${targetFolder}/${uniqueUntitledName(files, targetFolder)}.md`
      : `${uniqueUntitledName(files, targetFolder)}.md`;

    try {
      await flushEditBeforeSwitch();
      const res = await fetch("/api/notes/file", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: filePath, content: "" }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(data.error ?? "创建失败");
      }

      // 新建会顶掉正在写的草稿态，否则草稿的首字落盘逻辑会打到新笔记上
      isDraftRef.current = false;
      draftCreatedPathRef.current = null;
      setIsDraft(false);

      await refreshTree();
      // 从别处切过来时 note.path 会变，但这不该退出编辑态——新笔记本来就要直接开写
      keepEditingOnCommitRef.current = true;
      await loadNote(filePath);
      if (activePathRef.current !== filePath) {
        // 打开失败：别把「保持编辑态」的标记留给下一次真正的切换
        keepEditingOnCommitRef.current = false;
        return;
      }

      setAutoTitleTarget(filePath);
      setEditContent("");
      setEditorMinHeight(0);
      setIsEditing(true);
      setTimeout(() => editorFocusRef.current?.focus(), 0);
      if (isMobileViewport) {
        setMobileSidebarOpen(false);
        setMobileAssistantSheet("closed");
      }
    } catch (err) {
      alert(err instanceof Error ? err.message : "创建失败");
    }
  }, [files, flushEditBeforeSwitch, isMobileViewport, loadNote, refreshTree, setAutoTitleTarget]);

  /** 各处「新建笔记」入口的同步包装（TreeItem 等只接受同步回调） */
  const handleNewNote = useCallback((folder?: string) => {
    void createBlankNote(folder);
  }, [createBlankNote]);

  /** 打开新建笔记对话框（「新建并命名…」），默认目录 = 当前笔记所在目录 */
  const openNewNote = useCallback((folder?: string) => {
    const defaultFolder = folder ?? (activePath ? getParentFolder(activePath) : "");
    setNewNoteFolder(defaultFolder);
    setNewNoteTitle("");
    setNewNoteError(null);
    setInlineFolderOpen(false);
    setInlineFolderName("");
    setInlineFolderError(null);
    setNewNoteOpen(true);
    // 等 DOM 渲染后聚焦输入框
    setTimeout(() => newNoteTitleRef.current?.focus(), 30);
  }, [activePath]);

  /** 打开新建文件夹对话框 */
  const openNewFolder = useCallback((folder?: string) => {
    const defaultParent = folder ?? (activePath ? getParentFolder(activePath) : "");
    setNewFolderParent(defaultParent);
    setNewFolderName("");
    setNewFolderError(null);
    setNewFolderOpen(true);
    setTimeout(() => newFolderNameRef.current?.focus(), 30);
  }, [activePath]);

  /** 执行新建文件夹（独立对话框） */
  const handleCreateFolder = useCallback(async () => {
    const name = newFolderName.trim();
    if (!name) {
      setNewFolderError("请输入文件夹名称");
      newFolderNameRef.current?.focus();
      return;
    }
    const safeName = name.replace(/[/\\:*?"<>|]/g, "-");
    const folderPath = newFolderParent ? `${newFolderParent}/${safeName}` : safeName;
    setNewFolderLoading(true);
    setNewFolderError(null);
    try {
      const res = await fetch("/api/notes/folder", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: folderPath }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(data.error ?? "创建失败");
      }
      await refreshTree();
      setExpandedFolders((prev) => {
        const next = new Set(prev);
        const parts = folderPath.split("/");
        let accumulated = "";
        for (const part of parts) {
          accumulated = accumulated ? `${accumulated}/${part}` : part;
          next.add(accumulated);
        }
        return next;
      });
      setNewFolderOpen(false);
    } catch (err) {
      setNewFolderError(err instanceof Error ? err.message : "创建失败");
    } finally {
      setNewFolderLoading(false);
    }
  }, [newFolderName, newFolderParent, refreshTree]);

  /** 新建笔记对话框内 inline 新建文件夹 */
  const handleInlineCreateFolder = useCallback(async () => {
    const name = inlineFolderName.trim();
    if (!name) {
      setInlineFolderError("请输入文件夹名称");
      inlineFolderInputRef.current?.focus();
      return;
    }
    const safeName = name.replace(/[/\\:*?"<>|]/g, "-");
    const parentFolder = newNoteFolder;
    const folderPath = parentFolder ? `${parentFolder}/${safeName}` : safeName;
    setInlineFolderLoading(true);
    setInlineFolderError(null);
    try {
      const res = await fetch("/api/notes/folder", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: folderPath }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(data.error ?? "创建失败");
      }
      await refreshTree();
      setNewNoteFolder(folderPath);
      setInlineFolderOpen(false);
      setInlineFolderName("");
      setInlineFolderError(null);
    } catch (err) {
      setInlineFolderError(err instanceof Error ? err.message : "创建失败");
    } finally {
      setInlineFolderLoading(false);
    }
  }, [inlineFolderName, newNoteFolder, refreshTree]);



  const handleCreateNote = useCallback(async () => {
    const title = newNoteTitle.trim();
    if (!title) {
      setNewNoteError("请输入笔记标题");
      newNoteTitleRef.current?.focus();
      return;
    }

    // 将标题转为合法文件名（去掉 / \ : * ? " < > |）
    const safeName = title.replace(/[/\\:*?"<>|]/g, "-");
    const filePath = newNoteFolder ? `${newNoteFolder}/${safeName}.md` : `${safeName}.md`;

    setNewNoteLoading(true);
    setNewNoteError(null);

    try {
      const res = await fetch("/api/notes/file", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: filePath, content: `# ${title}\n` }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(data.error ?? "创建失败");
      }

      await refreshTree();
      // 展开新笔记所在目录
      if (newNoteFolder) {
        setExpandedFolders((prev) => {
          const next = new Set(prev);
          const parts = newNoteFolder.split("/");
          let accumulated = "";
          for (const part of parts) {
            accumulated = accumulated ? `${accumulated}/${part}` : part;
            next.add(accumulated);
          }
          return next;
        });
      }

      setNewNoteOpen(false);
      // 跳转到新笔记
      void loadNote(filePath);
    } catch (err) {
      setNewNoteError(err instanceof Error ? err.message : "创建失败");
    } finally {
      setNewNoteLoading(false);
    }
  }, [newNoteTitle, newNoteFolder, loadNote, refreshTree]);

  /** ⌘N / Ctrl+N 快捷键 */
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "n" && !e.shiftKey && !e.altKey) {
        // 避免在输入框内触发
        const tag = (e.target as HTMLElement).tagName;
        if (tag === "INPUT" || tag === "TEXTAREA" || (e.target as HTMLElement).isContentEditable) return;
        e.preventDefault();
        handleNewNote();
      }
      if (e.key === "Escape" && newNoteOpen) {
        setNewNoteOpen(false);
      }
      if (e.key === "Escape" && newFolderOpen) {
        setNewFolderOpen(false);
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [newNoteOpen, newFolderOpen, handleNewNote]);

  /** ⌘K / Ctrl+K 快速打开（输入框内也生效：这是全局导航，不与文本输入冲突） */
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "k" && !e.shiftKey && !e.altKey) {
        e.preventDefault();
        setQuickSwitcherOpen((open) => !open);
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);

  const handleToggle = useCallback((path: string) => {
    setTreeMenuTarget(null);
    setGlobalCreateMenuOpen(false);
    setExpandedFolders((current) => {
      const next = new Set(current);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });
  }, []);

  const handleSelect = useCallback(
    (path: string) => {
      setTreeMenuTarget(null);
      setGlobalCreateMenuOpen(false);
      void flushEditBeforeSwitch().then(() => loadNote(path));
      if (isMobileViewport) {
        setMobileSidebarOpen(false);
      }
    },
    [isMobileViewport, loadNote, flushEditBeforeSwitch],
  );

  const handleTabSelect = useCallback((path: string) => {
    if (path === activePathRef.current) return;
    // 标签切换恢复上次阅读位置（与文件树点击不同，这是标签的核心价值）
    void flushEditBeforeSwitch().then(() => loadNote(path, null, { restoreStoredScroll: true }));
  }, [flushEditBeforeSwitch, loadNote]);

  const handleTabClose = useCallback((path: string) => {
    const isActive = path === activePathRef.current;
    const idx = tabs.indexOf(path);
    const neighbor = isActive ? tabs[idx + 1] ?? tabs[idx - 1] ?? null : null;
    removeTabEntry(path);
    if (!isActive) return;
    if (neighbor) {
      void flushEditBeforeSwitch().then(() => loadNote(neighbor, null, { restoreStoredScroll: true }));
    } else {
      goHome();
    }
  }, [tabs, removeTabEntry, flushEditBeforeSwitch, loadNote, goHome]);

  const clearSearch = useCallback(() => {
    setSearchQuery("");
    setSearchResults([]);
    setSearchState("idle");
    setSearchError(null);
    setActiveSearchIndex(-1);
  }, []);

  const handleSearchResultSelect = useCallback(
    (path: string) => {
      clearSearch();
      handleSelect(path);
    },
    [clearSearch, handleSelect],
  );

  const handleMarkdownNavigate = useCallback(
    (path: string, hash?: string | null) => {
      void loadNote(path, hash);
    },
    [loadNote],
  );

  const handleHtmlHeadingsChange = useCallback((path: string, entries: TocEntry[]) => {
    setHtmlToc((current) => {
      const unchanged =
        current.path === path &&
        current.entries.length === entries.length &&
        current.entries.every((entry, index) => {
          const next = entries[index];
          return (
            next?.level === entry.level &&
            next.text === entry.text &&
            next.slug === entry.slug
          );
        });
      return unchanged ? current : { path, entries };
    });
  }, []);

  const handleHtmlHashNavigate = useCallback((fragment: string) => {
    const path = activePathRef.current;
    if (!path) return;
    const hash = normalizeNavigationHash(fragment);
    const nextUrl = new URL(window.location.href);
    nextUrl.searchParams.set("file", path);
    nextUrl.hash = hash ?? "";
    window.history.replaceState(null, "", nextUrl);
    pushNavHistory(path, hash);
  }, [pushNavHistory]);

  const handleHtmlLinkNavigate = useCallback((href: string) => {
    const currentPath = activePathRef.current;
    if (!currentPath) return;
    const target = resolveHtmlLinkTarget(href, currentPath, files);
    if (!target) return;

    if (target.path === currentPath) {
      if (target.hash !== null) {
        htmlPreviewRef.current?.scrollToFragment(target.hash, {
          behavior: "smooth",
          recordHistory: true,
        });
      }
      return;
    }
    void loadNote(target.path, target.hash);
  }, [files, loadNote]);

  const navigateToHistoryEntry = useCallback((entry: NavHistoryEntry) => {
    const nextUrl = new URL(window.location.href);
    nextUrl.searchParams.set("file", entry.path);
    nextUrl.hash = entry.hash ?? "";
    window.history.replaceState(null, "", nextUrl);

    if (entry.path === activePathRef.current && /\.html?$/i.test(entry.path)) {
      htmlPreviewRef.current?.scrollToFragment(entry.hash ?? "", {
        behavior: "auto",
        recordHistory: false,
      });
      return;
    }
    void loadNote(entry.path, entry.hash, { updateHistory: false });
  }, [loadNote]);

  const handleNavBack = useCallback(() => {
    const cur = navCursorRef.current;
    if (cur <= 0) return;
    navCursorRef.current = cur - 1;
    setNavCanGoBack(navCursorRef.current > 0);
    setNavCanGoForward(true);
    navigateToHistoryEntry(navHistoryRef.current[navCursorRef.current]);
  }, [navigateToHistoryEntry]);

  const handleNavForward = useCallback(() => {
    const cur = navCursorRef.current;
    const hist = navHistoryRef.current;
    if (cur >= hist.length - 1) return;
    navCursorRef.current = cur + 1;
    setNavCanGoBack(true);
    setNavCanGoForward(navCursorRef.current < hist.length - 1);
    navigateToHistoryEntry(hist[navCursorRef.current]);
  }, [navigateToHistoryEntry]);

  const handleCreateWikiNote = useCallback(
    (noteName: string) => {
      const folder = activePath ? getParentFolder(activePath) : "";
      const slashIdx = noteName.lastIndexOf("/");
      const noteTitle = slashIdx !== -1 ? noteName.slice(slashIdx + 1) : noteName;
      const noteFolder = slashIdx !== -1
        ? (folder ? `${folder}/${noteName.slice(0, slashIdx)}` : noteName.slice(0, slashIdx))
        : folder;
      setNewNoteFolder(noteFolder);
      setNewNoteTitle(noteTitle);
      setNewNoteError(null);
      setNewNoteOpen(true);
    },
    [activePath],
  );

  const handleImageDownload = useCallback(async () => {
    if (!activePath || !isImagePath(activePath)) return;

    const src = `/api/notes/doc?path=${encodeURIComponent(activePath)}`;
    const filename = getFilenameFromPath(activePath, "image.png");

    try {
      const response = await fetch(src);
      if (!response.ok) throw new Error("Image download failed");
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = filename;
      anchor.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 0);
    } catch {
      const anchor = document.createElement("a");
      anchor.href = src;
      anchor.download = filename;
      anchor.click();
    }
  }, [activePath]);

  const handleDownloadPath = useCallback(async (path: string) => {
    const src = `/api/notes/doc?path=${encodeURIComponent(path)}`;
    const filename = getFilenameFromPath(path, "download");

    try {
      const response = await fetch(src);
      if (!response.ok) throw new Error("Download failed");
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = filename;
      anchor.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 0);
    } catch {
      const anchor = document.createElement("a");
      anchor.href = src;
      anchor.download = filename;
      anchor.click();
    }
  }, []);

  const handleOpenTreeMenu = useCallback((target: TreeActionTarget) => {
    setGlobalCreateMenuOpen(false);
    if (isMobileViewport) {
      setTreeMenuTarget(null);
      setTreeSheetTarget(target);
    } else {
      setTreeSheetTarget(null);
      setTreeMenuTarget((current) => current?.path === target.path ? null : target);
    }
  }, [isMobileViewport]);

  // 稳定引用：TreeItem 已 memo 化，内联箭头会让整棵树每次父组件渲染都重渲染
  const handleCloseTreeMenu = useCallback(() => setTreeMenuTarget(null), []);

  const handleOpenRename = useCallback((target: TreeActionTarget) => {
    const ext = target.kind === "file" ? target.name.match(/\.[^.]+$/)?.[0] ?? "" : "";
    renameInProgressRef.current = false;
    setRenameTarget(target);
    setRenameName(target.kind === "file" && ext ? target.name.slice(0, -ext.length) : target.name);
    setRenameError(null);
    setTreeMenuTarget(null);
    setTreeSheetTarget(null);
  }, []);

  const handleRenameCancel = useCallback(() => {
    renameInProgressRef.current = true;
    setRenameTarget(null);
    setRenameError(null);
  }, []);

  // ── 删除核心（确认框路径与"直接删+撤销"路径共用） ─────────
  const deleteEntry = useCallback(async (target: TreeActionTarget) => {
    const currentPath = activePathRef.current;
    const affectsActivePath = !!currentPath && (
      target.kind === "file"
        ? currentPath === target.path
        : (currentPath === target.path || currentPath.startsWith(`${target.path}/`))
    );

    const res = await fetch(target.kind === "file" ? "/api/notes/file" : "/api/notes/folder", {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: target.path }),
    });
    if (!res.ok) {
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      throw new Error(data.error ?? "删除失败");
    }
    // 文件已删除 — 清自动保存定时器，再刷新文件树（失败不影响后续流程）
    if (autoSaveTimerRef.current) {
      clearTimeout(autoSaveTimerRef.current);
      autoSaveTimerRef.current = null;
    }
    pruneTabs((p) => target.kind === "file"
      ? p !== target.path
      : p !== target.path && !p.startsWith(`${target.path}/`));
    if (affectsActivePath) {
      skipNextFlushRef.current = true; // fix: goHome 里的 flushEditBeforeSwitch 不能 PATCH 已删除的文件
    }
    try {
      await refreshTree();
    } catch { /* 刷新文件树失败不影响回首页 */ }
    if (affectsActivePath) {
      setHasGitChanges(true);
      goHome();
    }
  }, [goHome, pruneTabs, refreshTree]);

  // ── Markdown 笔记：立即删除 + 撤销 toast（可撤销优于确认框）────
  const [undoDelete, setUndoDelete] = useState<{ path: string; name: string; content: string } | null>(null);
  const undoDeleteTimerRef = useRef<number | null>(null);

  const clearUndoDelete = useCallback(() => {
    if (undoDeleteTimerRef.current) {
      window.clearTimeout(undoDeleteTimerRef.current);
      undoDeleteTimerRef.current = null;
    }
    setUndoDelete(null);
  }, []);

  const handleSoftDeleteNote = useCallback(async (target: TreeActionTarget) => {
    try {
      // 删前抓取内容，撤销时原样写回；抓取失败则回落到确认框流程
      const res = await fetch(`/api/notes/file?path=${encodeURIComponent(target.path)}`);
      if (!res.ok) throw new Error("读取失败");
      const note = (await res.json()) as { content?: string };
      await deleteEntry(target);
      if (undoDeleteTimerRef.current) {
        window.clearTimeout(undoDeleteTimerRef.current);
      }
      setUndoDelete({ path: target.path, name: target.name, content: note.content ?? "" });
      undoDeleteTimerRef.current = window.setTimeout(() => {
        undoDeleteTimerRef.current = null;
        setUndoDelete(null);
      }, 6000);
      return true;
    } catch {
      return false;
    }
  }, [deleteEntry]);

  const handleUndoDelete = useCallback(async () => {
    if (!undoDelete) return;
    clearUndoDelete();
    try {
      const res = await fetch("/api/notes/file", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: undoDelete.path, content: undoDelete.content }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(data.error ?? "恢复失败");
      }
      try {
        await refreshTree();
      } catch { /* 刷新失败不影响恢复本身 */ }
    } catch (err) {
      alert(err instanceof Error ? err.message : "恢复失败");
    }
  }, [undoDelete, clearUndoDelete, refreshTree]);

  const handleOpenDelete = useCallback((target: TreeActionTarget) => {
    setTreeMenuTarget(null);
    setTreeSheetTarget(null);
    // .md 笔记直接删 + 撤销 toast；文件夹、html、pdf、图片仍走确认框
    // （恢复接口只支持 .md，且文件夹删除影响面大，保留一步确认）
    if (target.kind === "file" && /\.md$/i.test(target.path)) {
      void handleSoftDeleteNote(target).then((ok) => {
        if (!ok) {
          setDeleteTarget(target);
          setDeleteConfirmOpen(true);
        }
      });
      return;
    }
    setDeleteTarget(target);
    setDeleteConfirmOpen(true);
  }, [handleSoftDeleteNote]);

  const handleStartImport = useCallback((folder: string) => {
    setImportFolder(folder);
    setImportError(null);
    setTreeMenuTarget(null);
    setTreeSheetTarget(null);
    setGlobalCreateMenuOpen(false);
    if (importInputRef.current) {
      importInputRef.current.value = "";
      importInputRef.current.click();
    }
  }, []);

  const handleImportFiles = useCallback(async (fileList: FileList | null) => {
    const selectedFiles = Array.from(fileList ?? []);
    if (selectedFiles.length === 0) return;

    // 分批：每批累计不超过 ~20MB（nginx 上限 50M，留足余量），最多 8 个文件。
    // 单张超过 20MB 的大文件自成一批。批与批之间并发上传（见下方并发池），
    // 既避开请求体大小限制、控制服务端内存峰值，又不牺牲整体速度。
    const MAX_FILES_PER_BATCH = 8;
    const MAX_BYTES_PER_BATCH = 20 * 1024 * 1024;
    const UPLOAD_CONCURRENCY = 3;
    const batches: File[][] = [];
    let current: File[] = [];
    let currentBytes = 0;
    for (const file of selectedFiles) {
      const tooManyFiles = current.length >= MAX_FILES_PER_BATCH;
      const tooLarge = current.length > 0 && currentBytes + file.size > MAX_BYTES_PER_BATCH;
      if (tooManyFiles || tooLarge) {
        batches.push(current);
        current = [];
        currentBytes = 0;
      }
      current.push(file);
      currentBytes += file.size;
    }
    if (current.length > 0) batches.push(current);

    setImportFailed([]);
    setImportProgress({ total: selectedFiles.length, done: 0 });
    setImportLoading(true);

    const imported: Array<{ path: string }> = [];
    const failed: Array<{ name: string; reason: string }> = [];
    let done = 0;

    const uploadBatch = async (batch: File[]) => {
      const form = new FormData();
      form.set("folder", importFolder);
      batch.forEach((file) => form.append("files", file));

      try {
        const res = await fetch("/api/notes/import", { method: "POST", body: form });
        if (!res.ok) {
          const data = (await res.json().catch(() => ({}))) as { error?: string };
          // 整批请求失败（如 413 / 网络错误）：本批全部记为失败，继续其余批次。
          const reason = data.error ?? (res.status === 413 ? "文件过大" : `导入失败（${res.status}）`);
          batch.forEach((file) => failed.push({ name: file.name, reason }));
        } else {
          const data = (await res.json()) as {
            files: Array<{ path: string }>;
            failed?: Array<{ name: string; reason: string }>;
          };
          imported.push(...data.files);
          if (data.failed?.length) failed.push(...data.failed);
        }
      } catch {
        batch.forEach((file) => failed.push({ name: file.name, reason: "网络错误" }));
      }

      // JS 单线程，await 之间的累加与 push 不会竞态。
      done += batch.length;
      setImportProgress({ total: selectedFiles.length, done });
    };

    try {
      // 并发池：同时最多 UPLOAD_CONCURRENCY 个批次在传，传完一个立刻领下一个。
      let nextIndex = 0;
      const worker = async () => {
        while (nextIndex < batches.length) {
          const batch = batches[nextIndex++];
          await uploadBatch(batch);
        }
      };
      await Promise.all(
        Array.from({ length: Math.min(UPLOAD_CONCURRENCY, batches.length) }, worker),
      );

      await refreshTree();
      if (imported.length > 0) setHasGitChanges(true);
      if (imported.length === 1 && failed.length === 0) {
        void loadNote(imported[0].path);
      } else if (importFolder) {
        openAncestors(`${importFolder}/_`);
      }
      if (failed.length > 0) setImportFailed(failed);
    } finally {
      setImportLoading(false);
      setImportProgress(null);
      if (importInputRef.current) importInputRef.current.value = "";
    }
  }, [importFolder, loadNote, openAncestors, refreshTree]);

  const handleRenameTarget = useCallback(async () => {
    if (!renameTarget || renameInProgressRef.current) return;
    renameInProgressRef.current = true;
    const baseName = sanitizeEntryName(renameName);
    if (!baseName) {
      setRenameTarget(null);
      return;
    }

    const ext = renameTarget.kind === "file" ? renameTarget.name.match(/\.[^.]+$/)?.[0] ?? "" : "";
    const normalizedBaseName = renameTarget.kind === "file" && ext && baseName.toLowerCase().endsWith(ext.toLowerCase())
      ? baseName.slice(0, -ext.length)
      : baseName;
    const nextName = renameTarget.kind === "file" && ext ? `${normalizedBaseName}${ext}` : normalizedBaseName;
    if (nextName === renameTarget.name) {
      setRenameTarget(null);
      return;
    }

    setRenameError(null);
    try {
      const currentPath = activePathRef.current;
      // 重命名前先落盘当前编辑内容：服务端会改写指向被重命名笔记的双链，未保存的
      // 草稿若不先 flush，链接改写会基于旧的磁盘版本，保存时把改写覆盖回去。
      // 当前笔记本身未移动时，改写后的磁盘内容由 /api/notes/watch 的 SSE 自动重载。
      await flushEditBeforeSwitch();

      const res = await fetch(renameTarget.kind === "file" ? "/api/notes/file" : "/api/notes/folder", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(renameTarget.kind === "file"
          ? { action: "rename", path: renameTarget.path, name: nextName }
          : { path: renameTarget.path, name: nextName }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(data.error ?? "重命名失败");
      }
      const result = (await res.json()) as { oldPath: string; path: string; kind: TreeActionTarget["kind"] };
      // 用户亲自命名后，不再让首行接管文件名（文件夹改名则看它有没有把这篇带走）
      if (autoTitlePathRef.current &&
        (autoTitlePathRef.current === result.oldPath || autoTitlePathRef.current.startsWith(`${result.oldPath}/`))) {
        setAutoTitleTarget(null);
      }
      // 先映射标签路径再刷新文件树，否则刷新触发的失效清理会把旧路径标签删掉
      mapTabs((p) => replaceMovedPath(p, result.oldPath, result.path, result.kind));
      await refreshTree();

      setExpandedFolders((prev) => {
        const next = new Set<string>();
        prev.forEach((folder) => next.add(replaceMovedPath(folder, result.oldPath, result.path, "folder")));
        next.add(result.kind === "folder" ? result.path : getParentFolder(result.path));
        return next;
      });

      if (currentPath) {
        const resolvedNextActivePath = replaceMovedPath(currentPath, result.oldPath, result.path, result.kind);
        if (resolvedNextActivePath !== currentPath) {
          setHasGitChanges(true);
          void loadNote(resolvedNextActivePath, null, { preserveScroll: true });
        }
      }
      setRenameTarget(null);
    } catch (err) {
      setRenameError(err instanceof Error ? err.message : "重命名失败");
      renameInProgressRef.current = false;
    }
  }, [flushEditBeforeSwitch, loadNote, mapTabs, refreshTree, renameName, renameTarget, setAutoTitleTarget]);

  const handleSelectTocHeading = useCallback(
    (slug: string) => {
      if (/\.html?$/i.test(activePathRef.current ?? "")) {
        htmlPreviewRef.current?.scrollToHeading(slug, {
          behavior: "smooth",
          recordHistory: true,
        });
      } else {
        const target = document.getElementById(slug);
        target?.scrollIntoView({ behavior: "smooth", block: "start" });
      }
      setActiveTocSlug(slug);

      if (isMobileViewport) {
        setMobileTocOpen(false);
      }
    },
    [isMobileViewport],
  );

  const handleClaudeToggle = useCallback(() => {
    setAiStatus((prev) => (prev === "done" ? "idle" : prev));

    if (isMobileViewport) {
      setMobileSidebarOpen(false);
      setMobileAssistantSheet((s) => s === 'expanded' ? 'closed' : 'expanded');
    } else {
      setAssistantPanelVisible((visible) => !visible);
    }
  }, [isMobileViewport]);

  /** ⌘J / Ctrl+J 开合 AI 对话面板（全局导航，与 ⌘K 同级，输入框内也生效） */
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "j" && !e.shiftKey && !e.altKey) {
        e.preventDefault();
        handleClaudeToggle();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [handleClaudeToggle]);

  /** 焦点在 chat iframe 内时按键不冒泡，由 chat 侧把 ⌘J 转发成消息 */
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (
        event.origin !== window.location.origin
        || event.source !== claudeFrameRef.current?.contentWindow
      ) return;
      if (event.data?.type === "toggle-panel") handleClaudeToggle();
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [handleClaudeToggle]);

  // ── 移动端底部 sheet：跟手拖拽 + 速度吸附 ─────────────────
  // 两个吸附点（translateY，单位 px）：expanded=0, closed=H。
  const handleSheetPointerDown = useCallback((e: ReactPointerEvent<HTMLButtonElement>) => {
    if (!isMobileViewport) return;
    const el = assistantPanelRef.current;
    if (!el) return;
    const panelH = el.offsetHeight;
    const baseY = mobileAssistantSheet === 'expanded' ? 0 : panelH;
    sheetDragRef.current = {
      active: true, startY: e.clientY, baseY, panelH,
      lastY: e.clientY, lastT: e.timeStamp, velocity: 0, moved: 0,
    };
    el.style.transition = 'none'; // 拖拽期间关闭过渡，跟手
    e.currentTarget.setPointerCapture(e.pointerId);
  }, [isMobileViewport, mobileAssistantSheet]);

  const handleSheetPointerMove = useCallback((e: ReactPointerEvent<HTMLButtonElement>) => {
    const d = sheetDragRef.current;
    const el = assistantPanelRef.current;
    if (!d || !d.active || !el) return;
    const delta = e.clientY - d.startY;
    d.moved = Math.max(d.moved, Math.abs(delta));
    const y = Math.min(d.panelH, Math.max(0, d.baseY + delta));
    el.style.transform = `translateY(${y}px)`;
    const dt = e.timeStamp - d.lastT;
    if (dt > 0) d.velocity = (e.clientY - d.lastY) / dt; // px/ms，正=向下
    d.lastY = e.clientY;
    d.lastT = e.timeStamp;
  }, []);

  const handleSheetPointerUp = useCallback((e: ReactPointerEvent<HTMLButtonElement>) => {
    const d = sheetDragRef.current;
    const el = assistantPanelRef.current;
    if (!d || !d.active) return;
    d.active = false;

    // 让 class 先提交，下一帧再清掉 inline transform 并恢复过渡，
    // 这样吸附动画从「当前拖拽位置」平滑过渡到目标档位，不会先弹回旧档再跳。
    const settle = () => {
      requestAnimationFrame(() => {
        if (!el) return;
        el.style.transition = '';
        el.style.transform = '';
      });
    };

    // 轻点（位移很小）：等同点击切换 closed ↔ expanded
    if (d.moved < 6) {
      if (el) { el.style.transition = ''; el.style.transform = ''; }
      setMobileAssistantSheet((s) => s === 'expanded' ? 'closed' : 'expanded');
      return;
    }

    const finalY = Math.min(d.panelH, Math.max(0, d.baseY + (e.clientY - d.startY)));
    const order: Array<'expanded' | 'closed'> = ['expanded', 'closed'];
    const anchors = [0, d.panelH];
    // 动量投影：用松手时的速度把落点向前推一段（120ms 惯性），再吸附到最近档位。
    // 这样「快速甩到底」会落到 closed，「缓慢小拖」按实际位置就近吸附，符合直觉。
    const projectedY = Math.min(d.panelH, Math.max(0, finalY + d.velocity * 120));
    const targetIdx = anchors.reduce((best, a, i) =>
      Math.abs(a - projectedY) < Math.abs(anchors[best] - projectedY) ? i : best, 0);
    setMobileAssistantSheet(order[targetIdx]);
    settle();
  }, []);

  const handleTocToggle = useCallback(() => {
    if (isMobileViewport) {
      // 移动端：大纲降级为「用完即走」的底部 sheet
      setMobileSidebarOpen(false);
      setMobileTocOpen((open) => !open);
    } else {
      // 桌面端：大纲常驻左栏。reveal-first —— 若左栏被隐藏或大纲已折叠，
      // 一次点击先把它们露出来；只有当大纲已经完整可见时，再点击才收起。
      const fullyVisible = sidebarVisible && tocSectionOpen;
      if (fullyVisible) {
        setTocSectionOpen(false);
      } else {
        setSidebarVisible(true);
        setTocSectionOpen(true);
      }
    }
  }, [isMobileViewport, sidebarVisible, tocSectionOpen]);

  const loadShareInfo = useCallback(async () => {
    if (!note) {
      return;
    }

    setShareState("loading");
    setShareMessage(null);

    try {
      const params = new URLSearchParams({ path: note.path });
      const response = await fetch(`/api/notes/share?${params.toString()}`, {
        cache: "no-store",
      });

      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error ?? `读取分享状态失败：${response.status}`);
      }

      const payload = (await response.json()) as ShareInfo;
      setShareToken(payload.token);
      setShareUrl(payload.url);
      setShareState("ready");
    } catch (shareError) {
      setShareState("error");
      setShareMessage(shareError instanceof Error ? shareError.message : "读取分享状态失败");
    }
  }, [note]);

  const handleOpenShareDialog = useCallback(() => {
    if (!note) {
      return;
    }

    setShareModalOpen(true);
    void loadShareInfo();
  }, [loadShareInfo, note]);

  const handleCreateShare = useCallback(async () => {
    if (!note) {
      return;
    }

    setShareState("creating");
    setShareMessage(null);

    try {
      const response = await fetch("/api/notes/share", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          path: note.path,
        }),
      });

      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error ?? `创建分享失败：${response.status}`);
      }

      const payload = (await response.json()) as { token: string; url: string };
      setShareToken(payload.token);
      setShareUrl(payload.url);
      setShareState("ready");
      setShareMessage("分享链接已生成");
    } catch (shareError) {
      setShareState("error");
      setShareMessage(shareError instanceof Error ? shareError.message : "创建分享失败");
    }
  }, [note]);

  const handleCopyShare = useCallback(async () => {
    if (!shareUrl) {
      return;
    }

    setShareState("copying");
    setShareMessage(null);

    try {
      await navigator.clipboard.writeText(shareUrl);
      setShareState("ready");
      setShareMessage("链接已复制");
    } catch {
      setShareState("error");
      setShareMessage("复制失败，请手动复制链接");
    }
  }, [shareUrl]);

  const handleRevokeShare = useCallback(async () => {
    if (!shareToken) {
      return;
    }

    setShareState("revoking");
    setShareMessage(null);

    try {
      const response = await fetch("/api/notes/share", {
        method: "DELETE",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          token: shareToken,
        }),
      });

      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error ?? `取消分享失败：${response.status}`);
      }

      setShareToken(null);
      setShareUrl(null);
      setShareState("ready");
      setShareMessage("已取消分享");
    } catch (shareError) {
      setShareState("error");
      setShareMessage(shareError instanceof Error ? shareError.message : "取消分享失败");
    }
  }, [shareToken]);

  // ── ⋯ 菜单：点外部关闭 ────────────────────────────────
  useEffect(() => {
    if (!moreMenuOpen) return;
    const handleClick = (e: MouseEvent) => {
      if (
        moreMenuRef.current?.contains(e.target as Node) ||
        moreButtonRef.current?.contains(e.target as Node)
      ) return;
      setMoreMenuOpen(false);
    };
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [moreMenuOpen]);

  useEffect(() => {
    if (!treeMenuTarget && !globalCreateMenuOpen) return;
    const handleClick = (e: MouseEvent) => {
      const target = e.target as Node;
      if (
        globalCreateMenuRef.current?.contains(target) ||
        globalCreateButtonRef.current?.contains(target) ||
        (target instanceof Element && target.closest(`.${styles.treeActionMenu}`))
      ) {
        return;
      }
      setTreeMenuTarget(null);
      setGlobalCreateMenuOpen(false);
    };
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [globalCreateMenuOpen, treeMenuTarget]);

  // ── 删除文件（确认框路径：文件夹 / html / pdf / 图片） ─────────
  const handleDeleteNote = useCallback(async () => {
    const target = deleteTarget ?? (activePath ? { kind: "file" as const, path: activePath, name: getFilenameFromPath(activePath, activePath) } : null);
    if (!target) return;
    setDeleteLoading(true);
    try {
      await deleteEntry(target);
      setDeleteConfirmOpen(false);
      setDeleteTarget(null);
    } catch (err) {
      alert(err instanceof Error ? err.message : "删除失败");
    } finally {
      setDeleteLoading(false);
    }
  }, [activePath, deleteTarget, deleteEntry]);
  const shellStyle: NotesShellStyle = {
    "--assistant-panel-width": `${assistantPanelWidth}px`,
    "--sidebar-width": `${sidebarWidth}px`,
    "--keyboard-height": `${keyboardHeight}px`,
  };
  const isDesktopSidebarHidden = !isMobileViewport && !sidebarVisible;
  const isSidebarOpen = isMobileViewport ? mobileSidebarOpen : sidebarVisible;
  const isAssistantPanelOpen = isMobileViewport ? mobileAssistantPanelOpen : assistantPanelVisible;
  const [isDashboardChatActive, setIsDashboardChatActive] = useState(false);
  // 首页 → 对话的退场过渡：仪表盘先做退场动画，再原地展开对话面板
  const [isDashboardExiting, setIsDashboardExiting] = useState(false);
  const isDashboardChatMode = !note && isAssistantPanelOpen && isDashboardChatActive && !isMobileViewport;
  // 移动端从首页提问：对话是主任务，全屏接管而非底部 sheet。
  // 不依赖 sheet 是否展开，否则关闭下滑动画进行中全屏类被摘掉，面板高度会跳变。
  const isMobileDashboardChat = !note && isMobileViewport && isDashboardChatActive;
  // 打开任何笔记即退出「首页对话」语义，避免之后回首页时残留的 active
  // 标志让面板意外跳回全屏/居中对话模式
  useEffect(() => {
    if (activePath) {
      setIsDashboardChatActive(false);
    }
  }, [activePath]);
  const postAskToClaude = useCallback((text: string) => {
    const frameWindow = claudeFrameRef.current?.contentWindow;
    if (claudeFrameReadyRef.current && frameWindow) {
      frameWindow.postMessage({ type: "note-ask", text }, window.location.origin);
    } else {
      pendingClaudeAskRef.current = text;
    }
  }, []);
  const isDesktopAssistantPanelHidden = !isMobileViewport && !assistantPanelVisible;
  const isDesktopGitView = !isMobileViewport && gitPanelOpen;
  const hasMobileOverlayOpen = isMobileViewport && (mobileSidebarOpen || mobileAssistantSheet === 'expanded' || gitPanelOpen || mobileTocOpen || treeSheetTarget !== null);
  // track when overlay opens to prevent ghost-click closing it immediately (Android touch issue)
  if (hasMobileOverlayOpen) mobileOverlayOpenTime.current = mobileOverlayOpenTime.current || Date.now();
  if (!hasMobileOverlayOpen) mobileOverlayOpenTime.current = 0;

  return (
    <main
      className={`${styles.shell} ${isDesktopSidebarHidden ? styles.shellSidebarHidden : ""} ${
        mobileSidebarOpen ? styles.shellMobileSidebarOpen : ""
      } ${
        mobileAssistantSheet === 'expanded' ? styles.shellMobileAssistantPanelOpen : ""
      } ${
        isDesktopAssistantPanelHidden ? styles.shellAssistantPanelHidden : ""
      } ${isResizingAssistantPanel || isResizingSidebar ? styles.shellResizing : ""}`}
      style={shellStyle}
    >
      {/* 侧栏隐藏时的左缘感应区：悬停唤出悬浮侧栏 */}
      {isDesktopSidebarHidden ? (
        <div
          className={styles.sidebarPeekZone}
          onMouseEnter={openSidebarPeek}
          onMouseLeave={scheduleSidebarPeekClose}
          aria-hidden="true"
        />
      ) : null}
      <aside
        className={`${styles.sidebar} ${isDesktopSidebarHidden ? styles.sidebarHidden : ""} ${
          isDesktopSidebarHidden && sidebarPeek !== "closed" ? styles.sidebarPeek : ""
        } ${isDesktopSidebarHidden && sidebarPeek === "closing" ? styles.sidebarPeekClosing : ""}`}
        aria-hidden={!isSidebarOpen && sidebarPeek === "closed"}
        onMouseEnter={isDesktopSidebarHidden && sidebarPeek !== "closed" ? openSidebarPeek : undefined}
        onMouseLeave={isDesktopSidebarHidden && sidebarPeek !== "closed" ? scheduleSidebarPeekClose : undefined}
      >
        <button
          type="button"
          className={styles.sidebarResizer}
          onPointerDown={(event) => {
            event.preventDefault();
            setIsResizingSidebar(true);
          }}
          onDoubleClick={() => setSidebarWidth(DEFAULT_SIDEBAR_WIDTH)}
          onKeyDown={(event) => {
            if (event.key === "ArrowRight") {
              event.preventDefault();
              setSidebarWidth((w) => clamp(w + 24, MIN_SIDEBAR_WIDTH, MAX_SIDEBAR_WIDTH));
            }
            if (event.key === "ArrowLeft") {
              event.preventDefault();
              setSidebarWidth((w) => clamp(w - 24, MIN_SIDEBAR_WIDTH, MAX_SIDEBAR_WIDTH));
            }
          }}
          aria-label="调整侧边栏宽度"
          title="拖拽调整侧边栏宽度，双击恢复默认"
          tabIndex={!isMobileViewport && isSidebarOpen ? 0 : -1}
        />
        <div className={styles.sidebarHeader}>
          {showTauri ? (
            <div className={styles.vaultSwitcherWrapper}>
              <button
                ref={vaultButtonRef}
                type="button"
                className={styles.vaultSwitcherBtn}
                onClick={() => setVaultMenuOpen((open) => !open)}
                aria-expanded={vaultMenuOpen}
                title={`当前笔记本路径: ${vaultPath || "未设置"}`}
              >
                <div className={styles.vaultSwitcherMain}>
                  <p className={styles.vaultSwitcherEyebrow}>
                    {process.env.NEXT_PUBLIC_APP_NAME?.trim() || "inkfellow"}
                  </p>
                  <h1 className={styles.vaultSwitcherTitle}>
                    <span>{vaultName}</span>
                    <svg className={styles.vaultChevron} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                      <path d="m6 9 6 6 6-6" />
                    </svg>
                  </h1>
                </div>
              </button>

              {vaultMenuOpen ? (
                <div ref={vaultMenuRef} className={styles.vaultDropdownMenu} role="menu">
                  <div className={styles.vaultDropdownSectionTitle}>当前笔记本</div>
                  <div className={styles.activeVaultCard}>
                    <div className={styles.activeVaultIcon}>
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H20v20H6.5a2.5 2.5 0 0 1-2.5-2.5Z" />
                        <path d="M6 6h10" />
                        <path d="M6 10h10" />
                      </svg>
                    </div>
                    <div className={styles.activeVaultInfo}>
                      <p className={styles.activeVaultName}>{vaultName}</p>
                      <p className={styles.activeVaultPath} title={vaultPath || ""}>{getDisplayPath(vaultPath)}</p>
                    </div>
                  </div>

                  <div className={styles.vaultDropdownDivider} />

                  {recentVaults.length > 1 && (
                    <>
                      <div className={styles.vaultDropdownSectionTitle}>最近使用</div>
                      <div className={styles.recentVaultsList}>
                        {recentVaults.map((path) => {
                          if (path === vaultPath) return null;
                          const name = path.split(/[/\\]/).filter(Boolean).pop() || "未命名";
                          return (
                            <button
                              key={path}
                              type="button"
                              className={styles.vaultDropdownItem}
                              onClick={() => handleSwitchToVault(path)}
                              role="menuitem"
                            >
                              <svg className={styles.dropdownItemIcon} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                <path d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H20v20H6.5a2.5 2.5 0 0 1-2.5-2.5Z" />
                              </svg>
                              <div className={styles.recentVaultInfo}>
                                <span className={styles.recentVaultNameText}>{name}</span>
                                <span className={styles.recentVaultPathText}>{getDisplayPath(path)}</span>
                              </div>
                            </button>
                          );
                        })}
                      </div>
                      <div className={styles.vaultDropdownDivider} />
                    </>
                  )}

                  <button
                    type="button"
                    className={styles.vaultDropdownItemAction}
                    onClick={handleChooseVault}
                    role="menuitem"
                  >
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
                    </svg>
                    <span>选择其他笔记本文件夹...</span>
                  </button>
                </div>
              ) : null}
            </div>
          ) : (
            <div>
              <p className={styles.eyebrow}>{process.env.NEXT_PUBLIC_APP_NAME?.trim() || "inkfellow"}</p>
              <h1 className={styles.title}>知识库</h1>
            </div>
          )}
          {!showTauri && <span className={styles.counter}>{files.length} 篇</span>}
          <div className={styles.sidebarActions}>
            <div className={styles.globalCreateWrapper}>
              <button
                ref={globalCreateButtonRef}
                type="button"
                className={`${styles.newNoteButton} ${globalCreateMenuOpen ? styles.iconButtonActive : ""}`}
                onClick={() => {
                  setTreeMenuTarget(null);
                  setGlobalCreateMenuOpen((open) => !open);
                }}
                aria-label="新建或导入"
                title="新建或导入"
                aria-expanded={globalCreateMenuOpen}
              >
                <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M12 5v14" />
                  <path d="M5 12h14" />
                </svg>
              </button>
              {globalCreateMenuOpen ? (
                <div ref={globalCreateMenuRef} className={styles.globalCreateMenu} role="menu">
                  <button type="button" className={styles.moreMenuItem} role="menuitem" onClick={() => { setGlobalCreateMenuOpen(false); handleNewNote(); }}>新建笔记</button>
                  {/* 免命名是主路径；想一次选好目录和名字的仍走对话框 */}
                  <button type="button" className={styles.moreMenuItem} role="menuitem" onClick={() => { setGlobalCreateMenuOpen(false); openNewNote(); }}>新建并命名…</button>
                  <button type="button" className={styles.moreMenuItem} role="menuitem" onClick={() => { setGlobalCreateMenuOpen(false); openNewFolder(); }}>新建文件夹</button>
                  <button type="button" className={styles.moreMenuItem} role="menuitem" onClick={() => handleStartImport(activePath ? getParentFolder(activePath) : "")} disabled={importLoading}>
                    {importLoading ? "导入中…" : "导入文件"}
                  </button>
                </div>
              ) : null}
            </div>
          </div>

        </div>
        <input
          ref={importInputRef}
          type="file"
          multiple
          className={styles.hiddenFileInput}
          accept=".md,.html,.htm,.pdf,image/avif,image/gif,image/jpeg,image/png,image/svg+xml,image/webp"
          onChange={(event) => void handleImportFiles(event.currentTarget.files)}
        />

        <div className={styles.search} role="search">
          <span className={styles.searchIcon} aria-hidden="true" />
          <input
            ref={searchInputRef}
            type="search"
            value={searchQuery}
            onChange={(event) => {
              const value = event.target.value;
              setSearchQuery(value);
              setSearchResults([]);
              setSearchError(null);
              setActiveSearchIndex(-1);
              setSearchState(isSearchQueryReady(value) ? "loading" : "idle");
            }}
            onKeyDown={(event) => {
              if (event.key === "Escape" && searchQuery) {
                event.preventDefault();
                clearSearch();
                return;
              }
              if (!shouldSearchNotes || searchResults.length === 0) {
                return;
              }
              if (event.key === "ArrowDown") {
                event.preventDefault();
                setActiveSearchIndex((current) => (current + 1) % searchResults.length);
                return;
              }
              if (event.key === "ArrowUp") {
                event.preventDefault();
                setActiveSearchIndex((current) =>
                  current <= 0 ? searchResults.length - 1 : current - 1,
                );
                return;
              }
              if (event.key === "Enter") {
                event.preventDefault();
                const hit = searchResults[activeSearchIndex] ?? searchResults[0];
                if (hit) {
                  handleSearchResultSelect(hit.path);
                }
              }
            }}
            placeholder="搜索文件和正文"
            aria-label="搜索文件和正文"
            role="combobox"
            aria-autocomplete="list"
            aria-controls={shouldSearchNotes ? "notes-search-results" : undefined}
            aria-expanded={shouldSearchNotes}
            aria-activedescendant={
              shouldSearchNotes && activeSearchIndex >= 0
                ? `notes-search-result-${activeSearchIndex}`
                : undefined
            }
          />
          {searchQuery ? (
            <button
              type="button"
              className={styles.searchClear}
              onClick={() => {
                clearSearch();
                searchInputRef.current?.focus();
              }}
              aria-label="清空搜索"
              title="清空搜索"
            >
              ×
            </button>
          ) : null}
        </div>

        <div className={styles.treePanel}>
          {shouldSearchNotes ? (
            <div
              id="notes-search-results"
              className={styles.searchResults}
              role="listbox"
              aria-label="搜索结果"
              aria-live="polite"
            >
              {searchState === "loading" ? (
                <div className={styles.searchResultState}>正在搜索…</div>
              ) : null}
              {searchState === "error" ? (
                <div className={`${styles.searchResultState} ${styles.searchResultError}`}>
                  {searchError ?? "搜索失败"}
                </div>
              ) : null}
              {searchState === "ready" && searchResults.length === 0 ? (
                <div className={styles.searchResultState}>未找到匹配内容</div>
              ) : null}
              {searchResults.map((hit, index) => {
                const folderLabel = getParentFolder(hit.path).split("/").filter(Boolean).pop() ?? "";
                const meta = [folderLabel, hit.snippet].filter(Boolean).join(" · ");
                return (
                  <button
                    key={hit.path}
                    id={`notes-search-result-${index}`}
                    type="button"
                    role="option"
                    aria-selected={index === activeSearchIndex}
                    className={`${styles.searchHit} ${
                      index === activeSearchIndex ? styles.searchHitActive : ""
                    }`}
                    onMouseEnter={() => setActiveSearchIndex(index)}
                    onClick={() => handleSearchResultSelect(hit.path)}
                    title={hit.path}
                  >
                    <span className={styles.searchHitTitle}>{stripNoteExtension(hit.name)}</span>
                    {meta ? <span className={styles.searchHitMeta}>{meta}</span> : null}
                  </button>
                );
              })}
            </div>
          ) : (
            <>
              {treeState === "loading" ? (
                <div className={styles.sidebarState}>正在读取文件树...</div>
              ) : null}
              {treeState === "error" ? (
                <div className={styles.sidebarState}>{error ?? "文件树加载失败"}</div>
              ) : null}
              {visibleTree ? (
                <TreeItem
                  node={visibleTree}
                  level={0}
                  activePath={activePath}
                  expandedFolders={expandedFolders}
                  searchQuery={searchQuery.trim()}
                  activeMenuPath={treeMenuTarget?.path ?? null}
                  isMobileViewport={isMobileViewport}
                  renamingTarget={renameTarget}
                  renameValue={renameName}
                  renameError={renameError}
                  onToggle={handleToggle}
                  onSelect={handleSelect}
                  onOpenMenu={handleOpenTreeMenu}
                  onCloseMenu={handleCloseTreeMenu}
                  onCreateNote={handleNewNote}
                  onCreateFolder={openNewFolder}
                  onImport={handleStartImport}
                  onRename={handleOpenRename}
                  onDelete={handleOpenDelete}
                  onDownload={handleDownloadPath}
                  onRenameValueChange={setRenameName}
                  onRenameCommit={handleRenameTarget}
                  onRenameCancel={handleRenameCancel}
                />
              ) : null}
              {treeState === "ready" && normalizedSearchQuery && !visibleTree ? (
                <div className={styles.sidebarState}>无匹配文件</div>
              ) : null}
            </>
          )}
        </div>

        {/* 大纲：桌面端常驻左栏的可折叠段，仅在打开笔记且有目录时出现 */}
        {!isMobileViewport && note && articleTocEntries.length > 0 ? (
          <ArticleToc
            headings={articleTocEntries}
            activeSlug={activeTocSlug}
            onSelect={handleSelectTocHeading}
            variant="section"
            collapsed={!tocSectionOpen}
            onToggleCollapsed={() => setTocSectionOpen((open) => !open)}
          />
        ) : null}

        {globalGitPending !== null && (
          <div className={styles.sidebarFooter}>
            <button
              type="button"
              className={styles.sidebarGitStatus}
              onClick={() => {
                if (isMobileViewport) setMobileSidebarOpen(false);
                setGitPanelOpen(true);
              }}
              tabIndex={isSidebarOpen ? 0 : -1}
              title={globalGitPending === 0 ? "已同步到云端" : `${globalGitPending} 篇笔记有未同步的改动`}
            >
              <span className={`${styles.sidebarGitDot} ${globalGitPending === 0 ? styles.sidebarGitDotSynced : ""}`} />
              <span className={styles.sidebarGitLabel}>
                {globalGitPending === 0 ? "已同步到云端" : `${globalGitPending} 篇待同步`}
              </span>
              {globalGitPending > 0 && (
                <span className={styles.sidebarGitArrow} aria-hidden="true">↑↓</span>
              )}
            </button>
          </div>
        )}
      </aside>

      <button
        type="button"
        className={`${styles.mobileScrim} ${hasMobileOverlayOpen ? styles.mobileScrimOpen : ""} ${gitPanelOpen && isMobileViewport ? styles.mobileScrimOverPanel : ""}`}
        onClick={() => {
          if (Date.now() - mobileOverlayOpenTime.current < 350) return;
          setMobileSidebarOpen(false);
          setMobileAssistantSheet('closed');
          setGitPanelOpen(false);
          setMobileTocOpen(false);
          setTreeSheetTarget(null);
        }}
        aria-label={mobileSidebarOpen ? "关闭目录" : "关闭辅助面板"}
        aria-hidden={!hasMobileOverlayOpen}
        tabIndex={hasMobileOverlayOpen ? 0 : -1}
      />

      {/* 移动端 git 底部 sheet */}
      <div
        className={`${styles.gitMobileSheet} ${gitPanelOpen && isMobileViewport ? styles.gitMobileSheetOpen : ""}`}
        aria-hidden={!(gitPanelOpen && isMobileViewport)}
        inert={!(gitPanelOpen && isMobileViewport)}
      >
        <header className={styles.gitMobileSheetHeader}>
          <span className={styles.gitMobileSheetTitle}>云端同步</span>
          <button
            type="button"
            className={styles.gitMobileSheetClose}
            onClick={() => setGitPanelOpen(false)}
            aria-label="关闭"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="6 9 12 15 18 9" />
            </svg>
          </button>
        </header>
        <div className={styles.gitMobileSheetBody}>
          {gitPanelOpen && isMobileViewport && (
            <NotesGit onOpenFile={(path) => {
              const exactMatch = files.find((f) => f.path === path);
              const resolvedPath = exactMatch
                ? path
                : (files.find((f) => f.path.toLowerCase() === path.toLowerCase())?.path ?? path);
              setGitPanelOpen(false);
              void loadNote(resolvedPath);
            }} />
          )}
        </div>
      </div>

      <section
        className={`${styles.reader} ${isDashboardChatMode ? styles.readerHidden : ""} ${isDesktopGitView ? styles.readerGitMode : ""}`}
        ref={readerRef}
        onDoubleClick={handleReaderDoubleClick}
        data-notes-reader
      >
        <header
          className={`${styles.readerHeader} ${isScrolled ? styles.readerHeaderScrolled : ""}`}
          data-notes-reader-header
        >
          <div className={styles.readerActions}>
            <button
              type="button"
              className={`${styles.iconButton} ${styles.sidebarToggleBtn} ${isSidebarOpen ? styles.iconButtonActive : ""}`}
              onClick={() => {
                if (isMobileViewport) {
                  setMobileAssistantSheet('closed');
                  setMobileSidebarOpen((open) => !open);
                } else {
                  setSidebarVisible((visible) => !visible);
                }
              }}
              aria-pressed={isSidebarOpen}
              aria-label={isSidebarOpen ? "隐藏目录" : "显示目录"}
              title={isSidebarOpen ? "隐藏目录" : "显示目录"}
            >
              {isMobileViewport ? (
                /* 移动端开的是目录抽屉，用 ☰；panel-left 是桌面折叠侧栏的语义 */
                <svg viewBox="0 0 24 24" width="17" height="17" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="4" y1="7" x2="20" y2="7" />
                  <line x1="4" y1="12" x2="20" y2="12" />
                  <line x1="4" y1="17" x2="20" y2="17" />
                </svg>
              ) : (
                <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="3" y="3" width="18" height="18" rx="2" />
                  <line x1="9" y1="3" x2="9" y2="21" />
                </svg>
              )}
              {globalGitPending !== null && globalGitPending > 0 && !isSidebarOpen && (
                <span className={styles.sidebarToggleBadge} aria-hidden="true" />
              )}
            </button>
            {!isDesktopGitView && (navCanGoBack || navCanGoForward) ? (
              <>
                <button
                  type="button"
                  className={styles.iconButton}
                  onClick={handleNavBack}
                  disabled={!navCanGoBack}
                  aria-label="后退"
                  title="后退"
                >
                  <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="15 18 9 12 15 6" />
                  </svg>
                </button>
                <button
                  type="button"
                  className={styles.iconButton}
                  onClick={handleNavForward}
                  disabled={!navCanGoForward}
                  aria-label="前进"
                  title="前进"
                >
                  <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="9 18 15 12 9 6" />
                  </svg>
                </button>
              </>
            ) : null}
          </div>
          {isDesktopGitView ? (
            <div className={styles.noteMeta}>
              <span>云端同步</span>
            </div>
          ) : (
            <div className={styles.noteMeta}>
              {/* 桌面端文档身份由标签承载，顶栏不再重复显示标题；移动端无标签保持原样 */}
              <span>{isDraft ? "记录灵感" : activePath && (isMobileViewport || tabs.length === 0) ? stripNoteExtension(activePath.split("/").pop() ?? activePath) : ""}</span>
              {!isEditing && hasGitChanges && note ? (
                <button
                  type="button"
                  className={styles.gitChangeDot}
                  onClick={() => setGitPanelOpen(true)}
                  title="有未提交的改动，点击查看"
                  aria-label="有未提交的改动，点击查看"
                >
                  <span className={styles.gitChangeDotIndicator} aria-hidden="true" />
                </button>
              ) : null}
            </div>
          )}
          <div className={styles.readerActions}>
            {isDesktopGitView ? (
              <button
                type="button"
                className={styles.iconButton}
                onClick={() => setGitPanelOpen(false)}
                aria-label="关闭同步面板"
                title="关闭"
              >
                <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <line x1="18" y1="6" x2="6" y2="18" />
                  <line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            ) : (
              <>
                {savedFlash ? (
                  <span className={styles.savedHint}>已保存</span>
                ) : null}
                {note && !isEditing && (
                  <button
                    type="button"
                    className={`${styles.editBtn} ${isEditing ? styles.editBtnActive : ""}`}
                    onClick={() => void handleEditToggle()}
                    disabled={/\.html?$/i.test(note.path ?? "")}
                    aria-label="编辑笔记"
                    title="编辑笔记"
                  >
                    <svg viewBox="0 0 1024 1024" aria-hidden="true" focusable="false" style={{ transform: "scale(1.3)" }}>
                      <path fill="currentColor" d="M846 792H142c-4.4 0-8 3.6-8 8v40c0 4.4 3.6 8 8 8h704c4.4 0 8-3.6 8-8v-40c0-4.4-3.6-8-8-8zM194.7 726.4l157.4-41.5c4.1-1.1 7.8-3.2 10.8-6.2l357.5-357.5c9.4-9.4 9.4-24.6 0-33.9L614.3 181c-9.4-9.4-24.6-9.4-33.9 0L222.9 538.5c-3 3-5.2 6.7-6.2 10.8l-41.5 157.4c-3.2 12 7.6 22.8 19.5 19.7z m62.5-91.8l16.6-63.2c0.7-2.7 2.2-5.3 4.2-7.3l312.3-312.4c3.1-3.1 8.2-3.1 11.3 0l48.1 48.1c3.1 3.1 3.1 8.2 0 11.3L337.3 623.5c-2 2-4.5 3.4-7.2 4.2L267 644.4c-5.9 1.5-11.3-3.9-9.8-9.8z" />
                    </svg>
                  </button>
                )}
                {note && isEditing && (
                  <button
                    type="button"
                    className={`${styles.editBtn} ${styles.editBtnActive}`}
                    onClick={() => void handleEditToggle()}
                    aria-label="退出编辑"
                    title="退出编辑模式"
                  >
                    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z" />
                      <path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z" />
                    </svg>
                  </button>
                )}
                {/* ⋯ 更多菜单：仅在打开了笔记且非草稿态时显示 */}
                {note && !isDraft ? (
                  <div className={styles.moreMenuWrapper}>
                    <button
                      ref={moreButtonRef}
                      type="button"
                      className={`${styles.iconButton} ${moreMenuOpen ? styles.iconButtonActive : ""}`}
                      onClick={() => setMoreMenuOpen((o) => !o)}
                      aria-label="更多操作"
                      title="更多操作"
                      aria-expanded={moreMenuOpen}
                    >
                      <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true">
                        <circle cx="5" cy="12" r="1.5" />
                        <circle cx="12" cy="12" r="1.5" />
                        <circle cx="19" cy="12" r="1.5" />
                      </svg>
                    </button>
                    {moreMenuOpen && (
                      <div ref={moreMenuRef} className={styles.moreMenuDropdown} role="menu">
                        <button
                          type="button"
                          className={styles.moreMenuItem}
                          role="menuitem"
                          onClick={() => { setMoreMenuOpen(false); handleTocToggle(); }}
                        >
                          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                            <line x1="8" y1="6" x2="21" y2="6" /><line x1="8" y1="12" x2="21" y2="12" /><line x1="8" y1="18" x2="21" y2="18" />
                            <line x1="3" y1="6" x2="3.01" y2="6" /><line x1="3" y1="12" x2="3.01" y2="12" /><line x1="3" y1="18" x2="3.01" y2="18" />
                          </svg>
                          大纲
                        </button>
                        <button
                          type="button"
                          className={styles.moreMenuItem}
                          role="menuitem"
                          onClick={() => { setMoreMenuOpen(false); handleOpenShareDialog(); }}
                        >
                          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                            <path d="M7.2 11.2 12 6.4l4.8 4.8" /><path d="M12 6.4v11.2" />
                            <path d="M5 15.5v3.1c0 .8.6 1.4 1.4 1.4h11.2c.8 0 1.4-.6 1.4-1.4v-3.1" />
                          </svg>
                          分享
                        </button>
                        <div className={styles.moreMenuDivider} role="separator" />
                        <button
                          type="button"
                          className={`${styles.moreMenuItem} ${styles.moreMenuItemDanger}`}
                          role="menuitem"
                          onClick={() => {
                            setMoreMenuOpen(false);
                            if (note) {
                              handleOpenDelete({ kind: "file", name: note.name, path: note.path });
                            }
                          }}
                        >
                          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                            <polyline points="3 6 5 6 21 6" /><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
                            <path d="M10 11v6" /><path d="M14 11v6" />
                            <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
                          </svg>
                          删除文件
                        </button>
                      </div>
                    )}
                  </div>
                ) : null}
                <button
                  type="button"
                  className={`${styles.fellowPill} ${isAssistantPanelOpen ? styles.fellowPillActive : ""} ${aiStatus === "thinking" ? styles.fellowPillThinking : ""} ${aiStatus === "done" ? styles.fellowPillDone : ""}`}
                  onClick={handleClaudeToggle}
                  aria-pressed={isAssistantPanelOpen}
                  aria-label="Fellow AI 助手"
                  title="Fellow"
                >
                  <span aria-hidden="true">✦</span>
                  <span>Fellow</span>
                  {aiStatus === "done" && <span className={styles.fellowPillBadge} aria-hidden="true" />}
                </button>
              </>
            )}
          </div>
        </header>

        {/* 多标签条：仅桌面端、非 git 视图。移动端保持单文档交互 */}
        {!isMobileViewport && !isDesktopGitView ? (
          <NoteTabs
            tabs={tabs}
            activePath={isDraft ? null : activePath}
            onSelect={handleTabSelect}
            onClose={handleTabClose}
          />
        ) : null}

        {/* 桌面端 git 详情内联视图 */}
        {isDesktopGitView ? (
          <div className={styles.gitDesktopPanel}>
            <NotesGit onOpenFile={(path) => {
              const exactMatch = files.find((f) => f.path === path);
              const resolvedPath = exactMatch
                ? path
                : (files.find((f) => f.path.toLowerCase() === path.toLowerCase())?.path ?? path);
              setGitPanelOpen(false);
              void loadNote(resolvedPath);
            }} />
          </div>
        ) : null}

        {/* 编辑模式 — CodeMirror inline markdown 编辑 */}
        {!isDesktopGitView && isEditing ? (
          <div
            className={`${styles.editorPane} ${isDraft ? styles.editorPaneDraft : ""}`}
            style={editorMinHeight ? { minHeight: editorMinHeight } : undefined}
            onMouseDown={(e) => {
              // 点击 editorPane 空白区域（CM 编辑区和表单元素除外）保持 CM 聚焦
              const target = e.target as HTMLElement;
              if (target.closest(".CodeMirror, select, input, button, a, textarea")) return;
              e.preventDefault();
              editorFocusRef.current?.focus();
            }}
          >
            {isDraft ? (
              <div className={styles.captureBar}>
                <span className={styles.captureBarLabel}>存到</span>
                <select
                  className={styles.captureBarSelect}
                  value={captureFolder}
                  onChange={(e) => handleCaptureFolderChange(e.target.value)}
                  aria-label="选择保存的文件夹"
                  onBlur={() => { setTimeout(() => editorFocusRef.current?.focus(), 80); }}
                >
                  {captureFolderOptions.map((f) => (
                    <option key={f} value={f}>{f || "/ 根目录"}</option>
                  ))}
                </select>
                <span className={styles.captureBarHint}>开始输入即自动保存</span>
              </div>
            ) : null}
            <NotesEditor
              ref={editorFocusRef}
              value={editContent}
              onChange={handleEditorChange}
              onExit={handleEditToggle}
              noteNames={noteNames}
              currentPath={isDraft ? null : activePath}
              onImagePasted={() => {
                setHasGitChanges(true);
                void refreshTree().catch(() => { /* 树刷新失败不影响已插入的引用 */ });
              }}
              onImagePasteError={(message) => alert(message)}
              placeholder={!isDraft && autoTitlePath && autoTitlePath === activePath
                ? "写下第一行，它会成为标题"
                : "开始写点什么…"}
              onReady={() => {
                setEditorMinHeight(0);
                // fix: 草稿模式下确保 CM 就绪后光标落在编辑器内
                if (isDraftRef.current) {
                  setTimeout(() => editorFocusRef.current?.focus(), 0);
                }
              }}
            />
          </div>
        ) : !isDesktopGitView ? (
          <article
            key={note?.path || "empty"}
            className={`${styles.document} ${!note || /\.html?$/i.test(note.path) ? styles.documentHtml : ""}`}
            style={!note || /\.html?$/i.test(note.path) ? { width: '100%', maxWidth: '100%', margin: 0, padding: 0, borderRadius: 0, background: 'transparent', border: 'none', boxShadow: 'none' } : undefined}
          >
            {noteState === "loading" ? (
              <div className={styles.documentState}>正在加载文件...</div>
            ) : null}

            {noteState === "error" ? (
              <div className={styles.documentState}>{error ?? "Markdown 加载失败"}</div>
            ) : null}

            {/* PDF：浏览器原生只读预览，服务端只流字节，不做渲染 */}
            {noteState === "ready" && isPdfPath(activePath) ? (
              <iframe
                key={activePath ?? "pdf"}
                src={`/api/notes/doc?path=${encodeURIComponent(activePath ?? "")}`}
                title={activePath?.split("/").pop() ?? "PDF"}
                style={{ width: "100%", height: "100%", minHeight: "calc(100dvh - 56px)", border: "none", display: "block" }}
              />
            ) : null}

            {/* 图片：<img> 原生预览 */}
            {noteState === "ready" && isImagePath(activePath) ? (
              <div className={styles.imageViewer}>
                <div className={styles.imageViewerFrame}>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    key={activePath ?? "img"}
                    src={`/api/notes/doc?path=${encodeURIComponent(activePath ?? "")}`}
                    alt={getFilenameFromPath(activePath, "图片")}
                    className={styles.imageViewerImg}
                  />
                  {/* 翻页按钮压在图片上：pointerdown/dblclick 就地拦下，别冒泡去触发阅读区的双击进编辑 */}
                  {imageViewerNav?.previous ? (
                    <button
                      type="button"
                      className={`${styles.imageViewerNav} ${styles.imageViewerNavPrev}`}
                      onPointerDown={(e) => e.stopPropagation()}
                      onDoubleClick={(e) => e.stopPropagation()}
                      onClick={(e) => { e.preventDefault(); e.stopPropagation(); void navigateImageViewer("previous"); }}
                      aria-label={`上一张图片：${imageViewerNav.previous.name}`}
                      title="上一张图片（←）"
                    >
                      <svg viewBox="0 0 24 24" width="21" height="21" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                        <path d="M15 18l-6-6 6-6" />
                      </svg>
                    </button>
                  ) : null}
                  {imageViewerNav?.next ? (
                    <button
                      type="button"
                      className={`${styles.imageViewerNav} ${styles.imageViewerNavNext}`}
                      onPointerDown={(e) => e.stopPropagation()}
                      onDoubleClick={(e) => e.stopPropagation()}
                      onClick={(e) => { e.preventDefault(); e.stopPropagation(); void navigateImageViewer("next"); }}
                      aria-label={`下一张图片：${imageViewerNav.next.name}`}
                      title="下一张图片（→）"
                    >
                      <svg viewBox="0 0 24 24" width="21" height="21" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                        <path d="M9 18l6-6-6-6" />
                      </svg>
                    </button>
                  ) : null}
                  {imageViewerNav && imageViewerNav.total > 1 && imageViewerNav.index >= 0 ? (
                    <span
                      className={styles.imageViewerPosition}
                      aria-label={`当前为第 ${imageViewerNav.index + 1} 张，共 ${imageViewerNav.total} 张`}
                    >
                      {imageViewerNav.index + 1} / {imageViewerNav.total}
                    </span>
                  ) : null}
                  <button
                    type="button"
                    className={styles.imageDownloadBtn}
                    onClick={handleImageDownload}
                    aria-label="下载图片"
                    title="下载图片"
                  >
                    <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <path d="M8 2.5v7M5.5 7 8 9.5 10.5 7" />
                      <path d="M3 13h10" />
                    </svg>
                  </button>
                </div>
              </div>
            ) : null}

            {noteState === "ready" && note ? (
              /\.html?$/i.test(note.path) ? (
                <NotesHtml
                  ref={htmlPreviewRef}
                  html={note.content}
                  notePath={note.path}
                  initialHash={pendingHashRef.current}
                  onNavigate={handleMarkdownNavigate}
                  onLinkNavigate={handleHtmlLinkNavigate}
                  onHashNavigate={handleHtmlHashNavigate}
                  onHeadingsChange={handleHtmlHeadingsChange}
                  onActiveHeadingChange={setActiveTocSlug}
                />
              ) : (
                <div data-markdown-content>
                  <NotesMarkdown
                    markdown={note.content}
                    currentPath={note.path}
                    noteIndex={noteIndex}
                    onNavigate={handleMarkdownNavigate}
                    onCreateNote={handleCreateWikiNote}
                  />
                </div>
              )
            ) : null}

            {/* 空库也渲染仪表盘：首屏保留输入框并给出新建/导入 CTA，而非一句"没有文件" */}
            {treeState === "ready" && !note && !isPdfPath(activePath) && !isImagePath(activePath) && noteState !== "loading" ? (
              <NotesDashboard
                files={files}
                exiting={isDashboardExiting}
                onSelectNote={handleSelect}
                onAskAI={(query?: string) => {
                  // 提问先投递（或暂存），让对话面板露出时回显已经就位
                  if (query) {
                    postAskToClaude(query);
                  }
                  if (isMobileViewport) {
                    if (isDashboardExiting) return;
                    // 移动端与桌面端一致：仪表盘先退场，再原地转成全屏对话页，
                    // 而不是从底部弹出 sheet
                    setMobileSidebarOpen(false);
                    setIsDashboardExiting(true);
                    window.setTimeout(() => {
                      setIsDashboardChatActive(true);
                      setMobileAssistantSheet('expanded');
                      setIsDashboardExiting(false);
                    }, 240);
                  } else if (!isDashboardExiting) {
                    // 桌面端不直接切页：仪表盘先退场，再原地展开对话
                    setIsDashboardExiting(true);
                    window.setTimeout(() => {
                      setIsDashboardChatActive(true);
                      setAssistantPanelVisible(true);
                      setIsDashboardExiting(false);
                    }, 240);
                  }
                }}
                onQuickCapture={handleQuickCapture}
                onCreateNote={() => handleNewNote()}
                onImport={() => handleStartImport("")}
              />
            ) : null}
          </article>
        ) : null}
      </section>

      {importProgress ? (
        <div className={styles.shareOverlay} role="presentation">
          <section
            className={styles.importProgressDialog}
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="import-progress-title"
            aria-busy="true"
          >
            <span className={styles.importSpinner} aria-hidden="true" />
            <h2 id="import-progress-title" className={styles.importProgressTitle}>正在导入…</h2>
            <p className={styles.importProgressCount}>
              {importProgress.done} / {importProgress.total}
            </p>
            <div className={styles.importProgressTrack} role="progressbar" aria-valuemin={0} aria-valuemax={importProgress.total} aria-valuenow={importProgress.done}>
              <div
                className={styles.importProgressFill}
                style={{ width: `${importProgress.total ? Math.round((importProgress.done / importProgress.total) * 100) : 0}%` }}
              />
            </div>
          </section>
        </div>
      ) : null}

      {importFailed.length > 0 ? (
        <div className={styles.shareOverlay} role="presentation" onMouseDown={() => setImportFailed([])}>
          <section
            className={styles.shareDialog}
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="import-failed-title"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <header className={styles.shareDialogHeader}>
              <div>
                <p className={styles.shareDialogEyebrow}>导入文件</p>
                <h2 id="import-failed-title" className={styles.shareDialogTitle}>{importFailed.length} 个文件未导入</h2>
              </div>
              <button
                type="button"
                className={styles.shareDialogClose}
                onClick={() => setImportFailed([])}
                aria-label="关闭"
                title="关闭"
              >
                <span aria-hidden="true">×</span>
              </button>
            </header>
            <div className={styles.shareDialogBody}>
              <ul className={styles.importFailedList}>
                {importFailed.map((item, index) => (
                  <li key={`${item.name}-${index}`} className={styles.importFailedItem}>
                    <span className={styles.importFailedName}>{item.name}</span>
                    <span className={styles.importFailedReason}>{item.reason}</span>
                  </li>
                ))}
              </ul>
            </div>
            <footer className={styles.shareDialogActions}>
              <button type="button" className={styles.sharePrimaryButton} onClick={() => setImportFailed([])}>知道了</button>
            </footer>
          </section>
        </div>
      ) : null}

      {importError ? (
        <div className={styles.shareOverlay} role="presentation" onMouseDown={() => setImportError(null)}>
          <section
            className={styles.shareDialog}
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="import-error-title"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <header className={styles.shareDialogHeader}>
              <div>
                <p className={styles.shareDialogEyebrow}>导入文件</p>
                <h2 id="import-error-title" className={styles.shareDialogTitle}>导入失败</h2>
              </div>
              <button
                type="button"
                className={styles.shareDialogClose}
                onClick={() => setImportError(null)}
                aria-label="关闭导入错误"
                title="关闭导入错误"
              >
                <span aria-hidden="true">×</span>
              </button>
            </header>
            <div className={styles.shareDialogBody}>
              <p className={`${styles.shareDialogMessage} ${styles.shareDialogError}`}>{importError}</p>
            </div>
            <footer className={styles.shareDialogActions}>
              <button type="button" className={styles.sharePrimaryButton} onClick={() => setImportError(null)}>知道了</button>
            </footer>
          </section>
        </div>
      ) : null}

      {/* ── 删除确认条（底部滑入）────────────────────────── */}
      {deleteConfirmOpen ? (
        <div className={styles.shareOverlay} role="presentation" onMouseDown={() => {
          if (!deleteLoading) {
            setDeleteConfirmOpen(false);
            setDeleteTarget(null);
          }
        }}>
          <section
            className={`${styles.shareDialog} ${styles.deleteDialog}`}
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="delete-confirm-label"
            onMouseDown={(e) => e.stopPropagation()}
          >
            <header className={styles.shareDialogHeader}>
              <div>
                <p className={styles.shareDialogEyebrow}>永久删除</p>
                <h2 id="delete-confirm-label" className={styles.shareDialogTitle}>
                  {deleteTarget?.kind === "folder"
                    ? deleteTarget.name
                    : stripNoteExtension((deleteTarget?.name ?? note?.path.split("/").pop()) ?? "")}
                </h2>
              </div>
            </header>
            <div className={styles.shareDialogBody}>
              <p className={styles.deleteDialogDesc}>
                {deleteTarget?.kind === "folder"
                  ? "将删除此文件夹及其中所有文件。此操作无法撤销。"
                  : "此操作无法撤销。已同步到云端的文件可在「云端同步」面板中恢复。"}
              </p>
            </div>
            <footer className={styles.shareDialogActions}>
              <button
                type="button"
                className={styles.shareSecondaryButton}
                onClick={() => {
                  setDeleteConfirmOpen(false);
                  setDeleteTarget(null);
                }}
                disabled={deleteLoading}
              >
                取消
              </button>
              <button
                type="button"
                className={styles.deleteConfirmDelete}
                onClick={() => void handleDeleteNote()}
                disabled={deleteLoading}
              >
                {deleteLoading ? "删除中…" : "删除"}
              </button>
            </footer>
          </section>
        </div>
      ) : null}

      {shareModalOpen ? (
        <div className={styles.shareOverlay} role="presentation" onMouseDown={() => setShareModalOpen(false)}>
          <section
            className={styles.shareDialog}
            role="dialog"
            aria-modal="true"
            aria-labelledby="share-dialog-title"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <header className={styles.shareDialogHeader}>
              <div>
                <p className={styles.shareDialogEyebrow}>公开分享</p>
                <h2 id="share-dialog-title" className={styles.shareDialogTitle}>
                  当前文章
                </h2>
              </div>
              <button
                type="button"
                className={styles.shareDialogClose}
                onClick={() => setShareModalOpen(false)}
                aria-label="关闭分享窗口"
                title="关闭分享窗口"
              >
                <span aria-hidden="true">×</span>
              </button>
            </header>

            <div className={styles.shareDialogBody}>
              <p className={styles.shareDialogNote}>{note?.path ?? "未选择文件"}</p>

              {shareState === "loading" ? (
                <div className={styles.shareDialogState}>正在读取分享状态...</div>
              ) : null}

              {shareState !== "loading" && shareUrl ? (
                <label className={styles.shareLinkField}>
                  <span>分享链接</span>
                  <input value={shareUrl} readOnly onFocus={(event) => event.currentTarget.select()} />
                </label>
              ) : null}

              {shareState !== "loading" && !shareUrl ? (
                <div className={styles.shareDialogEmpty}>当前文章还没有公开分享链接。</div>
              ) : null}

              {shareMessage ? (
                <p className={`${styles.shareDialogMessage} ${shareState === "error" ? styles.shareDialogError : ""}`}>
                  {shareMessage}
                </p>
              ) : null}
            </div>

            <footer className={styles.shareDialogActions}>
              {shareUrl ? (
                <>
                  <button
                    type="button"
                    className={styles.shareSecondaryButton}
                    onClick={handleCopyShare}
                    disabled={shareState === "copying" || shareState === "revoking"}
                  >
                    {shareState === "copying" ? "复制中" : "复制链接"}
                  </button>
                  <button
                    type="button"
                    className={styles.shareDangerButton}
                    onClick={handleRevokeShare}
                    disabled={shareState === "revoking" || shareState === "copying"}
                  >
                    {shareState === "revoking" ? "取消中" : "取消分享"}
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  className={styles.sharePrimaryButton}
                  onClick={handleCreateShare}
                  disabled={shareState === "creating" || shareState === "loading"}
                >
                  {shareState === "creating" ? "生成中" : "生成分享链接"}
                </button>
              )}
            </footer>
          </section>
        </div>
      ) : null}

      <aside
        ref={assistantPanelRef}
        className={`${styles.assistantPanel} ${!isAssistantPanelOpen ? styles.assistantPanelHidden : ""} ${isDashboardChatMode ? styles.assistantPanelCenter : ""} ${isMobileDashboardChat ? styles.assistantPanelFullscreen : ""}`}
        aria-label="辅助面板"
        aria-hidden={isMobileViewport ? mobileAssistantSheet === 'closed' : !isAssistantPanelOpen}
        inert={isMobileViewport ? mobileAssistantSheet === 'closed' : !isAssistantPanelOpen}
      >
        {isMobileViewport && !isMobileDashboardChat && (
          <button
            type="button"
            className={styles.mobileSheetHandle}
            onPointerDown={handleSheetPointerDown}
            onPointerMove={handleSheetPointerMove}
            onPointerUp={handleSheetPointerUp}
            onPointerCancel={handleSheetPointerUp}
            aria-label={mobileAssistantSheet === 'expanded' ? '收起对话面板' : '展开对话面板'}
          >
            <span className={styles.mobileSheetHandlePill} />
          </button>
        )}
        {!isDashboardChatMode && (
          <>
            <button
              type="button"
              className={styles.assistantPanelResizer}
              onPointerDown={(event) => {
                event.preventDefault();
                setAssistantPanelVisible(true);
                setIsResizingAssistantPanel(true);
              }}
              onDoubleClick={() => setAssistantPanelWidth(DEFAULT_ASSISTANT_PANEL_WIDTH)}
              onKeyDown={(event) => {
                if (event.key === "ArrowLeft") {
                  event.preventDefault();
                  setAssistantPanelWidth((width) => clamp(width + 24, MIN_ASSISTANT_PANEL_WIDTH, MAX_ASSISTANT_PANEL_WIDTH));
                }
                if (event.key === "ArrowRight") {
                  event.preventDefault();
                  setAssistantPanelWidth((width) => clamp(width - 24, MIN_ASSISTANT_PANEL_WIDTH, MAX_ASSISTANT_PANEL_WIDTH));
                }
              }}
              aria-label="调整辅助面板宽度"
              title="拖拽调整面板宽度，双击恢复默认"
              tabIndex={!isMobileViewport && isAssistantPanelOpen ? 0 : -1}
            />
            {/* 桌面端收起按钮：浮在 iframe 顶栏（44px，按钮居右）左侧空白处，
                收起动作就近发生在面板上，而不是要回到笔记头部找 Fellow 胶囊 */}
            {!isMobileViewport && (
              <button
                type="button"
                className={`${styles.assistantPanelCollapse} ${isChildOverlayOpen ? styles.assistantPanelCollapseHidden : ""}`}
                onClick={() => setAssistantPanelVisible(false)}
                aria-label="收起对话面板"
                title="收起（⌘J）"
                tabIndex={isAssistantPanelOpen && !isChildOverlayOpen ? 0 : -1}
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <polyline points="13 17 18 12 13 7" />
                  <polyline points="6 17 11 12 6 7" />
                </svg>
              </button>
            )}
          </>
        )}

        {(isDashboardChatMode || isMobileDashboardChat) && (
          <header className={styles.dashboardChatHeader}>
            <button
              className={`${styles.dashboardChatBackBtn} ${isChildOverlayOpen ? styles.dashboardChatBackBtnHidden : ""}`}
              tabIndex={isChildOverlayOpen ? -1 : 0}
              onClick={() => {
                if (isMobileViewport) {
                  // 只收起面板，保持全屏几何到下滑动画结束；
                  // isDashboardChatActive 在打开笔记时统一复位
                  setMobileAssistantSheet('closed');
                } else {
                  setAssistantPanelVisible(false);
                  setIsDashboardChatActive(false);
                }
              }}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ width: "18px", height: "18px" }}>
                <line x1="19" y1="12" x2="5" y2="12" />
                <polyline points="12 19 5 12 12 5" />
              </svg>
              <span>返回首页</span>
            </button>
          </header>
        )}
        <iframe
          key="claude-frame"
          ref={claudeFrameRef}
          className={styles.assistantPanelFrame}
          title="Claude Chat"
          src={`/notes-claude/?v=10${process.env.NEXT_PUBLIC_CLAUDE_CHAT_PORT ? `&wsPort=${process.env.NEXT_PUBLIC_CLAUDE_CHAT_PORT}` : ""}`}
          allow="clipboard-read; clipboard-write"
          referrerPolicy="same-origin"
          tabIndex={isAssistantPanelOpen ? 0 : -1}
          onLoad={() => {
            claudeFrameReadyRef.current = true;
            // Re-send the current note context once the iframe is ready.
            // The useEffect fires when activePath changes, but the iframe may
            // still be loading at that point and miss the message.
            if (activePathRef.current) {
              claudeFrameRef.current?.contentWindow?.postMessage(
                { type: "note-context", filePath: activePathRef.current },
                window.location.origin,
              );
            }
            // 首页提问可能早于 iframe 就绪，补投暂存的问题，避免首条提问丢失
            if (pendingClaudeAskRef.current) {
              claudeFrameRef.current?.contentWindow?.postMessage(
                { type: "note-ask", text: pendingClaudeAskRef.current },
                window.location.origin,
              );
              pendingClaudeAskRef.current = null;
            }
          }}
        />
      </aside>

      {/* 移动端 Fellow 悬浮按钮：仅在打开笔记时显示 */}
      {note ? <button
        type="button"
        className={`${styles.claudeFab} ${mobileAssistantSheet !== 'closed' ? styles.claudeFabHidden : ""} ${isAssistantPanelOpen ? styles.claudeFabActive : ""} ${aiStatus === "thinking" ? styles.claudeFabThinking : ""} ${aiStatus === "done" ? styles.claudeFabDone : ""}`}
        onClick={handleClaudeToggle}
        aria-label="Fellow AI 助手"
        title="Fellow"
      >
        <span className={styles.claudeFabIcon} aria-hidden="true">✦</span>
        {aiStatus === "done" && <span className={styles.claudeFabBadge} />}
      </button> : null}

      {/* 移动端大纲底部 sheet */}
      {isMobileViewport ? (
        <aside
          className={`${styles.mobileTocSheet} ${mobileTocOpen ? styles.mobileTocSheetOpen : ""}`}
          aria-label="文章大纲"
          aria-hidden={!mobileTocOpen}
          inert={!mobileTocOpen}
        >
          <header className={styles.mobileTocSheetHeader}>
            <span className={styles.mobileTocSheetTitle}>大纲</span>
            <button
              type="button"
              className={styles.mobileTocSheetClose}
              onClick={() => setMobileTocOpen(false)}
              aria-label="关闭大纲"
              tabIndex={mobileTocOpen ? 0 : -1}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <polyline points="6 9 12 15 18 9" />
              </svg>
            </button>
          </header>
          <ArticleToc
            headings={articleTocEntries}
            activeSlug={activeTocSlug}
            onSelect={handleSelectTocHeading}
          />
        </aside>
      ) : null}

      {isMobileViewport ? (
        <aside
          className={`${styles.nodeActionSheet} ${treeSheetTarget ? styles.nodeActionSheetOpen : ""}`}
          aria-label="文件操作"
          aria-hidden={!treeSheetTarget}
          inert={!treeSheetTarget}
        >
          <header className={styles.nodeActionSheetHeader}>
            <div className={styles.nodeActionSheetTitleGroup}>
              <span className={styles.nodeActionSheetTitle}>{treeSheetTarget?.name ?? ""}</span>
              <span className={styles.nodeActionSheetPath}>{treeSheetTarget?.path ?? ""}</span>
            </div>
            <button
              type="button"
              className={styles.mobileTocSheetClose}
              onClick={() => setTreeSheetTarget(null)}
              aria-label="关闭文件操作"
              tabIndex={treeSheetTarget ? 0 : -1}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <polyline points="6 9 12 15 18 9" />
              </svg>
            </button>
          </header>
          <div className={styles.nodeActionSheetBody}>
            {treeSheetTarget?.kind === "folder" ? (
              <>
                <button type="button" className={styles.nodeActionButton} onClick={() => { const folder = treeSheetTarget.path; setTreeSheetTarget(null); handleNewNote(folder); }}>新建笔记</button>
                <button type="button" className={styles.nodeActionButton} onClick={() => { const folder = treeSheetTarget.path; setTreeSheetTarget(null); openNewNote(folder); }}>新建并命名…</button>
                <button type="button" className={styles.nodeActionButton} onClick={() => { const folder = treeSheetTarget.path; setTreeSheetTarget(null); openNewFolder(folder); }}>新建文件夹</button>
                <button type="button" className={styles.nodeActionButton} onClick={() => handleStartImport(treeSheetTarget.path)} disabled={importLoading}>
                  {importLoading ? "导入中…" : "导入文件"}
                </button>
              </>
            ) : null}
            {treeSheetTarget?.kind === "file" && (isPdfPath(treeSheetTarget.path) || isImagePath(treeSheetTarget.path)) ? (
              <button type="button" className={styles.nodeActionButton} onClick={() => { const path = treeSheetTarget.path; setTreeSheetTarget(null); void handleDownloadPath(path); }}>下载</button>
            ) : null}
            {treeSheetTarget ? (
              <>
                <button type="button" className={styles.nodeActionButton} onClick={() => handleOpenRename(treeSheetTarget)}>重命名</button>
                <button type="button" className={`${styles.nodeActionButton} ${styles.nodeActionButtonDanger}`} onClick={() => handleOpenDelete(treeSheetTarget)}>删除</button>
              </>
            ) : null}
          </div>
        </aside>
      ) : null}

      {/* ── 新建笔记对话框 ─────────────────────────────── */}
      {newNoteOpen ? (
        <div
          className={styles.newNoteBackdrop}
          onClick={(e) => { if (e.target === e.currentTarget) setNewNoteOpen(false); }}
          role="presentation"
        >
          <div
            className={styles.newNoteDialog}
            role="dialog"
            aria-modal="true"
            aria-labelledby="new-note-heading"
          >
            <h2 id="new-note-heading" className={styles.newNoteHeading}>新建笔记</h2>

            <label className={styles.newNoteLabel} htmlFor="new-note-title">标题</label>
            <input
              id="new-note-title"
              ref={newNoteTitleRef}
              className={styles.newNoteInput}
              type="text"
              placeholder="笔记标题"
              value={newNoteTitle}
              onChange={(e) => { setNewNoteTitle(e.target.value); setNewNoteError(null); }}
              onKeyDown={(e) => { if (e.key === "Enter") void handleCreateNote(); }}
              autoComplete="off"
              spellCheck={false}
            />

            <div className={styles.newNoteLabelRow}>
              <label className={styles.newNoteLabel} htmlFor="new-note-folder">位置</label>
              <button
                type="button"
                className={styles.inlineFolderToggle}
                onClick={() => {
                  setInlineFolderOpen((prev) => !prev);
                  setInlineFolderName("");
                  setInlineFolderError(null);
                  setTimeout(() => inlineFolderInputRef.current?.focus(), 30);
                }}
                title="新建文件夹"
              >
                <svg viewBox="0 0 1024 1024" aria-hidden="true" fill="currentColor" style={{ width: "12px", height: "12px" }}>
                  <path d="M703.8 547.8h-167v-167c0-13.8-11.2-25-25-25s-25 11.2-25 25v167h-167c-13.8 0-25 11.2-25 25s11.2 25 25 25h167v167c0 13.8 11.2 25 25 25s25-11.2 25-25v-167h167c13.8 0 25-11.2 25-25s-11.2-25-25-25z" />
                  <path d="M833.3 234.1H530.8l-29.6-58.5c-10.4-20.6-26.4-37.9-46.1-50.1-19.7-12.1-42.3-18.5-65.5-18.5H188.7c-68.9 0-125 56.1-125 125v513.5c0 96.5 78.5 175 175 175h544.7c96.5 0 175-78.5 175-175V359.1c-0.1-68.9-56.1-125-125.1-125z m75 511.5c0 68.9-56.1 125-125 125H238.7c-68.9 0-125-56.1-125-125V232c0-41.4 33.6-75 75-75h200.9c28.4 0 54.1 15.8 66.9 41.1l36.6 72.2c4.3 8.4 12.9 13.7 22.3 13.7h317.9c41.4 0 75 33.6 75 75v386.6z" />
                </svg>
                新建文件夹
              </button>
            </div>
            <FolderPicker
              id="new-note-folder"
              tree={tree}
              value={newNoteFolder}
              onChange={setNewNoteFolder}
            />
            {inlineFolderOpen ? (
              <div className={styles.inlineFolderForm}>
                <input
                  ref={inlineFolderInputRef}
                  className={styles.inlineFolderInput}
                  type="text"
                  placeholder={newNoteFolder ? `在 "${newNoteFolder}" 内新建` : "文件夹名称"}
                  value={inlineFolderName}
                  onChange={(e) => { setInlineFolderName(e.target.value); setInlineFolderError(null); }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void handleInlineCreateFolder();
                    if (e.key === "Escape") { setInlineFolderOpen(false); setInlineFolderName(""); }
                  }}
                  autoComplete="off"
                  spellCheck={false}
                />
                <button
                  type="button"
                  className={styles.inlineFolderConfirm}
                  onClick={() => void handleInlineCreateFolder()}
                  disabled={inlineFolderLoading}
                >
                  {inlineFolderLoading ? "创建中…" : "创建"}
                </button>
              </div>
            ) : null}
            {inlineFolderError ? <p className={styles.newNoteError}>{inlineFolderError}</p> : null}

            {newNoteError ? <p className={styles.newNoteError}>{newNoteError}</p> : null}

            <div className={styles.newNoteActions}>
              <button
                type="button"
                className={styles.newNoteCancelBtn}
                onClick={() => setNewNoteOpen(false)}
                disabled={newNoteLoading}
              >
                取消
              </button>
              <button
                type="button"
                className={styles.newNoteConfirmBtn}
                onClick={() => void handleCreateNote()}
                disabled={newNoteLoading}
              >
                {newNoteLoading ? "创建中…" : "创建"}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {/* ── 新建文件夹对话框 ─────────────────────────────── */}
      {newFolderOpen ? (
        <div
          className={styles.newNoteBackdrop}
          onClick={(e) => { if (e.target === e.currentTarget) setNewFolderOpen(false); }}
          role="presentation"
        >
          <div
            className={styles.newNoteDialog}
            role="dialog"
            aria-modal="true"
            aria-labelledby="new-folder-heading"
          >
            <h2 id="new-folder-heading" className={styles.newNoteHeading}>新建文件夹</h2>

            <label className={styles.newNoteLabel} htmlFor="new-folder-name">文件夹名称</label>
            <input
              id="new-folder-name"
              ref={newFolderNameRef}
              className={styles.newNoteInput}
              type="text"
              placeholder="文件夹名称"
              value={newFolderName}
              onChange={(e) => { setNewFolderName(e.target.value); setNewFolderError(null); }}
              onKeyDown={(e) => { if (e.key === "Enter") void handleCreateFolder(); }}
              autoComplete="off"
              spellCheck={false}
            />

            <label className={styles.newNoteLabel} htmlFor="new-folder-parent">位置</label>
            <FolderPicker
              id="new-folder-parent"
              tree={tree}
              value={newFolderParent}
              onChange={setNewFolderParent}
            />

            {newFolderError ? <p className={styles.newNoteError}>{newFolderError}</p> : null}

            <div className={styles.newNoteActions}>
              <button
                type="button"
                className={styles.newNoteCancelBtn}
                onClick={() => setNewFolderOpen(false)}
                disabled={newFolderLoading}
              >
                取消
              </button>
              <button
                type="button"
                className={styles.newNoteConfirmBtn}
                onClick={() => void handleCreateFolder()}
                disabled={newFolderLoading}
              >
                {newFolderLoading ? "创建中…" : "创建文件夹"}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {selectionRect ? (
        <button
          className={styles.selectionAskAiBtn}
          style={{
            top: Math.max(10, selectionRect.top - 40),
            left: selectionRect.left + selectionRect.width / 2,
          }}
          onPointerDown={(e) => {
            e.preventDefault(); // preserve selection
            if (isMobileViewport) {
              setMobileSidebarOpen(false);
              setMobileAssistantSheet('expanded');
            } else {
              setAssistantPanelVisible(true);
            }
            setSelectionRect(null);
            // We do not set setIsDashboardChatActive(true) because they are reading a note.
          }}
          aria-label="Ask AI about selection"
        >
          ✦ Ask AI
        </button>
      ) : null}

      <QuickSwitcher
        open={quickSwitcherOpen}
        files={files}
        onClose={() => setQuickSwitcherOpen(false)}
        onSelect={(path) => {
          setQuickSwitcherOpen(false);
          handleSelect(path);
        }}
      />

      {undoDelete ? (
        <div className={styles.undoToast} role="status">
          <span className={styles.undoToastText}>已删除「{stripNoteExtension(undoDelete.name)}」</span>
          <button type="button" className={styles.undoToastButton} onClick={() => void handleUndoDelete()}>
            撤销
          </button>
        </div>
      ) : null}
    </main>
  );
}
