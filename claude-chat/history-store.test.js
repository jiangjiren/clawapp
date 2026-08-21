import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, appendFileSync, readdirSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createHistoryStore, fileNameFor } from "./history-store.js";

function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), "hist-"));
  test.after(() => { try { rmSync(dir, { recursive: true, force: true }); } catch { } });
  return dir;
}

const conv = (id, messages, extra = {}) => ({
  id, title: `会话 ${id}`, date: "2026-08-21T10:00:00.000Z", messages, ...extra,
});
const msg = (id, text, role = "user") => ({ id, role, text });

const lineCount = (file) =>
  readFileSync(file, "utf8").split("\n").filter(l => l.trim()).length;

test("首次落盘后能原样读回来", () => {
  const dir = tempDir();
  const store = createHistoryStore({ dir });
  store.save(conv("c1", [msg("m1", "你好"), msg("m2", "在", "assistant")]));

  const [loaded] = createHistoryStore({ dir }).load();
  assert.equal(loaded.id, "c1");
  assert.equal(loaded.title, "会话 c1");
  assert.deepEqual(loaded.messages, [msg("m1", "你好"), msg("m2", "在", "assistant")]);
  // meta 的 t 字段是日志内部用的，不该渗进会话对象
  assert.equal("t" in loaded, false);
});

test("没变化就不写盘", () => {
  const dir = tempDir();
  const store = createHistoryStore({ dir });
  const c = conv("c1", [msg("m1", "你好")]);
  assert.equal(store.save(c), "rewrite");
  assert.equal(store.save(c), "unchanged");
  assert.equal(store.save({ ...c }), "unchanged");
});

test("新增消息走 append，不重写整个文件", () => {
  const dir = tempDir();
  const store = createHistoryStore({ dir });
  const c = conv("c1", [msg("m1", "一")]);
  store.save(c);
  const before = lineCount(store.pathFor("c1"));

  c.messages.push(msg("m2", "二"));
  assert.equal(store.save(c), "append");
  assert.equal(lineCount(store.pathFor("c1")), before + 1);   // 只多了一行

  const [loaded] = createHistoryStore({ dir }).load();
  assert.deepEqual(loaded.messages.map(m => m.text), ["一", "二"]);
});

test("改写已有消息时同 id 后写的生效", () => {
  // 流式回答就是这个形态：同一条 assistant 消息被反复改写
  const dir = tempDir();
  const store = createHistoryStore({ dir });
  const c = conv("c1", [msg("a1", "", "assistant")]);
  store.save(c);

  c.messages[0].text = "写到一半";
  assert.equal(store.save(c), "append");
  c.messages[0].text = "写完了";
  assert.equal(store.save(c), "append");

  const [loaded] = createHistoryStore({ dir }).load();
  assert.equal(loaded.messages.length, 1);
  assert.equal(loaded.messages[0].text, "写完了");
});

test("meta 变了但消息没变，只补一行 meta", () => {
  const dir = tempDir();
  const store = createHistoryStore({ dir });
  const c = conv("c1", [msg("m1", "一")]);
  store.save(c);
  const before = lineCount(store.pathFor("c1"));

  c.title = "改了标题";
  assert.equal(store.save(c), "append");
  assert.equal(lineCount(store.pathFor("c1")), before + 1);
  assert.equal(createHistoryStore({ dir }).load()[0].title, "改了标题");
});

test("冗余行堆到阈值触发 compact", () => {
  const dir = tempDir();
  const store = createHistoryStore({ dir });
  const c = conv("c1", [msg("a1", "0", "assistant")]);
  store.save(c);

  let compacted = false;
  for (let i = 1; i <= 40 && !compacted; i += 1) {
    c.messages[0].text = String(i);
    compacted = store.save(c) === "compact";
  }
  assert.ok(compacted, "反复改写同一条消息应当触发 compact");

  // compact 之后文件回到最小形态：1 行 meta + 1 行消息
  assert.equal(lineCount(store.pathFor("c1")), 2);
  assert.equal(createHistoryStore({ dir }).load()[0].messages[0].text, c.messages[0].text);
});

