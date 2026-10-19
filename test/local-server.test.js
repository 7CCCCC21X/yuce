// tools/local-server.js：静态文件 + api/ 函数的本地壳子。
// 运行：npm test

const test = require('node:test');
const assert = require('node:assert');
const { createServer } = require('../tools/local-server');

async function withServer(fn) {
  const server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try { await fn(base); }
  finally { await new Promise(resolve => server.close(resolve)); }
}

test('静态文件：/ 返回 index.html，js/ 带 JS 类型，仓库外与 api/ 目录不可读', async () => {
  await withServer(async base => {
    const home = await fetch(`${base}/`);
    assert.strictEqual(home.status, 200);
    assert.match(home.headers.get('content-type'), /text\/html/);
    assert.match(await home.text(), /<title>/);

    const js = await fetch(`${base}/js/api.js`);
    assert.strictEqual(js.status, 200);
    assert.match(js.headers.get('content-type'), /javascript/);

    assert.strictEqual((await fetch(`${base}/api/_predict-graphql.js`)).status, 404);
    assert.strictEqual((await fetch(`${base}/tools/local-server.js`)).status, 404);
    assert.strictEqual((await fetch(`${base}/..%2Fpackage.json`)).status, 404);
  });
});

test('api/：按文件名路由到 Vercel 函数，req.query 已解析，带 CORS 头', async () => {
  await withServer(async base => {
    // 非法地址走不到上游，直接 400：验证路由、query 解析与 send() 兼容。
    const bad = await fetch(`${base}/api/portfolio?address=nope`);
    assert.strictEqual(bad.status, 400);
    assert.strictEqual(bad.headers.get('access-control-allow-origin'), '*');
    const body = await bad.json();
    assert.strictEqual(body.success, false);
    assert.match(body.error, /Invalid address/);

    const pnl = await fetch(`${base}/api/portfolio-pnl?address=nope&interval=ALL`);
    assert.strictEqual(pnl.status, 400);

    const missing = await fetch(`${base}/api/nope`);
    assert.strictEqual(missing.status, 404);
    assert.strictEqual((await fetch(`${base}/api/_predict-graphql`)).status, 404);

    const preflight = await fetch(`${base}/api/portfolio`, { method: 'OPTIONS' });
    assert.strictEqual(preflight.status, 204);
    assert.strictEqual(preflight.headers.get('access-control-allow-private-network'), 'true');
  });
});
