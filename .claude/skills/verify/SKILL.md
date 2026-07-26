---
name: verify
description: 在真实运行的 inkfellow 应用里端到端验证改动（Next.js + Playwright MCP）
---

# inkfellow 验证方法

## 启动

```bash
npm run dev   # Next.js (Turbopack)，http://localhost:3000，~1s 就绪
```

- 笔记应用只有一个路由：`/`（`/notes` 是 404）。带文件参数：`/?file=<vault相对路径>`。另有 `/share/[token]` 分享页，与笔记主界面无关。
- 应用直接读写 `vault/` 目录——**这是用户的真实笔记库（450+ 篇）**。
  - 只读操作随意；写操作（新建/重命名/删除）只对自己新建的测试文件做，测完删掉，保持净零。
  - 不要动 `原始素材库/`、`wiki/` 下的任何文件。

## 驱动

用 Playwright MCP（`browser_navigate` / `browser_snapshot` / `browser_evaluate`）。

- 主组件是 `src/app/notes/NotesExplorer.tsx`（4500 行巨石组件），阅读区滚动容器是 `<section class*="reader">`（`readerRef`，overflow-y auto）。已拆出去的部分：树节点在 `TreeItem.tsx`，⌘K 快速打开在 `QuickSwitcher.tsx`，多标签在 `NoteTabs.tsx`。
- 关键 localStorage/sessionStorage 键：
  - `inkfellow-notes-last-file-v1` — 上次打开的文件
  - `inkfellow-notes-tabs-v1` — 多标签列表
  - `inkfellow-notes-scroll-v1:<path>` —（sessionStorage）每篇滚动快照
- 新建笔记：侧栏「新建或导入」→「新建笔记」对话框；React 受控输入框要用 native setter + `dispatchEvent(new Event('input', {bubbles:true}))` 填值。
- 树节点操作菜单：`[aria-label="<文件名> 的操作"]` → 重命名/删除。

## 坑

- **Fast Refresh 会重挂载组件**：编辑源码后，evaluate 里缓存的 DOM 引用会指向脱离文档的旧节点（操作静默失效）。每个步骤重新 query，或分多次 evaluate。
- `.playwright-mcp/` 目录会生成在仓库根部（截图/快照/console 日志），验证完删掉；它的写入还可能触发多余的 Fast Refresh。
- console 里 `<div> cannot be a descendant of <p>`（NotesMarkdown CodeBlock）是既有告警，与新改动无关。
- 桌面/移动行为分叉多（`isMobileViewport`），移动端验证用 `browser_resize` 到 390×844。
