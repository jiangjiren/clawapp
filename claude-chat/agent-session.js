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

export function isTerminalTaskLifecycleEvent(event) {
  if (!isTaskLifecycleEvent(event)) return false;
  if (event.subtype === "task_notification") return true;
  const status = String(event.patch?.status ?? event.status ?? "").toLowerCase();
  return event.subtype === "task_updated"
    && ["completed", "failed", "killed", "cancelled", "canceled"].includes(status);
}

export function updateTaskRegistry(taskIds, event) {
  if (!isTaskLifecycleEvent(event) || !event.task_id) return false;
  const before = taskIds.has(event.task_id);
  if (isTerminalTaskLifecycleEvent(event)) {
    taskIds.delete(event.task_id);
  } else {
    taskIds.add(event.task_id);
  }
  return before !== taskIds.has(event.task_id);
}

// A foreground result can become idle while background Tasks are still running.
// The Claude SDK later wakes the parent Agent automatically so it can summarize
// those Tasks. Keep the foreground transport open across both idle states.
export class BackgroundTaskTurnGate {
  constructor({
    wakeGraceMs = 5_000,
    schedule = (callback, delay) => setTimeout(callback, delay),
    cancel = timer => clearTimeout(timer),
  } = {}) {
    this.wakeGraceMs = wakeGraceMs;
    this.schedule = schedule;
    this.cancel = cancel;
    this.wakePending = false;
    this.timer = null;
    this.finish = null;
  }

  clearWakePending() {
    if (this.timer !== null) this.cancel(this.timer);
    this.timer = null;
    this.wakePending = false;
    this.finish = null;
  }

  markForegroundStart() {
    this.clearWakePending();
  }

  reset() {
    this.clearWakePending();
  }

  handle(event, { taskCount = 0, finish } = {}) {
    const sessionState = event?.type === "system"
      && event.subtype === "session_state_changed"
      ? event.state
      : null;

    if (isTerminalTaskLifecycleEvent(event) && taskCount === 0) {
      this.clearWakePending();
      this.wakePending = true;
      this.finish = finish;
      this.timer = this.schedule(() => {
        this.timer = null;
        if (!this.wakePending) return;
        const finishTurn = this.finish;
        this.wakePending = false;
        this.finish = null;
        finishTurn?.();
      }, this.wakeGraceMs);
      this.timer?.unref?.();
    }

    // session_state_changed/running is the canonical auto-wake signal. The
    // parent-only event fallback also covers SDK versions that omit that frame.
    const parentOutputStarted = !event?.parent_tool_use_id
      && ["user", "assistant", "stream_event"].includes(event?.type);
    if (this.wakePending && ((sessionState && sessionState !== "idle") || parentOutputStarted)) {
      this.clearWakePending();
    }

    if (sessionState !== "idle") return false;
    return taskCount === 0 && !this.wakePending;
  }
}

export class PersistentQueryRuntime {
  constructor({ queryFactory, onEvent, onError, onClose, onCallbackError } = {}) {
    if (typeof queryFactory !== "function") throw new TypeError("queryFactory is required");
    this.queryFactory = queryFactory;
    this.onEvent = onEvent ?? (() => {});
    this.onError = onError ?? (() => {});
    this.onClose = onClose ?? (() => {});
    this.onCallbackError = onCallbackError ?? (() => {});
    this.query = null;
    this.input = null;
    this.pumpPromise = null;
    this.foregroundRunning = false;
    this.taskIds = new Set();
    this.generation = 0;
  }

  start(options) {
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
    this.pumpPromise = this.pump(activeQuery, input, generation);
    return activeQuery;
  }

  send(message) {
    if (!this.query || !this.input) throw new Error("Persistent query is not started");
    this.foregroundRunning = true;
    this.input.push(message);
  }

  async interrupt() {
    if (!this.query || (!this.foregroundRunning && this.taskIds.size === 0)) return false;
    await this.query.interrupt();
    return true;
  }

  close() {
    const activeQuery = this.query;
    const input = this.input;
    this.query = null;
    this.generation += 1;
    this.input = null;
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
