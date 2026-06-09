// 展示格式化与指标计算（积分成本 / 量分比等）。

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
