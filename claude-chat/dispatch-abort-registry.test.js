import test from "node:test";
import assert from "node:assert/strict";

import { DispatchAbortRegistry } from "./dispatch-abort-registry.js";

test("停止一个对话只中止它自己的 provider dispatch", () => {
  const registry = new DispatchAbortRegistry();
  const a = new AbortController();
  const b = new AbortController();
  registry.add(a, "conv-a");
  registry.add(b, "conv-b");

  registry.abortConversation("conv-a");

  assert.equal(a.signal.aborted, true);
  assert.equal(b.signal.aborted, false);
});

test("abortAll 仍可用于进程级收尾", () => {
  const registry = new DispatchAbortRegistry();
  const a = new AbortController();
  const b = new AbortController();
  registry.add(a, "conv-a");
  registry.add(b, "conv-b");
  registry.abortAll();
  assert.equal(a.signal.aborted, true);
  assert.equal(b.signal.aborted, true);
});
