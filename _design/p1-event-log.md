# P1：事件日志 + 游标同步（设计契约）

> 目标不变量：**消息一旦发出，这一轮就一定跑完并留下完整记录。客户端在不在、连不连得上、刷不刷新，都不影响。**

本文是 P1 的唯一契约。`core/event-log.js`、`scripts/migrate-history.mjs`、`server.js`、
`public/index.html` 四处改动必须严格按本文的接口和协议实现，任何偏离先改本文。

---

## 0. P1 的边界

**做：**
- 每会话 append-only 事件日志（NDJSON），取代 `history-<PORT>.json` 全量重写
- 事件带单调递增 `seq`
- `hello / sync` 游标协议，取代 `resumeRun / run_not_found`
- 一次性迁移脚本
- P0 止血（断线不再 abort、补 `ws.on("error")`、客户端 120s 静默检测）

**不做（留给 P2/P3）：**
- turn-manager / event-bus 抽象
- 微信、定时任务投递链路的统一
- server.js / index.html 的模块拆分
- 前端投影渲染重构（P1 仍沿用现有渲染，只是数据来源变了）

**硬性兼容要求：** REST `/api/history`、`/api/history/:id`（GET/PUT/DELETE）的
出入参 JSON 形状**完全不变**。前端历史面板、`saveCurrentConversation()`
无需改动即可继续工作。这是本次迁移可以安全落地的前提。

---

## 1. 存储布局

```
data/
  conversations/
    <PORT>/             同一部署目录的多实例隔离边界
      <convId>/
        events.ndjson   append-only，一行一个事件
        meta.json       小文件，会话元信息 + lastSeq
  history-<PORT>.json   迁移后保留为只读回滚源，不再写入
  history-<PORT>.json.pre-p1.bak  完整遍历迁移后复制出的原始备份
```

`convId` 复用现有 `normalizeHistoryId()` 的结果，正则 `^[A-Za-z0-9_-]{4,128}$`，
可直接作目录名。**不匹配的一律拒绝**，防目录穿越。

### events.ndjson 每行

```jsonc
{"seq":1,"ts":1780000000000,"kind":"user","payload":{...}}
{"seq":2,"ts":1780000000123,"kind":"sdk","payload":{...原始 SDK 事件...}}
{"seq":3,"ts":1780000004567,"kind":"turn","payload":{"turnId":"...","status":"running","requestId":"..."}}
```

- `seq`：该会话内单调递增，从 1 开始，**不复用、不回退**
- `ts`：`Date.now()`
- `kind`：`"user"` | `"sdk"` | `"turn"`
  - `user`：用户发出的消息，`payload = {id, text, images?}`
  - `sdk`：Agent SDK / Codex 原样事件（现在 `persistRunEvent` 处理的那些）
  - `turn`：轮次状态变更，`payload = {turnId, status, requestId, cost?, error?}`
    - `status` ∈ `running` | `complete` | `error` | `stopped` | `continued`

### meta.json

```jsonc
{
  "id": "ms4cqgp5a9ocn",
  "title": "在详细搜索行业标杆…",
  "date": "2026-07-28T09:16:38.357Z",
  "sessionId": "ecf38bc2-…",
  "sessionProvider": "claude",
  "profileId": "…",
  "lastSeq": 1043,
  "messageCount": 8,
  "turn": { "turnId": "…", "status": "running", "requestId": "…" }
}
```

`turn` 是**当前/最后一轮**的状态快照，重连时服务端据此告诉客户端"还在跑吗"。
没有轮次时为 `null`。

---

## 2. `core/event-log.js` 接口

全部同步实现（单进程、单用户，`appendFileSync` 足够，避免引入异步竞态）。

