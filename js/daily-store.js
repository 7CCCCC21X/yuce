// 每日盈亏页自己的数据存储，与主页面的「导入官网数据」互不影响。
// 可多次导入，按地址合并（同一地址以后导入的为准）；单独清除。

import { normalizeImportedEntry } from "./imported.js";

export const DAILY_STORAGE_KEY = "yuce.daily.v1";
const MAX_PERSIST_CHARS = 4_000_000;

const store = new Map(); // 小写地址 → { entry, fileName, importedAt }

function persist() {
  try {
    const data = JSON.stringify([...store.entries()]);
    if (data.length > MAX_PERSIST_CHARS) { localStorage.removeItem(DAILY_STORAGE_KEY); return false; }
    localStorage.setItem(DAILY_STORAGE_KEY, data);
    return true;
  } catch { return false; }
}

export function restoreDaily() {
  store.clear();
  try {
    const raw = localStorage.getItem(DAILY_STORAGE_KEY);
    if (!raw) return 0;
    for (const [k, v] of JSON.parse(raw)) if (v && v.entry) store.set(k, v);
  } catch { /* 损坏的缓存直接忽略 */ }
  return store.size;
}

// 解析导出文件并合并进来。返回 { added, updated, total, persisted }。
export function addDailyText(text, fileName = "") {
  let data;
  try { data = JSON.parse(text); } catch { throw new Error("不是合法的 JSON 文件"); }
  if (!data || data.format !== "yuce-portfolio-export" || !data.wallets || typeof data.wallets !== "object") {
    throw new Error("不是 yuce 官网数据导出文件（format 应为 yuce-portfolio-export）");
  }
  let added = 0, updated = 0;
  const importedAt = new Date().toISOString();
  for (const [key, raw] of Object.entries(data.wallets)) {
    const entry = normalizeImportedEntry(raw);
    if (!entry) continue;
    const k = String(key || entry.address).trim().toLowerCase();
    if (!/^0x[0-9a-f]{40}$/.test(k)) continue;
    if (store.has(k)) updated += 1; else added += 1;
    store.set(k, { entry, fileName, importedAt });
  }
  const persisted = persist();
  return { added, updated, total: store.size, persisted };
}

export async function addDailyFile(file) { return addDailyText(await file.text(), file.name || ""); }

// 把一组 [地址, entry]（例如主页面已导入的数据）合并进来。
export function addDailyEntries(entries, fileName = "主页面导入数据") {
  let n = 0;
  const importedAt = new Date().toISOString();
  for (const [k, entry] of entries) { if (entry && entry.pnl_points && entry.pnl_points.length) { store.set(k, { entry, fileName, importedAt }); n += 1; } }
  persist();
  return n;
}

export function removeDaily(addr) { const ok = store.delete(String(addr).toLowerCase()); persist(); return ok; }
export function clearDaily() { store.clear(); try { localStorage.removeItem(DAILY_STORAGE_KEY); } catch {} }
export function dailyEntries() { return [...store.entries()].map(([k, v]) => [k, v.entry]); }
export function dailyCount() { return store.size; }

export function describeDaily() {
  if (!store.size) return "本页还没有数据。导入数据文件，或输入地址查询。";
  const files = new Set([...store.values()].map(v => v.fileName).filter(Boolean));
  return `本页已有 ${store.size} 个地址的数据${files.size ? `，来自 ${[...files].slice(0, 3).join("、")}${files.size > 3 ? ` 等 ${files.size} 个文件` : ""}` : ""}。`;
}
