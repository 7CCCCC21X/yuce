// 浏览器直连 Predict GraphQL（js/predict-graphql.js）单元测试：注入假的 post。
// 运行：npm test

const test = require('node:test');
const assert = require('node:assert');

const ADDR_LOWER = '0x9b94ac8c4fc28ad3885c31dec9e95394757c4094';
const ADDR_CHECKSUM = '0x9B94ac8C4fc28ad3885C31DEC9e95394757C4094';

test('normalizeInterval 与服务端口径一致', async () => {
  const { normalizeInterval } = await import('../js/predict-graphql.js');
  assert.strictEqual(normalizeInterval(''), 'ALL');
  assert.strictEqual(normalizeInterval('all'), 'ALL');
  assert.strictEqual(normalizeInterval('1d'), '_1D');
  assert.strictEqual(normalizeInterval('_1W'), '_1W');
  assert.strictEqual(normalizeInterval('MAX'), 'MAX');
  assert.strictEqual(normalizeInterval('??'), 'ALL');
});

test('fetchPortfolioDirect: 地址转校验和格式，信封与 /api/portfolio 一致', async () => {
  const { fetchPortfolioDirect } = await import('../js/predict-graphql.js');
  const calls = [];
  const post = async op => {
    calls.push(op);
    return { data: { account: { name: 'alice', pointsEarningRatio: 1.1, leaderboard: { totalPoints: 12, rank: 3 }, statistics: { positionsValueUsd: '123.45', pnlUsd: '-1.5', volumeUsd: '999', marketsCount: 4 } } } };
  };
  const env = await fetchPortfolioDirect(post, ADDR_LOWER);
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].operationName, 'GetPortfolio');
  assert.strictEqual(calls[0].variables.address, ADDR_CHECKSUM);
  assert.deepStrictEqual(env, {
    success: true, address: ADDR_CHECKSUM, name: 'alice', positionsValueUsd: '123.45', pnlUsd: '-1.5', volumeUsd: '999',
    marketsCount: 4, pointsEarningRatio: 1.1, totalPoints: 12, rank: 3, source: 'predict_graphql_GetPortfolio'
  });
});

test('fetchPortfolioDirect: account 为 null → success:false', async () => {
  const { fetchPortfolioDirect } = await import('../js/predict-graphql.js');
  const env = await fetchPortfolioDirect(async () => ({ data: { account: null } }), ADDR_LOWER);
  assert.strictEqual(env.success, false);
  assert.match(env.error, /No account found/);
});

test('fetchPortfolioDirect: 地址非法直接抛错，不发请求', async () => {
  const { fetchPortfolioDirect } = await import('../js/predict-graphql.js');
  await assert.rejects(() => fetchPortfolioDirect(async () => { throw new Error('should not be called'); }, '0x123'), /钱包地址格式错误/);
});

test('fetchPnlDirect: 跟随 hasNextPage 翻页、按 x 排序、信封含 points', async () => {
  const { fetchPnlDirect } = await import('../js/predict-graphql.js');
  const calls = [];
  const pages = [
    { pageInfo: { hasNextPage: true, endCursor: 'c2' }, edges: [{ cursor: 'c1', node: { x: 100, y: 1 } }, { cursor: 'c2', node: { x: 200, y: 2 } }] },
    { pageInfo: { hasNextPage: false, endCursor: 'c3' }, edges: [{ cursor: 'c3', node: { x: 300, y: 3.5 } }] },
  ];
  const post = async op => { calls.push(op.variables); return { data: { account: { pnlTimeseries: pages[calls.length - 1] } } }; };
  const env = await fetchPnlDirect(post, ADDR_LOWER, 'ALL');
  assert.strictEqual(calls.length, 2);
  // 与官网一致：首页 { first: 750 }，第二页追加 after=endCursor；ALL 实际发送 MAX。
  assert.deepStrictEqual(calls[0].pagination, { first: 750 });
  assert.deepStrictEqual(calls[1].pagination, { first: 750, after: 'c2' });
  assert.strictEqual(calls[0].filter.interval, 'MAX');
  assert.strictEqual(env.success, true);
  assert.strictEqual(env.pnlUsd, 3.5);
  assert.strictEqual(env.timestamp, 300);
  assert.strictEqual(env.pointCount, 3);
  assert.deepStrictEqual(env.points, [{ x: 100, y: 1 }, { x: 200, y: 2 }, { x: 300, y: 3.5 }]);
  assert.strictEqual(env.interval, 'MAX');
});

test('fetchPnlDirect: 枚举名不被认识时沿候选链回退，其它错误直接抛出', async () => {
  const { fetchPnlDirect } = await import('../js/predict-graphql.js');
  const tried = [];
  const post = async op => {
    tried.push(op.variables.filter.interval);
    if (op.variables.filter.interval === 'MAX') {
      const err = new Error('Variable "$filter" got invalid value "MAX"; Value "MAX" does not exist in "TimeseriesInterval" enum.');
      err.raw = { errors: [{ message: err.message }] };
      throw err;
    }
    return { data: { account: { pnlTimeseries: { pageInfo: { hasNextPage: false }, edges: [{ cursor: 'c', node: { x: 1, y: 9 } }] } } } };
  };
  const env = await fetchPnlDirect(post, ADDR_LOWER, 'all');
  assert.deepStrictEqual(tried, ['MAX', 'ALL']);
  assert.strictEqual(env.interval, 'ALL');
  assert.strictEqual(env.pnlUsd, 9);

  // 非枚举错误（例如网络层 TypeError）不回退，原样抛出。
  await assert.rejects(() => fetchPnlDirect(async () => { throw new TypeError('Failed to fetch'); }, ADDR_LOWER, '_1D'), TypeError);
});

test('fetchPnlDirect: 没有任何点 → success:false', async () => {
  const { fetchPnlDirect } = await import('../js/predict-graphql.js');
  const env = await fetchPnlDirect(async () => ({ data: { account: { pnlTimeseries: { pageInfo: { hasNextPage: false }, edges: [] } } } }), ADDR_LOWER, '_1D');
  assert.strictEqual(env.success, false);
  assert.match(env.error, /No PNL timeseries point/);
});