```js
// 追加一个事件；返回写入后的 {seq, ts}
appendEvent(convId, kind, payload) -> { seq, ts }

// 批量追加，单次 I/O，返回 [{seq, ts}, ...]
appendEvents(convId, entries) -> Array<{seq, ts}>   // entries: [{kind, payload}, ...]

// 读取 seq > sinceSeq 的事件
// limit 默认 2000；超出则 truncated:true，调用方应改走快照重置
readEventsSince(convId, sinceSeq, { limit } = {}) -> { events, lastSeq, truncated }

// 元信息，会话不存在返回 null
getMeta(convId) -> meta | null

// 浅合并 patch 到 meta 并落盘（lastSeq 由 appendEvent 自己维护，patch 不得覆盖）
updateMeta(convId, patch) -> meta

// 确保会话存在（不存在则建目录 + 初始 meta）
ensureConversation(convId, { title } = {}) -> meta

// 把日志投影成"今天 history.json 里那种 conversation 对象"
project(convId) -> conversation | null

// 列表摘要，按 date 倒序
listConversations() -> Array<{ id, title, date, messageCount }>

deleteConversation(convId) -> boolean

// 用一个完整 conversation 对象覆盖会话（供 PUT /api/history/:id 兼容路径用）
replaceFromConversation(conversation) -> meta
```

### 实现要求

1. **崩溃容错**：读取时若最后一行不是完整 JSON，**跳过并忽略**，不得抛异常。
   `lastSeq` 以实际解析成功的最大 seq 为准。
2. **meta 内存缓存**：`getMeta` 走内存 Map，避免每次读盘。进程启动不预扫全部会话，
   按需 lazy load。
3. **projection 缓存**：LRU，最多 8 个会话，key 带 `lastSeq`，日志追加即失效。
4. **`project()` 的输出形状必须与今天 `history.json` 里的 conversation 完全一致**：
   ```js
   { id, title, date, sessionId, sessionProvider, profileId,
     messages: [ { id, role, text, blocks, raw, events, cost, status, createdAt, updatedAt } ] }
   ```
   投影规则直接复刻 `server.js` 现有的 `appendRunHistoryBlocks` /
   `normalizeAssistantHistoryBlocks` / `finalizeRunHistory` 三个函数的行为——
   **把它们从 server.js 搬进 event-log.js 并以日志为输入重写，不要另起炉灶。**
   验收标准：拿迁移后的数据跑 `project()`，结果应与原 history.json 里对应会话
   在 `role/text/blocks.length/cost/status` 上逐条一致。
5. **不得把全部会话常驻内存。** 当前 30MB 全量常驻是本次要消灭的问题之一。

---

## 3. 线路协议

### 3.1 客户端 → 服务端

```jsonc
// 连接建立后立刻发，取代原来的 resumeRun
{ "type": "hello", "conversationId": "ms4…" | null, "lastSeq": 1043 }
```

`conversationId` 为 null（新会话尚未产生 id）时，服务端回一个空 sync。

### 3.2 服务端 → 客户端

```jsonc
// 正常增量补齐
{ "type": "sync", "conversationId": "ms4…", "lastSeq": 1097,
  "turn": { "turnId": "…", "status": "running", "requestId": "…" } | null,
  "events": [ {seq, ts, kind, payload}, … ] }

// 落后太多（truncated）或客户端 lastSeq 超前（服务端数据被重置过）
{ "type": "sync", "conversationId": "ms4…", "lastSeq": 20481,
  "turn": {...} | null,
  "reset": true,
  "snapshot": { …project(convId) 的完整 conversation… } }
```

### 3.3 实时推流

所有属于某会话的出站事件，在原有字段基础上**额外**带上：

```jsonc
{ "…原有字段…", "conversationId": "ms4…", "seq": 1098 }
```

客户端据 `seq` 更新游标。**`seq` 必须先落盘再发送**，保证"客户端看到的 seq 一定已持久化"。

### 3.4 兼容期

P1 期间 `resumeRun` / `run_not_found` **保留不删**，作为老页面（浏览器缓存了旧
index.html）的降级路径。新客户端不再发 `resumeRun`。P2 再删。

---

## 4. server.js 改动清单

