// /api/positions-value：REST 持仓分页汇总与 wei 换算。
// 运行：npm test

const test = require('node:test');
const assert = require('node:assert');
const { toAmount, valuePosition, aggregatePositions } = require('../api/positions-value');

test('toAmount：wei 整数按 1e18 换算，普通小数原样', () => {
  assert.strictEqual(toAmount('300074213786861026296'), 300.074213786861026296);
  assert.strictEqual(toAmount('3000742137868610262960'), 3000.74213786861026296);
  assert.strictEqual(toAmount('0.91'), 0.91);
  assert.strictEqual(toAmount(0.1), 0.1);
  assert.strictEqual(toAmount('12'), 12);           // 小整数不当 wei
  assert.strictEqual(toAmount('0.91', { weiHint: false }), 0.91);
  assert.strictEqual(toAmount(''), null);
  assert.strictEqual(toAmount(null), null);
  assert.strictEqual(toAmount('abc'), null);
});

// 按 2026-10 实测结构构造的持仓：amount 为 wei，均价普通小数，价格取 outcome.bestBid。
function position(overrides = {}) {
  return {
    id: 'pos-1',
    amount: '300074213786861026296',
    averageBuyPriceUsd: '0.91',
    outcomeIndex: 0,
    market: {
      id: 932241,
      outcomes: [
        { id: 1, name: 'Yes', bestBid: { price: 0.9, size: 100 }, bestAsk: { price: 0.92, size: 589.766 } },
        { id: 2, name: 'No', bestBid: { price: 0.08, size: 100 }, bestAsk: { price: 0.1, size: 589.766 } },
      ],
    },
    ...overrides,
  };
}

test('valuePosition：份额 × 所属 outcome 的 bestBid，成本 = 份额 × 均价', () => {
  const v = valuePosition(position());
  assert.ok(Math.abs(v.shares - 300.0742137868610) < 1e-9);
  assert.strictEqual(v.price, 0.9);
  assert.strictEqual(v.priceSource, 'outcome.bestBid.price');
  assert.ok(Math.abs(v.value - 300.074213786861 * 0.9) < 1e-9);
  assert.ok(Math.abs(v.cost - 300.074213786861 * 0.91) < 1e-9);
});

test('valuePosition：直接 valueUsd 优先；按名称 / indexSet 找 outcome；无价可取时 value 为 null', () => {
  assert.strictEqual(valuePosition(position({ valueUsd: '123.45' })).value, 123.45);
  assert.strictEqual(valuePosition(position({ valueUsd: '123450000000000000000' })).value, 123.45);
  const byName = valuePosition(position({ outcomeIndex: undefined, outcome: 'no' }));
  assert.strictEqual(byName.price, 0.08);
  const byIndexSet = valuePosition(position({ outcomeIndex: undefined, indexSet: 2 }));
  assert.strictEqual(byIndexSet.price, 0.08);
  const noPrice = valuePosition(position({ outcomeIndex: undefined, market: { outcomes: [] } }));
  assert.strictEqual(noPrice.value, null);
  assert.strictEqual(noPrice.priceSource, 'none');
  const own = valuePosition(position({ currentPriceUsd: '0.5' }));
  assert.strictEqual(own.price, 0.5);
  assert.strictEqual(own.priceSource, 'currentPriceUsd');
});

test('aggregatePositions：跟随 cursor 翻页、汇总、空列表为 0', async () => {
  const pages = {
    null: { success: true, cursor: 'c2', data: [position({ id: 'a' }), position({ id: 'b', outcomeIndex: 1 })] },
    c2: { success: true, cursor: null, data: [position({ id: 'c', valueUsd: '10' })] },
  };
  const asked = [];
  const agg = await aggregatePositions(async cursor => { asked.push(cursor); return pages[cursor]; });
  assert.deepStrictEqual(asked, [null, 'c2']);
  assert.strictEqual(agg.pages, 2);
  assert.strictEqual(agg.breakdown.length, 3);
  const s = 300.074213786861026296;
  assert.ok(Math.abs(agg.value - (s * 0.9 + s * 0.08 + 10)) < 1e-6);
  assert.ok(Math.abs(agg.cost - (s * 0.91 * 3)) < 1e-6);
  assert.strictEqual(agg.unpriced, 0);

  const empty = await aggregatePositions(async () => ({ success: true, cursor: null, data: [] }));
  assert.strictEqual(empty.value, 0);
  assert.strictEqual(empty.cost, null);
  assert.strictEqual(empty.breakdown.length, 0);

  // 游标重复（上游异常）不会死循环。
  const loop = await aggregatePositions(async () => ({ success: true, cursor: 'same', data: [position()] }));
  assert.strictEqual(loop.pages, 2);
});

test('handler：非法地址 400；上游 401 → 502 并提示 key；空持仓 → positionsValueUsd 0', async () => {
  const handler = require('../api/positions-value');
  const call = async (query) => {
    const res = { statusCode: 0, headers: {}, body: '', setHeader(k, v) { this.headers[k] = v; }, end(b) { this.body = b; } };
    await handler({ method: 'GET', query }, res);
    return { status: res.statusCode, json: JSON.parse(res.body) };
  };
  const bad = await call({ address: 'nope' });
  assert.strictEqual(bad.status, 400);

  const realFetch = globalThis.fetch;
  const oldKey = process.env.PREDICT_API_KEY;
  delete process.env.PREDICT_API_KEY;
  try {
    globalThis.fetch = async () => ({ ok: false, status: 401, text: async () => '{"success":false,"error":"Unauthorized"}' });
    const unauth = await call({ address: '0xb8075c1b52c1e00b62aa4df4cf55b29dbb71c179' });
    assert.strictEqual(unauth.status, 502);
    assert.match(unauth.json.error, /Unauthorized/);

    const urls = [];
    globalThis.fetch = async (url) => { urls.push(String(url)); return { ok: true, status: 200, text: async () => JSON.stringify({ success: true, cursor: null, data: [] }) }; };
    const empty = await call({ address: '0xb8075c1b52c1e00b62aa4df4cf55b29dbb71c179', debug: '1' });
    assert.strictEqual(empty.status, 200);
    assert.strictEqual(empty.json.success, true);
    assert.strictEqual(empty.json.positionsValueUsd, '0');
    assert.strictEqual(empty.json.positionCount, 0);
    assert.deepStrictEqual(empty.json.breakdown, []);
    assert.strictEqual(urls[0], 'https://api.predict.fun/v1/positions/0xb8075c1b52c1e00b62aa4df4cf55b29dbb71c179');
  } finally {
    globalThis.fetch = realFetch;
    if (oldKey !== undefined) process.env.PREDICT_API_KEY = oldKey;
  }
});
