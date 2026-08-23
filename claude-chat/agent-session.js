import { randomUUID } from "node:crypto";

export class AsyncMessageQueue {
  constructor() {
    this.items = [];
    this.waiters = [];
    this.closed = false;
    this.failure = null;
  }

  push(value) {
    if (this.closed) throw new Error("Cannot push to a closed async message queue");
    const waiter = this.waiters.shift();
    if (waiter) waiter.resolve({ value, done: false });
    else this.items.push(value);
  }

  close(error = null) {
    if (this.closed) return;
    this.closed = true;
    this.failure = error;
    const waiters = this.waiters.splice(0);
    for (const waiter of waiters) {
      if (error) waiter.reject(error);
      else waiter.resolve({ value: undefined, done: true });
    }
  }

  next() {
    if (this.items.length > 0) {
      return Promise.resolve({ value: this.items.shift(), done: false });
    }
    if (this.failure) return Promise.reject(this.failure);
    if (this.closed) return Promise.resolve({ value: undefined, done: true });
    return new Promise((resolve, reject) => this.waiters.push({ resolve, reject }));
  }

  return() {
    this.close();
    return Promise.resolve({ value: undefined, done: true });
  }

  [Symbol.asyncIterator]() {
    return this;
  }
}

export function isTaskLifecycleEvent(event) {
  return event?.type === "system" && [
    "task_started",
    "task_progress",
    "task_updated",
    "task_notification",
  ].includes(event.subtype);
}

export function updateTaskRegistry(taskIds, event) {
  if (!isTaskLifecycleEvent(event) || !event.task_id) return false;
  const before = taskIds.has(event.task_id);
  const terminalUpdate = event.subtype === "task_updated"
    && ["completed", "failed", "killed"].includes(event.patch?.status);
  if (event.subtype === "task_notification" || terminalUpdate) {
    taskIds.delete(event.task_id);
  } else {
    taskIds.add(event.task_id);
  }
  return before !== taskIds.has(event.task_id);
}

export class SteeringQueue {
  constructor() {
    this.items = [];
  }

  get length() {
    return this.items.length;
  }

  enqueue(item) {
    const userMessageId = String(item?.userMessageId ?? "").trim();
    const ownerToken = String(item?.ownerToken ?? "").trim();
    if (!userMessageId) throw new TypeError("userMessageId is required");
    if (!ownerToken) throw new TypeError("ownerToken is required");
    const existing = this.items.find(entry => entry.userMessageId === userMessageId);
    if (existing) return { item: existing, inserted: false };
    const queued = {
      ...item,
      userMessageId,
      ownerToken,
      paused: item.paused === true,
      state: "queued",
      claimToken: null,
    };
    this.items.push(queued);
    return { item: queued, inserted: true };
  }

  get(userMessageId) {
    const id = String(userMessageId ?? "").trim();
    return this.items.find(item => item.userMessageId === id) ?? null;
  }

  snapshot(ownerToken = null) {
    const items = ownerToken == null
      ? this.items
      : this.items.filter(item => item.ownerToken === ownerToken);
    return items.map(item => ({ ...item }));
  }

  update(userMessageId, patch, ownerToken = null) {
    const item = this.get(userMessageId);
    if (!item || item.state !== "queued") return null;
    if (ownerToken != null && item.ownerToken !== ownerToken) return null;
    const originalOwnerToken = item.ownerToken;
    Object.assign(item, patch);
    item.userMessageId = String(userMessageId).trim();
    item.ownerToken = originalOwnerToken;
    item.state = "queued";
    item.claimToken = null;
    return item;
  }

  remove(userMessageId, ownerToken = null) {
    const id = String(userMessageId ?? "").trim();
    const index = this.items.findIndex(item => (
      item.userMessageId === id
      && item.state === "queued"
      && (ownerToken == null || item.ownerToken === ownerToken)
    ));
    if (index < 0) return null;
    return this.items.splice(index, 1)[0];
  }

  removeOwner(ownerToken) {
    const removed = [];
    this.items = this.items.filter(item => {
      if (item.ownerToken !== ownerToken) return true;
      removed.push(item);
      return false;
    });
    return removed;
  }

  /**
   * 移除某个对话排着的全部插话，不论处在哪个状态。
   *
   * ownerToken 是「哪一轮」，跟对话不是一回事：同一个对话的两轮是两个 token。
   * /clear 要清的是这个对话的全部，按对话清才既不漏自己的、也不碰别人的。
   */
  removeConversation(conversationId) {
    const id = String(conversationId ?? "").trim();
    if (!id) return [];
    const removed = [];
    this.items = this.items.filter(item => {
      if (item.conversationId !== id) return true;
      removed.push(item);
      return false;
    });
    return removed;
  }

  reorder(ownerToken, orderedIds) {
    if (!ownerToken || !Array.isArray(orderedIds)) return false;
    const owned = this.items.filter(item => item.ownerToken === ownerToken && item.state === "queued");
    if (owned.length === 0) return false;
    const byId = new Map(owned.map(item => [item.userMessageId, item]));
    const seen = new Set();
    const reordered = [];
    for (const rawId of orderedIds) {
      const id = String(rawId ?? "").trim();
      const item = byId.get(id);
      if (!item || seen.has(id)) continue;
      seen.add(id);
      reordered.push(item);
    }
    for (const item of owned) {
      if (!seen.has(item.userMessageId)) reordered.push(item);
    }
    let cursor = 0;
    this.items = this.items.map(item => (
      item.ownerToken === ownerToken && item.state === "queued"
        ? reordered[cursor++]
        : item
    ));
    return true;
  }

