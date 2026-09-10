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

test('weeklyPnlFromPoints: 按累计时序切出周 PNL', async () => {
  const { weeklyPnlFromPoints } = await import('../js/format.js');
  // 日级累计 PNL：第 0 天 0，第 1 天 +10，第 3 天 +25，第 8 天 +20
  const day = 86400, base = 1_700_000_000; // 真实秒级时间戳量级
  const pts = [{ x: base, y: 0 }, { x: base + day, y: 10 }, { x: base + 3 * day, y: 25 }, { x: base + 8 * day, y: 20 }];
  // 周 [day, 8day]：25→20 之间起点累计 10，终点累计 20 → +10
  assert.strictEqual(weeklyPnlFromPoints(pts, base + day, base + 8 * day), '10');
  // 周 [2day, 5day]：起点累计取 day 的 10，终点取 3day 的 25 → +15
  assert.strictEqual(weeklyPnlFromPoints(pts, base + 2 * day, base + 5 * day), '15');
  // 周末在未来 → 取最新点；周初早于所有点 → 0
  assert.strictEqual(weeklyPnlFromPoints(pts, base - day, base + 100 * day), '20');
  // 整周都早于账户历史 → 0
  assert.strictEqual(weeklyPnlFromPoints(pts, base - 10 * day, base - 5 * day), '0');
  // 毫秒时间戳的点也能对上秒级周时间
  const ms = pts.map(p => ({ x: p.x * 1000, y: p.y }));
  assert.strictEqual(weeklyPnlFromPoints(ms, base + 2 * day, base + 5 * day), '15');
  // 无时序 / 缺时间戳 → ""
  assert.strictEqual(weeklyPnlFromPoints([], base + day, base + 2 * day), '');
  assert.strictEqual(weeklyPnlFromPoints(pts, '', base + 2 * day), '');
});
