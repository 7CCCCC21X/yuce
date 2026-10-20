// /api/usdt-flows：充提分类、过滤、汇总与区块窗口翻页。
// 运行：npm test

const test = require('node:test');
const assert = require('node:assert');
const flows = require('../api/usdt-flows');

const ME = '0xA332264ac2ffd399c8a9a8aa8fe4ca2d552b9e74';
const OTHER = '0x1111111111111111111111111111111111111111';
const EXCHANGE = '0x6bEb5a40C032AFc305961162d8204CDA16DECFa5'; // YB_CTFExchange（混合大小写）
const REWARD = '0x14e3cB02F48818a8FeF6BC257059767cA9d436Ae';
const usdt = n => (BigInt(Math.round(n * 1e6)) * 10n ** 12n).toString(); // n USDT → wei(18)

function tx(from, to, amount, i) {
  return { hash: `0xhash${i}`, from, to, value: usdt(amount), tokenDecimal: '18', blockNumber: String(1000 + i), timeStamp: String(1700000000 + i * 60) };
}

test('weiToDecimal / minAmountWei', () => {
  assert.strictEqual(flows.weiToDecimal(1500000000000000000n), '1.5');
  assert.strictEqual(flows.weiToDecimal(10n ** 18n), '1');
  assert.strictEqual(flows.weiToDecimal(-25n * 10n ** 17n), '-2.5');
  assert.strictEqual(flows.weiToDecimal(0n), '0');
  assert.strictEqual(flows.minAmountWei({ USDT_FLOWS_MIN_AMOUNT: '10' }), 10n * 10n ** 18n);
  assert.strictEqual(flows.minAmountWei({ USDT_FLOWS_MIN_AMOUNT: '0.5' }), 5n * 10n ** 17n);
  assert.strictEqual(flows.minAmountWei({}), 10n * 10n ** 18n);
});

test('summarizeTransfers：方向、市场合约剔除、奖励入金剔除、金额阈值', () => {
  const list = [
    tx(OTHER, ME, 500, 1),        // 充值 500
    tx(ME, OTHER, 120, 2),        // 提现 120
    tx(EXCHANGE, ME, 300, 3),     // 来自交易所合约 → 剔除
    tx(ME, EXCHANGE, 50, 4),      // 打给交易所合约 → 剔除
    tx(REWARD, ME, 40, 5),        // 奖励发放 → 剔除
    tx(ME, REWARD, 15, 6),        // 打给 RewardDistributor 的「提现」不剔除（SQL 只剔除 IN）
    tx(OTHER, ME, 9.99, 7),       // < 10 U → 剔除
    tx(OTHER, ME, 10, 8),         // 恰好 10 U → 计入
    { ...tx(OTHER, OTHER, 100, 9) }, // 与本钱包无关 → 跳过
  ];
  const r = flows.summarizeTransfers(ME, list);
  assert.strictEqual(flows.weiToDecimal(r.deposit), '510');
  assert.strictEqual(flows.weiToDecimal(r.withdraw), '135');
  assert.strictEqual(flows.weiToDecimal(r.net), '375');
  assert.deepStrictEqual(r.flows.map(f => f.tx_hash), ['0xhash8', '0xhash6', '0xhash2', '0xhash1']); // 时间倒序
  assert.strictEqual(r.flows[0].category, '充值 ←');
  assert.strictEqual(r.flows[1].category, '提现 →');
  assert.strictEqual(r.flows[1].counterparty, REWARD);
  assert.strictEqual(r.flows[0].amount_usdt, '10');
  assert.strictEqual(r.flows[0].block_time, new Date(1700000480 * 1000).toISOString());
});

test('summarizeTransfers：追加剔除地址通过 env 生效；decimals 不是 18 也能换算', () => {
  const lists = flows.buildLists({ USDT_FLOWS_EXTRA_MARKET_CONTRACTS: OTHER, USDT_FLOWS_EXTRA_EXCLUDE_INFLOW: '' });
  const r = flows.summarizeTransfers(ME, [tx(OTHER, ME, 500, 1)], { lists });
  assert.strictEqual(r.deposit, 0n);
  const six = { ...tx('0x2222222222222222222222222222222222222222', ME, 0, 2), value: '25000000', tokenDecimal: '6' }; // 25 USDT（6 位）
  assert.strictEqual(flows.weiToDecimal(flows.summarizeTransfers(ME, [six]).deposit), '25');
});

