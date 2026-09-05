# inkfellow

English | [中文](./README.zh-CN.md)

inkfellow turns a folder of Markdown notes into a self-hosted, local-first knowledge workspace. Read and edit the vault from a browser or installed PWA, keep it under Git, share individual notes, and work with an AI agent that can use the vault as its working context.

The repository contains two cooperating services:

| Surface | Best for | Implementation |
| --- | --- | --- |
| Web app / PWA | Self-hosting, phones, tablets, and remote access | Next.js 16 + React 19 |
| AI service | Streaming agent chat, provider switching, history, schedules, and WeChat connection | Node.js + WebSocket + Claude Agent SDK + Codex SDK |

## Current Features

- Browse, search, create, import, rename, edit, and delete notes and folders.
- Render GFM Markdown, front matter, tables of contents, Mermaid diagrams, local images, Wiki links, backlinks, and mentions.
- Read and edit `.md`, `.html`, and `.htm` files; preview PDF and common image formats read-only.
- Keep edits under Git: inspect status and diffs, view history, pull, commit and push, or discard a selected change.
- Generate revocable public links for individual notes under `/share/<token>`.
- Install the web app as a PWA; the UI shell is cached for faster reopening.
- Open a resizable AI panel beside the active note. Selected text and the current note can be passed into the conversation.
- Focus on chat in desktop browsers: use the expand button or `Ctrl/⌘ + \` to hide the note preview and restore your reading position when leaving focus mode.
- Keep a separate account, model, and reasoning effort for each conversation in the current browser. New conversations inherit the current selection.
- Switch between Claude subscription login, Codex/ChatGPT login, Anthropic, DeepSeek, OpenRouter, MiniMax, and custom Anthropic-compatible endpoints.
- Preserve chat history, choose models and permission modes, create one-off or cron schedules, and optionally connect a WeChat bot.
- Use responsive layouts designed for desktop and mobile screens.

## How the Pieces Fit Together

```text
Browser / installed PWA
        |
        v
