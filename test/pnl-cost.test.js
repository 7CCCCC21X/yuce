// 盈亏积分成本（-PNL / 积分）计算与展示 单元测试。
// 运行：npm test （即 node --test test/）

const test = require('node:test');
const assert = require('node:assert');

test('computePnlCostPerPoint / formatPnlCostPerPoint / pnlCppSortValue', async () => {
  const { computePnlCostPerPoint, formatPnlCostPerPoint, isValidPnlCpp, pnlCppSortValue } = await import('../js/format.js');

  // 亏损 100 U、10000 积分 → 每积分成本 0.01
  assert.strictEqual(computePnlCostPerPoint('10000', '-100'), '0.01');
  // 盈利 50 U、10000 积分 → 每积分 -0.005（负成本 = 净盈利）
  assert.strictEqual(computePnlCostPerPoint('10000', '50'), '-0.005');
  assert.strictEqual(computePnlCostPerPoint('10000', '0'), '0');
  assert.strictEqual(computePnlCostPerPoint('0', '-5'), 'Infinity');
  assert.strictEqual(computePnlCostPerPoint('0', '0'), '');
  // PNL 未取到 → 空
  assert.strictEqual(computePnlCostPerPoint('10000', ''), '');
  assert.strictEqual(computePnlCostPerPoint('10000', null), '');
  assert.strictEqual(computePnlCostPerPoint('10000', 'abc'), '');

  assert.strictEqual(formatPnlCostPerPoint(''), '—');
  assert.strictEqual(formatPnlCostPerPoint('Infinity'), '无积分');
  assert.strictEqual(formatPnlCostPerPoint('0'), '免费');
  assert.strictEqual(formatPnlCostPerPoint('0.01'), '$0.0100');
  assert.strictEqual(formatPnlCostPerPoint('-0.005'), '-$0.00500');
  assert.strictEqual(formatPnlCostPerPoint('1.5'), '$1.50');
  assert.strictEqual(formatPnlCostPerPoint('0.00002'), '$2.00e-5');

  assert.strictEqual(isValidPnlCpp('-0.005'), true);
  assert.strictEqual(isValidPnlCpp('Infinity'), false);
  assert.strictEqual(isValidPnlCpp(''), false);

  assert.strictEqual(pnlCppSortValue('-0.005'), -0.005);
  assert.strictEqual(pnlCppSortValue(''), Number.POSITIVE_INFINITY);
  assert.strictEqual(pnlCppSortValue('Infinity'), Number.POSITIVE_INFINITY);
});
