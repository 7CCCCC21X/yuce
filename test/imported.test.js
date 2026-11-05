// 官网数据导入（js/imported.js）与 api.js 的优先使用逻辑。
// 运行：npm test

const test = require('node:test');
const assert = require('node:assert');

const W = '0xA332264ac2ffd399c8a9a8aa8fe4ca2d552b9e74';
const EXPORT = {
  format: 'yuce-portfolio-export', version: 1, exported_at: '2026-11-05T08:00:00.000Z', source: 'test',
  wallets: {
    [W.toLowerCase()]: { address: W, name: 'alice', positionsValueUsd: '271.03', pnlUsd: -12.5, totalPoints: 1290.8, rank: 18633, pnl_interval: 'MAX', pnl_points: [{ x: 1700000000, y: -3 }, { x: 1700086400, y: -12.5 }], error: '' },
    '0xb8075c1b52c1e00b62aa4df4cf55b29dbb71c179': { address: '0xB8075C1b52C1e00B62aA4df4Cf55B29dBb71C179', name: '', positionsValueUsd: null, pnlUsd: null, pnl_points: [], error: 'No account found for address' },
  },
};

function installDom(checks = {}) {
  const els = {};
  const mk = id => (els[id] ||= { value: '', checked: checks[id] ?? true });
  globalThis.document = { getElementById: id => (id in checks || ['useImported', 'importedFallback', 'queryHoldings', 'queryPnl', 'retries', 'timeoutMs', 'positionApiTemplate', 'positionValuePaths', 'pnlApiTemplate', 'proxyPrefix'].includes(id) ? mk(id) : null) };
  els.retries = { value: '0' }; els.timeoutMs = { value: '3000' };
  els.positionApiTemplate = { value: '/api/portfolio?address={wallet}' }; els.positionValuePaths = { value: 'positionsValueUsd' };
  els.pnlApiTemplate = { value: '/api/portfolio-pnl?address={wallet}&interval=ALL' }; els.proxyPrefix = { value: '' };
  const storage = new Map();
  globalThis.localStorage = { getItem: k => storage.get(k) ?? null, setItem: (k, v) => storage.set(k, v), removeItem: k => storage.delete(k) };
  globalThis.location = { origin: 'https://yuce.example' };
  return els;
}

test('loadImportedText：校验格式、按小写地址索引、数值规范化、restore 可恢复', async () => {
  installDom();
  const imp = await import('../js/imported.js');
  imp.clearImported();
  assert.throws(() => imp.loadImportedText('not json'), /JSON/);
  assert.throws(() => imp.loadImportedText('{"format":"other","wallets":{}}'), /yuce-portfolio-export/);
  const n = imp.loadImportedText(JSON.stringify(EXPORT), 'x.json');
  assert.strictEqual(n, 2);
  const e = imp.importedFor(W.toUpperCase().replace('0X', '0x'));
  assert.strictEqual(e.name, 'alice');
  assert.strictEqual(e.positionsValueUsd, '271.03');
  assert.strictEqual(e.pnlUsd, '-12.5');
  assert.deepStrictEqual(e.pnl_points, [{ x: 1700000000, y: -3 }, { x: 1700086400, y: -12.5 }]);
  assert.match(imp.describeImported(), /已导入 2 个钱包（x.json）/);
  // 清空内存后从 localStorage 恢复
  imp.clearImported();
  assert.strictEqual(imp.importedCount(), 0);
  localStorage.setItem('yuce.import.v1', JSON.stringify({ fileName: 'x.json', text: JSON.stringify(EXPORT) }));
  assert.strictEqual(imp.restoreImported(), 2);
  assert.strictEqual(imp.importedFor(W).name, 'alice');
});

test('api.js：有导入数据的钱包不请求接口；未导入的钱包按开关回退或报错', async () => {
  const els = installDom();
  const imp = await import('../js/imported.js');
  const api = await import('../js/api.js');
  imp.loadImportedText(JSON.stringify(EXPORT));
  const urls = [];
  globalThis.fetch = async (url) => { urls.push(String(url)); return { ok: true, status: 200, statusText: 'OK', text: async () => JSON.stringify({ success: true, positionsValueUsd: '1', name: 'from-api', pnlUsd: '9', points: [] }) }; };

  const h = await api.fetchPositionValue(W);
  assert.deepStrictEqual(h, { holding_amount_usdt: '271.03', name: 'alice', error: '' });
  const p = await api.fetchOfficialPortfolioPnl(W.toLowerCase());
  assert.strictEqual(p.pnl, '-12.5');
  assert.strictEqual(p.points.length, 2);
  assert.deepStrictEqual(urls, []);

  // 导出里标记 No account 的钱包：持仓报导入错误，不回退。
  const miss = await api.fetchPositionValue('0xb8075c1b52c1e00b62aa4df4cf55b29dbb71c179');
  assert.match(miss.error, /导入数据: No account found/);
  assert.deepStrictEqual(urls, []);

  // 不在导出里的钱包：默认回退接口。
  const other = '0x1111111111111111111111111111111111111111';
  const viaApi = await api.fetchPositionValue(other);
  assert.strictEqual(viaApi.name, 'from-api');
  assert.strictEqual(urls.length, 1);

  // 关闭回退：直接报错，不请求。
  els.importedFallback.checked = false;
  const noFallback = await api.fetchOfficialPortfolioPnl(other);
  assert.match(noFallback.error, /导入的官网数据里没有这个钱包/);
  assert.strictEqual(urls.length, 1);

  // 关闭「优先使用导入数据」：一律走接口。
  els.useImported.checked = false;
  const forced = await api.fetchPositionValue(W);
  assert.strictEqual(forced.name, 'from-api');
  assert.strictEqual(urls.length, 2);
});
