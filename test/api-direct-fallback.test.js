// api.js 的「直连优先 → 同域代理回退」调度测试（桩掉 DOM 与 fetch）。
// 运行：npm test

const test = require('node:test');
const assert = require('node:assert');

const WALLET_A = '0x9b94ac8c4fc28ad3885c31dec9e95394757c4094';
const WALLET_B = '0xb8075c1b52c1e00b62aa4df4cf55b29dbb71c179';

function installDom(values) {
  const els = {};
  for (const [id, v] of Object.entries(values)) els[id] = typeof v === 'boolean' ? { checked: v } : { value: String(v) };
  globalThis.document = { getElementById: id => els[id] || null };
  globalThis.location = { origin: 'https://yuce.example' };
  globalThis.performance = globalThis.performance || { now: () => Date.now() };
  return els;
}

const BASE = {
  retries: 0, timeoutMs: 3000, maxQps: 0,
  graphqlMode: 'auto', graphqlUrl: 'https://graphql.example/graphql', graphqlAuth: '',
  positionApiTemplate: '/api/portfolio?address={wallet}',
  positionValuePaths: 'positionsValueUsd',
  pnlApiTemplate: '/api/portfolio-pnl?address={wallet}&interval=ALL',
  proxyPrefix: '',
  queryHoldings: true, queryPnl: true,
};

function jsonResponse(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, statusText: 'OK', text: async () => JSON.stringify(body), json: async () => body };
}

test('auto：直连成功时不再请求代理', async () => {
  installDom(BASE);
  const api = await import('../js/api.js');
  api.resetDirectState();
  const urls = [];
  globalThis.fetch = async (url, init) => {
    urls.push(String(url));
    const op = JSON.parse(init.body);
    assert.strictEqual(init.method, 'POST');
    assert.strictEqual(op.operationName, 'GetPortfolio');
    return jsonResponse({ data: { account: { name: 'bob', statistics: { positionsValueUsd: '42.5' } } } });
  };
  const r = await api.fetchPositionValue(WALLET_A);
  assert.deepStrictEqual(r, { holding_amount_usdt: '42.5', name: 'bob', error: '' });
  assert.deepStrictEqual(urls, ['https://graphql.example/graphql']);
});

test('auto：直连被 CORS 拒绝 → 回退代理，且本轮后续钱包直接走代理', async () => {
  installDom(BASE);
  const api = await import('../js/api.js');
  api.resetDirectState();
  const urls = [];
  globalThis.fetch = async (url) => {
    urls.push(String(url));
    if (String(url).startsWith('https://graphql.example')) throw new TypeError('Failed to fetch');
    return jsonResponse({ success: true, positionsValueUsd: '7', name: 'proxy-name' });
  };
  const a = await api.fetchPositionValue(WALLET_A);
  assert.strictEqual(a.holding_amount_usdt, '7');
  assert.strictEqual(a.name, 'proxy-name');
  const b = await api.fetchPositionValue(WALLET_B);
  assert.strictEqual(b.holding_amount_usdt, '7');
  // 第一个钱包：直连 1 次 + 代理 1 次；第二个钱包：只走代理。
  assert.deepStrictEqual(urls, [
    'https://graphql.example/graphql',
    `/api/portfolio?address=${WALLET_A}`,
    `/api/portfolio?address=${WALLET_B}`,
  ]);
});

test('auto：直连与代理都失败时，错误同时说明两边原因', async () => {
  installDom(BASE);
  const api = await import('../js/api.js');
  api.resetDirectState();
  globalThis.fetch = async (url) => {
    if (String(url).startsWith('https://graphql.example')) throw new TypeError('Failed to fetch');
    return jsonResponse({ success: false, error: 'Cloudflare blocked the request (HTTP 403; error 1020)' }, 502);
  };
  const r = await api.fetchPositionValue(WALLET_A);
  assert.strictEqual(r.holding_amount_usdt, '');
  assert.match(r.error, /^持仓接口失败: 直连: 浏览器直连被拒绝/);
  assert.match(r.error, /代理: HTTP 502/);
  assert.match(r.error, /Cloudflare blocked/);
});

test('direct：只直连，失败不碰代理', async () => {
  installDom({ ...BASE, graphqlMode: 'direct' });
  const api = await import('../js/api.js');
  api.resetDirectState();
  const urls = [];
  globalThis.fetch = async (url) => { urls.push(String(url)); throw new TypeError('Failed to fetch'); };
  const r = await api.fetchOfficialPortfolioPnl(WALLET_A);
  assert.deepStrictEqual(urls, ['https://graphql.example/graphql']);
  assert.strictEqual(r.pnl, '');
  assert.match(r.error, /^官网PNL失败: 直连: 浏览器直连被拒绝/);
});

