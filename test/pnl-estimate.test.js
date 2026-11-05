// 推算盈亏 = 持仓 + 余额 − 净入金；持仓来源开关。
// 运行：npm test

const test = require('node:test');
const assert = require('node:assert');

function installDom(values = {}) {
  const els = {};
  globalThis.document = { getElementById: id => (id in values ? (els[id] ||= { value: String(values[id]), checked: !!values[id] }) : null) };
  globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
  return els;
}

test('computePnlEstimate：三项齐全才算，带负数与小数', async () => {
  installDom();
  const { computePnlEstimate, assetFields } = await import('../js/rows.js');
  assert.strictEqual(computePnlEstimate('271.03', '128.5', '500'), '-100.47');
  assert.strictEqual(computePnlEstimate('0', '1000', '-200'), '1200'); // 净入金为负（提现多于充值）
  assert.strictEqual(computePnlEstimate('', '1', '1'), '');
  assert.strictEqual(computePnlEstimate('1', '1', ''), '');
  const a = assetFields({ holding_amount_usdt: '271.03', name: 'n' }, { available_balance_usdt: '128.5' }, { pnl: '' }, { deposit_usdt: '600', withdraw_usdt: '100', net_usdt: '500' });
  assert.strictEqual(a.pnl_estimate_usdt, '-100.47');
  assert.strictEqual(a.net_deposit_usdt, '500');
  const b = assetFields({ holding_amount_usdt: '1' }, { available_balance_usdt: '' }, { pnl: '' }, { deposit_usdt: '', withdraw_usdt: '', net_usdt: '' });
  assert.strictEqual(b.pnl_estimate_usdt, '');
});

test('buildSummaryRows：推算盈亏按钱包沿用', async () => {
  installDom();
  const { buildSummaryRows } = await import('../js/rows.js');
  const row = { wallet: '0xabc', status: 'ok', week: 1, calculated: 'true', total_points: '1', points: '1', cost_usdt: '0', paid_fee_usdt: '0', trade_count: '0', paid_volume_usdt: '0', free_volume_usdt: '0', total_volume_usdt: '0', total_volume_shares: '', referral_points: '0', all_fee_usdt: '0', holding_amount_usdt: '10', available_balance_usdt: '5', net_asset_usdt: '15', pnl: '', week_pnl: '', deposit_usdt: '20', withdraw_usdt: '2', net_deposit_usdt: '18', pnl_estimate_usdt: '-3', error: '' };
  const s = buildSummaryRows([row])[0];
  assert.strictEqual(s.pnl_estimate_usdt, '-3');
});

test('makePositionUrl：按持仓来源切换 GraphQL / REST / 自定义模板', async () => {
  const els = installDom({ holdingsSource: 'graphql', positionApiTemplate: 'https://x/{wallet}' });
  const api = await import('../js/api.js');
  assert.strictEqual(api.makePositionUrl('0xabc'), '/api/portfolio?address=0xabc');
  els.holdingsSource.value = 'rest';
  assert.strictEqual(api.makePositionUrl('0xabc'), '/api/positions-value?address=0xabc');
  els.holdingsSource.value = 'custom';
  assert.strictEqual(api.makePositionUrl('0xabc'), 'https://x/0xabc');
});
