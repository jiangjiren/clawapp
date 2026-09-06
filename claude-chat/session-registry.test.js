import test from "node:test";
import assert from "node:assert/strict";

import { SessionRegistry } from "./session-registry.js";

/** 造一个 registry，busy 状态由外部的 Set 控制，方便测并发。 */
function makeRegistry({ limit = 10, maxTracked = 50, createSession = null } = {}) {
  const busy = new Set();
  let currentId = null;
  const registry = new SessionRegistry({
    limit,
    maxTracked,
    createSession: createSession ?? ((id) => ({ id, marker: null })),
    resolveCurrentId: () => currentId,
    isBusy: (s) => busy.has(s.id),
  });
  return {
    registry,
    busy,
    enter: (id) => { currentId = id; },
    leave: () => { currentId = null; },
  };
}

test("同一个对话拿到的永远是同一个实例", () => {
  const { registry } = makeRegistry();
  const a1 = registry.acquire("conv-a");
  const a2 = registry.acquire("conv-a");
  assert.equal(a1, a2);
  assert.notEqual(a1, registry.acquire("conv-b"));
  assert.equal(registry.trackedCount, 2);
});

test("状态跟着对话走，不互相串", () => {
  const { registry } = makeRegistry();
  registry.acquire("conv-a").marker = "A";
  registry.acquire("conv-b").marker = "B";
  assert.equal(registry.acquire("conv-a").marker, "A");
  assert.equal(registry.acquire("conv-b").marker, "B");
});

test("current() 跟着上下文走，没上下文时落在 ambient", () => {
  const { registry, enter, leave } = makeRegistry();
  leave();
  assert.equal(registry.current(), registry.ambient);

  enter("conv-a");
  assert.equal(registry.current().id, "conv-a");
  enter("conv-b");
  assert.equal(registry.current().id, "conv-b");

  leave();
  assert.equal(registry.current(), registry.ambient);
});

test("ambient 不占并发名额", () => {
  // 进程刚起来、还没关联到具体对话时的状态落在 ambient，
  // 它要是被算进「在跑」，第一个真实对话就少一个名额
  const { registry, busy } = makeRegistry({ limit: 1 });
  busy.add(null);                      // ambient 的 id 是 null
  assert.equal(registry.runningCount, 0);
  assert.equal(registry.canRun("conv-a"), true);
});

test("并发上限拦住第 11 个，但在跑的那个可以继续下一轮", () => {
  const { registry, busy } = makeRegistry({ limit: 10 });
  for (let i = 0; i < 10; i += 1) {
    const id = `conv-${i}`;
    registry.acquire(id);
    busy.add(id);
  }
  assert.equal(registry.runningCount, 10);
  assert.equal(registry.canRun("conv-new"), false);
  // 已经在跑的那个再发一条是同一个会话的下一轮，不占新名额
  assert.equal(registry.canRun("conv-3"), true);

  busy.delete("conv-3");
  assert.equal(registry.canRun("conv-new"), true);
});

test("切走的对话仍然活着，回来能接上", () => {
  const { registry, enter } = makeRegistry();
  enter("conv-a");
  registry.current().marker = "写到一半";
  enter("conv-b");
  registry.current().marker = "另一个对话";
  enter("conv-a");
  assert.equal(registry.current().marker, "写到一半");
});

test("对话太多时回收最久没碰的，在跑的绝不动", () => {
  const { registry, busy } = makeRegistry({ maxTracked: 3 });
  busy.add("old-busy");                 // 最老，但在跑
  registry.acquire("old-busy");
  registry.acquire("old-idle");         // 最老的空闲
  registry.acquire("mid");
  registry.acquire("new");              // 触发回收

  assert.equal(registry.peek("old-busy")?.id, "old-busy", "在跑的不能被回收");
  assert.equal(registry.peek("old-idle"), null, "最久没碰的空闲会话被回收");
  assert.equal(registry.trackedCount, 3);
});

test("回收不会掉进死循环——全都在跑时就让它超出上限", () => {
  const { registry, busy } = makeRegistry({ maxTracked: 2 });
  for (const id of ["a", "b", "c", "d"]) {
    busy.add(id);
    registry.acquire(id);
  }
  assert.equal(registry.trackedCount, 4, "宁可超出上限，也不能丢掉正在跑的会话");
});

test("drop 明确丢弃一个对话", () => {
  let disposed = 0;
  const { registry } = makeRegistry({
    createSession: (id) => ({ id, marker: null, disposeRuntime: () => { disposed += 1; } }),
  });
  registry.acquire("conv-a");
  assert.equal(registry.drop("conv-a"), true);
  assert.equal(disposed, 1, "丢弃前必须关闭会话 runtime");
  assert.equal(registry.peek("conv-a"), null);
  assert.equal(registry.drop("conv-a"), false);
});

test("空闲回收会关闭被淘汰会话的 runtime", () => {
  const disposed = [];
  const { registry } = makeRegistry({
    maxTracked: 1,
    createSession: (id) => ({ id, disposeRuntime: () => disposed.push(id) }),
  });
  registry.acquire("old");
  registry.acquire("new");
  assert.deepEqual(disposed, ["old"]);
});

test("空 id 一律落到 ambient，不会造出一堆匿名会话", () => {
  const { registry } = makeRegistry();
  assert.equal(registry.acquire(""), registry.ambient);
  assert.equal(registry.acquire(null), registry.ambient);
  assert.equal(registry.acquire(undefined), registry.ambient);
  assert.equal(registry.acquire("   "), registry.ambient);
  assert.equal(registry.trackedCount, 0);
});

test("runningIds 报的是真在干活的那些", () => {
  const { registry, busy } = makeRegistry();
  for (const id of ["a", "b", "c"]) registry.acquire(id);
  busy.add("a");
  busy.add("c");
  assert.deepEqual(registry.runningIds().sort(), ["a", "c"]);
});
