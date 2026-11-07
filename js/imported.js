// 导入「官网数据导出文件」：scripts/predict-console-export.js 在 predict.fun 页面上
// 批量查 GraphQL 后下载的 JSON。导入后，查询时持仓金额 / 用户名 / 官网 PNL 优先用
// 导入数据，不再请求 /api/portfolio、/api/portfolio-pnl（被 Cloudflare 拦时的替代路径）。

import { $ } from "./dom.js";
import { normalizeDecimal } from "./decimal.js";

const STORAGE_KEY = "yuce.import.v1";
// 超过这个大小就不写 localStorage（避免卡顿 / 超配额），只在本次会话内有效。
const MAX_PERSIST_CHARS = 3_000_000;

const store = { wallets: new Map(), exportedAt: "", source: "", fileName: "" };

export function normalizeImportedEntry(raw) {
  if (!raw || typeof raw !== "object") return null;
  const num = v => (v === undefined || v === null || v === "" ? "" : normalizeDecimal(v));
  const points = Array.isArray(raw.pnl_points)
    ? raw.pnl_points.map(p => ({ x: Number(p?.x), y: Number(p?.y) })).filter(p => Number.isFinite(p.x) && Number.isFinite(p.y))
    : [];
  return {
    address: String(raw.address || ""),
    name: raw.name === undefined || raw.name === null ? "" : String(raw.name),
    positionsValueUsd: num(raw.positionsValueUsd),
    pnlUsd: num(raw.pnlUsd),
    totalPoints: num(raw.totalPoints),
    rank: raw.rank === undefined || raw.rank === null ? "" : String(raw.rank),
    pnl_points: points,
    error: raw.error ? String(raw.error) : ""
  };
}

// 解析导出文件内容；格式不对会抛错（给 toast 用）。返回导入的钱包数。
export function loadImportedText(text, fileName = "") {
  let data;
  try { data = JSON.parse(text); } catch { throw new Error("不是合法的 JSON 文件"); }
  if (!data || typeof data !== "object" || data.format !== "yuce-portfolio-export" || !data.wallets || typeof data.wallets !== "object") {
    throw new Error("不是 yuce 官网数据导出文件（format 应为 yuce-portfolio-export）");
  }
  const wallets = new Map();
  for (const [key, raw] of Object.entries(data.wallets)) {
    const entry = normalizeImportedEntry(raw);
    if (!entry) continue;
    const k = String(key || entry.address).trim().toLowerCase();
    if (/^0x[0-9a-f]{40}$/.test(k)) wallets.set(k, entry);
  }
  store.wallets = wallets;
  store.exportedAt = typeof data.exported_at === "string" ? data.exported_at : "";
  store.source = typeof data.source === "string" ? data.source : "";
  store.fileName = fileName;
  persist(text);
  return wallets.size;
}

export async function loadImportedFile(file) {
  const text = await file.text();
  return loadImportedText(text, file.name || "");
}

function persist(text) {
  try {
    if (text.length > MAX_PERSIST_CHARS) { localStorage.removeItem(STORAGE_KEY); return; }
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ fileName: store.fileName, text }));
  } catch { /* 配额不够等，静默 */ }
}

// 页面加载时恢复上次导入的数据。
export function restoreImported() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return 0;
    const saved = JSON.parse(raw);
    if (!saved || typeof saved.text !== "string") return 0;
    return loadImportedText(saved.text, saved.fileName || "");
  } catch { return 0; }
}

export function clearImported() {
  store.wallets = new Map();
  store.exportedAt = ""; store.source = ""; store.fileName = "";
  try { localStorage.removeItem(STORAGE_KEY); } catch {}
}

export function importedCount() { return store.wallets.size; }
// 全部导入的钱包：[[小写地址, entry], ...]（每日盈亏页用）。
export function importedEntries() { return [...store.wallets.entries()]; }
export function importedInfo() { return { count: store.wallets.size, exportedAt: store.exportedAt, source: store.source, fileName: store.fileName }; }

// 是否启用导入数据（设置里的开关，没有该元素时视为启用）。
export function useImported() { const el = $("useImported"); return !el || el.checked; }
// 导入数据里没有这个钱包时，是否回退到接口。
export function importedFallback() { const el = $("importedFallback"); return !el || el.checked; }

export function importedFor(wallet) {
  if (!useImported() || !store.wallets.size) return null;
  return store.wallets.get(String(wallet || "").trim().toLowerCase()) || null;
}

// 导入数据已启用且非空，但这个钱包不在其中、又不允许回退 → 返回要显示的错误文案。
export function importedMissMessage(wallet) {
  if (!useImported() || !store.wallets.size || importedFallback()) return "";
  return importedFor(wallet) ? "" : "导入的官网数据里没有这个钱包";
}

export function describeImported() {
  const info = importedInfo();
  if (!info.count) return "未导入。";
  const when = info.exportedAt ? new Date(info.exportedAt) : null;
  const whenText = when && !Number.isNaN(when.getTime()) ? when.toLocaleString("zh-CN", { hour12: false }) : "";
  return `已导入 ${info.count} 个钱包${info.fileName ? `（${info.fileName}）` : ""}${whenText ? `，导出于 ${whenText}` : ""}。`;
}
