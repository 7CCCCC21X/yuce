// 配置持久化（localStorage）+ 导入/导出 JSON + 恢复默认。

import { $, debounce } from "./dom.js";
import { toast } from "./toast.js";
import { setWeekSelection, isAllWeeksSelected } from "./week.js";

const STORAGE_KEY = "yuce.config.v1";

// 接口迁移：积分/份额接口域名从 tool.opinx.app 迁到 indexer.predalpha.xyz。
// 老用户的旧域名已存进 localStorage，加载时就地改写，使其自动切到新接口。
const LEGACY_API_HOST = "tool.opinx.app";
const NEW_API_HOST = "indexer.predalpha.xyz";

function migrateApiHost(cfg) {
  if (!cfg || !cfg.values) return false;
  let changed = false;
  for (const id of ["apiTemplate", "tradesApiTemplate"]) {
    const v = cfg.values[id];
    if (typeof v === "string" && v.includes(LEGACY_API_HOST)) {
      cfg.values[id] = v.replaceAll(LEGACY_API_HOST, NEW_API_HOST);
      changed = true;
    }
  }
  return changed;
}

// PNL 口径迁移：默认从 1 天（interval=_1D）改为全部（interval=ALL）。
// 旧版本只支持 _1D，老用户的模板已存进 localStorage，加载时就地改写。
function migratePnlInterval(cfg) {
  const v = cfg?.values?.pnlApiTemplate;
  if (typeof v === "string" && v.includes("interval=_1D")) {
    cfg.values.pnlApiTemplate = v.replaceAll("interval=_1D", "interval=ALL");
    return true;
  }
  return false;
}

// 钱包列表是一次性输入，而不是长期配置。地址非常多时（比如几万个），把整段
// 文本反复写进 localStorage 会让每次打开页面都要解析、回填、重扫上 MB 的文本，
// 每次输入又要同步重写整块数据，从而明显卡顿。超过此阈值就不再持久化钱包列表
// （其余配置照常保存）。约 2300 个地址。
export const MAX_PERSISTED_WALLETS_CHARS = 100000;

export function walletsTooLargeToPersist(value) {
  return typeof value === "string" && value.length > MAX_PERSISTED_WALLETS_CHARS;
}

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
  try {
    const cfg = snapshotConfig();
    // 钱包列表过大时不写入本地存储，避免下次打开 / 后续输入时卡顿。
    if (walletsTooLargeToPersist(cfg.values.wallets)) delete cfg.values.wallets;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(cfg));
  }
  catch { /* localStorage 不可用 / 满，静默忽略 */ }
}

export const saveConfigSoon = debounce(saveConfig, 300);

export function loadConfig() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return false;
    const cfg = JSON.parse(raw);
    // 兼容旧版本：清理早先存进来的超大钱包列表，否则它会被反复回填导致卡顿。
    let needsRewrite = false;
    if (cfg && cfg.values && walletsTooLargeToPersist(cfg.values.wallets)) {
      delete cfg.values.wallets;
      needsRewrite = true;
    }
    // 旧域名接口就地迁移到新域名。
    if (migrateApiHost(cfg)) needsRewrite = true;
    // PNL 默认口径迁移：_1D → ALL（全部）。
    if (migratePnlInterval(cfg)) needsRewrite = true;
    if (needsRewrite) { try { localStorage.setItem(STORAGE_KEY, JSON.stringify(cfg)); } catch {} }
    applyConfig(cfg);
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
    const cfg = JSON.parse(text);
    migrateApiHost(cfg);
    migratePnlInterval(cfg);
    applyConfig(cfg);
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
