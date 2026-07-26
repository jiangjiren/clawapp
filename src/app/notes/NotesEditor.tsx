"use client";

import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import CodeMirror from "codemirror";
import "codemirror/lib/codemirror.css";
import "codemirror/mode/markdown/markdown";
import "codemirror/addon/edit/continuelist";
import "codemirror/addon/hint/show-hint";
import "codemirror/addon/hint/show-hint.css";
import styles from "./notes.module.css";

/* eslint-disable @typescript-eslint/no-explicit-any */

interface NotesEditorProps {
  value: string;
  onChange: (value: string) => void;
  onReady?: () => void;
  /** 在编辑器内按 Esc 时触发（退出编辑模式）；补全弹窗打开时 Esc 仍优先关弹窗 */
  onExit?: () => void;
  noteNames?: string[];
  /** 当前笔记路径：粘贴图片存到它的同目录；非 .md 时禁用图片粘贴 */
  currentPath?: string | null;
  /** 图片落盘成功后回调（刷新文件树等） */
  onImagePasted?: () => void;
  /** 粘贴图片失败提示 */
  onImagePasteError?: (message: string) => void;
  /** 空文档时压在首行的提示语（未命名的新笔记会换成「首行=标题」的说明） */
  placeholder?: string;
}

export interface NotesEditorHandle {
  /** 聚焦编辑器并把光标移到末尾 */
  focus: () => void;
}

type WikiContext = {
  openIndex: number;
  query: string;
};

const normalizeWikiSearch = (value: string) => value.normalize("NFKC").toLocaleLowerCase();

// ── 粘贴图片（与桌面端 pasteEditorImage 约定一致） ─────────────
const MAX_PASTED_IMAGE_BYTES = 20 * 1024 * 1024;

const pastedImageMime = (file: File | null | undefined) => {
  const declared = String(file?.type || "").toLowerCase();
  if (/^image\/(?:png|jpeg|gif|webp)$/.test(declared)) return declared;
  const extension = (String(file?.name || "").match(/\.([^.]+)$/)?.[1] || "").toLowerCase();
  return ({
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    webp: "image/webp",
  } as Record<string, string>)[extension] || "";
};

const readFileAsBase64 = (file: File) =>
  new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result || "");
      const separator = result.indexOf(",");
      if (separator === -1) reject(new Error("无法读取剪贴板图片。"));
      else resolve(result.slice(separator + 1));
    };
    reader.onerror = () => reject(reader.error || new Error("无法读取剪贴板图片。"));
    reader.readAsDataURL(file);
  });

