/**
 * 验证「上下文随事件流传递」这件事真的成立。
 *
 * 原先事件归属是发出时回头猜的：读 activeForegroundConversationId 等几个
 * 全局，按优先级挑一个。单会话时凑合能用，两个会话同时在跑必然猜错——
 * A 的子任务事件回来时，全局早被 B 改写了，于是 A 的回答渲染进 B。
 *
 * 这里证明：把 context 绑在 runtime 的事件泵上之后，哪怕事件隔了几百毫秒
 * 才从异步生成器里出来，回调里读到的仍然是它自己那份。
 */

import test from "node:test";
import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";

import { PersistentQueryRuntime } from "./agent-session.js";

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

/** 一个假的 SDK query：按给定节奏异步吐事件。 */
function fakeQuery(events, { gap = 0 } = {}) {
  return {
    async *[Symbol.asyncIterator]() {
      for (const event of events) {
        if (gap) await delay(gap);
        yield event;
      }
    },
    interrupt: async () => {},
    close: () => {},
  };
}

test("事件回调里读到的是这个 runtime 自己的 context", async () => {
  const store = new AsyncLocalStorage();
  const seen = [];
  const runtime = new PersistentQueryRuntime({
    contextStore: store,
    queryFactory: () => fakeQuery([{ type: "a" }, { type: "b" }], { gap: 5 }),
    onEvent: (event) => { seen.push([event.type, store.getStore()?.conversationId]); },
  });

  runtime.start({}, { conversationId: "conv-1" });
  await runtime.pumpPromise;

  assert.deepEqual(seen, [["a", "conv-1"], ["b", "conv-1"]]);
});

test("两个 runtime 并发跑，各认各的 context 不串", async () => {
  // 这正是多开时最怕的串话场景：两条事件流交错回来。
  const store = new AsyncLocalStorage();
  const seen = [];
  const make = (id, gap) => new PersistentQueryRuntime({
    contextStore: store,
    queryFactory: () => fakeQuery([{ type: `${id}-1` }, { type: `${id}-2` }], { gap }),
    onEvent: (event) => { seen.push([event.type, store.getStore()?.conversationId]); },
  });

  const a = make("A", 7);
  const b = make("B", 11);
  a.start({}, { conversationId: "conv-A" });
  b.start({}, { conversationId: "conv-B" });
  await Promise.all([a.pumpPromise, b.pumpPromise]);

  // 交错顺序不确定，但每条事件必须配对到自己的会话
  assert.equal(seen.length, 4);
  for (const [type, conversationId] of seen) {
    assert.equal(conversationId, type.startsWith("A") ? "conv-A" : "conv-B",
      `事件 ${type} 被归到了 ${conversationId}`);
  }
});

test("context 穿透 onError 与 onClose", async () => {
  const store = new AsyncLocalStorage();
  const seen = {};
  const runtime = new PersistentQueryRuntime({
    contextStore: store,
    queryFactory: () => ({
      async *[Symbol.asyncIterator]() {
        await delay(3);
        throw new Error("boom");
      },
      interrupt: async () => {},
      close: () => {},
    }),
    onError: () => { seen.error = store.getStore()?.conversationId; },
    onClose: () => { seen.close = store.getStore()?.conversationId; },
  });

  runtime.start({}, { conversationId: "conv-err" });
  await runtime.pumpPromise;

  assert.equal(seen.error, "conv-err");
  assert.equal(seen.close, "conv-err");
});

test("跨越 setTimeout 的深层异步回调仍然读得到 context", async () => {
  // 子任务事件就是这个形态：SDK 内部转了几手才吐出来
  const store = new AsyncLocalStorage();
  let deep = null;
  const runtime = new PersistentQueryRuntime({
    contextStore: store,
    queryFactory: () => fakeQuery([{ type: "task_started" }], { gap: 2 }),
    onEvent: async () => {
      await delay(5);
      await new Promise(resolve => setTimeout(resolve, 5));
      deep = store.getStore()?.conversationId;
    },
  });

  runtime.start({}, { conversationId: "conv-deep" });
  await runtime.pumpPromise;
  assert.equal(deep, "conv-deep");
});

test("不给 contextStore 时行为跟以前一样", async () => {
  const seen = [];
  const runtime = new PersistentQueryRuntime({
    queryFactory: () => fakeQuery([{ type: "a" }]),
    onEvent: (event) => seen.push(event.type),
  });
  runtime.start({});
  await runtime.pumpPromise;
  assert.deepEqual(seen, ["a"]);
});

test("close() 之后 context 被清掉，不会泄漏给下一轮", async () => {
  const store = new AsyncLocalStorage();
  const runtime = new PersistentQueryRuntime({
    contextStore: store,
    queryFactory: () => fakeQuery([]),
    onEvent: () => {},
  });
  runtime.start({}, { conversationId: "conv-1" });
  assert.equal(runtime.context.conversationId, "conv-1");
  runtime.close();
  assert.equal(runtime.context, null);
});
