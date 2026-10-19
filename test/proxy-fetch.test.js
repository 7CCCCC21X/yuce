// tools/proxy-fetch.js：经 HTTP CONNECT 代理的 fetch。用本地假代理 + 本地目标服务验证。
// 运行：npm test

const test = require('node:test');
const assert = require('node:assert');
const net = require('node:net');
const http = require('node:http');
const { installProxyFetch, proxiedFetch, parseProxy, matchesNoProxy } = require('../tools/proxy-fetch');

// net.Server 没有 closeAllConnections；自己记录连接，关闭时一并销毁，避免
// 对端已销毁但 'close' 回调迟迟不来导致测试挂起。
function trackedNetServer(handler) {
  const sockets = new Set();
  const server = net.createServer(socket => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    handler(socket);
  });
  server.closeAllConnections = () => { for (const s of sockets) s.destroy(); };
  return server;
}

// 最小 CONNECT 代理：记录目标，把后续字节原样转发。
function startFakeProxy({ reject = false } = {}) {
  const seen = [];
  const server = trackedNetServer(client => {
    let head = '';
    const onData = chunk => {
      head += chunk.toString('latin1');
      const end = head.indexOf('\r\n\r\n');
      if (end === -1) return;
      client.removeListener('data', onData);
      const m = head.match(/^CONNECT ([^ ]+):(\d+) HTTP\/1\.1/);
      seen.push({ target: m && m[1], port: m && Number(m[2]), auth: (head.match(/Proxy-Authorization: (.+)/) || [])[1] || '' });
      if (reject) { client.end('HTTP/1.1 407 Proxy Authentication Required\r\n\r\n'); return; }
      const upstream = net.connect({ host: m[1], port: Number(m[2]) }, () => {
        client.write('HTTP/1.1 200 Connection established\r\n\r\n');
        const rest = Buffer.from(head.slice(end + 4), 'latin1');
        if (rest.length) upstream.write(rest);
        client.pipe(upstream).pipe(client);
      });
      upstream.on('error', () => client.destroy());
    };
    client.on('data', onData);
    client.on('error', () => {});
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({ server, seen, url: `http://127.0.0.1:${server.address().port}` })));
}

function startTarget() {
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      if (req.url === '/nobody') { res.statusCode = 204; return res.end(); }
      res.statusCode = req.url === '/fail' ? 503 : 200;
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('x-echo-ua', req.headers['user-agent'] || '');
      res.end(JSON.stringify({ method: req.method, url: req.url, body, host: req.headers.host }));
    });
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({ server, url: `http://127.0.0.1:${server.address().port}` })));
}

const close = s => new Promise(r => { s.close(() => r()); if (typeof s.closeAllConnections === 'function') s.closeAllConnections(); });

test('parseProxy / matchesNoProxy', () => {
  assert.deepStrictEqual(parseProxy('http://127.0.0.1:7897'), { host: '127.0.0.1', port: 7897, tls: false, auth: '' });
  assert.strictEqual(parseProxy('http://u:p%40ss@proxy.local').auth, Buffer.from('u:p@ss').toString('base64'));
  assert.throws(() => parseProxy('socks5://127.0.0.1:7891'), /只支持 http/);
  assert.strictEqual(matchesNoProxy('api.predict.fun', 'localhost,.predict.fun'), true);
  assert.strictEqual(matchesNoProxy('predict.fun', '.predict.fun'), true);
  assert.strictEqual(matchesNoProxy('graphql.predict.fun', 'localhost'), false);
  assert.strictEqual(matchesNoProxy('anything', '*'), true);
});

test('proxiedFetch：经 CONNECT 隧道发 POST，返回标准 Response', async () => {
  const proxy = await startFakeProxy();
  const target = await startTarget();
  try {
    const res = await proxiedFetch(parseProxy(proxy.url), `${target.url}/graphql?x=1`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'User-Agent': 'yuce-test' }, body: '{"query":"{__typename}"}',
    });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.headers.get('content-type'), 'application/json');
    assert.strictEqual(res.headers.get('x-echo-ua'), 'yuce-test');
    const json = await res.json();
    assert.deepStrictEqual(json, { method: 'POST', url: '/graphql?x=1', body: '{"query":"{__typename}"}', host: new URL(target.url).host });
    assert.strictEqual(proxy.seen.length, 1);
    assert.strictEqual(proxy.seen[0].target, '127.0.0.1');
    assert.strictEqual(proxy.seen[0].port, Number(new URL(target.url).port));

    const fail = await proxiedFetch(parseProxy(proxy.url), `${target.url}/fail`);
    assert.strictEqual(fail.status, 503);
    assert.strictEqual(fail.ok, false);
    const empty = await proxiedFetch(parseProxy(proxy.url), `${target.url}/nobody`);
    assert.strictEqual(empty.status, 204);
    assert.strictEqual(await empty.text(), '');
  } finally { await close(proxy.server); await close(target.server); }
});

test('proxiedFetch：代理拒绝 CONNECT 时报错说明状态码；超时 signal 生效', async () => {
  const bad = await startFakeProxy({ reject: true });
  try {
    await assert.rejects(() => proxiedFetch(parseProxy(bad.url), 'http://127.0.0.1:9/x'), /代理拒绝建立隧道.*407/);
  } finally { await close(bad.server); }
  // 代理永不应答 → AbortSignal.timeout 触发 AbortError/TimeoutError。
  const silent = trackedNetServer(() => {});
  await new Promise(r => silent.listen(0, '127.0.0.1', r));
  try {
    await assert.rejects(
      () => proxiedFetch(parseProxy(`http://127.0.0.1:${silent.address().port}`), 'http://127.0.0.1:9/x', { signal: AbortSignal.timeout(100) }),
      err => err.name === 'AbortError' || err.name === 'TimeoutError'
    );
  } finally { await close(silent); }
});

test('installProxyFetch：替换 globalThis.fetch，NO_PROXY 命中走原 fetch，可还原', async () => {
  const proxy = await startFakeProxy();
  const target = await startTarget();
  const original = globalThis.fetch;
  const restore = installProxyFetch(proxy.url, { noProxy: 'localhost' });
  try {
    assert.notStrictEqual(globalThis.fetch, original);
    const viaProxy = await fetch(`${target.url}/a`);
    assert.strictEqual((await viaProxy.json()).url, '/a');
    assert.strictEqual(proxy.seen.length, 1);
    // localhost 在 NO_PROXY 里：不经代理（seen 不增加）。
    const direct = await fetch(`http://localhost:${new URL(target.url).port}/b`);
    assert.strictEqual((await direct.json()).url, '/b');
    assert.strictEqual(proxy.seen.length, 1);
  } finally {
    restore();
    assert.strictEqual(globalThis.fetch, original);
    await close(proxy.server); await close(target.server);
  }
});
