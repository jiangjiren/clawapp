import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { resolveProxyFor, fetchMaybeViaProxy } from "./proxy-fetch.js";

// ── 选路规则 ────────────────────────────────────────────────

test("https 目标优先用 HTTPS_PROXY，回落到 HTTP_PROXY", () => {
  assert.equal(
    resolveProxyFor("https://chatgpt.com/x", { HTTPS_PROXY: "http://127.0.0.1:7890", HTTP_PROXY: "http://127.0.0.1:1" })?.port,
    "7890",
  );
  assert.equal(
    resolveProxyFor("https://chatgpt.com/x", { HTTP_PROXY: "http://127.0.0.1:7890" })?.port,
    "7890",
  );
  assert.equal(
    resolveProxyFor("https://chatgpt.com/x", { https_proxy: "http://127.0.0.1:8080" })?.port,
    "8080",
  );
});

test("没配代理时返回 null——退回原生 fetch，行为与改动前一致", () => {
  assert.equal(resolveProxyFor("https://chatgpt.com/x", {}), null);
});

test("NO_PROXY 命中就不走代理", () => {
  const env = { HTTPS_PROXY: "http://127.0.0.1:7890" };
  assert.equal(resolveProxyFor("https://chatgpt.com/x", { ...env, NO_PROXY: "chatgpt.com" }), null);
  assert.equal(resolveProxyFor("https://api.chatgpt.com/x", { ...env, NO_PROXY: ".chatgpt.com" }), null);
  assert.equal(resolveProxyFor("https://chatgpt.com/x", { ...env, NO_PROXY: "*" }), null);
  assert.equal(resolveProxyFor("https://chatgpt.com/x", { ...env, no_proxy: "a.com, chatgpt.com" }), null);
  // 不该误伤：后缀相同但不是同一个域
  assert.ok(resolveProxyFor("https://notchatgpt.com/x", { ...env, NO_PROXY: "chatgpt.com" }));
});

test("socks 代理认不出来就当没配，不能拿 CONNECT 去捅它", () => {
  assert.equal(resolveProxyFor("https://chatgpt.com/x", { HTTPS_PROXY: "socks5://127.0.0.1:1080" }), null);
});

// ── 隧道本身 ────────────────────────────────────────────────

/** 一个只认 CONNECT 的假代理，记下收到的请求，不真的转发。 */
async function startFakeProxy({ statusLine = "HTTP/1.1 200 Connection Established\r\n\r\n" } = {}) {
  const seen = [];
  const server = createServer();
  server.on("connect", (req, socket) => {
    seen.push({ path: req.url, auth: req.headers["proxy-authorization"] ?? null });
    socket.write(statusLine);
    // 隧道之后是 TLS 握手，这里不扮演真服务器——握手失败正是我们要的信号：
    // 说明 CONNECT 这一段已经走通了
    socket.end();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return { port: server.address().port, seen, close: () => server.close() };
}

test("配了代理就向它发 CONNECT，目标 host:port 正确", async () => {
  const proxy = await startFakeProxy();
  try {
    const env = { HTTPS_PROXY: `http://127.0.0.1:${proxy.port}` };
    await fetchMaybeViaProxy("https://chatgpt.com/backend-api/wham/usage", { env })
      .catch(() => { /* TLS 握手会失败，本例只验证 CONNECT 那一段 */ });
    assert.equal(proxy.seen.length, 1, "必须真的经过了代理");
    assert.equal(proxy.seen[0].path, "chatgpt.com:443");
    assert.equal(proxy.seen[0].auth, null, "没有账号密码时不该带 Proxy-Authorization");
  } finally { proxy.close(); }
});

test("代理带账号密码时补上 Proxy-Authorization", async () => {
  const proxy = await startFakeProxy();
  try {
    const env = { HTTPS_PROXY: `http://user:p%40ss@127.0.0.1:${proxy.port}` };
    await fetchMaybeViaProxy("https://chatgpt.com/x", { env }).catch(() => {});
    assert.equal(proxy.seen.length, 1);
    const expected = "Basic " + Buffer.from("user:p@ss").toString("base64");
    assert.equal(proxy.seen[0].auth, expected, "密码里的转义字符要还原");
  } finally { proxy.close(); }
});

test("代理拒绝 CONNECT 时报得出是代理的问题", async () => {
  const proxy = await startFakeProxy({ statusLine: "HTTP/1.1 407 Proxy Authentication Required\r\n\r\n" });
  try {
    const env = { HTTPS_PROXY: `http://127.0.0.1:${proxy.port}` };
    await assert.rejects(
      () => fetchMaybeViaProxy("https://chatgpt.com/x", { env }),
      /代理拒绝了 CONNECT（HTTP 407）/,
    );
  } finally { proxy.close(); }
});

test("已经 abort 的请求不去开隧道", async () => {
  const proxy = await startFakeProxy();
  try {
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(() => fetchMaybeViaProxy("https://chatgpt.com/x", {
      env: { HTTPS_PROXY: `http://127.0.0.1:${proxy.port}` },
      signal: controller.signal,
    }));
    assert.equal(proxy.seen.length, 0, "abort 过的请求不该还去连代理");
  } finally { proxy.close(); }
});
