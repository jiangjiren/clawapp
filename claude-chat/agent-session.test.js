import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import test from "node:test";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { AsyncMessageQueue, PersistentQueryRuntime, updateTaskRegistry } from "./agent-session.js";

const flush = () => new Promise(resolve => setImmediate(resolve));
const waitFor = async (predicate, timeoutMs = 2000) => {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for offline SDK probe");
    await flush();
  }
};

class FakeQuery {
  constructor(prompt) {
    this.events = new AsyncMessageQueue();
    this.received = [];
    this.interruptCalls = 0;
    this.closed = false;
    this.consumePromise = (async () => {
      for await (const message of prompt) this.received.push(message);
    })();
  }

  [Symbol.asyncIterator]() {
    return this.events;
  }

  async interrupt() {
    this.interruptCalls += 1;
  }

  close() {
    this.closed = true;
    this.events.close();
  }
}

test("AsyncMessageQueue accepts messages over time until explicitly closed", async () => {
  const queue = new AsyncMessageQueue();
  const first = queue.next();
  queue.push("one");
  assert.deepEqual(await first, { value: "one", done: false });
  queue.push("two");
  assert.deepEqual(await queue.next(), { value: "two", done: false });
  queue.close();
  assert.deepEqual(await queue.next(), { value: undefined, done: true });
});

test("task registry stays busy until a terminal lifecycle event", () => {
  const tasks = new Set();
  updateTaskRegistry(tasks, { type: "system", subtype: "task_started", task_id: "task-1" });
  assert.deepEqual([...tasks], ["task-1"]);
  updateTaskRegistry(tasks, { type: "system", subtype: "task_progress", task_id: "task-1" });
  assert.equal(tasks.size, 1);
  updateTaskRegistry(tasks, { type: "system", subtype: "task_updated", task_id: "task-1", patch: { status: "completed" } });
  assert.equal(tasks.size, 0, "a terminal task_updated frame clears the running registry");
  updateTaskRegistry(tasks, { type: "system", subtype: "task_started", task_id: "task-2" });
  assert.equal(tasks.size, 1);
  updateTaskRegistry(tasks, { type: "system", subtype: "task_notification", task_id: "task-2", status: "completed" });
  assert.equal(tasks.size, 0);
});

test("persistent runtime reuses one query across turns and preserves background tasks", async () => {
  const queries = [];
  const runtime = new PersistentQueryRuntime({
    queryFactory: ({ prompt }) => {
      const fake = new FakeQuery(prompt);
      queries.push(fake);
      return fake;
    },
  });

  runtime.start({});
  runtime.send({ type: "user", message: { role: "user", content: "first" } });
  await flush();
  queries[0].events.push({ type: "system", subtype: "task_started", task_id: "bg-1" });
  queries[0].events.push({ type: "system", subtype: "session_state_changed", state: "idle" });
  await flush();
  assert.equal(runtime.running, true, "background task keeps runtime busy after the turn becomes idle");

  runtime.send({ type: "user", message: { role: "user", content: "second" } });
  await flush();
  assert.equal(queries.length, 1, "the underlying query process is reused");
  assert.equal(queries[0].received.length, 2);

  queries[0].events.push({ type: "system", subtype: "task_notification", task_id: "bg-1", status: "completed" });
  queries[0].events.push({ type: "system", subtype: "session_state_changed", state: "idle" });
  await flush();
  assert.equal(runtime.running, false);
  runtime.close();
});

test("interrupt stops the foreground turn without closing the reusable query", async () => {
  let fake;
  const runtime = new PersistentQueryRuntime({
    queryFactory: ({ prompt }) => (fake = new FakeQuery(prompt)),
  });
  runtime.start({});
  runtime.send({ type: "user", message: { role: "user", content: "first" } });
  assert.equal(await runtime.interrupt(), true);
  assert.equal(fake.interruptCalls, 1);
  assert.equal(fake.closed, false);
  fake.events.push({ type: "system", subtype: "session_state_changed", state: "idle" });
  await flush();
  runtime.send({ type: "user", message: { role: "user", content: "second" } });
  await flush();
  assert.equal(fake.received.length, 2);
  runtime.close();
});

test("stale events from a closed query cannot enter a replacement query", async () => {
  const queries = [];
  const seen = [];
  const runtime = new PersistentQueryRuntime({
    queryFactory: ({ prompt }) => {
      const fake = new FakeQuery(prompt);
      queries.push(fake);
      return fake;
    },
    onEvent: event => seen.push(event.id),
  });
  runtime.start({ generation: 1 });
  queries[0].events.push({ id: "stale" });
  runtime.close();
  runtime.start({ generation: 2 });
  queries[1].events.push({ id: "current" });
  await flush();
  assert.deepEqual(seen, ["current"]);
  runtime.close();
});

