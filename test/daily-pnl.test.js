// 每日盈亏（北京时间切日）与星期汇总。
const test = require('node:test');
const assert = require('node:assert');

const H = 3600, D = 86400;
// 2026-11-02 是周一。北京 00:00 = 前一天 UTC 16:00。
const MON = Date.UTC(2026, 10, 2) / 1000 - 8 * H;

test('beijingDayStart / beijingDateInfo', async () => {
  const m = await import('../js/daily-pnl.js');
  assert.strictEqual(m.beijingDayStart(MON + 5 * H), MON);
  assert.strictEqual(m.beijingDayStart(MON - 1), MON - D);
  assert.deepStrictEqual(m.beijingDateInfo(MON), { date: '2026-11-02', weekday: 0, weekdayName: '周一' });
  assert.strictEqual(m.beijingDateInfo(MON + 6 * D).weekdayName, '周日');
});

test('dailyPnlFromPoints：次日零点累计 − 当天零点累计；小时级时序都完整', async () => {
  const { dailyPnlFromPoints } = await import('../js/daily-pnl.js');
  // 每小时一个点：周一 0 点累计 -1000，周二 0 点 -1200，周三 0 点 -1100，周三 23 点 -1100。
  const pts = [];
  for (let t = MON; t <= MON + 3 * D - H; t += H) {
    const day = Math.floor((t - MON) / D);
    const y = day === 0 ? -1000 - 200 * ((t - MON) / D) : day === 1 ? -1200 + 100 * ((t - MON - D) / D) : -1100;
    pts.push({ x: t * 1000, y }); // 毫秒也能识别
  }
  pts.push({ x: (MON + 3 * D) * 1000, y: -1100 });
  const rows = dailyPnlFromPoints(pts, { nowSec: MON + 10 * D });
  assert.deepStrictEqual(rows.map(r => [r.date, r.weekday_name, r.pnl, r.complete]).slice(0, 3), [
    ['2026-11-02', '周一', -200, true],
    ['2026-11-03', '周二', 100, true],
    ['2026-11-04', '周三', 0, true],
  ]);
  assert.strictEqual(rows[0].cumulative, -1200);
});

test('粒度不足、未结束、起点推定都会标出', async () => {
  const { dailyPnlFromPoints } = await import('../js/daily-pnl.js');
  // 每天只有 UTC 0 点一个点（= 北京 08:00），离北京零点 8 小时。
  const daily = [0, 1, 2].map(i => ({ x: MON + 8 * H + i * D, y: -10 * i }));
  const rows = dailyPnlFromPoints(daily, { nowSec: MON + 10 * D });
  assert.ok(rows[0].flags.includes('起点推定'));
  assert.ok(rows[1].flags.includes('边界粗'));
  assert.ok(rows.every(r => !r.complete));
  // 当天没过完
  const today = dailyPnlFromPoints([{ x: MON, y: 0 }, { x: MON + 5 * H, y: 3 }], { nowSec: MON + 6 * H });
  assert.strictEqual(today.length, 1);
  assert.ok(today[0].flags.includes('未结束'));
  assert.strictEqual(today[0].pnl, 3);
});

test('mergeDailyRows 与 weekdaySummary', async () => {
  const { mergeDailyRows, weekdaySummary } = await import('../js/daily-pnl.js');
  const a = [{ day_start: MON, date: '2026-11-02', weekday: 0, weekday_name: '周一', pnl: -200, cumulative: -1200, complete: true, flags: '' },
             { day_start: MON + D, date: '2026-11-03', weekday: 1, weekday_name: '周二', pnl: 50, cumulative: -1150, complete: true, flags: '' }];
  const b = [{ day_start: MON, date: '2026-11-02', weekday: 0, weekday_name: '周一', pnl: 30, cumulative: 30, complete: false, flags: '边界粗' }];
  const merged = mergeDailyRows([a, b]);
  assert.strictEqual(merged[0].pnl, -170);
  assert.strictEqual(merged[0].complete, false);
  assert.strictEqual(merged[0].wallets, 2);
  const s = weekdaySummary(merged);
  assert.strictEqual(s[0].days, 0);               // 周一不完整，不计
  assert.strictEqual(s[1].days, 1);
  assert.strictEqual(s[1].profit_sum, 50);
  const all = weekdaySummary(merged, { onlyComplete: false });
  assert.strictEqual(all[0].loss_days, 1);
  assert.strictEqual(all[0].loss_sum, -170);
  assert.strictEqual(all[0].avg, -170);
});
