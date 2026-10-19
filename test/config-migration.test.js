// 配置迁移：旧默认的 GraphQL 持仓模板 → REST；自定义值不动。
// 运行：npm test

const test = require('node:test');
const assert = require('node:assert');

function installDom() {
  const els = {};
  // toast() 会创建 DOM 节点，给个最小桩。
  const node = () => ({ classList: { add() {}, remove() {} }, setAttribute() {}, appendChild() {}, remove() {} });
  globalThis.document = { getElementById: id => (els[id] ||= { value: '', checked: false }), createElement: node, body: node() };
  globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
  globalThis.location = { reload() {} };
  globalThis.requestAnimationFrame = fn => fn();
  return els;
}

test('importConfig 迁移：旧默认持仓模板 / 字段路径改为 REST，自定义值保留', async () => {
  const els = installDom();
  const cfg = await import('../js/config.js');
  const legacy = { values: {
    positionApiTemplate: '/api/portfolio?address={wallet}',
    positionValuePaths: 'positionsValueUsd,statistics.positionsValueUsd,data.statistics.positionsValueUsd,data.account.statistics.positionsValueUsd',
    apiTemplate: 'https://tool.opinx.app/api/predict/points/{wallet}',
  } };
  await cfg.importConfigFile({ text: async () => JSON.stringify(legacy) });
  assert.strictEqual(els.positionApiTemplate.value, '/api/predict?network=mainnet&path=/v1/positions/{wallet}');
  assert.match(els.positionValuePaths.value, /^data\[\]\.valueUsd,/);
  assert.strictEqual(els.apiTemplate.value, 'https://indexer.predalpha.xyz/api/predict/points/{wallet}');

  const custom = { values: { positionApiTemplate: 'https://my.proxy/positions/{wallet}', positionValuePaths: 'items[].usd' } };
  await cfg.importConfigFile({ text: async () => JSON.stringify(custom) });
  assert.strictEqual(els.positionApiTemplate.value, 'https://my.proxy/positions/{wallet}');
  assert.strictEqual(els.positionValuePaths.value, 'items[].usd');
});
