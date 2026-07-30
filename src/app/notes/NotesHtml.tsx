"use client";

import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import type { TocEntry } from "@/lib/noteToc";
import styles from "./notes.module.css";

type HtmlHeading = TocEntry & {
  fragment: string;
  top: number;
};

type ScrollToFragmentOptions = {
  behavior?: ScrollBehavior;
  recordHistory?: boolean;
};

export type NotesHtmlHandle = {
  scrollToFragment: (fragment: string, options?: ScrollToFragmentOptions) => void;
  scrollToHeading: (slug: string, options?: ScrollToFragmentOptions) => void;
};

type NotesHtmlProps = {
  html: string;
  /** Vault-relative path, used to resolve CSS/scripts/images referenced by the HTML file. */
  notePath?: string;
  /** Hash to restore after a new HTML document finishes loading. */
  initialHash?: string | null;
  /** Open an Obsidian-style link inside inkfellow. */
  onNavigate?: (path: string, hash?: string | null) => void;
  /** Resolve an ordinary relative HTML link against the current note. */
  onLinkNavigate?: (href: string) => void;
  onHashNavigate?: (fragment: string) => void;
  onHeadingsChange?: (path: string, headings: TocEntry[]) => void;
  onActiveHeadingChange?: (slug: string) => void;
};

const htmlAssetBaseHref = (notePath?: string): string => {
  if (!notePath) return "";
  const normalized = notePath.replace(/\\/g, "/").replace(/^\/+/, "");
  const folder = normalized.includes("/")
    ? normalized.split("/").slice(0, -1)
    : [];
  const encodedFolder = folder.map((segment) => encodeURIComponent(segment)).join("/");
  return `/api/notes/html-assets/${encodedFolder ? `${encodedFolder}/` : ""}`;
};

const escapeAttribute = (value: string) =>
  value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

