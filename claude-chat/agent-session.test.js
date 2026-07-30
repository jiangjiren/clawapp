import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import test from "node:test";
import { query } from "@anthropic-ai/claude-agent-sdk";
import {
  AsyncMessageQueue,
  PersistentQueryRuntime,
  SteeringQueue,
  updateTaskRegistry,
} from "./agent-session.js";

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

test("steering queue is idempotent, owner-scoped, editable, and reorderable before apply", () => {
  const queue = new SteeringQueue();
  const first = queue.enqueue({
    userMessageId: "steer-1",
    ownerToken: "conv-a|profile-a",
    displayText: "first",
    prompt: "first prompt",
  });
  queue.enqueue({
    userMessageId: "other-1",
    ownerToken: "conv-b|profile-a",
    displayText: "other",
    prompt: "other prompt",
  });
  queue.enqueue({
    userMessageId: "steer-2",
    ownerToken: "conv-a|profile-a",
    displayText: "second",
    prompt: "second prompt",
  });
  const duplicate = queue.enqueue({
    userMessageId: "steer-1",
    ownerToken: "conv-b|profile-b",
    displayText: "must not replace",
  });

  assert.equal(first.inserted, true);
  assert.equal(duplicate.inserted, false, "a retried userMessageId must not create a second steering item");
  assert.equal(duplicate.item.ownerToken, "conv-a|profile-a", "a duplicate ID cannot steal another owner");
  assert.equal(duplicate.item.displayText, "first");
  assert.equal(queue.length, 3);

  assert.equal(
    queue.update("steer-1", { displayText: "hijack" }, "conv-b|profile-a"),
    null,
    "another conversation cannot edit a pending steering item",
  );
  const updated = queue.update(
    "steer-1",
    {
      displayText: "first edited",
      prompt: "first edited prompt",
      userMessageId: "renamed",
      ownerToken: "conv-b|profile-b",
      state: "applied",
      claimToken: "forged",
    },
    "conv-a|profile-a",
  );
  assert.equal(updated?.userMessageId, "steer-1", "the canonical id is immutable while editing");
  assert.equal(updated?.ownerToken, "conv-a|profile-a", "editing content cannot move an item to another owner");
  assert.equal(updated?.state, "queued");
  assert.equal(updated?.claimToken, null);
  assert.equal(updated?.displayText, "first edited");

  assert.equal(queue.reorder("conv-a|profile-a", ["steer-2", "steer-1"]), true);
  assert.deepEqual(
    queue.snapshot().map(item => item.userMessageId),
    ["steer-2", "other-1", "steer-1"],
    "reordering one owner keeps other conversations in their original slots",
  );
  assert.equal(queue.remove("steer-2", "conv-b|profile-a"), null);
  assert.equal(queue.remove("steer-2", "conv-a|profile-a")?.userMessageId, "steer-2");
  assert.deepEqual(
    queue.snapshot("conv-a|profile-a").map(item => [item.userMessageId, item.displayText]),
    [["steer-1", "first edited"]],
    "the reconnect snapshot contains the latest pending content exactly once",
  );
});

