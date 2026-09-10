// 展示格式化与指标计算（积分成本 / 盈亏积分成本 / 量分比等）。

export function num(value, fallback = 0) { const n = Number(value); return Number.isFinite(n) ? n : fallback; }
export function formatTwoDecimal(value) { const n = Number(String(value ?? "").replace(/,/g, "")); return Number.isFinite(n) ? n.toFixed(2) : "—"; }
export function formatMoney(value) { const n = Number(String(value ?? "").replace(/,/g, "")); return Number.isFinite(n) ? n.toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : "—"; }
export function signedMoney(value) { const n = Number(String(value ?? "").replace(/,/g, "")); if (!Number.isFinite(n)) return "—"; return (n > 0 ? "+" : "") + n.toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
export function timestampToUTC8(ts) { const n = Number(ts); return Number.isFinite(n) ? new Date((n + 8 * 3600) * 1000).toISOString().replace("T", " ").slice(0, 19) : ""; }
export function joinErrors(...parts) { return parts.filter(Boolean).join(" | "); }

export function computeCostPerPoint(pointsStr, costStr) {
  const p = Number(pointsStr || "0"), c = Number(costStr || "0");
  if (!isFinite(p) || !isFinite(c) || p < 0 || c < 0) return "";
  if (p === 0 && c === 0) return "";
  if (p === 0) return "Infinity";
  if (c === 0) return "0";
  return String(c / p);
}

// 盈亏积分成本：按官网 PNL 与钱包总积分计算，成本 = -PNL / 总积分（亏损为正成本，盈利为负成本）。
// PNL 缺失（未取到）返回 ""；积分为 0 且 PNL 非 0 返回 "Infinity"。
export function computePnlCostPerPoint(pointsStr, pnlStr) {
  if (pnlStr === "" || pnlStr === undefined || pnlStr === null) return "";
  const p = Number(pointsStr || "0"), pnl = Number(pnlStr);
  if (!isFinite(p) || !isFinite(pnl) || p < 0) return "";
  if (p === 0 && pnl === 0) return "";
  if (p === 0) return "Infinity";
  if (pnl === 0) return "0";
  return String(-pnl / p);
}

// 从累计 PNL 时序（[{x, y}]，y 为累计盈亏）切出一周的盈亏：
// 周 PNL = 周末时刻的累计值 − 周初时刻的累计值。某时刻的累计值取该时刻之前（含）最后一个点；
// 时刻早于第一个点视为 0（账户尚无盈亏）；周末在未来时自然取到最新点（即本周至今）。
// x 支持秒或毫秒（>1e11 视为毫秒）；无时序或缺时间戳返回 ""。
export function weeklyPnlFromPoints(points, startTs, endTs) {
  if (!Array.isArray(points) || !points.length) return "";
  const start = Number(startTs), end = Number(endTs);
  if (!Number.isFinite(start) || !Number.isFinite(end) || startTs === "" || endTs === "") return "";
  const norm = [];
  for (const pt of points) {
    let x = Number(pt && pt.x), y = Number(pt && pt.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    if (x > 1e11) x = x / 1000;
    norm.push({ x, y });
  }
  if (!norm.length) return "";
  norm.sort((a, b) => a.x - b.x);
  const cumAt = t => { let v = 0; for (const pt of norm) { if (pt.x <= t) v = pt.y; else break; } return v; };
  const diff = cumAt(end) - cumAt(start);
  // 避免浮点尾差把 0 显示成 1e-13。
  return String(Number(diff.toFixed(8)));
}

export function computeVolumePerPoint(pointsStr, volumeStr) {
  const p = Number(pointsStr || "0"), v = Number(volumeStr || "0");
  if (!isFinite(p) || !isFinite(v) || p < 0 || v < 0) return "";
  if (p === 0 && v === 0) return "";
  if (p === 0) return "Infinity";
  return String(v / p);
}

export function computeOptionalVolumePerPoint(pointsStr, volumeStr) {
  if (volumeStr === "" || volumeStr === undefined || volumeStr === null) return "";
  return computeVolumePerPoint(pointsStr, volumeStr);
}

export function formatCostPerPoint(s) {
  if (s === "" || s === undefined || s === null) return "—";
  if (s === "Infinity") return "无积分";
  const n = Number(s);
  if (!isFinite(n) || n < 0) return "—";
  if (n === 0) return "免费";
  if (n >= 1) return "$" + n.toFixed(2);
  if (n >= 0.01) return "$" + n.toFixed(4);
  if (n >= 0.0001) return "$" + n.toFixed(5);
  return "$" + n.toExponential(2);
}

// 盈亏积分成本展示：负数表示每积分净盈利，前面带 "-" 号。
export function formatPnlCostPerPoint(s) {
  if (s === "" || s === undefined || s === null) return "—";
  if (s === "Infinity") return "无积分";
  const n = Number(s);
  if (!Number.isFinite(n)) return "—";
  if (n === 0) return "免费";
  const abs = Math.abs(n);
  const body = abs >= 1 ? abs.toFixed(2) : abs >= 0.01 ? abs.toFixed(4) : abs >= 0.0001 ? abs.toFixed(5) : abs.toExponential(2);
  return (n < 0 ? "-$" : "$") + body;
}

export function formatVolumePerPoint(s) {
  if (s === "" || s === undefined || s === null) return "—";
  if (s === "Infinity") return "无积分";
  const n = Number(s);
  return Number.isFinite(n) && n >= 0 ? n.toFixed(2) : "—";
}

export function isValidCpp(v) {
  if (v === "" || v === undefined || v === null || v === "Infinity") return false;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0;
}

export function cppSortValue(v) {
  if (v === "" || v === undefined || v === null || v === "Infinity") return Number.POSITIVE_INFINITY;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : Number.POSITIVE_INFINITY;
}

export function isValidPnlCpp(v) {
  if (v === "" || v === undefined || v === null || v === "Infinity") return false;
  return Number.isFinite(Number(v));
}

// 盈亏积分成本允许负值（盈利）；缺失 / 无积分排到最后。
export function pnlCppSortValue(v) {
  if (v === "" || v === undefined || v === null || v === "Infinity") return Number.POSITIVE_INFINITY;
  const n = Number(v);
  return Number.isFinite(n) ? n : Number.POSITIVE_INFINITY;
}

export function vppSortValue(v) {
  if (v === "" || v === undefined || v === null || v === "Infinity") return Number.POSITIVE_INFINITY;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : Number.POSITIVE_INFINITY;
}

export function shortWallet(addr) { return addr && addr.length >= 12 ? `${addr.slice(0, 6)}…${addr.slice(-4)}` : (addr || ""); }
export function walletPortfolioUrl(wallet) { return `https://predict.fun/zh-cn/portfolio/${encodeURIComponent(String(wallet || "").toLowerCase())}`; }

export function csvEscape(value) { const s = String(value ?? ""); return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; }

// 统计卡展示用：最多 dp 位小数并去掉尾零（Number 精度足够展示用途）。
export function trimNumber(n, dp = 6) {
  if (!Number.isFinite(n)) return "0";
  return String(Number(n.toFixed(dp)));
}
