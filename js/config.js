// 配置持久化（localStorage）+ 导入/导出 JSON + 恢复默认。

import { $, debounce } from "./dom.js";
import { toast } from "./toast.js";
import { setWeekSelection, isAllWeeksSelected } from "./week.js";

const STORAGE_KEY = "yuce.config.v1";

const VALUE_IDS = [
  "wallets",
  "concurrency", "retries", "maxQps", "timeoutMs",
  "pointsMultiplier", "feeMultiplier",
  "apiTemplate", "tradesApiTemplate",
  "positionApiTemplate", "positionValuePaths", "pnlApiTemplate",
  "usdtAddress", "usdtDecimals", "rpcUrls", "proxyPrefix",
];
const CHECK_IDS = ["onlyCalculated", "liveRender", "queryShares", "queryHoldings", "queryPnl", "queryBalance"];

export function snapshotConfig() {
  const cfg = { values: {}, checks: {} };
  for (const id of VALUE_IDS) { const el = $(id); if (el) cfg.values[id] = el.value; }
  for (const id of CHECK_IDS) { const el = $(id); if (el) cfg.checks[id] = !!el.checked; }
  cfg.weeksAll = isAllWeeksSelected();
  cfg.weeks = $("weeks") ? $("weeks").value : "";
  return cfg;
}

export function applyConfig(cfg) {
  if (!cfg || typeof cfg !== "object") return;
  for (const [id, v] of Object.entries(cfg.values || {})) {
    const el = $(id);
    if (el && typeof v === "string") el.value = v;
  }
  for (const [id, v] of Object.entries(cfg.checks || {})) {
    const el = $(id);
    if (el) el.checked = !!v;
  }
  if ("weeks" in cfg || "weeksAll" in cfg) {
    setWeekSelection(cfg.weeksAll ? "" : String(cfg.weeks || ""));
  }
}

export function saveConfig() {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(snapshotConfig())); }
  catch { /* localStorage 不可用 / 满，静默忽略 */ }
}

export const saveConfigSoon = debounce(saveConfig, 300);

export function loadConfig() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return false;
    applyConfig(JSON.parse(raw));
    return true;
  } catch { return false; }
}

export function resetConfig() {
  try { localStorage.removeItem(STORAGE_KEY); } catch {}
  // HTML 属性里保存着默认值，整页刷新即恢复。
  location.reload();
}

export function exportConfig() {
  const blob = new Blob([JSON.stringify(snapshotConfig(), null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = "yuce-config.json";
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
  toast("配置已导出。", "success");
}

export async function importConfigFile(file) {
  try {
    const text = await file.text();
    applyConfig(JSON.parse(text));
    saveConfig();
    toast("配置已导入并保存。", "success");
    return true;
  } catch {
    toast("配置文件格式错误，导入失败。", "error");
    return false;
  }
}

// 为所有配置项挂自动保存。
export function attachConfigPersistence() {
  for (const id of [...VALUE_IDS, ...CHECK_IDS]) {
    const el = $(id);
    if (!el) continue;
    el.addEventListener("input", saveConfigSoon);
    el.addEventListener("change", saveConfigSoon);
  }
  // 周选择在面板里变化（change/click 都可能改选择），统一搭车保存。
  const weekPanel = $("weekPanel");
  if (weekPanel) {
    weekPanel.addEventListener("change", saveConfigSoon);
    weekPanel.addEventListener("click", saveConfigSoon);
  }
}