test("删掉消息时退回整份重写", () => {
  // append 表达不了删除，只能重写
  const dir = tempDir();
  const store = createHistoryStore({ dir });
  const c = conv("c1", [msg("m1", "一"), msg("m2", "二")]);
  store.save(c);

  c.messages = [msg("m1", "一")];
  assert.equal(store.save(c), "rewrite");
  assert.deepEqual(createHistoryStore({ dir }).load()[0].messages.map(m => m.id), ["m1"]);
});

test("崩溃截断的半行被跳过，前面的内容完好", () => {
  const dir = tempDir();
  const store = createHistoryStore({ dir });
  store.save(conv("c1", [msg("m1", "一"), msg("m2", "二")]));
  // 模拟写到一半进程被杀
  appendFileSync(store.pathFor("c1"), '{"t":"msg","k":"id:m3","m":{"id":"m3","te');

  const [loaded] = createHistoryStore({ dir }).load();
  assert.deepEqual(loaded.messages.map(m => m.id), ["m1", "m2"]);
});

test("没有 meta 的文件不认，避免造出半个会话", () => {
  const dir = tempDir();
  writeFileSync(join(dir, "junk.jsonl"), '{"t":"msg","m":{"id":"x","text":"孤儿"}}\n');
  assert.deepEqual(createHistoryStore({ dir }).load(), []);
});

test("会话之间互不影响——这正是分片要解决的问题", () => {
  const dir = tempDir();
  const store = createHistoryStore({ dir });
  const a = conv("a", [msg("m1", "A1")], { date: "2026-08-21T09:00:00.000Z" });
  const b = conv("b", [msg("m2", "B1")], { date: "2026-08-21T11:00:00.000Z" });
  store.saveAll([a, b]);

  // 只动 a，b 的文件应当一个字节都不变
  const bBytes = readFileSync(store.pathFor("b"), "utf8");
  a.messages.push(msg("m3", "A2"));
  assert.equal(store.saveAll([a, b]), 1);            // 只有一个会话真写了盘
  assert.equal(readFileSync(store.pathFor("b"), "utf8"), bBytes);

  // 读回按时间倒序
  assert.deepEqual(createHistoryStore({ dir }).load().map(c => c.id), ["b", "a"]);
});

test("落盘一批不完整的会话，不会连带删掉没在列表里的分片", () => {
  /* 真实事故：调用方内存里的历史被 MAX_SERVER_HISTORY 截断到 100 条，
     曾经有个 replaceAll 按这批做差集去删文件——用户只是多开了几个新对话，
     最老的分片就被 unlink 了。磁盘该保全，删除只能来自用户显式操作。 */
  const dir = tempDir();
  const store = createHistoryStore({ dir });
  const older = conv("older", [msg("m1", "老对话")], { date: "2026-08-01T10:00:00.000Z" });
  const newer = conv("newer", [msg("m2", "新对话")], { date: "2026-08-21T10:00:00.000Z" });
  store.saveAll([older, newer]);

  // 只落盘"最近的那批"，older 不在其中
  store.saveAll([newer]);

  assert.deepEqual(
    createHistoryStore({ dir }).load().map(c => c.id),
    ["newer", "older"],
    "没进列表的会话必须还在磁盘上",
  );
});

test("删除会话连文件一起删掉", () => {
  const dir = tempDir();
  const store = createHistoryStore({ dir });
  store.saveAll([conv("a", [msg("m1", "A")]), conv("b", [msg("m2", "B")])]);
  assert.equal(store.remove("a"), true);
  assert.deepEqual(createHistoryStore({ dir }).load().map(c => c.id), ["b"]);
  assert.equal(store.remove("不存在"), false);
});