const injectPreviewBase = (html: string, notePath?: string): string => {
  const baseHref = htmlAssetBaseHref(notePath);
  if (!baseHref) return html;

  const existingBase = /(<base\b[^>]*\bhref\s*=\s*)(["'])([^"']*)\2/i;
  const match = html.match(existingBase);
  if (match) {
    try {
      const placeholderOrigin = "https://inkfellow.invalid";
      const resolved = new URL(match[3], `${placeholderOrigin}${baseHref}`).href;
      const href = resolved.startsWith(placeholderOrigin)
        ? resolved.slice(placeholderOrigin.length)
        : resolved;
      return html.replace(
        existingBase,
        () => `${match[1]}${match[2]}${escapeAttribute(href)}${match[2]}`,
      );
    } catch {
      return html;
    }
  }

  const baseTag = `<base href="${escapeAttribute(baseHref)}">`;
  const head = /<head\b[^>]*>/i.exec(html);
  if (head?.index != null) {
    const insertion = head.index + head[0].length;
    return `${html.slice(0, insertion)}${baseTag}${html.slice(insertion)}`;
  }

  const htmlElement = /<html\b[^>]*>/i.exec(html);
  if (htmlElement?.index != null) {
    const insertion = htmlElement.index + htmlElement[0].length;
    return `${html.slice(0, insertion)}<head>${baseTag}</head>${html.slice(insertion)}`;
  }

  return `<head>${baseTag}</head>${html}`;
};

// The preview bridge reports intrinsic height/headings, routes links back to the
// application, and accepts fragment-scroll commands from the outer reader.
const injectPreviewBridge = (html: string): string => {
  const script = `<script>(function(){
    var resizeObserver;
    var mutationObserver;
    var resizeFrame = 0;
    var lastViewportWidth = window.innerWidth;
    var lastViewportHeight = window.innerHeight;
    var suppressedHeight = null;
    var lastHeadingSignature = "";

    function saveStyle(element, property) {
      return [element.style.getPropertyValue(property), element.style.getPropertyPriority(property)];
    }

    function restoreStyle(element, property, saved) {
      if (saved[0]) element.style.setProperty(property, saved[0], saved[1]);
      else element.style.removeProperty(property);
    }

    function currentScrollTop() {
      var root = document.documentElement;
      return window.scrollY || root.scrollTop || (document.body && document.body.scrollTop) || 0;
    }

    function decodeFragment(value) {
      var fragment = String(value || "").replace(/^#/, "");
      try { fragment = decodeURIComponent(fragment); } catch (error) {}
      return fragment;
    }

    function fragmentTarget(fragment) {
      var decoded = decodeFragment(fragment);
      if (!decoded) return document.documentElement;
      var named = document.getElementsByName(decoded);
      return document.getElementById(decoded) || (named.length ? named[0] : null);
    }

    function slugifyHeading(text, seen) {
      var base = text.toLowerCase().trim().replace(/\\s+/g, "-")
        .replace(/[^\\p{L}\\p{N}_-]/gu, "") || "heading";
      var count = seen[base] || 0;
      seen[base] = count + 1;
      return count > 0 ? base + "-" + count : base;
    }

    function reportHeadings() {
      if (!document.body) return;
      var seen = Object.create(null);
      var scrollTop = currentScrollTop();
      var nodes = document.querySelectorAll("h1,h2,h3,h4,h5,h6");
      var headings = [];

      for (var i = 0; i < nodes.length; i++) {
        var heading = nodes[i];
        var text = (heading.textContent || "").trim();
        if (!text) continue;
        var fragment = heading.id;
        if (!fragment) {
          var base = slugifyHeading(text, seen);
          fragment = base;
          var suffix = 1;
          while (document.getElementById(fragment)) {
            fragment = base + "-" + suffix++;
          }
          heading.id = fragment;
        }
        var key = "html-heading-" + i;
        heading.setAttribute("data-inkfellow-heading-key", key);
        headings.push({
          level: Number(heading.tagName.slice(1)),
          text: text,
          slug: key,
          fragment: fragment,
          top: Math.round((heading.getBoundingClientRect().top + scrollTop) * 100) / 100
        });
      }

      var signature = JSON.stringify(headings);
      if (signature === lastHeadingSignature) return;
      lastHeadingSignature = signature;
      try {
        window.parent.postMessage({type:"iframe-headings",headings:headings},"*");
      } catch (error) {}
    }

    function postFragmentTarget(fragment, behavior, recordHistory) {
      var decoded = decodeFragment(fragment);
      var target = fragmentTarget(decoded);
      if (!target) return false;
      var root = document.documentElement;
      var targetTop = decoded
        ? target.getBoundingClientRect().top + currentScrollTop()
        : 0;
      var rootStyle = window.getComputedStyle(root);
      var offset = parseFloat(rootStyle.scrollPaddingTop) || 0;
      try {
        window.parent.postMessage({
          type:"iframe-anchor",
          top:targetTop,
          offset:offset,
          behavior:behavior === "smooth" ? "smooth" : "auto",
          fragment:decoded,
          recordHistory:recordHistory !== false
        },"*");
      } catch (error) {}
      return true;
    }

    function measureIntrinsicHeight() {
      var root = document.documentElement;
      var body = document.body;
      if (!body) return Math.max(1, Math.ceil(root.scrollHeight));

      // A page using min-height:100vh otherwise reports the iframe viewport as
      // content height. Temporarily neutralise only the root/body height rules
      // while measuring, then restore them before the browser paints.
      var rootHeight = saveStyle(root, "height");
      var rootMinHeight = saveStyle(root, "min-height");
      var bodyHeight = saveStyle(body, "height");
      var bodyMinHeight = saveStyle(body, "min-height");

      root.style.setProperty("height", "auto", "important");
      root.style.setProperty("min-height", "0", "important");
      body.style.setProperty("height", "auto", "important");
      body.style.setProperty("min-height", "0", "important");

      var scrollTop = currentScrollTop();
      var viewportHeight = Math.max(1, window.innerHeight || root.clientHeight || 1);
      var rootRect = root.getBoundingClientRect();
      var bodyRect = body.getBoundingClientRect();
      var bodyStyle = window.getComputedStyle(body);
      var marginTop = parseFloat(bodyStyle.marginTop) || 0;
      var marginBottom = parseFloat(bodyStyle.marginBottom) || 0;
      var height = Math.max(
        rootRect.bottom + scrollTop,
        bodyRect.height + marginTop + marginBottom,
        bodyRect.top + scrollTop + body.scrollHeight + marginBottom,
        root.scrollHeight > viewportHeight + 0.5 ? root.scrollHeight : 0
      );

      // body/root boxes do not include every out-of-flow visual box.
      var elements = body.querySelectorAll("*");
      for (var i = 0; i < elements.length; i++) {
        var rect = elements[i].getBoundingClientRect();
        if (Number.isFinite(rect.bottom)) {
          height = Math.max(height, rect.bottom + scrollTop);
        }
      }

      restoreStyle(root, "height", rootHeight);
      restoreStyle(root, "min-height", rootMinHeight);
      restoreStyle(body, "height", bodyHeight);
      restoreStyle(body, "min-height", bodyMinHeight);

      return Math.max(1, Math.ceil(height));
    }

    function reportHeight() {
      resizeFrame = 0;
      var viewportWidth = window.innerWidth;
      var viewportHeight = window.innerHeight;
      var widthChanged = Math.abs(viewportWidth - lastViewportWidth) >= 0.5;
      var heightChanged = Math.abs(viewportHeight - lastViewportHeight) >= 0.5;
      lastViewportWidth = viewportWidth;
      lastViewportHeight = viewportHeight;

      var measuredHeight = measureIntrinsicHeight();
      reportHeadings();
      if (heightChanged && !widthChanged) {
        suppressedHeight = measuredHeight;
        return;
      }
      if (
        !widthChanged &&
        suppressedHeight !== null &&
        Math.abs(measuredHeight - suppressedHeight) < 0.5
      ) {
        return;
      }
      suppressedHeight = null;

      try {
        window.parent.postMessage({type:"iframeHeight",h:measuredHeight},"*");
      } catch (error) {}
    }

    function scheduleHeightReport() {
      if (resizeFrame) cancelAnimationFrame(resizeFrame);
      resizeFrame = requestAnimationFrame(reportHeight);
    }

    function startObservers() {
      if (resizeObserver || !document.body) return;
      resizeObserver = new ResizeObserver(scheduleHeightReport);
      resizeObserver.observe(document.documentElement);
      resizeObserver.observe(document.body);
      Array.prototype.forEach.call(document.body.children, function(child) {
        resizeObserver.observe(child);
      });
      mutationObserver = new MutationObserver(scheduleHeightReport);
      mutationObserver.observe(document.body, {
        childList:true,
        subtree:true,
        characterData:true
      });
      scheduleHeightReport();
    }

    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", startObservers, {once:true});
    } else {
      startObservers();
    }
    window.addEventListener("load", scheduleHeightReport);
    window.addEventListener("message", function(event) {
      if (event.source !== window.parent || !event.data) return;
      if (event.data.type === "iframeMeasure") {
        scheduleHeightReport();
      } else if (
        event.data.type === "iframeScrollToFragment" &&
        typeof event.data.fragment === "string"
      ) {
        postFragmentTarget(
          event.data.fragment,
          event.data.behavior,
          event.data.recordHistory
        );
      }
    });

    document.addEventListener("click",function(event){
      if (
        event.defaultPrevented ||
        event.button !== 0 ||
        event.metaKey ||
        event.ctrlKey ||
        event.shiftKey ||
        event.altKey
      ) return;
      var target = event.target && event.target.nodeType === 1
        ? event.target
        : event.target && event.target.parentElement;
      var link = target && target.closest ? target.closest("a") : null;
      if (!link) return;
      var href = (link.getAttribute("href") || "").trim();
      if (!href || href.indexOf("inkwell-wiki:") === 0) return;

      if (href.charAt(0) === "#") {
        if (!fragmentTarget(href)) return;
        event.preventDefault();
        postFragmentTarget(href, "smooth", true);
        return;
      }

      if (/^https?:\\/\\//i.test(href) || href.indexOf("//") === 0) {
        event.preventDefault();
        try {
          window.parent.postMessage({
            type:"open-external",
            url:href.indexOf("//") === 0 ? "https:" + href : href
          },"*");
        } catch (error) {}
        return;
      }

      if (href.indexOf("obsidian://") === 0) {
        event.preventDefault();
        try {
          var query = href.split("?")[1] || "";
          var file = "";
          var parts = query.split("&");
          for (var i = 0; i < parts.length; i++) {
            if (parts[i].indexOf("file=") === 0) {
              file = parts[i].slice(5);
              break;
            }
          }
          if (/%[0-9A-Fa-f]{2}/.test(file)) {
            try { file = decodeURIComponent(file); } catch (error) {}
          }
          if (file) {
            window.parent.postMessage({type:"note-navigate",path:file},"*");
          }
        } catch (error) {}
        return;
      }

      if (/^[a-z][a-z0-9+.-]*:/i.test(href)) return;
      event.preventDefault();
      try {
        window.parent.postMessage({type:"note-link",href:href},"*");
      } catch (error) {}
    },true);
  })()</script>`;

  const lowerHtml = html.toLocaleLowerCase();
  const bodyClose = lowerHtml.lastIndexOf("</body>");
  if (bodyClose !== -1) return html.slice(0, bodyClose) + script + html.slice(bodyClose);

  const htmlClose = lowerHtml.lastIndexOf("</html>");
  if (htmlClose !== -1) return html.slice(0, htmlClose) + script + html.slice(htmlClose);

  return html + script;
};

const buildPreviewHtml = (html: string, notePath?: string) =>
  injectPreviewBridge(injectPreviewBase(html, notePath));

const requestHeightMeasurement = (iframe: HTMLIFrameElement | null) => {
  iframe?.contentWindow?.postMessage({ type: "iframeMeasure" }, "*");
};

const normalizeFragment = (value: string) => {
  const raw = value.replace(/^#/, "");
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
};

const isHtmlHeading = (value: unknown): value is HtmlHeading => {
  if (!value || typeof value !== "object") return false;
  const heading = value as Partial<HtmlHeading>;
  return (
    typeof heading.level === "number" &&
    Number.isFinite(heading.level) &&
    typeof heading.text === "string" &&
    typeof heading.slug === "string" &&
    typeof heading.fragment === "string" &&
    typeof heading.top === "number" &&
    Number.isFinite(heading.top)
  );
};

const NotesHtml = forwardRef<NotesHtmlHandle, NotesHtmlProps>(function NotesHtml(
  {
    html,
    notePath = "",
    initialHash = null,
    onNavigate,
    onLinkNavigate,
    onHashNavigate,
    onHeadingsChange,
    onActiveHeadingChange,
  },
  ref,
) {
  const [height, setHeight] = useState(600);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const headingsRef = useRef<HtmlHeading[]>([]);
  const headingSignatureRef = useRef("");
  const syncActiveHeadingRef = useRef<() => void>(() => {});
  const notePathRef = useRef(notePath);
  const initialHashRef = useRef(initialHash);
  const onNavigateRef = useRef(onNavigate);
  const onLinkNavigateRef = useRef(onLinkNavigate);
  const onHashNavigateRef = useRef(onHashNavigate);
  const onHeadingsChangeRef = useRef(onHeadingsChange);
  const onActiveHeadingChangeRef = useRef(onActiveHeadingChange);

  useEffect(() => {
    notePathRef.current = notePath;
    initialHashRef.current = initialHash;
    onNavigateRef.current = onNavigate;
    onLinkNavigateRef.current = onLinkNavigate;
    onHashNavigateRef.current = onHashNavigate;
    onHeadingsChangeRef.current = onHeadingsChange;
    onActiveHeadingChangeRef.current = onActiveHeadingChange;
  }, [
    initialHash,
    notePath,
    onActiveHeadingChange,
    onHashNavigate,
    onHeadingsChange,
    onLinkNavigate,
    onNavigate,
  ]);

  const previewHtml = useMemo(() => buildPreviewHtml(html, notePath), [html, notePath]);

  const requestFragmentScroll = (
    fragment: string,
    options: ScrollToFragmentOptions = {},
  ) => {
    iframeRef.current?.contentWindow?.postMessage(
      {
        type: "iframeScrollToFragment",
        fragment,
        behavior: options.behavior ?? "auto",
        recordHistory: options.recordHistory ?? false,
      },
      "*",
    );
  };

  useImperativeHandle(ref, () => ({
    scrollToFragment: requestFragmentScroll,
    scrollToHeading: (slug, options = {}) => {
      const heading = headingsRef.current.find((entry) => entry.slug === slug);
      if (heading) requestFragmentScroll(heading.fragment, options);
    },
  }));

  useEffect(() => {
    const iframe = iframeRef.current;
    if (!iframe) return;

    const reader = iframe.closest<HTMLElement>("[data-notes-reader]");
    const syncActiveHeading = () => {
      const headings = headingsRef.current;
      if (headings.length === 0) return;

      const readerScrollable = Boolean(
        reader && window.getComputedStyle(reader).overflowY !== "visible",
      );
      const iframeTop = iframe.getBoundingClientRect().top;
      const viewportTop = readerScrollable && reader
        ? reader.getBoundingClientRect().top
        : 0;
      const viewportHeight = readerScrollable && reader
        ? reader.clientHeight
        : window.innerHeight;
      if (viewportHeight <= 0) return;

      const atBottom = readerScrollable && reader
        ? reader.scrollTop + reader.clientHeight >= reader.scrollHeight - 2
        : window.scrollY + window.innerHeight >= document.documentElement.scrollHeight - 2;
      let active = headings[0].slug;

      if (atBottom) {
        active = headings[headings.length - 1].slug;
      } else {
        const threshold = viewportTop + viewportHeight * 0.22;
        for (const heading of headings) {
          if (iframeTop + heading.top <= threshold) active = heading.slug;
          else break;
        }
      }
      onActiveHeadingChangeRef.current?.(active);
    };

    syncActiveHeadingRef.current = syncActiveHeading;
    reader?.addEventListener("scroll", syncActiveHeading, { passive: true });
    window.addEventListener("scroll", syncActiveHeading, { passive: true });
    const resizeObserver = new ResizeObserver(syncActiveHeading);
    resizeObserver.observe(iframe);
    const timeout = window.setTimeout(syncActiveHeading, 80);

    return () => {
      reader?.removeEventListener("scroll", syncActiveHeading);
      window.removeEventListener("scroll", syncActiveHeading);
      resizeObserver.disconnect();
      window.clearTimeout(timeout);
      syncActiveHeadingRef.current = () => {};
    };
  }, []);

  useEffect(() => {
    const scrollOuterReader = (
      targetOffset: number,
      requestedOffset: number,
      behavior: ScrollBehavior,
    ) => {
      const iframe = iframeRef.current;
      if (!iframe) return;
      const reader = iframe.closest<HTMLElement>("[data-notes-reader]");
      const readerHeader = reader?.querySelector<HTMLElement>("[data-notes-reader-header]");
      const offset = Math.max(
        Math.min(500, Math.max(0, requestedOffset)),
        (readerHeader?.getBoundingClientRect().height ?? 0) + 8,
      );
      const iframeRect = iframe.getBoundingClientRect();
      const readerScrollable = Boolean(
        reader && window.getComputedStyle(reader).overflowY !== "visible",
      );

      if (readerScrollable && reader) {
        const readerTop = reader.getBoundingClientRect().top;
        reader.scrollTo({
          top: Math.max(0, reader.scrollTop + iframeRect.top - readerTop + targetOffset - offset),
          behavior,
        });
      } else {
        window.scrollTo({
          top: Math.max(0, window.scrollY + iframeRect.top + targetOffset - offset),
          behavior,
        });
      }
      window.requestAnimationFrame(syncActiveHeadingRef.current);
    };

    const handle = (event: MessageEvent) => {
      if (event.source !== iframeRef.current?.contentWindow) return;
      if (
        event.data?.type === "iframeHeight" &&
        typeof event.data.h === "number" &&
        Number.isFinite(event.data.h)
      ) {
        const nextHeight = Math.max(1, Math.ceil(event.data.h));
        setHeight((currentHeight) =>
          currentHeight === nextHeight ? currentHeight : nextHeight,
        );
      } else if (event.data?.type === "iframe-headings" && Array.isArray(event.data.headings)) {
        const headings = (event.data.headings as unknown[]).filter(isHtmlHeading);
        const signature = JSON.stringify(headings);
        if (signature !== headingSignatureRef.current) {
          headingSignatureRef.current = signature;
          headingsRef.current = headings;
          onHeadingsChangeRef.current?.(
            notePathRef.current,
            headings.map(({ level, text, slug }) => ({ level, text, slug })),
          );
        }
        window.requestAnimationFrame(syncActiveHeadingRef.current);
      } else if (
        event.data?.type === "iframe-anchor" &&
        typeof event.data.top === "number" &&
        Number.isFinite(event.data.top)
      ) {
        const offset =
          typeof event.data.offset === "number" && Number.isFinite(event.data.offset)
            ? event.data.offset
            : 0;
        const behavior: ScrollBehavior = event.data.behavior === "smooth" ? "smooth" : "auto";
        scrollOuterReader(Math.max(0, event.data.top), offset, behavior);
        if (
          event.data.recordHistory !== false &&
          typeof event.data.fragment === "string"
        ) {
          onHashNavigateRef.current?.(normalizeFragment(event.data.fragment));
        }
      } else if (event.data?.type === "note-navigate" && typeof event.data.path === "string") {
        onNavigateRef.current?.(event.data.path);
      } else if (event.data?.type === "note-link" && typeof event.data.href === "string") {
        onLinkNavigateRef.current?.(event.data.href);
      } else if (event.data?.type === "open-external" && typeof event.data.url === "string") {
        window.open(event.data.url, "_blank", "noopener,noreferrer");
      }
    };

    window.addEventListener("message", handle);
    requestHeightMeasurement(iframeRef.current);
    return () => window.removeEventListener("message", handle);
  }, []);

  useEffect(() => () => {
    onHeadingsChangeRef.current?.(notePathRef.current, []);
  }, []);

  // A width change can reflow the iframe content. Ignore height-only changes to
  // avoid feeding the child height report back into itself.
  useEffect(() => {
    const iframe = iframeRef.current;
    if (!iframe) return;
    let previousWidth = iframe.getBoundingClientRect().width;
    const resizeObserver = new ResizeObserver((entries) => {
      const nextWidth =
        entries[0]?.contentRect.width ?? iframe.getBoundingClientRect().width;
      if (Math.abs(nextWidth - previousWidth) < 0.5) return;
      previousWidth = nextWidth;
      requestHeightMeasurement(iframe);
    });
    resizeObserver.observe(iframe);
    return () => resizeObserver.disconnect();
  }, []);

  return (
    <iframe
      ref={iframeRef}
      className={styles.htmlFrame}
      srcDoc={previewHtml}
      sandbox="allow-scripts allow-same-origin"
      allow="clipboard-write"
      onLoad={(event) => {
        requestHeightMeasurement(event.currentTarget);
        const hash = initialHashRef.current;
        if (hash) {
          window.setTimeout(() => {
            requestFragmentScroll(hash, { behavior: "auto", recordHistory: false });
          }, 0);
        }
      }}
      width="100%"
      style={{ height, width: "100%" }}
      title="HTML 文件内容"
    />
  );
});

export default NotesHtml;
