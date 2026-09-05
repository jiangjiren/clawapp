import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
const source = readFileSync(new URL("public/pending-queue.js", import.meta.url), "utf8");
function queue() {
  const values = new Map();
  const storage = { getItem: key => values.get(key), setItem: (key, value) => values.set(key, value) };
  const make = () => vm.runInNewContext(source + "; new PendingMessageQueue(storage)", { storage });
  return { q: make(), make };
}
const payload = (id, conv = "a") => ({ userMessageId: id, conversationId: conv, prompt: "context\n\nold", composerText: "old", contextParts: ["context"], displaySuffix: "\n引用文件：note", images: [{ data: "image", mediaType: "image/png" }], queueState: "pending" });
test("queued edits preserve attachments and context across tab refresh", () => {
  const { q, make } = queue();
  q.set("one", payload("one"));
  assert.equal(q.edit("one", " new text "), true);
  const item = make().get("one");
  assert.equal(item.prompt, "context\n\nnew text");
  assert.equal(item.composerText, "new text");
  assert.equal(item.displayText, "new text\n引用文件：note");
  assert.equal(item.images[0].data, "image");
});
test("reordering and clearing one conversation leave other queues intact", () => {
  const { q, make } = queue();
  q.set("a1", payload("a1")); q.set("b1", payload("b1", "b")); q.set("a2", payload("a2"));
  q.move("a2", -1);
  assert.equal(q.forConversation("a").map(([id]) => id).join(), "a2,a1");
  q.delete("a2");
  assert.equal(make().has("a2"), false);
  q.clearConversation("a");
  assert.equal(q.has("b1"), true);
  assert.equal(q.size, 1);
});
test("messages already being dispatched cannot be edited or reordered", () => {
  const { q } = queue();
  q.set("first", { ...payload("first"), queueState: "sending" });
  q.set("second", payload("second"));
  assert.equal(q.edit("first", "different"), false);
  q.move("second", -1);
  assert.equal([...q.keys()].join(), "first,second");
  assert.equal(q.edit("second", "  "), false);
});
