"use client";

import { useEffect, useRef, useState } from "react";
import styles from "./notes.module.css";

// Inject a script that (1) reports the document height to the parent frame and
// (2) intercepts Obsidian-style links (obsidian://open?...&file=xxx.md) so they
// navigate inside inkfellow instead of trying to launch the Obsidian desktop app
// (which the browser cannot do for the obsidian:// protocol).
const injectHeightScript = (html: string): string => {
  const script = `<script>(function(){
    var resizeObserver;
    var resizeFrame = 0;
    var lastViewportWidth = window.innerWidth;
    var lastViewportHeight = window.innerHeight;
    var suppressedHeight = null;

    function saveStyle(element, property) {
      return [element.style.getPropertyValue(property), element.style.getPropertyPriority(property)];
    }

    function restoreStyle(element, property, saved) {
      if (saved[0]) element.style.setProperty(property, saved[0], saved[1]);
      else element.style.removeProperty(property);
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

      var scrollTop = window.scrollY || root.scrollTop || body.scrollTop || 0;
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

      // body/root boxes do not include every out-of-flow visual box. In
      // particular, an HTML document made only from positioned elements can
      // otherwise collapse to 1px. Include descendant render bounds while the
      // document still has its height constraints neutralised.
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

      // Applying the previous report changes the iframe viewport height. A
      // descendant using vh can then resize by exactly the same amount and
      // create an endless parent/child feedback loop. A height-only viewport
      // change is the response to our own report. Remember that resulting
      // measurement as well, because restoring the temporary measurement
      // styles can enqueue one more ResizeObserver callback.
      var measuredHeight = measureIntrinsicHeight();
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
      } catch (e) {}
    }

    function scheduleHeightReport() {
      if (resizeFrame) cancelAnimationFrame(resizeFrame);
      resizeFrame = requestAnimationFrame(reportHeight);
    }

    function startHeightObserver() {
      if (resizeObserver || !document.body) return;
      resizeObserver = new ResizeObserver(scheduleHeightReport);
      resizeObserver.observe(document.documentElement);
      resizeObserver.observe(document.body);
      Array.prototype.forEach.call(document.body.children, function(child) {
        resizeObserver.observe(child);
      });
      scheduleHeightReport();
    }

    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", startHeightObserver, {once:true});
    } else {
      startHeightObserver();
    }
    window.addEventListener("load", scheduleHeightReport);
    window.addEventListener("message", function(event) {
      if (event.data && event.data.type === "iframeMeasure") scheduleHeightReport();
    });

    document.addEventListener("click",function(e){
    var t=e.target&&e.target.nodeType===1?e.target:e.target&&e.target.parentElement;
    var a=t&&t.closest?t.closest('a[href^="obsidian://"]'):null;
    if(!a)return;e.preventDefault();` +
    // 不能用 URLSearchParams：这些 obsidian 链接的 file 值是原始 UTF-8 且含字面 '+'，
    // URLSearchParams 会把 '+' 当空格解码，导致带 '+' 的文件名跳转失败。手动取 file= 后的原始串。
    `try{var q=(a.getAttribute("href")||"").split("?")[1]||"";var file="";` +
    `var parts=q.split("&");for(var i=0;i<parts.length;i++){if(parts[i].indexOf("file=")===0){file=parts[i].slice(5);break;}}` +
    `if(/%[0-9A-Fa-f]{2}/.test(file)){try{file=decodeURIComponent(file);}catch(e2){}}` +
    `if(file){window.parent.postMessage({type:"note-navigate",path:file},"*");}}catch(err){}` +
    `},true);` +
    `})()</script>`;

  const bodyClose = html.lastIndexOf("</body>");
  if (bodyClose !== -1) return html.slice(0, bodyClose) + script + html.slice(bodyClose);

  const htmlClose = html.lastIndexOf("</html>");
  if (htmlClose !== -1) return html.slice(0, htmlClose) + script + html.slice(htmlClose);

  return html + script;
};

type NotesHtmlProps = {
  html: string;
  /** Open an Obsidian-style link (obsidian://...&file=xxx.md) inside inkfellow. */
  onNavigate?: (path: string) => void;
};

export default function NotesHtml({ html, onNavigate }: NotesHtmlProps) {
  const [height, setHeight] = useState(600);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const onNavigateRef = useRef(onNavigate);

  useEffect(() => {
    onNavigateRef.current = onNavigate;
  }, [onNavigate]);

  useEffect(() => {
    const handle = (ev: MessageEvent) => {
      if (ev.source !== iframeRef.current?.contentWindow) return;
      if (
        ev.data?.type === "iframeHeight" &&
        typeof ev.data.h === "number" &&
        Number.isFinite(ev.data.h)
      ) {
        const nextHeight = Math.max(1, Math.ceil(ev.data.h));
        setHeight((currentHeight) =>
          currentHeight === nextHeight ? currentHeight : nextHeight,
        );
      } else if (ev.data?.type === "note-navigate" && typeof ev.data.path === "string") {
        onNavigateRef.current?.(ev.data.path);
      }
    };
    window.addEventListener("message", handle);
    return () => window.removeEventListener("message", handle);
  }, []);

  // A width change can reflow the iframe content. Ask the child to measure
  // again, but ignore height-only ResizeObserver events to avoid feedback.
  useEffect(() => {
    const iframe = iframeRef.current;
    if (!iframe) return;
    let previousWidth = iframe.getBoundingClientRect().width;
    const ro = new ResizeObserver((entries) => {
      const nextWidth = entries[0]?.contentRect.width ?? iframe.getBoundingClientRect().width;
      if (Math.abs(nextWidth - previousWidth) < 0.5) return;
      previousWidth = nextWidth;
      iframe.contentWindow?.postMessage({ type: "iframeMeasure" }, "*");
    });
    ro.observe(iframe);
    return () => ro.disconnect();
  }, []);

  return (
    <iframe
      ref={iframeRef}
      className={styles.htmlFrame}
      srcDoc={injectHeightScript(html)}
      sandbox="allow-scripts allow-same-origin"
      allow="clipboard-write"
      width="100%"
      style={{ height, width: "100%" }}
      title="HTML 文件内容"
    />
  );
}