test('proxy：旧行为，不发直连请求', async () => {
  installDom({ ...BASE, graphqlMode: 'proxy' });
  const api = await import('../js/api.js');
  api.resetDirectState();
  const urls = [];
  globalThis.fetch = async (url) => { urls.push(String(url)); return jsonResponse({ success: true, pnlUsd: '-3.25', points: [{ x: 1, y: -3.25 }] }); };
  const r = await api.fetchOfficialPortfolioPnl(WALLET_A);
  assert.deepStrictEqual(urls, [`/api/portfolio-pnl?address=${WALLET_A}&interval=ALL&full=1`]);
  assert.strictEqual(r.pnl, '-3.25');
  assert.strictEqual(r.points.length, 1);
});

test('直连 PNL：interval 取自模板参数，Authorization 头按设置附带', async () => {
  installDom({ ...BASE, graphqlAuth: 'Bearer abc', pnlApiTemplate: '/api/portfolio-pnl?address={wallet}&interval=_1W' });
  const api = await import('../js/api.js');
  api.resetDirectState();
  let seen = null;
  globalThis.fetch = async (url, init) => {
    seen = { headers: init.headers, op: JSON.parse(init.body) };
    return jsonResponse({ data: { account: { pnlTimeseries: { pageInfo: { hasNextPage: false }, edges: [{ cursor: 'c', node: { x: 10, y: 1.25 } }] } } } });
  };
  const r = await api.fetchOfficialPortfolioPnl(WALLET_A);
  assert.strictEqual(seen.headers.Authorization, 'Bearer abc');
  assert.strictEqual(seen.op.variables.filter.interval, '_1W');
  assert.strictEqual(r.pnl, '1.25');
  assert.deepStrictEqual(r.points, [{ x: 10, y: 1.25 }]);
});

// ---------- 持仓：REST 优先，GraphQL 回退 ----------

const REST = { ...BASE, positionApiTemplate: '/api/predict?network=mainnet&path=/v1/positions/{wallet}', positionValuePaths: 'data[].valueUsd,data[].currentValueUsd,positions[].valueUsd,list[].valueUsd,positionsValueUsd,statistics.positionsValueUsd' };

test('REST 优先：累加 valueUsd，成功时不碰 GraphQL', async () => {
  installDom(REST);
  const api = await import('../js/api.js');
  api.resetDirectState();
  const urls = [];
  globalThis.fetch = async (url) => { urls.push(String(url)); return jsonResponse({ success: true, data: [{ valueUsd: '1.5' }, { valueUsd: '2.25' }, { valueUsd: null }] }); };
  const r = await api.fetchPositionValue(WALLET_A);
  assert.deepStrictEqual(r, { holding_amount_usdt: '3.75', name: '', error: '' });
  assert.deepStrictEqual(urls, [`/api/predict?network=mainnet&path=/v1/positions/${WALLET_A}`]);
});

test('REST 优先：空持仓列表 = 0，不算失败', async () => {
  installDom(REST);
  const api = await import('../js/api.js');
  api.resetDirectState();
  globalThis.fetch = async () => jsonResponse({ success: true, data: [] });
  const r = await api.fetchPositionValue(WALLET_A);
  assert.deepStrictEqual(r, { holding_amount_usdt: '0', name: '', error: '' });
});

test('REST 失败 → 回退 GraphQL 直连，取到官网口径与用户名', async () => {
  installDom(REST);
  const api = await import('../js/api.js');
  api.resetDirectState();
  const urls = [];
  globalThis.fetch = async (url) => {
    urls.push(String(url));
    if (String(url).startsWith('/api/predict')) return jsonResponse({ success: false, error: 'Missing PREDICT_API_KEY' }, 500);
    return jsonResponse({ data: { account: { name: 'carol', statistics: { positionsValueUsd: '88' } } } });
  };
  const r = await api.fetchPositionValue(WALLET_A);
  assert.deepStrictEqual(r, { holding_amount_usdt: '88', name: 'carol', error: '' });
  assert.deepStrictEqual(urls, [`/api/predict?network=mainnet&path=/v1/positions/${WALLET_A}`, 'https://graphql.example/graphql']);
});

test('REST、直连、代理全部失败 → 错误逐项说明', async () => {
  installDom(REST);
  const api = await import('../js/api.js');
  api.resetDirectState();
  const urls = [];
  globalThis.fetch = async (url) => {
    urls.push(String(url));
    if (String(url).startsWith('/api/predict')) return jsonResponse({ success: false, error: 'rest down' }, 502);
    if (String(url).startsWith('https://graphql.example')) throw new TypeError('Failed to fetch');
    return jsonResponse({ success: false, error: 'Cloudflare blocked the request (HTTP 403; error 1020)' }, 502);
  };
  const r = await api.fetchPositionValue(WALLET_A);
  assert.strictEqual(r.holding_amount_usdt, '');
  assert.match(r.error, /^持仓接口失败: REST: HTTP 502 .*rest down/);
  assert.match(r.error, /直连: 浏览器直连被拒绝/);
  assert.match(r.error, /代理: HTTP 502 .*Cloudflare blocked/);
  // 回退代理用的是 /api/portfolio，而不是把 REST 模板再请求一遍。
  assert.strictEqual(urls[2], `/api/portfolio?address=${WALLET_A}`);
});