test("an event callback failure does not stop the query event pump", async () => {
  let fake;
  const seen = [];
  const callbackErrors = [];
  const runtime = new PersistentQueryRuntime({
    queryFactory: ({ prompt }) => (fake = new FakeQuery(prompt)),
    onEvent: event => {
      seen.push(event.id);
      if (event.id === "first") throw new Error("renderer failed");
    },
    onCallbackError: error => callbackErrors.push(error.message),
  });
  runtime.start({});
  fake.events.push({ id: "first" });
  fake.events.push({ id: "second" });
  await flush();
  assert.deepEqual(seen, ["first", "second"]);
  assert.deepEqual(callbackErrors, ["renderer failed"]);
  assert.equal(runtime.started, true);
  runtime.close();
});

test("real SDK query keeps one CLI process open across AsyncIterable turns", async () => {
  const sessionId = "11111111-1111-4111-8111-111111111111";
  const emitter = new EventEmitter();
  const stdout = new PassThrough();
  const userTexts = [];
  let inputBuffer = "";
  let killed = false;
  let exitCode = null;
  let turn = 0;
  let eventSequence = 0;
  let spawnCount = 0;
  let idleCount = 0;

  const emit = event => stdout.write(`${JSON.stringify(event)}\n`);
  const nextUuid = () => `00000000-0000-4000-8000-${String(++eventSequence).padStart(12, "0")}`;
  const stdin = new Writable({
    write(chunk, _encoding, callback) {
      inputBuffer += chunk.toString();
      let newline;
      while ((newline = inputBuffer.indexOf("\n")) >= 0) {
        const line = inputBuffer.slice(0, newline);
        inputBuffer = inputBuffer.slice(newline + 1);
        if (!line.trim()) continue;
        const frame = JSON.parse(line);
        if (frame.type === "control_request") {
          emit({
            type: "control_response",
            response: {
              subtype: "success",
              request_id: frame.request_id,
              response: {},
            },
          });
          continue;
        }
        if (frame.type !== "user") continue;
        turn += 1;
        const content = frame.message?.content;
        userTexts.push(Array.isArray(content) ? content[0]?.text : content);
        emit({ type: "system", subtype: "session_state_changed", state: "running", uuid: nextUuid(), session_id: sessionId });
        if (turn === 1) {
          emit({ type: "system", subtype: "task_started", task_id: "bg-1", description: "offline", uuid: nextUuid(), session_id: sessionId });
        } else {
          emit({ type: "system", subtype: "task_notification", task_id: "bg-1", status: "completed", output_file: "", summary: "done", uuid: nextUuid(), session_id: sessionId });
        }
        emit({
          type: "result",
          subtype: "success",
          is_error: false,
          duration_ms: 1,
          duration_api_ms: 1,
          num_turns: 1,
          result: `ok-${turn}`,
          session_id: sessionId,
          total_cost_usd: 0,
          usage: {},
        });
        emit({ type: "system", subtype: "session_state_changed", state: "idle", uuid: nextUuid(), session_id: sessionId });
      }
      callback();
    },
  });
  const fakeProcess = {
    stdin,
    stdout,
    get killed() { return killed; },
    get exitCode() { return exitCode; },
    kill(signal) {
      killed = true;
      exitCode = 0;
      stdout.end();
      emitter.emit("exit", 0, signal);
      return true;
    },
    on: (...args) => emitter.on(...args),
    once: (...args) => emitter.once(...args),
    off: (...args) => emitter.off(...args),
  };

  const runtime = new PersistentQueryRuntime({
    queryFactory: ({ prompt, options }) => query({ prompt, options }),
    onEvent: event => {
      if (event.type === "system" && event.subtype === "session_state_changed" && event.state === "idle") idleCount += 1;
    },
  });
  runtime.start({
    spawnClaudeCodeProcess: () => {
      spawnCount += 1;
      return fakeProcess;
    },
  });
  runtime.send({ type: "user", message: { role: "user", content: [{ type: "text", text: "first" }] }, parent_tool_use_id: null });
  await waitFor(() => idleCount === 1);
  assert.equal(runtime.running, true, "the SDK task remains live after the first idle state");

  runtime.send({ type: "user", message: { role: "user", content: [{ type: "text", text: "second" }] }, parent_tool_use_id: null });
  await waitFor(() => idleCount === 2);
  assert.equal(spawnCount, 1);
  assert.deepEqual(userTexts, ["first", "second"]);
  assert.equal(runtime.running, false);
  runtime.close();
});