test("steering claims are FIFO, compare-and-delete, pausable on Stop, and isolated on reset", () => {
  const queue = new SteeringQueue();
  const ownerA = "conv-a|profile-a";
  const ownerB = "conv-b|profile-b";
  for (const [userMessageId, ownerToken] of [
    ["a-1", ownerA],
    ["b-1", ownerB],
    ["a-2", ownerA],
  ]) {
    queue.enqueue({ userMessageId, ownerToken, displayText: userMessageId });
  }

  const claim = queue.claimNext(ownerA);
  assert.equal(claim?.item.userMessageId, "a-1", "the first unpaused item for an owner is claimed first");
  assert.equal(queue.update("a-1", { displayText: "too late" }, ownerA), null);
  assert.equal(queue.remove("a-1", ownerA), null, "an applied-in-progress item cannot be removed by a stale UI command");
  assert.equal(queue.commitClaim("a-1", "wrong-token"), null, "a stale claim cannot delete the current owner's item");

  const paused = queue.pauseOwner(ownerA);
  assert.deepEqual(paused.map(item => item.userMessageId), ["a-2"]);
  assert.equal(queue.claimNext(ownerA), null, "Stop pauses pending work instead of automatically draining it");
  assert.equal(queue.claimNext(ownerB)?.item.userMessageId, "b-1", "pausing one conversation does not pause another");

  assert.equal(queue.releaseClaim("a-1", claim.claimToken, { paused: true })?.paused, true);
  assert.equal(queue.hasUnpaused(ownerA), false);
  assert.deepEqual(
    queue.resumeOwner(ownerA).map(item => item.userMessageId),
    ["a-1", "a-2"],
  );
  assert.equal(queue.claimNext(ownerA)?.item.userMessageId, "a-1", "released work returns to its original FIFO position");

  const resetRemoved = queue.removeOwner(ownerA);
  assert.deepEqual(
    resetRemoved.map(item => item.userMessageId).sort(),
    ["a-1", "a-2"],
    "reset invalidates both queued and claimed work owned by the old conversation",
  );
  assert.deepEqual(
    queue.snapshot().map(item => item.userMessageId),
    ["b-1"],
    "reset cannot clear another conversation and leaves no old steering claim recoverable",
  );
  assert.equal(
    queue.commitClaim("a-1", claim.claimToken),
    null,
    "a stale apply callback cannot resurrect or commit a claim invalidated by reset",
  );
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

test("persistent runtime forwards cross-provider dispatch events without closing the session", async () => {
  let fake;
  const seen = [];
  const runtime = new PersistentQueryRuntime({
    queryFactory: ({ prompt }) => (fake = new FakeQuery(prompt)),
    onEvent: event => seen.push(event),
  });
  runtime.start({ mcpServers: { dispatch: { name: "provider-dispatch" } } });
  runtime.send({ type: "user", message: { role: "user", content: "dispatch" } });
  await flush();
  fake.events.push({
    type: "assistant",
    message: {
      role: "assistant",
      content: [{
        type: "tool_use",
        id: "dispatch-1",
        name: "mcp__dispatch__dispatch_to_provider",
        input: { provider: "deepseek", task: "find root cause" },
      }],
    },
  });
  fake.events.push({
    type: "user",
    message: {
      role: "user",
      content: [{
        type: "tool_result",
        tool_use_id: "dispatch-1",
        content: JSON.stringify({
          provider: "deepseek",
          providerName: "DeepSeek",
          model: "deepseek-v4-pro[1m]",
          output: "root cause",
        }),
      }],
    },
  });
  fake.events.push({ type: "system", subtype: "session_state_changed", state: "idle" });
  await flush();

  assert.deepEqual(seen.map(event => event.type), ["assistant", "user", "system"]);
  assert.equal(runtime.started, true);
  runtime.send({ type: "user", message: { role: "user", content: "continue" } });
  await flush();
  assert.equal(fake.received.length, 2, "dispatch result must not force a replacement query");
  runtime.close();
});

test("active runtime accepts FIFO steering messages without an implicit interrupt", async () => {
  const queries = [];
  const seen = [];
  const runtime = new PersistentQueryRuntime({
    queryFactory: ({ prompt }) => {
      const fake = new FakeQuery(prompt);
      queries.push(fake);
      return fake;
    },
    onEvent: event => seen.push(event),
  });

  runtime.start({});
  runtime.send({ type: "user", message: { role: "user", content: "first" }, priority: "next" });
  await waitFor(() => queries[0].received.length === 1);
  queries[0].events.push({ type: "system", subtype: "session_state_changed", state: "running" });
  queries[0].events.push({
    type: "assistant",
    message: {
      role: "assistant",
      content: [{ type: "tool_use", id: "tool-1", name: "Read", input: { file_path: "a.txt" } }],
    },
  });
  queries[0].events.push({
    type: "user",
    message: {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "tool-1", content: "ok" }],
    },
  });
  await waitFor(() => seen.some(event =>
    event.type === "user"
    && event.message?.content?.some(block => block.type === "tool_result" && block.tool_use_id === "tool-1")
  ));

  runtime.send({ type: "user", message: { role: "user", content: "steer-one" }, priority: "next" });
  runtime.send({ type: "user", message: { role: "user", content: "steer-two" }, priority: "next" });
  await waitFor(() => queries[0].received.length === 3);

  assert.equal(queries.length, 1, "steering must reuse the active SDK query");
  assert.equal(queries[0].interruptCalls, 0, "steering must not turn a second Enter into Stop");
  assert.deepEqual(
    queries[0].received.map(message => message.message.content),
    ["first", "steer-one", "steer-two"],
    "multiple steering messages reach the SDK in FIFO order",
  );
  assert.equal(runtime.foregroundRunning, true, "a steering send keeps the foreground turn owned until idle");

  queries[0].events.push({ type: "system", subtype: "session_state_changed", state: "idle" });
  await waitFor(() => runtime.foregroundRunning === false);
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
