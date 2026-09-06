/**
 * ══════════════════════════════════════════════════════════
 * 只给「需要走代理」的那几个请求用的 fetch
 * ══════════════════════════════════════════════════════════
 *
 * Node 22 的 undici 默认不读 HTTP_PROXY/HTTPS_PROXY。官方开关是进程级的
 * NODE_USE_ENV_PROXY=1，但这里不能用它：
 *
 *   buildAgentEnv() 是 `{ ...process.env }` 起手的，那个开关会跟着派生进
 *   Claude Code CLI 子进程，把它现在直连且正常的网络路径一起改掉。为了让
 *   额度面板多显示一行而动主模型那条路，不划算。
 *
 * 所以这里只给点名的请求手动建一条 CONNECT 隧道。没有配代理时直接退回原生
 * fetch，行为与改动前完全一致。
 *
 * 返回的是标准 Response，调用方该怎么用 fetch 就还怎么用。
 */
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";

/** NO_PROXY 命中就不走代理。支持 `*`、`example.com`、`.example.com` 三种写法。 */
function isProxyBypassed(hostname, env) {
  const raw = env.NO_PROXY ?? env.no_proxy ?? "";
  const host = hostname.toLowerCase();
  for (const entry of raw.split(",")) {
    const rule = entry.trim().toLowerCase();
    if (!rule) continue;
    if (rule === "*") return true;
    const bare = rule.startsWith(".") ? rule.slice(1) : rule;
    if (host === bare || host.endsWith(`.${bare}`)) return true;
  }
  return false;
}

/**
 * 这个目标该走哪个代理；不该走代理时返回 null。
 * 单独导出是为了能直接测规则本身——隧道那半段没法在单测里便宜地验证。
 */
export function resolveProxyFor(targetUrl, env = process.env) {
  let target;
  try { target = new URL(targetUrl); } catch { return null; }
  if (isProxyBypassed(target.hostname, env)) return null;
  const raw = target.protocol === "https:"
    ? (env.HTTPS_PROXY ?? env.https_proxy ?? env.HTTP_PROXY ?? env.http_proxy)
    : (env.HTTP_PROXY ?? env.http_proxy);
  if (!raw) return null;
  try {
    const proxy = new URL(raw);
    // socks 得另一套协议，这里只认 http(s) 正向代理；认不出就当没配
    if (proxy.protocol !== "http:" && proxy.protocol !== "https:") return null;
    return proxy;
  } catch { return null; }
}

/** 向代理发 CONNECT，拿到一条通往目标的裸 socket。 */
function openTunnel(proxy, target, signal) {
  return new Promise((resolve, reject) => {
    const port = target.port || (target.protocol === "https:" ? 443 : 80);
    const headers = { host: `${target.hostname}:${port}` };
    if (proxy.username || proxy.password) {
      const credentials = `${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`;
      headers["proxy-authorization"] = `Basic ${Buffer.from(credentials).toString("base64")}`;
    }
    const connectReq = httpRequest({
      host: proxy.hostname,
      port: proxy.port || (proxy.protocol === "https:" ? 443 : 80),
      method: "CONNECT",
      path: `${target.hostname}:${port}`,
      headers,
    });
    const onAbort = () => { connectReq.destroy(new Error("aborted")); };
    signal?.addEventListener("abort", onAbort, { once: true });
    const cleanup = () => signal?.removeEventListener("abort", onAbort);

    connectReq.once("connect", (res, socket) => {
      cleanup();
      if (res.statusCode !== 200) {
        socket.destroy();
        reject(new Error(`代理拒绝了 CONNECT（HTTP ${res.statusCode}）`));
        return;
      }
      resolve(socket);
    });
    connectReq.once("error", (err) => { cleanup(); reject(err); });
    connectReq.end();
  });
}

/** 在已建好的隧道上跑一次 HTTPS 请求，攒完 body 后包成 Response。 */
function requestOverTunnel(socket, target, { method, headers, body, signal }) {
  return new Promise((resolve, reject) => {
    const req = httpsRequest({
      socket,
      servername: target.hostname,   // TLS SNI，少了它握手会失败
      host: target.hostname,
      port: target.port || 443,
      method,
      path: `${target.pathname}${target.search}`,
      headers: { ...headers, host: target.host },
      agent: false,                  // socket 是我们自己给的，别再走连接池
    });
    const onAbort = () => { req.destroy(new Error("aborted")); };
    signal?.addEventListener("abort", onAbort, { once: true });
    const cleanup = () => signal?.removeEventListener("abort", onAbort);

    req.once("response", (res) => {
      const chunks = [];
      res.on("data", chunk => chunks.push(chunk));
      res.once("end", () => {
        cleanup();
        socket.destroy();
        const responseHeaders = new Headers();
        for (const [key, value] of Object.entries(res.headers)) {
          if (value == null) continue;
          for (const one of Array.isArray(value) ? value : [value]) {
            // set-cookie 之类会是数组，逐条 append 才不会被拼成一行
            try { responseHeaders.append(key, one); } catch { /* 非法头名跳过 */ }
          }
        }
        // 204/304 不允许带 body，给 null 才不会被 Response 拒绝
        const status = res.statusCode ?? 502;
        const hasBody = status !== 204 && status !== 304 && status !== 205;
        resolve(new Response(hasBody ? Buffer.concat(chunks) : null, {
          status,
          statusText: res.statusMessage || "",
          headers: responseHeaders,
        }));
      });
      res.once("error", (err) => { cleanup(); socket.destroy(); reject(err); });
    });
    req.once("error", (err) => { cleanup(); socket.destroy(); reject(err); });
    if (body != null) req.write(body);
    req.end();
  });
}

/**
 * 配了代理就走隧道，没配就退回原生 fetch。签名与用法都对齐 fetch。
 */
export async function fetchMaybeViaProxy(targetUrl, options = {}) {
  const { method = "GET", headers = {}, body = null, signal = null, env = process.env } = options;
  const proxy = resolveProxyFor(targetUrl, env);
  if (!proxy) return fetch(targetUrl, { method, headers, body, signal });

  const target = new URL(targetUrl);
  if (target.protocol !== "https:") {
    // http:// 走正向代理是发绝对 URL，不用 CONNECT；这里用不到，交回原生 fetch
    return fetch(targetUrl, { method, headers, body, signal });
  }
  if (signal?.aborted) throw new Error("aborted");
  const socket = await openTunnel(proxy, target, signal);
  return requestOverTunnel(socket, target, { method, headers, body, signal });
}