| # | 位置 | 改动 |
|---|---|---|
| 1 | `readHistory/writeHistory/historyStore`（L807-840） | 保留函数名作为兼容垫片，内部改调 event-log；不再全量重写 |
| 2 | `persistRunEvent`（L1042） | 改为 `appendEvent(convId, "sdk", event)`，投影逻辑移入 event-log |
| 3 | `beginRunHistory`（L957） | 改为写 `user` + `turn(running)` 两条日志 |
| 4 | `finalizeRunHistory`（L1031） | 改为写 `turn(<status>)` 一条日志 |
| 5 | `run.send`（L2925） | 落盘拿到 seq 后再发，事件补 `conversationId` + `seq` |
| 6 | `detach()`（L2936-2953） | **不再 `ac.abort()`**；`RUN_GRACE_MS` 90s → 30min，到期只清 buffer |
| 7 | `wss.on("connection")`（L2998） | 处理 `hello`，回 `sync` |
| 8 | `wss.on("connection")` | 补 `ws.on("error", …)` |
| 9 | REST `/api/history*`（L2469, L2641） | 改走 `listConversations` / `project` / `replaceFromConversation` |

---

## 5. index.html 改动清单

| # | 位置 | 改动 |
|---|---|---|
| 1 | `connect().onopen`（L3946） | 发 `hello{conversationId, lastSeq}`，不再发 `resumeRun` |
| 2 | 新增 | 处理 `sync`：增量事件依次喂给 `handleEvent`；`reset:true` 时用 snapshot 重渲染 |
| 3 | `handleEvent`（L4929） | 收到带 `seq` 的事件即更新游标并写 `sessionStorage` |
| 4 | 游标持久化 | `sessionStorage["chat.cursor"] = {conversationId, lastSeq}`，**刷新后仍在** |
| 5 | 心跳（L3985-4003） | 删掉 ping/pong 往返，改 120s 静默检测（照抄 desktop-lite `CLIENT_STALL_MS`） |
| 6 | 重连（L3938） | 独立兜底定时器，不再只靠 `onclose`；对 CLOSING/CLOSED 也能触发 |
| 7 | `run_not_found`（L4995） | 保留但降级：不再报红字，改为发 `hello` 重新同步 |

---

## 6. 迁移脚本 `scripts/migrate-history.mjs`

```
node scripts/migrate-history.mjs --port 8082 [--dry-run] [--verify]
```

1. 读 `data/history-<PORT>.json`
2. 每个 conversation 建 `data/conversations/<PORT>/<id>/`
3. 把 `messages[]` 反向拆成事件序列写入 `events.ndjson`：
   - `role:"user"` → 一条 `kind:"user"`
   - `role:"assistant"` → 其 `events[]`（原始 SDK 事件）逐条 `kind:"sdk"`；
     若 `events[]` 缺失，用 `blocks[]` 合成一条 `kind:"sdk"` 的 assistant 事件兜底
   - 每条 assistant 消息末尾补一条 `kind:"turn"`，status 取原 `message.status`
4. 写 `meta.json`
5. **原 history-<PORT>.json 不删不改**（可直接回滚旧版本），完整遍历后另复制
   `history-<PORT>.json.pre-p1.bak` 留档；已有备份不覆盖
6. `--verify`：对每个会话跑 `project()`，与原 conversation 逐条比对
   `role / text / blocks.length / cost / status`，输出差异报告，有差异则退出码非 0
7. `--dry-run`：在系统临时目录构造事件库并真实跑 `project()` 比对，不写源数据目录

**幂等**：重复执行不得产生重复事件（目标目录已存在且 meta.lastSeq > 0 时跳过，除非 `--force`）。

---

## 7. 验收标准

1. `node --test` 全绿（含新增的 event-log / migrate 测试）
2. `--verify` 迁移零差异
3. 手机锁屏 10 分钟回来，回答继续、内容完整，无红字
4. 生成过程中刷新页面，回答能接回来
5. 关掉浏览器，重开打开该会话，能看到完整内容
6. `data/conversations/<PORT>/<id>/events.ndjson` 单次追加写入 < 5ms（对比现在 ~125ms 全量重写）
7. 进程常驻内存不随历史总量增长
