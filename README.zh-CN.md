# inkfellow

[English](./README.md) | 中文

inkfellow 可以把一个 Markdown 文件夹变成自托管、本地优先的个人知识工作台。你可以通过浏览器或已安装的 PWA 读写笔记库，用 Git 管理版本、公开分享单篇笔记，也可以让 AI Agent 以整个笔记库为工作上下文。

仓库目前包含两个协作服务：

| 入口 | 适用场景 | 实现 |
| --- | --- | --- |
| Web / PWA | 自托管、手机和平板访问、远程使用 | Next.js 16 + React 19 |
| AI 服务 | 流式 Agent 对话、服务商切换、历史、定时任务和微信连接 | Node.js + WebSocket + Claude Agent SDK + Codex SDK |

## 当前功能

- 浏览、搜索、新建、导入、重命名、编辑和删除笔记或文件夹。
- 渲染 GFM Markdown、Front Matter、文章目录、Mermaid、本地图片、Wiki 链接、反向链接和提及关系。
- 可读写 `.md`、`.html`、`.htm`，并以只读方式预览 PDF 和常见图片格式。
- 内置 Git 工作区：查看状态和 diff、浏览提交历史、拉取、提交并推送，或丢弃指定改动。
- 为单篇笔记生成可撤销的 `/share/<token>` 公开链接。
- Web 端可安装为 PWA，缓存应用外壳以便更快再次打开。
- 在当前笔记旁打开可调整宽度的 AI 面板；选中的文字和当前笔记可以直接带入对话。
- 桌面浏览器支持专注聊天：点击展开按钮或按 `Ctrl/⌘ + \` 隐藏笔记预览，退出时恢复阅读位置。
- 每个对话独立记住账号、模型和推理档位，保存在当前浏览器中；新对话继承当前选择。
- 支持 Claude 会员登录、Codex/ChatGPT 登录、Anthropic、DeepSeek、OpenRouter、MiniMax 和自定义 Anthropic 兼容端点。
- 保存会话历史、切换模型和权限模式、创建一次性或 cron 定时任务，并可连接微信机器人。
- Web 界面同时适配桌面与移动端布局。

## 组件关系

```text
浏览器 / 已安装的 PWA
        |
        v