test('fetchAllTransfers：满页时按最后区块继续，跨窗口去重；不满页即停', async () => {
  const PAGE = flows.PAGE_SIZE;
  const page1 = Array.from({ length: PAGE }, (_, i) => tx(OTHER, ME, 20, i)); // blocks 1000..10999
  const lastBlock = Number(page1[page1.length - 1].blockNumber);
  const page2 = [page1[page1.length - 1], tx(OTHER, ME, 30, PAGE + 1)];       // 首条与上页末条重复
  const asked = [];
  const r = await flows.fetchAllTransfers(async ({ startblock }) => { asked.push(startblock); return startblock === 0 ? page1 : page2; });
  assert.deepStrictEqual(asked, [0, lastBlock]);
  assert.strictEqual(r.transfers.length, PAGE + 1);
  assert.strictEqual(r.windows, 2);
  assert.strictEqual(r.truncated, false);

  const single = await flows.fetchAllTransfers(async () => [tx(OTHER, ME, 20, 1)]);
  assert.strictEqual(single.windows, 1);
  const empty = await flows.fetchAllTransfers(async () => []);
  assert.strictEqual(empty.transfers.length, 0);
});

test('handler：非法地址 400；未配置 key → 500 提示；上游空结果 → 全 0', async () => {
  const handler = flows;
  const call = async (query) => {
    const res = { statusCode: 0, headers: {}, body: '', setHeader(k, v) { this.headers[k] = v; }, end(b) { this.body = b; } };
    await handler({ method: 'GET', query }, res);
    return { status: res.statusCode, json: JSON.parse(res.body) };
  };
  assert.strictEqual((await call({ address: 'nope' })).status, 400);
  const saved = { E: process.env.ETHERSCAN_API_KEY, B: process.env.BSCSCAN_API_KEY };
  delete process.env.ETHERSCAN_API_KEY; delete process.env.BSCSCAN_API_KEY;
  const realFetch = globalThis.fetch;
  try {
    const noKey = await call({ address: ME });
    assert.strictEqual(noKey.status, 500);
    assert.match(noKey.json.error, /ETHERSCAN_API_KEY/);

    process.env.ETHERSCAN_API_KEY = 'k';
    let seenUrl = null;
    globalThis.fetch = async (url) => { seenUrl = new URL(String(url)); return { ok: true, status: 200, text: async () => JSON.stringify({ status: '0', message: 'No transactions found', result: [] }) }; };
    const empty = await call({ address: ME, full: '1' });
    assert.strictEqual(empty.status, 200);
    assert.strictEqual(empty.json.deposit_usdt, '0');
    assert.strictEqual(empty.json.withdraw_usdt, '0');
    assert.strictEqual(empty.json.net_usdt, '0');
    assert.deepStrictEqual(empty.json.flows, []);
    assert.strictEqual(seenUrl.searchParams.get('chainid'), '56');
    assert.strictEqual(seenUrl.searchParams.get('action'), 'tokentx');
    assert.strictEqual(seenUrl.searchParams.get('contractaddress').toLowerCase(), '0x55d398326f99059ff775485246999027b3197955');
    assert.strictEqual(seenUrl.searchParams.get('apikey'), 'k');

    globalThis.fetch = async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ status: '0', message: 'NOTOK', result: 'Invalid API Key' }) });
    const bad = await call({ address: ME });
    assert.strictEqual(bad.status, 500);
    assert.match(bad.json.error, /Invalid API Key/);
  } finally {
    globalThis.fetch = realFetch;
    if (saved.E !== undefined) process.env.ETHERSCAN_API_KEY = saved.E; else delete process.env.ETHERSCAN_API_KEY;
    if (saved.B !== undefined) process.env.BSCSCAN_API_KEY = saved.B;
  }
});
