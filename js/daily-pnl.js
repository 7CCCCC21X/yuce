// 每日盈亏 + 星期分布（纯计算，无 DOM）。
//
// 输入：累计 PNL 时序 points: [{ x: 时间戳(秒或毫秒), y: 累计盈亏 }]。
// 口径：北京时间（UTC+8）每天 00:00 至次日 00:00。
//   当天盈亏 = 次日零点累计PNL − 当天零点累计PNL
//   某时刻的累计PNL = 该时刻及之前最后一个点的 y（阶梯取值，与周 PNL 同口径）。
//
// 数据是否完整（每天单独判断）：
//   - 「未结束」：当天还没过完，或时序最后一个点早于当天结束 → 单独标出，不计入星期汇总。
//   - 「边界粗」：取值用的点离零点太远（默认 > 3 小时），说明时序粒度不够细，
//     这一天的盈亏可能被划到相邻日期。比如只有每天一个 UTC 0 点的点，北京时间就切不准。
//   - 「起点推定」：当天零点之前没有任何点，按 0 起算（账户此前无历史）。
//   缺失日期不会被记成 0：没有数据覆盖的日期只在「边界粗」里体现。

export const BEIJING_OFFSET_SEC = 8 * 3600;
export const DAY_SEC = 86400;
export const WEEKDAY_NAMES = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"];

export function normalizePoints(points) {
  const out = [];
  for (const pt of Array.isArray(points) ? points : []) {
    let x = Number(pt && pt.x), y = Number(pt && pt.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    if (x > 1e11) x = x / 1000; // 毫秒 → 秒
    out.push({ x, y });
  }
  out.sort((a, b) => a.x - b.x);
  return out;
}

// 北京时间某天零点（UTC 秒）。
export function beijingDayStart(ts) {
  return Math.floor((ts + BEIJING_OFFSET_SEC) / DAY_SEC) * DAY_SEC - BEIJING_OFFSET_SEC;
}

// 北京日期字符串 YYYY-MM-DD 与星期下标（0 = 周一）。
export function beijingDateInfo(dayStart) {
  const d = new Date((dayStart + BEIJING_OFFSET_SEC) * 1000);
  const date = d.toISOString().slice(0, 10);
  const weekday = (d.getUTCDay() + 6) % 7;
  return { date, weekday, weekdayName: WEEKDAY_NAMES[weekday] };
}

// 时序中位间隔（秒），用来提示数据粒度。
export function medianIntervalSec(points) {
  const pts = normalizePoints(points);
  if (pts.length < 2) return null;
  const gaps = [];
  for (let i = 1; i < pts.length; i++) gaps.push(pts[i].x - pts[i - 1].x);
  gaps.sort((a, b) => a - b);
  return gaps[Math.floor(gaps.length / 2)];
}

function round8(n) { return Number(Number(n).toFixed(8)); }

// 单个地址的每日盈亏。opts.toleranceSec：边界点允许离零点多远（默认 3 小时）；opts.nowSec：当前时间（测试用）。
export function dailyPnlFromPoints(points, { toleranceSec = 3 * 3600, nowSec = Date.now() / 1000 } = {}) {
  const pts = normalizePoints(points);
  if (!pts.length) return [];
  const lastX = pts[pts.length - 1].x;
  // 在 t 时刻的累计值，以及取值所用点的时间（null = 之前没有点）。
  let idx = -1;
  const valueAt = t => {
    while (idx + 1 < pts.length && pts[idx + 1].x <= t) idx++;
    return idx >= 0 ? { y: pts[idx].y, at: pts[idx].x } : { y: 0, at: null };
  };
  const rows = [];
  const firstDay = beijingDayStart(pts[0].x);
  const lastDay = beijingDayStart(lastX);
  let start = valueAt(firstDay);
  for (let day = firstDay; day <= lastDay; day += DAY_SEC) {
    const end = valueAt(day + DAY_SEC);
    const flags = [];
    const unfinished = day + DAY_SEC > nowSec || day + DAY_SEC > lastX + toleranceSec;
    if (unfinished) flags.push("未结束");
    if (start.at === null) flags.push("起点推定");
    else if (day - start.at > toleranceSec) flags.push("边界粗");
    if (!unfinished && end.at !== null && day + DAY_SEC - end.at > toleranceSec && !flags.includes("边界粗")) flags.push("边界粗");
    const info = beijingDateInfo(day);
    rows.push({
      day_start: day,
      date: info.date,
      weekday: info.weekday,
      weekday_name: info.weekdayName,
      pnl: round8(end.y - start.y),
      cumulative: round8(end.y),
      complete: !flags.includes("未结束") && !flags.includes("边界粗"),
      flags: flags.join("、"),
    });
    start = end;
  }
  return rows;
}

// 多地址同一天合并：盈亏与累计相加；任一地址不完整则该天不完整。
export function mergeDailyRows(rowsByWallet) {
  const map = new Map();
  for (const rows of rowsByWallet) {
    for (const r of rows) {
      const m = map.get(r.date) || { ...r, pnl: 0, cumulative: 0, complete: true, flags: new Set(), wallets: 0 };
      m.pnl = round8(m.pnl + r.pnl);
      m.cumulative = round8(m.cumulative + r.cumulative);
      m.complete = m.complete && r.complete;
      if (r.flags) for (const f of r.flags.split("、")) m.flags.add(f);
      m.wallets += 1;
      map.set(r.date, m);
    }
  }
  return [...map.values()].sort((a, b) => a.day_start - b.day_start).map(m => ({ ...m, flags: [...m.flags].join("、") }));
}

// 星期汇总（默认只统计完整的天）。
export function weekdaySummary(rows, { onlyComplete = true } = {}) {
  const out = WEEKDAY_NAMES.map((name, weekday) => ({ weekday, weekday_name: name, days: 0, profit_days: 0, loss_days: 0, flat_days: 0, profit_sum: 0, loss_sum: 0, net: 0, avg: null, worst: null, best: null }));
  for (const r of rows) {
    if (onlyComplete && !r.complete) continue;
    const s = out[r.weekday];
    s.days += 1;
    if (r.pnl > 0) { s.profit_days += 1; s.profit_sum = round8(s.profit_sum + r.pnl); }
    else if (r.pnl < 0) { s.loss_days += 1; s.loss_sum = round8(s.loss_sum + r.pnl); }
    else s.flat_days += 1;
    s.net = round8(s.net + r.pnl);
    if (s.worst === null || r.pnl < s.worst.pnl) s.worst = { date: r.date, pnl: r.pnl };
    if (s.best === null || r.pnl > s.best.pnl) s.best = { date: r.date, pnl: r.pnl };
  }
  for (const s of out) s.avg = s.days ? round8(s.net / s.days) : null;
  return out;
}