Next.js :3000  ---- 读写 ----> VAULT_PATH
        |
        +---- /notes-claude/* -----------> claude-chat :8082
        |
        +---- /share/<token> ------------> 单篇公开只读笔记
```

Next.js 已内置 `/notes-claude/*` 到 AI 服务的 rewrite，因此本地开发时直接访问 `http://localhost:3000` 就能使用 AI 面板。生产 Nginx 示例仍会把这一路径直接转发到 8082，以便明确处理长连接 WebSocket。

## 环境要求

Web 与 AI 服务需要：

- Node.js 20.9 或更高版本
- npm
- 一个笔记文件夹，推荐使用 Obsidian vault
- 如果需要同步与版本历史，再安装 Git

## 快速开始：Web

```bash
git clone https://github.com/jiangjiren/inkfellow.git
cd inkfellow
npm ci
cp .env.example .env.local
```

PowerShell 请把最后一条改为 `Copy-Item .env.example .env.local`。

编辑 `.env.local`：

```dotenv
NEXT_PUBLIC_APP_NAME=inkfellow
VAULT_PATH=/你的笔记库绝对路径
SITE_URL=http://localhost:3000

# 通过非本机域名访问时必须设置。
NOTES_BASIC_AUTH_USERNAME=notes
NOTES_BASIC_AUTH_PASSWORD=请替换为强密码
```

启动开发环境：

```bash
npm run dev
```

打开 <http://localhost:3000>。Host 为 `localhost` 或 `127.0.0.1` 时会跳过 Basic Auth，远程访问不会跳过；远程密码为空时会主动拒绝访问。

仓库自带示例 `vault/`，未设置 `VAULT_PATH` 时会使用它。Linux 用户也可以运行 `bash scripts/setup-vault.sh`，脚本会创建工作 vault 和裸 Git 远程仓库、写入示例笔记，并把 `VAULT_PATH` 写入 `.env.local`。

## 启用 AI 面板

再启动一个 AI 服务进程：

```bash
cd claude-chat
npm ci
cp .env.example .env
npm start
```

把 `claude-chat/.env` 中的 `VAULT_PATH` 设为 Web 应用使用的同一目录。服务默认监听 `127.0.0.1:8082`。

可用认证方式：

| 服务商 | 配置方式 |
| --- | --- |
| Claude 会员 | 安装 Claude Code，用运行 `claude-chat` 的同一系统用户登录，再用 `claude auth status` 验证。 |
| Codex / ChatGPT 会员 | 通过 Codex 登录，或用服务用户执行 `codex login`；服务会检测 `~/.codex/auth.json`。 |
| Anthropic、DeepSeek、OpenRouter、MiniMax | 在 AI 面板设置中添加账号和 API Key。 |
| 自定义 | 为 Anthropic 兼容端点填写 API Key、Base URL 和模型映射。 |

系统用户和 `HOME` 很重要：订阅凭据必须能被服务进程读取。API Key 与账号配置保存在本地，不能提交到 Git。

服务商行为、数据文件、定时任务、微信、REST 接口和安全细节见 [claude-chat/README.md](./claude-chat/README.md)。

## 环境变量

### Web 应用

| 变量 | 默认值 | 用途 |
| --- | --- | --- |
| `NEXT_PUBLIC_APP_NAME` | `inkfellow` | UI、页面标题和认证提示中的应用名。 |
| `VAULT_PATH` | `./vault` | 笔记库路径，可为绝对路径或相对进程路径。 |
| `SITE_URL` | `http://localhost:3000` | 生成公开分享链接时使用的站点地址。 |
| `SHARED_NOTES_PATH` | `./shared-notes.json` | 分享 token 数据文件。 |
| `NOTES_BASIC_AUTH_USERNAME` | `notes` | 远程 Web 和笔记 API 用户名。 |
| `NOTES_BASIC_AUTH_PASSWORD` | 空 | 为空时拒绝远程访问。 |
| `NEXT_PUBLIC_CLAUDE_CHAT_PORT` | `8082` | Next rewrite 和 AI 面板使用的服务端口。 |
| `NOTES_GIT_PUSH_TARGET` | `HEAD:main` | Web Git 推送时使用的 refspec。 |
| `GIT_COMMIT_USER_NAME` | `Inkfellow Web` | Web 提交使用的 Git 作者名。 |
| `GIT_COMMIT_USER_EMAIL` | `web-editor@inkfellow.local` | Web 提交使用的 Git 作者邮箱。 |
| `NEXT_PUBLIC_CF_WEB_ANALYTICS_TOKEN` | 空 | 设置后启用 Cloudflare Web Analytics。 |
| `DISABLE_PWA` | 未设置 | 设为 `1` 可在生产构建中关闭 PWA。 |

`NOTES_BASIC_AUTH_USER` 和 `NOTES_PASSWORD` 仍作为旧变量名兼容，但新部署应使用表中的标准名称。

### AI 服务

常用变量是 `HOST`、`PORT`、`VAULT_PATH`、`CLAUDE_PERMISSION_MODE` 和 `CLAUDE_CHAT_DATA_DIR`。完整说明见 [claude-chat/README.md](./claude-chat/README.md#configuration)。

## Git 同步

Git 功能操作的是 `VAULT_PATH`，不是 inkfellow 的源码仓库。

网页同步和夜间自动同步会在拉取后检查未解决的合并冲突；有冲突时停止，保留本地改动和冲突现场，避免把冲突标记提交到云端。处理冲突后再重试。夜间脚本在拉取失败时也会停止。

1. 在 vault 中初始化 Git 并创建第一次提交。
2. 如需拉取和推送，再添加远程仓库。
3. 确保运行 inkfellow 的系统用户无需交互输入密码即可访问远程仓库。

私有远程仓库示例：

```bash
cd /path/to/vault
git init
git add .
git -c user.name="Vault Setup" -c user.email="setup@localhost" commit -m "Initial notes"
git branch -M main
git remote add origin <你的私有远程地址>
git push -u origin main
```

Web Git 面板会显示未提交改动、diff、提交历史、上游 ahead/behind 状态和同步操作。也可以通过 cron 调用 `scripts/nightly-sync.js`，自动拉取、生成简短日志、提交并推送。

## 生产部署

先构建两个 Node 项目：

```bash
npm ci
npm run build

cd claude-chat
npm ci
cd ..
```

仓库提供以下模板：

- `deploy/notes-app.service.example`：Next.js systemd 服务
- `deploy/claude-chat.service.example`：AI systemd 服务
- `deploy/nginx.conf.example`：HTTPS、WebSocket 转发、上传限制，以及 AI 路径的可选额外认证
- `ecosystem.config.cjs`：PM2 替代方案

启用前必须替换所有占位符，并让两个服务使用同一 vault。AI 服务要由持有 Claude/Codex 登录凭据的同一 Unix 用户运行。`claude-chat` 应继续绑定 loopback，只通过 Next.js 或可信反向代理暴露。

多用户部署时，应为每个 vault 单独运行一组 Web 与 AI 进程，并使用不同端口、登录凭据、分享 token 文件和 AI 数据目录。单个进程内部没有多租户权限隔离。

### Vercel 演示

仓库自带 `vault/`，可快速部署接近只读的演示：

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https://github.com/jiangjiren/inkfellow)

Serverless 文件系统和短生命周期进程无法代替持久化服务器与长连接 WebSocket。需要编辑、Git 同步、持久分享状态或 AI 服务时，请使用 VPS。

## 安装 PWA

- 桌面 Chrome / Edge：点击地址栏中的安装图标。
- Android Chrome：选择“安装应用”或“添加到主屏幕”。
- iOS Safari：选择“分享 → 添加到主屏幕”。

PWA 缓存的是应用外壳；笔记和 AI 数据仍来自正在运行的服务器，并不是完整的离线笔记副本。

## 常用命令

| 命令 | 用途 |
| --- | --- |
| `npm run dev` | 启动 Next.js 开发环境。 |
| `npm run build` | 创建生产 standalone 构建。 |
| `npm start` | 启动生产 Web 应用。 |
| `npm run typecheck` | 运行 TypeScript 类型检查。 |
| `npm run lint` | 运行 ESLint。 |
| `node scripts/create-share-link.mjs "path/to/note.md"` | 创建或复用公开分享 token。 |
| `node scripts/nightly-sync.js /path/to/vault` | 手动执行一次自动 Git 同步。 |
| `bash scripts/update_app.sh` | 拉取、安装、构建并重启 systemd Web 服务。 |
| `bash scripts/deploy.sh` | 按 `ecosystem.config.cjs` 重建并重启 PM2 部署。 |

`scripts/deploy.sh` 会停止所有 PM2 应用，并结束它在 3000/3001 端口找到的监听进程。它只适合专门运行本部署的主机；共享主机请先改成按进程名操作。

## 仓库结构

```text
src/app/             Next.js UI 与 API 路由
src/lib/             vault、分享和笔记辅助逻辑
src/proxy.ts         远程 Basic Auth 入口
claude-chat/         AI 面板与 Node/WebSocket 服务
deploy/              systemd 与 Nginx 示例
scripts/             初始化、分享、同步和部署脚本
vault/               示例笔记
```

## 安全说明

- 远程访问 `/` 与 `/api/notes/*` 需要 Basic Auth；localhost 为本地使用场景而有意豁免。
- `/share/<token>` 对任何知道 token 的人公开；不再需要时应撤销链接。
- 独立 AI 服务没有通用登录层。请绑定 `127.0.0.1`，并在 Next.js/Nginx 处做认证。
- vault 路径解析会拒绝越界访问，并在笔记发现时排除内部和工具目录。
- 服务商配置、OAuth 凭据、聊天历史、分享 token、`.env*`、`.next`、`node_modules` 和真实 vault 内容都不应提交。
- `bypassPermissions` 会给 Agent 较宽的文件与工具权限，只应在可信的单用户环境中使用。

## 常见问题

- **AI 面板无法连接：**确认 `claude-chat` 已启动、`PORT` 与 `NEXT_PUBLIC_CLAUDE_CHAT_PORT` 一致，并让反向代理保留 WebSocket Upgrade 请求头。
- **远程站点始终返回 401：**设置非空的 `NOTES_BASIC_AUTH_PASSWORD`，重新构建/重启，并使用配置的用户名。
- **Git 拉取或推送失败：**确认 vault 本身配置了远程仓库，并且服务用户拥有无需交互的 SSH 或 token 权限。
- **生产构建不存在：**先执行 `npm run build` 再执行 `npm start`，并确认进程工作目录是仓库根目录。

## 开源协议

[GNU Affero General Public License v3.0](./LICENSE)

## 联系方式

- 邮箱：jiangjiren@hotmail.com
- 微信：jiangjiren