Next.js app :3000  ---- reads/writes ----> VAULT_PATH
        |
        +---- /notes-claude/* -----------> claude-chat :8082
        |
        +---- /share/<token> ------------> public read-only note
```

Next.js already rewrites `/notes-claude/*` to the AI service, so the panel works through `http://localhost:3000` during local development. The production Nginx example proxies that path directly to port 8082 to handle long-lived WebSocket traffic explicitly.

## Requirements

For the web app and AI service:

- Node.js 20.9 or newer
- npm
- A notes folder; an Obsidian vault works well
- Git only if you want sync and version-history features

## Quick Start: Web App

```bash
git clone https://github.com/jiangjiren/inkfellow.git
cd inkfellow
npm ci
cp .env.example .env.local
```

On PowerShell, use `Copy-Item .env.example .env.local` instead of `cp`.

Edit `.env.local`:

```dotenv
NEXT_PUBLIC_APP_NAME=inkfellow
VAULT_PATH=/absolute/path/to/your/vault
SITE_URL=http://localhost:3000

# Required when the site is accessed through a non-local hostname.
NOTES_BASIC_AUTH_USERNAME=notes
NOTES_BASIC_AUTH_PASSWORD=replace-with-a-strong-password
```

Then start development:

```bash
npm run dev
```

Open <http://localhost:3000>. Requests whose host is `localhost` or `127.0.0.1` bypass Basic Auth; remote access does not. An empty remote password deliberately denies access.

The repository includes a sample `vault/`. If `VAULT_PATH` is omitted, that folder is used. On Linux, `bash scripts/setup-vault.sh` can create a working vault, a bare Git remote, seed the sample notes, and write `VAULT_PATH` to `.env.local`.

## Enable the AI Panel

Run the AI service as a second process:

```bash
cd claude-chat
npm ci
cp .env.example .env
npm start
```

Set `VAULT_PATH` in `claude-chat/.env` to the same folder used by the web app. The default listener is `127.0.0.1:8082`.

Authentication options:

| Provider | Setup |
| --- | --- |
| Claude subscription | Install Claude Code, log in under the same OS user that runs `claude-chat`, then verify with `claude auth status`. |
| Codex / ChatGPT subscription | Log in through Codex or run `codex login` under the service user. The service detects `~/.codex/auth.json`. |
| Anthropic, DeepSeek, OpenRouter, MiniMax | Add an account and API key in the AI panel settings. |
| Custom | Add an API key, base URL, and model mapping for an Anthropic-compatible endpoint. |

The service user and `HOME` matter: subscription credentials must be visible to the process. API keys and provider profiles are stored locally and must not be committed.

See [claude-chat/README.md](./claude-chat/README.md) for provider behavior, data files, schedules, WeChat, REST endpoints, and security details.

## Environment Variables

### Web app

| Variable | Default | Purpose |
| --- | --- | --- |
| `NEXT_PUBLIC_APP_NAME` | `inkfellow` | Name shown in the UI, page titles, and auth realm. |
| `VAULT_PATH` | `./vault` | Absolute or process-relative path to the notes vault. |
| `SITE_URL` | `http://localhost:3000` | Public origin used when creating share links. |
| `SHARED_NOTES_PATH` | `./shared-notes.json` | Share-token database. |
| `NOTES_BASIC_AUTH_USERNAME` | `notes` | Username for remote web and notes API access. |
| `NOTES_BASIC_AUTH_PASSWORD` | empty | Remote access is denied while empty. |
| `NEXT_PUBLIC_CLAUDE_CHAT_PORT` | `8082` | Port used by the Next rewrite and AI panel. |
| `NOTES_GIT_PUSH_TARGET` | `HEAD:main` | Refspec used by the web Git push action. |
| `GIT_COMMIT_USER_NAME` | `Inkfellow Web` | Git author name used for web commits. |
| `GIT_COMMIT_USER_EMAIL` | `web-editor@inkfellow.local` | Git author email used for web commits. |
| `NEXT_PUBLIC_CF_WEB_ANALYTICS_TOKEN` | empty | Enables Cloudflare Web Analytics when set. |
| `DISABLE_PWA` | unset | Set to `1` to disable PWA generation in production. |

`NOTES_BASIC_AUTH_USER` and `NOTES_PASSWORD` remain accepted as legacy aliases, but new installations should use the canonical names above.

### AI service

The most common settings are `HOST`, `PORT`, `VAULT_PATH`, `CLAUDE_PERMISSION_MODE`, and `CLAUDE_CHAT_DATA_DIR`. The complete table is in [claude-chat/README.md](./claude-chat/README.md#configuration).

## Git Sync

Git features operate on `VAULT_PATH`, not on the inkfellow source repository.

Web sync and nightly sync check for unresolved merge conflicts after pulling. If conflicts remain, syncing stops and preserves local changes and the conflict state without committing or pushing them. Resolve the conflicts before retrying. Nightly sync also stops if the pull fails.

1. Initialize the vault and make an initial commit.
2. Add a remote if you want pull and push.
3. Make sure the OS user running inkfellow can access the remote without an interactive password prompt.

Example using a private remote:

```bash
cd /path/to/vault
git init
git add .
git -c user.name="Vault Setup" -c user.email="setup@localhost" commit -m "Initial notes"
git branch -M main
git remote add origin <your-private-remote>
git push -u origin main
```

The web Git panel shows uncommitted changes, diffs, history, upstream ahead/behind state, and sync actions. `scripts/nightly-sync.js` can also pull, create a concise commit message, commit, and push from cron.

## Production Deployment

Build both Node projects first:

```bash
npm ci
npm run build

cd claude-chat
npm ci
cd ..
```

The repository provides:

- `deploy/notes-app.service.example` for the Next.js process
- `deploy/claude-chat.service.example` for the AI service
- `deploy/nginx.conf.example` for HTTPS, WebSocket proxying, upload limits, and optional extra auth on the AI route
- `ecosystem.config.cjs` as a PM2 alternative

Before enabling the examples, replace every placeholder and make both services use the same vault. Run the AI service as the same Unix user that owns the Claude/Codex subscription credentials. Keep `claude-chat` bound to loopback and expose it only through Next.js or a trusted reverse proxy.

For multiple users, run one isolated web process and one isolated AI process per vault, with unique ports, credentials, share-token files, and AI data directories. The repository does not provide multi-tenant authorization inside a single process.

### Vercel demo

The bundled `vault/` makes a read-only-style demo deployment possible:

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https://github.com/jiangjiren/inkfellow)

Serverless filesystems and long-lived WebSockets are not a replacement for a persistent inkfellow server. Use a VPS for editing, Git sync, durable share state, and the AI service.

## PWA Installation

- Chrome or Edge on desktop: use the install icon in the address bar.
- Android Chrome: choose **Install app** or **Add to Home screen**.
- iOS Safari: choose **Share → Add to Home Screen**.

PWA caching covers the application shell. The vault and AI service still come from your running server; it is not a full offline copy of all notes.

## Useful Commands

| Command | Purpose |
| --- | --- |
| `npm run dev` | Start Next.js development mode. |
| `npm run build` | Create the production standalone build. |
| `npm start` | Start the production web app. |
| `npm run typecheck` | Run TypeScript without emitting files. |
| `npm run lint` | Run ESLint. |
| `node scripts/create-share-link.mjs "path/to/note.md"` | Create or reuse a public share token. |
| `node scripts/nightly-sync.js /path/to/vault` | Run one automated Git sync cycle. |
| `bash scripts/update_app.sh` | Pull, install, build, and restart the systemd web service. |
| `bash scripts/deploy.sh` | Rebuild and restart the PM2 deployment described by `ecosystem.config.cjs`. |

`scripts/deploy.sh` stops every PM2 app and terminates listeners it finds on ports 3000/3001 before rebuilding. Use it only on a host dedicated to this deployment, or adapt it to target named processes.

## Repository Layout

```text
src/app/             Next.js UI and API routes
src/lib/             vault, share, and note helpers
src/proxy.ts         remote Basic Auth gate
claude-chat/         AI panel and Node/WebSocket service
deploy/              systemd and Nginx examples
scripts/             setup, share, sync, and deployment helpers
vault/               sample notes
```

## Security Notes

- Remote `/` and `/api/notes/*` access is protected by Basic Auth. Localhost is intentionally exempt for local use.
- `/share/<token>` is public to anyone who knows the token; revoke links that should no longer work.
- The standalone AI service has no general-purpose login layer. Bind it to `127.0.0.1` and place authentication at Next.js/Nginx.
- Vault path resolution rejects traversal outside the configured vault and excludes internal/tooling directories from note discovery.
- Provider profiles, OAuth credentials, chat history, share tokens, `.env*`, `.next`, `node_modules`, and vault content should not be committed.
- `bypassPermissions` gives the agent broad filesystem/tool access inside the allowed working directory. Use it only for a trusted single-user deployment.

## Troubleshooting

- **AI panel does not connect:** start `claude-chat`, confirm its `PORT` matches `NEXT_PUBLIC_CLAUDE_CHAT_PORT`, and preserve WebSocket upgrade headers in the reverse proxy.
- **Remote site always returns 401:** set a non-empty `NOTES_BASIC_AUTH_PASSWORD`, rebuild/restart, and use the configured username.
- **Git pull or push fails:** verify the vault itself has a remote and that the service user has non-interactive SSH or token access.
- **Production build is missing:** run `npm run build` before `npm start`, and make sure the process working directory is the repository root.

## License

[GNU Affero General Public License v3.0](./LICENSE)

## Contact

- Email: jiangjiren@hotmail.com
- WeChat: jiangjiren