/** markdown 链接目标逐段 percent-encode（与桌面端 encodeWikiMediaTarget 一致） */
const encodeMediaTarget = (value: string) =>
  value.split("/").map((segment) => {
    let decoded = segment;
    try { decoded = decodeURIComponent(segment); } catch { /* keep raw */ }
    return encodeURIComponent(decoded).replace(/[!'()*]/g, (char) =>
      `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
    );
  }).join("/");

/** 同时识别半角 [[、全角 ［［，以及输入法可能产生的混合括号。 */
function findWikiContext(beforeCursor: string): WikiContext | null {
  const openerPattern = /[\[［]{2}/g;
  let opener: RegExpExecArray | null;
  let openIndex = -1;

  while ((opener = openerPattern.exec(beforeCursor)) !== null) {
    openIndex = opener.index;
  }
  if (openIndex === -1) return null;

  const query = beforeCursor.slice(openIndex + 2);
  if (/[\]］]{2}/.test(query)) return null;
  return { openIndex, query };
}

function makeWikiHint(noteNames: string[]) {
  return function wikiHint(cm: any) {
    const cursor = cm.getCursor();
    const line: string = cm.getLine(cursor.line);
    const before = line.slice(0, cursor.ch);
    const context = findWikiContext(before);
    if (!context) return { list: [], from: cursor, to: cursor };

    const normalizedQuery = normalizeWikiSearch(context.query);
    const list = [...new Set(noteNames)]
      .filter((name) => normalizeWikiSearch(name).includes(normalizedQuery))
      .sort((left, right) => {
        const a = normalizeWikiSearch(left);
        const b = normalizeWikiSearch(right);
        if (a === normalizedQuery && b !== normalizedQuery) return -1;
        if (b === normalizedQuery && a !== normalizedQuery) return 1;
        const aStarts = a.startsWith(normalizedQuery);
        const bStarts = b.startsWith(normalizedQuery);
        if (aStarts !== bStarts) return aStarts ? -1 : 1;
        return left.localeCompare(right, "zh-CN", { numeric: true, sensitivity: "base" });
      })
      .slice(0, 20)
      .map((name) => ({
        // 无论用户输入半角还是全角括号，落盘统一使用标准 Wiki Link 语法。
        text: `[[${name}]]`,
        displayText: name,
        from: { line: cursor.line, ch: context.openIndex },
        to: cursor,
      }));

    return {
      list,
      from: { line: cursor.line, ch: context.openIndex },
      to: cursor,
    };
  };
}

const NotesEditor = forwardRef<NotesEditorHandle, NotesEditorProps>(
  function NotesEditor({ value, onChange, onReady, onExit, noteNames = [], currentPath = null, onImagePasted, onImagePasteError, placeholder = "开始写点什么…" }, ref) {
    const containerRef = useRef<HTMLDivElement>(null);
    const cmRef        = useRef<any>(null);
    const onChangeRef  = useRef(onChange);
    const onReadyRef   = useRef(onReady);
    const onExitRef    = useRef(onExit);
    const noteNamesRef = useRef(noteNames);
    const currentPathRef = useRef(currentPath);
    const onImagePastedRef = useRef(onImagePasted);
    const onImagePasteErrorRef = useRef(onImagePasteError);

    useEffect(() => { onChangeRef.current = onChange; }, [onChange]);
    useEffect(() => { onReadyRef.current = onReady; }, [onReady]);
    useEffect(() => { onExitRef.current = onExit; }, [onExit]);
    useEffect(() => { noteNamesRef.current = noteNames; }, [noteNames]);
    useEffect(() => { currentPathRef.current = currentPath; }, [currentPath]);
    useEffect(() => { onImagePastedRef.current = onImagePasted; }, [onImagePasted]);
    useEffect(() => { onImagePasteErrorRef.current = onImagePasteError; }, [onImagePasteError]);

    // 向父组件暴露 focus()
    useImperativeHandle(ref, () => ({
      focus() {
        const cm = cmRef.current;
        if (!cm) return;
        cm.focus();
        const lastLine = cm.lastLine();
        cm.setCursor({ line: lastLine, ch: cm.getLine(lastLine).length });
      },
    }), []);

    useEffect(() => {
      if (!containerRef.current || cmRef.current) return;

      const cm = (CodeMirror as any)(containerRef.current, {
        value,
        mode: "markdown",
        lineWrapping: true,
        autofocus: false,
        indentUnit: 2,
        tabSize: 2,
        extraKeys: {
          "Enter": "newlineAndIndentContinueMarkdownList",
          "Ctrl-Space": (instance: any) => instance.showHint({ completeSingle: false }),
          // 补全弹窗打开时让 show-hint 先吃掉 Esc（关弹窗）；否则退出编辑模式
          "Esc": (instance: any) =>
            instance.state.completionActive ? (CodeMirror as any).Pass : onExitRef.current?.(),
        },
        hintOptions: {
          completeSingle: false,
          hint: (instance: any) => makeWikiHint(noteNamesRef.current)(instance),
          container: containerRef.current,
        },
        // 编辑区由外层 reader 统一滚动，需渲染完整文档才能正确计算光标和补全框位置。
        viewportMargin: Infinity,
      });

      let wikiHintTimer: ReturnType<typeof setTimeout> | null = null;
      cm.on("change", (_inst: any, change: any) => {
        onChangeRef.current(cm.getValue());
        if (["+input", "*compose", "+delete", "paste", "cut", "undo", "redo"].includes(change.origin)) {
          const cur = cm.getCursor();
          const before: string = cm.getLine(cur.line).slice(0, cur.ch);
          const context = findWikiContext(before);
          if (context) {
            if (wikiHintTimer) clearTimeout(wikiHintTimer);
            wikiHintTimer = setTimeout(() => {
              if (!cm.state.completionActive) {
                cm.showHint({ completeSingle: false });
              }
            }, 80);
          } else {
            if (wikiHintTimer) clearTimeout(wikiHintTimer);
            wikiHintTimer = null;
            cm.closeHint();
          }
        }
      });

      // ── 粘贴图片：拦截剪贴板图片 → 上传到笔记同目录 → 插入 markdown 引用 ──
      const pasteImage = async (instance: any, file: File, mimeType: string) => {
        const notePath = currentPathRef.current;
        if (!notePath) return;

        const from = instance.getCursor("from");
        const to = instance.getCursor("to");
        const hasSelection = from.line !== to.line || from.ch !== to.ch;
        const spinner = document.createElement("span");
        spinner.className = styles.cmImagePastePending;
        spinner.setAttribute("aria-label", "正在保存图片");
        spinner.title = "正在保存图片";

        // 保存期间用书签锚定插入点，允许用户继续输入
        const selectionMarker = hasSelection
          ? instance.markText(from, to, {
              className: styles.cmImagePasteSelection,
              clearWhenEmpty: false,
              inclusiveLeft: false,
              inclusiveRight: false,
            })
          : null;
        const insertionMarker = instance.setBookmark(hasSelection ? to : from, {
          widget: spinner,
          insertLeft: false,
        });
        if (hasSelection) instance.setCursor(to);

        try {
          if (file.size > MAX_PASTED_IMAGE_BYTES) throw new Error("图片不能超过 20 MB。");
          const dataBase64 = await readFileAsBase64(file);
          const response = await fetch("/api/notes/asset", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ notePath, originalName: file.name || "", mimeType, dataBase64 }),
          });
          if (!response.ok) {
            const data = (await response.json().catch(() => ({}))) as { error?: string };
            throw new Error(data.error ?? "图片保存失败。");
          }
          const saved = (await response.json()) as { name: string };

          const markedRange = selectionMarker?.find();
          const markedPosition = insertionMarker.find();
          selectionMarker?.clear();
          insertionMarker.clear();

          if (currentPathRef.current !== notePath || cmRef.current !== instance) {
            onImagePasteErrorRef.current?.("图片已保存，但当前笔记已切换。");
            return;
          }
          if (!markedRange && !markedPosition) return;

          const insertFrom = markedRange?.from ?? markedPosition;
          const insertTo = markedRange?.to ?? markedPosition;
          instance.replaceRange(`![图片](./${encodeMediaTarget(saved.name)})`, insertFrom, insertTo, "paste");
          onImagePastedRef.current?.();
        } catch (error) {
          selectionMarker?.clear();
          insertionMarker.clear();
          onImagePasteErrorRef.current?.(error instanceof Error ? error.message : "图片保存失败。");
        }
      };

      cm.on("paste", (instance: any, event: ClipboardEvent) => {
        if (!/\.md$/i.test(currentPathRef.current ?? "")) return;
        const file = Array.from(event.clipboardData?.items || [])
          .filter((item) => item.kind === "file")
          .map((item) => item.getAsFile())
          .find((candidate) => candidate && pastedImageMime(candidate));
        const mimeType = pastedImageMime(file);
        if (!file || !mimeType) return;

        event.preventDefault();
        void pasteImage(instance, file, mimeType);
      });

      cmRef.current = cm;
      (cm.getInputField() as HTMLElement).focus({ preventScroll: true });
      onReadyRef.current?.();

      return () => {
        if (wikiHintTimer) clearTimeout(wikiHintTimer);
        // 销毁 CM DOM：否则 StrictMode/重挂载会在同一容器叠出僵尸编辑器
        cm.getWrapperElement()?.remove();
        cmRef.current = null;
      };
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    useEffect(() => {
      const cm = cmRef.current;
      if (!cm) return;
      if (cm.getValue() === value) return;
      const cursor = cm.getCursor();
      cm.setValue(value);
      cm.setCursor(cursor);
    }, [value]);

    // 点 cmContainer 的内边距区域（CM 文字以外）→ 重新聚焦到末尾
    const handleContainerMouseDown = (event: React.MouseEvent<HTMLDivElement>) => {
      const cm = cmRef.current;
      if (!cm) return;
      if (event.target !== containerRef.current) return;
      event.preventDefault();
      cm.focus();
      const lastLine = cm.lastLine();
      cm.setCursor({ line: lastLine, ch: cm.getLine(lastLine).length });
    };

    return (
      <div
        ref={containerRef}
        // 空态提示走 CSS ::before，不塞进 CM 文档，避免被当成正文保存
        className={`${styles.cmContainer} ${value === "" ? styles.cmEmpty : ""}`}
        data-placeholder={placeholder}
        onMouseDown={handleContainerMouseDown}
      />
    );
  }
);

export default NotesEditor;