test("从旧的 history.json 迁移，旧文件改名留底", () => {
  const dir = tempDir();
  const legacy = join(dir, "..", `legacy-${Date.now()}.json`);
  writeFileSync(legacy, JSON.stringify([
    conv("c1", [msg("m1", "一")]),
    conv("c2", [msg("m2", "二")]),
    { messages: [] },                     // 没有 id 的坏数据，跳过
  ]), "utf8");

  const store = createHistoryStore({ dir });
  assert.equal(store.isEmpty(), true);
  assert.equal(store.migrateFrom(legacy), 2);
  assert.equal(store.isEmpty(), false);

  assert.deepEqual(createHistoryStore({ dir }).load().map(c => c.id).sort(), ["c1", "c2"]);
  assert.equal(readFileSync(`${legacy}.migrated`, "utf8").length > 0, true);
  rmSync(`${legacy}.migrated`, { force: true });
});

test("mergeFrom 只补分片没有的会话，不覆盖已有的", () => {
  /* legacy 文件不是一次性的：server 每次启动都会把 history-<PORT>.json 残留
     重新合并成 history.json。migrateFrom 只跑一次，之后那份就没人读了。 */
  const dir = tempDir();
  const store = createHistoryStore({ dir });
  store.save(conv("c1", [msg("m1", "分片里的最新版")]));

  const legacy = join(dir, "legacy.json");
  writeFileSync(legacy, JSON.stringify([
    conv("c1", [msg("m1", "legacy 里的旧版")]),   // 已有，必须不被覆盖
    conv("c2", [msg("m2", "legacy 独有")]),       // 缺失，要补进来
    { messages: [] },                              // 没 id，跳过
  ]), "utf8");

  assert.equal(store.mergeFrom(legacy), 1);

  const loaded = createHistoryStore({ dir }).load();
  assert.deepEqual(loaded.map(c => c.id).sort(), ["c1", "c2"]);
  assert.equal(loaded.find(c => c.id === "c1").messages[0].text, "分片里的最新版");

  // 幂等：再跑一次不该重复补
  assert.equal(store.mergeFrom(legacy), 0);
  // legacy 文件不改名——留给下次启动再比对一遍
  assert.equal(existsSync(legacy), true);
});

test("迁移源不存在或为空时什么都不做", () => {
  const dir = tempDir();
  const store = createHistoryStore({ dir });
  assert.equal(store.migrateFrom(join(dir, "没有这个文件.json")), 0);
  assert.equal(store.migrateFrom(null), 0);

  const empty = join(dir, "empty.json");
  writeFileSync(empty, "[]", "utf8");
  assert.equal(store.migrateFrom(empty), 0);

  const broken = join(dir, "broken.json");
  writeFileSync(broken, "{ 不是 JSON", "utf8");
  assert.equal(store.migrateFrom(broken), 0);
});

test("没有 id 的老消息按序号认，不会丢", () => {
  const dir = tempDir();
  const store = createHistoryStore({ dir });
  const c = conv("c1", [{ role: "user", text: "无 id 的老数据" }, msg("m2", "有 id")]);
  store.save(c);

  const [loaded] = createHistoryStore({ dir }).load();
  assert.equal(loaded.messages.length, 2);
  assert.equal(loaded.messages[0].text, "无 id 的老数据");
});

test("会话 id 含路径分隔符时不会写到目录外", () => {
  assert.equal(fileNameFor("conv_123"), "conv_123.jsonl");
  const evil = fileNameFor("../../etc/passwd");
  assert.equal(evil.includes("/"), false);
  assert.equal(evil.includes(".."), false);

  // sanitize 后可能撞名的两个 id，必须落在不同文件
  assert.notEqual(fileNameFor("a/b"), fileNameFor("a:b"));

  const dir = tempDir();
  const store = createHistoryStore({ dir });
  store.save(conv("wechat_/../x", [msg("m1", "一")]));
  assert.equal(readdirSync(dir).filter(n => n.endsWith(".jsonl")).length, 1);
  assert.equal(createHistoryStore({ dir }).load()[0].id, "wechat_/../x");
});