  pauseOwner(ownerToken) {
    const paused = [];
    for (const item of this.items) {
      if (item.ownerToken !== ownerToken || item.state !== "queued" || item.paused) continue;
      item.paused = true;
      paused.push(item);
    }
    return paused;
  }

  resumeOwner(ownerToken) {
    const resumed = [];
    for (const item of this.items) {
      if (item.ownerToken !== ownerToken || item.state !== "queued" || !item.paused) continue;
      item.paused = false;
      resumed.push(item);
    }
    return resumed;
  }

  claimNext(ownerToken, predicate = null) {
    const item = this.items.find(entry => (
      entry.ownerToken === ownerToken
      && entry.state === "queued"
      && !entry.paused
      && (typeof predicate !== "function" || predicate(entry))
    ));
    if (!item) return null;
    item.state = "claimed";
    item.claimToken = randomUUID();
    return { item, claimToken: item.claimToken };
  }

  commitClaim(userMessageId, claimToken) {
    const index = this.items.findIndex(item => (
      item.userMessageId === userMessageId
      && item.state === "claimed"
      && item.claimToken === claimToken
    ));
    if (index < 0) return null;
    return this.items.splice(index, 1)[0];
  }

  releaseClaim(userMessageId, claimToken, { paused = false } = {}) {
    const item = this.items.find(entry => (
      entry.userMessageId === userMessageId
      && entry.state === "claimed"
      && entry.claimToken === claimToken
    ));
    if (!item) return null;
    item.state = "queued";
    item.claimToken = null;
    item.paused = paused;
    return item;
  }

  hasUnpaused(ownerToken = null) {
    return this.items.some(item => (
      item.state === "queued"
      && !item.paused
      && (ownerToken == null || item.ownerToken === ownerToken)
    ));
  }
}

export class PersistentQueryRuntime {
  constructor({ queryFactory, onEvent, onError, onClose, onCallbackError, contextStore = null } = {}) {
    if (typeof queryFactory !== "function") throw new TypeError("queryFactory is required");
    this.queryFactory = queryFactory;
    this.onEvent = onEvent ?? (() => {});
    this.onError = onError ?? (() => {});
    this.onClose = onClose ?? (() => {});
    this.onCallbackError = onCallbackError ?? (() => {});
    // AsyncLocalStorage（或任何同形状的东西）。给了就把 start() 的 context
    // 绑到事件泵上，没给就退回原来的行为。
    this.contextStore = contextStore;
    this.context = null;
    this.query = null;
    this.input = null;
    this.pumpPromise = null;
    this.foregroundRunning = false;
    this.taskIds = new Set();
    this.generation = 0;
  }

  /**
   * 起一轮持久 query。
   *
   * context 会被绑在这个 runtime 的事件泵上：pump 里 await 出来的每个事件、
   * 以及它触发的每个回调，都能通过 contextStore.getStore() 读到它——包括
   * 异步子任务那些隔了几秒才回来的事件。
   *
   * 这是为了替掉「事件发出时回头猜它属于谁」那套做法。猜的代价是两套
   * owner 追踪 Map 加两套 TTL 定时器，而且一旦同时有多个会话在跑必然猜错。
   */
  start(options, context = null) {
    if (this.query) throw new Error("Persistent query is already started");
    const input = new AsyncMessageQueue();
    let activeQuery;
    try {
      activeQuery = this.queryFactory({ prompt: input, options });
    } catch (error) {
      input.close(error);
      throw error;
    }
    const generation = ++this.generation;
    this.input = input;
    this.query = activeQuery;
    this.context = context;
    const runPump = () => this.pump(activeQuery, input, generation);
    this.pumpPromise = this.contextStore && context
      ? this.contextStore.run(context, runPump)
      : runPump();
    return activeQuery;
  }

  send(message) {
    if (!this.query || !this.input) throw new Error("Persistent query is not started");
    this.foregroundRunning = true;
    this.input.push(message);
  }

  async interrupt() {
    if (!this.query || !this.foregroundRunning) return false;
    await this.query.interrupt();
    return true;
  }

  close() {
    const activeQuery = this.query;
    const input = this.input;
    this.query = null;
    this.generation += 1;
    this.input = null;
    this.context = null;
    this.pumpPromise = null;
    this.foregroundRunning = false;
    this.taskIds.clear();
    input?.close();
    activeQuery?.close();
  }

  get started() {
    return this.query !== null;
  }

  get running() {
    return this.foregroundRunning || this.taskIds.size > 0;
  }

  async reportCallbackError(error, source, event = null) {
    try {
      await this.onCallbackError(error, { source, event }, this);
    } catch {
      // UI/logging callbacks must never be able to terminate the SDK iterator.
    }
  }

  async pump(activeQuery, input, generation) {
    let failure = null;
    try {
      for await (const event of activeQuery) {
        if (this.query !== activeQuery || this.generation !== generation) break;
        updateTaskRegistry(this.taskIds, event);
        if (event?.type === "system" && event.subtype === "session_state_changed") {
          this.foregroundRunning = event.state !== "idle";
        }
        try {
          await this.onEvent(event, this);
        } catch (error) {
          await this.reportCallbackError(error, "event", event);
        }
      }
    } catch (error) {
      failure = error;
      if (this.query === activeQuery && this.generation === generation) {
        try {
          await this.onError(error, this);
        } catch (callbackError) {
          await this.reportCallbackError(callbackError, "error");
        }
      }
    } finally {
      input.close();
      if (this.query === activeQuery && this.generation === generation) {
        this.query = null;
        this.input = null;
        this.pumpPromise = null;
        this.foregroundRunning = false;
        this.taskIds.clear();
        try {
          await this.onClose({ error: failure }, this);
        } catch (callbackError) {
          await this.reportCallbackError(callbackError, "close");
        }
      }
    }
  }
}
