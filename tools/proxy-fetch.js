// 让 Node 自带的 fetch 走 HTTP 代理（Clash / V2Ray 等本地代理的 http 端口）。
//
// Node 22 的 fetch 不读 HTTPS_PROXY 环境变量，也没有暴露 undici 的 ProxyAgent。
// 这里不依赖任何第三方包：对代理发 CONNECT 建隧道，再在隧道上做 TLS 与
// HTTP 请求，最后包装成标准 Response 返回。只覆盖 api/ 函数用到的子集：
// method / headers / body / signal，以及 res.status / ok / statusText /
// headers.get / text / json。
//
// 用法（tools/local-server.js 会自动调用）：
//   const { installProxyFetch } = require('./proxy-fetch');
//   installProxyFetch('http://127.0.0.1:7897');   // 之后 globalThis.fetch 即走代理

const net = require('node:net');
const tls = require('node:tls');
const http = require('node:http');

function parseProxy(proxyUrl) {
  const u = new URL(proxyUrl);
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error(`只支持 http(s):// 形式的代理地址，收到：${proxyUrl}`);
  const auth = u.username ? Buffer.from(`${decodeURIComponent(u.username)}:${decodeURIComponent(u.password || '')}`).toString('base64') : '';
  return { host: u.hostname, port: Number(u.port || (u.protocol === 'https:' ? 443 : 80)), tls: u.protocol === 'https:', auth };
}

function matchesNoProxy(hostname, noProxy) {
  if (!noProxy) return false;
  const host = hostname.toLowerCase();
  return noProxy.split(',').map(s => s.trim().toLowerCase()).filter(Boolean).some(rule => {
    if (rule === '*') return true;
    const r = rule.replace(/^\./, '');
    return host === r || host.endsWith(`.${r}`);
  });
}

// 向代理发 CONNECT，成功后返回已建立的隧道 socket。
function connectTunnel(proxy, targetHost, targetPort, signal) {
  return new Promise((resolve, reject) => {
    const socket = proxy.tls
      ? tls.connect({ host: proxy.host, port: proxy.port, servername: proxy.host })
      : net.connect({ host: proxy.host, port: proxy.port });
    let buffer = '';
    const fail = err => { socket.destroy(); reject(err); };
    const onAbort = () => fail(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }));
    if (signal) {
      if (signal.aborted) return onAbort();
      signal.addEventListener('abort', onAbort, { once: true });
    }
    socket.once('error', fail);
    socket.once(proxy.tls ? 'secureConnect' : 'connect', () => {
      const lines = [`CONNECT ${targetHost}:${targetPort} HTTP/1.1`, `Host: ${targetHost}:${targetPort}`, 'Proxy-Connection: keep-alive'];
      if (proxy.auth) lines.push(`Proxy-Authorization: Basic ${proxy.auth}`);
      socket.write(lines.join('\r\n') + '\r\n\r\n');
    });
    const onData = chunk => {
      buffer += chunk.toString('latin1');
      const end = buffer.indexOf('\r\n\r\n');
      if (end === -1) return;
      socket.removeListener('data', onData);
      socket.removeListener('error', fail);
      if (signal) signal.removeEventListener('abort', onAbort);
      const status = Number((buffer.match(/^HTTP\/1\.[01] (\d{3})/) || [])[1]);
      if (status !== 200) return fail(new Error(`代理拒绝建立隧道（CONNECT ${targetHost}:${targetPort} → HTTP ${status || '?'}）`));
      // 极少数代理会把后续数据和响应头一起发来，塞回流里。
      const rest = Buffer.from(buffer.slice(end + 4), 'latin1');
      if (rest.length) socket.unshift(rest);
      resolve(socket);
    };
    socket.on('data', onData);
  });
}

function headersToObject(headers) {
  const out = {};
  if (!headers) return out;
  const entries = typeof headers.entries === 'function' ? headers.entries() : Object.entries(headers);
  for (const [k, v] of entries) if (v !== undefined && v !== null) out[k] = String(v);
  return out;
}

async function proxiedFetch(proxy, input, init = {}) {
  const url = new URL(typeof input === 'string' ? input : input.url);
  const isHttps = url.protocol === 'https:';
  const port = Number(url.port || (isHttps ? 443 : 80));
  const signal = init.signal;
  const tunnel = await connectTunnel(proxy, url.hostname, port, signal);
  const socket = isHttps ? tls.connect({ socket: tunnel, servername: url.hostname }) : tunnel;

  return new Promise((resolve, reject) => {
    const req = http.request({
      createConnection: () => socket,
      method: init.method || 'GET',
      host: url.hostname,
      port,
      path: url.pathname + url.search,
      headers: { Host: url.host, ...headersToObject(init.headers) },
    });
    const onAbort = () => { req.destroy(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' })); };
    if (signal) {
      if (signal.aborted) return onAbort();
      signal.addEventListener('abort', onAbort, { once: true });
    }
    const cleanup = () => { if (signal) signal.removeEventListener('abort', onAbort); };
    req.once('error', err => { cleanup(); reject(err); });
    req.once('response', res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.once('error', err => { cleanup(); reject(err); });
      res.once('end', () => {
        cleanup();
        const headers = new Headers();
        for (const [k, v] of Object.entries(res.headers)) {
          if (Array.isArray(v)) v.forEach(x => headers.append(k, x));
          else if (v !== undefined) headers.set(k, v);
        }
        // 204/304 等不允许带 body 的状态码，Response 构造器要求 body 为 null。
        const body = Buffer.concat(chunks);
        const nullBody = res.statusCode === 204 || res.statusCode === 304 || (res.statusCode >= 100 && res.statusCode < 200);
        resolve(new Response(nullBody ? null : body, { status: res.statusCode, statusText: res.statusMessage || '', headers }));
      });
    });
    if (init.body !== undefined && init.body !== null) req.write(typeof init.body === 'string' ? init.body : Buffer.from(init.body));
    req.end();
  });
}

// 把 globalThis.fetch 替换成走代理的版本；NO_PROXY 命中或非 http(s) 目标仍走原 fetch。
function installProxyFetch(proxyUrl, { noProxy = process.env.NO_PROXY || process.env.no_proxy || '' } = {}) {
  const proxy = parseProxy(proxyUrl);
  const original = globalThis.fetch;
  globalThis.fetch = (input, init) => {
    let url;
    try { url = new URL(typeof input === 'string' ? input : input.url); } catch { return original(input, init); }
    if ((url.protocol !== 'http:' && url.protocol !== 'https:') || matchesNoProxy(url.hostname, noProxy)) return original(input, init);
    return proxiedFetch(proxy, input, init);
  };
  return () => { globalThis.fetch = original; };
}

module.exports = { installProxyFetch, proxiedFetch, parseProxy, matchesNoProxy, connectTunnel };
