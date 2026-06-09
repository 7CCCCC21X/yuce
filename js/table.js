// 表格渲染、筛选/排序、统计卡更新。

import { $, copyText } from "./dom.js";
import { toast } from "./toast.js";
import {
  state, numericKeys, CPP_KEYS, VPP_KEYS, MONEY_KEYS, PNL_KEYS, TWO_DECIMAL_KEYS,
  detailColumns, summaryColumns, MAX_RENDER_ROWS, RENDER_INTERVAL_MS
} from "./state.js";
import {
  num, formatTwoDecimal, formatMoney, signedMoney, trimNumber,
  formatCostPerPoint, formatVolumePerPoint, isValidCpp, cppSortValue, vppSortValue,
  computeCostPerPoint, shortWallet, walletPortfolioUrl
} from "./format.js";
import { buildSummaryRows, findBestWallet } from "./rows.js";
import { shouldQueryPnl } from "./api.js";

// ---------- 筛选 / 排序 ----------

// 全文搜索串按行缓存；行数据变化时（如 PNL 回填）置空 _search 失效。
function rowSearchText(row) {
  if (row._search == null) {
    let s = "";
    for (const [k, v] of Object.entries(row)) {
      if (k === "_search" || v === null || v === undefined) continue;
      s += String(v).toLowerCase() + "\u0000";
    }
    row._search = s;
  }
  return row._search;
}

export function filterRows(rows, tableKey) {
  let result = rows;
  if (state.onlyFailed) result = result.filter(r => r.status === "error");
  if (state.onlyCalculated) {
    if (tableKey === "detail") result = result.filter(r => String(r.calculated).toLowerCase() === "true");
    else result = result.filter(r => String(r.calculated_all).toLowerCase() === "true");
  }
  if (state.minPoints > 0) result = result.filter(r => num(r.points) >= state.minPoints);
  if (state.minBalance > 0) result = result.filter(r => num(r.available_balance_usdt) >= state.minBalance);
  if (state.minHolding > 0) result = result.filter(r => num(r.holding_amount_usdt) >= state.minHolding);
  if (state.maxHolding > 0) result = result.filter(r => num(r.holding_amount_usdt) <= state.maxHolding);
  if (state.minNetAsset > 0) result = result.filter(r => num(r.net_asset_usdt) >= state.minNetAsset);
  if (state.maxNetAsset > 0) result = result.filter(r => num(r.net_asset_usdt) <= state.maxNetAsset);
  if (state.maxReferralPoints > 0) result = result.filter(r => num(r.referral_points) <= state.maxReferralPoints);
  if (state.maxCpp > 0) result = result.filter(r => isValidCpp(r.cost_per_point) && Number(r.cost_per_point) <= state.maxCpp);
  const q = state.filterText.trim().toLowerCase();
  if (!q) return result;
  return result.filter(row => rowSearchText(row).includes(q));
}

export function sortRows(rows, sortState) {
  if (!sortState.key) return rows;
  const key = sortState.key;
  const dir = sortState.dir === "desc" ? -1 : 1;
  const numeric = numericKeys.has(key);
  const isCpp = CPP_KEYS.has(key);
  const isVpp = VPP_KEYS.has(key);
  return [...rows].sort((a, b) => {
    const va = a[key], vb = b[key];
    if (isCpp) {
      const ae = va === "" || va === null || va === undefined, be = vb === "" || vb === null || vb === undefined;
      if (ae && be) return 0; if (ae) return 1; if (be) return -1;
      return (cppSortValue(va) - cppSortValue(vb)) * dir;
    }
    if (isVpp) return (vppSortValue(va) - vppSortValue(vb)) * dir;
    const ae = va === "" || va === null || va === undefined, be = vb === "" || vb === null || vb === undefined;
    if (ae && be) return 0; if (ae) return 1; if (be) return -1;
    if (numeric) {
      const na = Number(va), nb = Number(vb);
      if (!Number.isFinite(na) && !Number.isFinite(nb)) return 0;
      if (!Number.isFinite(na)) return 1;
      if (!Number.isFinite(nb)) return -1;
      return (na - nb) * dir;
    }
    return String(va).localeCompare(String(vb)) * dir;
  });
}

export function getSortedRows(rows, tableKey) {
  const filtered = filterRows(rows, tableKey);
  return { filtered, sorted: sortRows(filtered, state.sort[tableKey]) };
}

// ---------- 单元格渲染 ----------

function cellClass(key, value) {
  if (key === "status") return "status-cell";
  if (key === "calculated" || key === "calculated_all") { if (value === "true") return "ok"; if (value === "false") return "warnText"; }
  if (key === "wallet") return "wallet";
  if (PNL_KEYS.has(key)) {
    if (value === "" || value === undefined || value === null) return "money";
    const n = Number(value);
    if (!Number.isFinite(n)) return "money";
    return n > 0 ? "money pnl-pos" : (n < 0 ? "money pnl-neg" : "money");
  }
  if (MONEY_KEYS.has(key)) return "money";
  if (CPP_KEYS.has(key)) { if (value === "" || value === undefined || value === null) return "cpp none"; if (value === "Infinity") return "cpp inf"; if (Number(value) === 0) return "cpp free"; return "cpp"; }
  return "";
}

function statusBadgeLabel(value) {
  if (value === "ok") return "成功";
  if (value === "error") return "失败";
  if (value === "week_not_found") return "缺失";
  return value || "";
}
function statusBadgeTone(value) {
  if (value === "ok") return "ok";
  if (value === "error") return "bad";
  if (value === "week_not_found") return "warn";
  return "muted";
}

function renderCellValue(td, key, value) {
  if (key === "status") {
    td.innerHTML = "";
    const badge = document.createElement("span");
    badge.className = `status-badge ${statusBadgeTone(value)}`;
    badge.textContent = statusBadgeLabel(value);
    td.appendChild(badge);
    td.title = value || "";
    return;
  }
  if (key === "wallet" && value) {
    td.innerHTML = "";
    const wrap = document.createElement("span"); wrap.className = "walletInner";
    const link = document.createElement("a"); link.className = "walletLink"; link.textContent = shortWallet(value); link.title = value; link.href = walletPortfolioUrl(value); link.target = "_blank"; link.rel = "noopener noreferrer";
    const btn = document.createElement("button"); btn.className = "copyBtn"; btn.type = "button"; btn.textContent = "复制"; btn.dataset.wallet = value;
    wrap.append(link, btn); td.appendChild(wrap); return;
  }
  if (PNL_KEYS.has(key)) { td.textContent = value === "" || value === undefined || value === null ? "—" : signedMoney(value); td.title = value || ""; return; }
  if (MONEY_KEYS.has(key)) { td.textContent = value === "" || value === undefined || value === null ? "—" : formatMoney(value); td.title = value || ""; return; }
  if (TWO_DECIMAL_KEYS.has(key)) { td.textContent = formatTwoDecimal(value); td.title = value || ""; return; }
  if (VPP_KEYS.has(key)) { td.textContent = formatVolumePerPoint(value); td.title = value || ""; return; }
  if (CPP_KEYS.has(key)) {
    td.innerHTML = "";
    const wrap = document.createElement("span"); wrap.className = "cppInner";
    const numEl = document.createElement("span"); numEl.className = "cppVal"; numEl.textContent = formatCostPerPoint(value);
    const bar = document.createElement("span"); bar.className = "cppBar";
    const fill = document.createElement("span"); fill.className = "cppFill";
    let pct = 0;
    if (value === "Infinity") pct = 6;
    else if (isValidCpp(value)) {
      const n = Number(value);
      pct = n === 0 ? 100 : Math.max(4, Math.min(100, 0.0001 / n * 100));
    }
    fill.style.width = pct + "%";
    bar.appendChild(fill); wrap.append(numEl, bar); td.appendChild(wrap); return;
  }
  td.textContent = value ?? ""; td.title = value ?? "";
}

function buildThead(columns, tableKey) {
  const thead = document.createElement("thead");
  const tr = document.createElement("tr");
  const indexTh = document.createElement("th"); indexTh.textContent = "序号"; tr.appendChild(indexTh);
  const s = state.sort[tableKey];
  for (const [key, label] of columns) {
    const th = document.createElement("th");
    th.dataset.key = key;
    th.className = "sortable";
    // 排序通过容器上的事件委托触发（见 setupTableInteractions），支持键盘操作。
    th.tabIndex = 0;
    th.setAttribute("role", "button");
    const active = s.key === key;
    th.classList.toggle("activeSort", active);
    th.setAttribute("aria-sort", active ? (s.dir === "desc" ? "descending" : "ascending") : "none");
    const span = document.createElement("span"); span.textContent = label; th.appendChild(span);
    const arrow = document.createElement("span"); arrow.className = "arrow";
    arrow.textContent = active ? (s.dir === "desc" ? "▼" : "▲") : "↕";
    th.appendChild(arrow);
    tr.appendChild(th);
  }
  thead.appendChild(tr);
  return thead;
}

export function renderTable(containerId, rows, columns, tableKey, precomputed = null) {
  const box = $(containerId);
  const { sorted } = precomputed || getSortedRows(rows, tableKey);
  const renderLimit = MAX_RENDER_ROWS[tableKey] || 500;
  const visibleRows = sorted.slice(0, renderLimit);
  if (state.activeTab === tableKey) {
    const filteredInfo = rows.length !== sorted.length ? ` / 筛选前 ${rows.length}` : "";
    $("rowCount").textContent = sorted.length > renderLimit
      ? `显示 ${visibleRows.length} / ${sorted.length} 行${filteredInfo}`
      : `${sorted.length} 行${filteredInfo}`;
  }
  if (!sorted.length) { box.innerHTML = `<div style="padding:18px;color:var(--muted)">${rows.length ? "没有匹配的行" : "暂无数据"}</div>`; return; }
  const table = document.createElement("table"); table.appendChild(buildThead(columns, tableKey));
  const tbody = document.createElement("tbody");
  for (let i = 0; i < visibleRows.length; i++) {
    const row = visibleRows[i]; const tr = document.createElement("tr");
    if (tableKey === "summary" && state.bestWallet && row.wallet === state.bestWallet) tr.classList.add("best-row");
    const idxTd = document.createElement("td"); idxTd.textContent = String(i + 1); tr.appendChild(idxTd);
    for (const [key] of columns) {
      const td = document.createElement("td"); const value = row[key] ?? "";
      renderCellValue(td, key, value);
      const cls = cellClass(key, value); if (cls) td.className = td.className ? `${td.className} ${cls}` : cls;
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  box.innerHTML = "";
  if (sorted.length > renderLimit) {
    const notice = document.createElement("div");
    notice.className = "renderNotice";
    notice.textContent = `为避免页面卡顿，当前只渲染前 ${renderLimit} 行；筛选、排序、复制当前钱包和导出 CSV 仍然基于全部 ${sorted.length} 行。`;
    box.appendChild(notice);
  }
  box.appendChild(table);
}

// ---------- 渲染调度 ----------

let renderTimer = null;

// summaryRows 是派生数据：单一来源是 summaryMap（增量），否则从 detailRows 重建。
export function refreshSummaryRows() {
  state.summaryRows = state.summaryMap.size
    ? Array.from(state.summaryMap.values())
    : buildSummaryRows(state.detailRows);
}

export function renderAll() {
  refreshSummaryRows();
  // summary 的筛选+排序只算一次：既用于「最优钱包」也用于表格渲染。
  const summaryBundle = getSortedRows(state.summaryRows, "summary");
  const best = findBestWallet(summaryBundle.sorted);
  state.bestWallet = best ? best.wallet : null;
  updateFilterHint();
  if (state.activeTab === "summary") renderTable("summaryBox", state.summaryRows, summaryColumns, "summary", summaryBundle);
  else renderTable("detailBox", state.detailRows, detailColumns, "detail");
  updateStats();
}

export function scheduleRender(force = false) {
  if (force) {
    if (renderTimer) clearTimeout(renderTimer);
    renderTimer = null;
    renderAll();
    return;
  }
  if (renderTimer) return;
  renderTimer = setTimeout(() => {
    renderTimer = null;
    renderAll();
  }, RENDER_INTERVAL_MS);
}

// ---------- 统计卡 ----------

export function updateProgressOnly() {
  $("statProgress").textContent = `${state.completedWallets} / ${state.totalWallets}`;
  $("statSuccess").textContent = `${state.successWallets} / ${state.failedWallets}`;
  const pct = state.totalWallets ? Math.round(state.completedWallets / state.totalWallets * 100) : 0;
  $("progressBar").style.width = `${pct}%`;
}

// 统计卡只展示 2~6 位小数，这里用 Number 累加（每帧全量 BigInt 字符串求和太重）；
// 表格行内与 CSV 导出仍然走高精度 decimal 字符串。
export function updateStats() {
  $("statProgress").textContent = `${state.completedWallets} / ${state.totalWallets}`;
  $("statSuccess").textContent = `${state.successWallets} / ${state.failedWallets}`;
  let totalVolume = 0, totalShares = 0, sharesCount = 0, totalCost = 0, totalTrades = 0, totalPoints = 0;
  let calculated = 0, uncalculated = 0;
  for (const r of state.detailRows) {
    if (r.status !== "ok") continue;
    totalVolume += num(r.total_volume_usdt);
    if (r.total_volume_shares !== "" && r.total_volume_shares !== undefined && r.total_volume_shares !== null) { totalShares += num(r.total_volume_shares); sharesCount += 1; }
    totalCost += num(r.cost_usdt);
    totalTrades += num(r.trade_count);
    totalPoints += num(r.points);
    if (r.calculated === "true") calculated += 1; else if (r.calculated === "false") uncalculated += 1;
  }
  let totalHolding = 0, holdingCount = 0, totalBalance = 0, balanceCount = 0, totalNet = 0, netCount = 0;
  let totalTotalPoints = 0, totalPointsCount = 0, totalPnl = 0, pnlCount = 0, okCount = 0;
  for (const r of state.summaryRows) {
    if (r.status !== "ok") continue;
    okCount += 1;
    if (r.holding_amount_usdt !== "" && r.holding_amount_usdt !== undefined && r.holding_amount_usdt !== null) { totalHolding += num(r.holding_amount_usdt); holdingCount += 1; }
    if (r.available_balance_usdt !== "" && r.available_balance_usdt !== undefined && r.available_balance_usdt !== null) { totalBalance += num(r.available_balance_usdt); balanceCount += 1; }
    if (r.net_asset_usdt !== "" && r.net_asset_usdt !== undefined && r.net_asset_usdt !== null) { totalNet += num(r.net_asset_usdt); netCount += 1; }
    if (r.total_points !== "" && r.total_points !== undefined && r.total_points !== null) { totalTotalPoints += num(r.total_points); totalPointsCount += 1; }
    if (r.pnl !== "" && r.pnl !== undefined && r.pnl !== null) { totalPnl += num(r.pnl); pnlCount += 1; }
  }
  $("statVolume").textContent = formatMoney(totalVolume);
  $("statShares").textContent = sharesCount ? formatMoney(totalShares) : "—";
  $("statCost").textContent = trimNumber(totalCost, 6) + " U";
  $("statTrades").textContent = String(Math.round(totalTrades));
  $("statPoints").textContent = formatTwoDecimal(totalPoints);
  $("statTotalPoints").textContent = totalPointsCount ? formatTwoDecimal(totalTotalPoints) : "0";
  $("statCalcSplit").textContent = `${calculated} / ${uncalculated}`;
  $("statOverallCpp").textContent = formatCostPerPoint(computeCostPerPoint(totalPoints, totalCost));
  $("statHolding").textContent = holdingCount ? formatMoney(totalHolding) + " U" : "—";
  $("statBalance").textContent = balanceCount ? formatMoney(totalBalance) + " U" : "—";
  $("statNetAsset").textContent = netCount ? formatMoney(totalNet) + " U" : "—";
  const statPnlEl = $("statPnl");
  if (statPnlEl) {
    statPnlEl.textContent = pnlCount ? signedMoney(totalPnl) : "—";
    statPnlEl.classList.toggle("pnl-pos", pnlCount > 0 && totalPnl > 0);
    statPnlEl.classList.toggle("pnl-neg", pnlCount > 0 && totalPnl < 0);
  }
  const statPnlSub = $("statPnlSub");
  if (statPnlSub) {
    const missing = shouldQueryPnl() ? Math.max(0, okCount - pnlCount) : 0;
    statPnlSub.textContent = missing > 0 ? `${missing} 个地址未取到官网PNL` : "Predict.fun GraphQL pnlTimeseries 最新值";
    statPnlSub.classList.toggle("pnl-neg", missing > 0);
  }
  const pct = state.totalWallets ? Math.round(state.completedWallets / state.totalWallets * 100) : 0;
  $("progressBar").style.width = `${pct}%`;

  const best = state.bestWallet ? state.summaryRows.find(r => r.wallet === state.bestWallet) : null;
  const panel = $("bestPanel");
  if (best) {
    panel.hidden = false;
    $("bestAddr").textContent = shortWallet(best.wallet); $("bestAddr").title = best.wallet; $("bestAddr").dataset.wallet = best.wallet;
    $("bestPoints").textContent = formatTwoDecimal(best.points);
    $("bestCost").textContent = trimNumber(num(best.cost_usdt), 6);
    $("bestCpp").textContent = formatCostPerPoint(best.cost_per_point);
    $("bestHolding").textContent = best.holding_amount_usdt !== "" ? formatMoney(best.holding_amount_usdt) : "—";
    $("bestBalance").textContent = best.available_balance_usdt !== "" ? formatMoney(best.available_balance_usdt) : "—";
    $("bestNetAsset").textContent = best.net_asset_usdt !== "" ? formatMoney(best.net_asset_usdt) : "—";
  } else panel.hidden = true;

  const hasRows = state.detailRows.length > 0;
  $("exportSummaryBtn").disabled = !hasRows; $("exportDetailBtn").disabled = !hasRows; $("copySummaryBtn").disabled = !hasRows; $("copyFilteredWalletsBtn").disabled = !state.summaryRows.length;

  const statSuccessEl = $("statSuccess");
  if (statSuccessEl) statSuccessEl.classList.toggle("has-fail", state.failedWallets > 0);
  const viewFailed = $("viewFailedLink");
  const retryFailed = $("retryFailedLink");
  if (viewFailed) viewFailed.style.display = state.failedWallets > 0 ? "" : "none";
  if (retryFailed) retryFailed.style.display = state.failedWallets > 0 && !state.running ? "" : "none";
}

// ---------- 筛选 chips ----------

export function updateFilterHint() {
  const chips = $("filterChips");
  if (!chips) return;
  const items = [];
  if (state.minPoints > 0) items.push({ label: `积分 ≥ ${state.minPoints}`, key: "minPoints" });
  if (state.minBalance > 0) items.push({ label: `余额 ≥ ${state.minBalance}`, key: "minBalance" });
  if (state.minHolding > 0) items.push({ label: `持仓 ≥ ${state.minHolding}`, key: "minHolding" });
  if (state.maxHolding > 0) items.push({ label: `持仓 ≤ ${state.maxHolding}`, key: "maxHolding" });
  if (state.minNetAsset > 0) items.push({ label: `净资产 ≥ ${state.minNetAsset}`, key: "minNetAsset" });
  if (state.maxNetAsset > 0) items.push({ label: `净资产 ≤ ${state.maxNetAsset}`, key: "maxNetAsset" });
  if (state.maxReferralPoints > 0) items.push({ label: `推荐积分 ≤ ${state.maxReferralPoints}`, key: "maxReferralPoints" });
  if (state.maxCpp > 0) items.push({ label: `积分成本 ≤ ${state.maxCpp}`, key: "maxCpp" });
  if (state.onlyCalculated) items.push({ label: "已结算", key: "onlyCalculated" });
  if (state.onlyFailed) items.push({ label: "只看失败", key: "onlyFailed" });
  chips.innerHTML = "";
  for (const it of items) {
    const chip = document.createElement("span"); chip.className = "filter-chip";
    chip.textContent = it.label;
    const x = document.createElement("button"); x.type = "button"; x.textContent = "×"; x.title = "移除此筛选";
    x.addEventListener("click", () => clearFilter(it.key));
    chip.appendChild(x);
    chips.appendChild(chip);
  }
}

export function clearFilter(key) {
  if (key === "onlyCalculated") { state.onlyCalculated = false; $("onlyCalculated").checked = false; }
  else if (key === "onlyFailed") { state.onlyFailed = false; }
  else { state[key] = 0; const el = $(key); if (el) el.value = ""; }
  renderAll();
}

// ---------- 表格交互（事件委托：排序 + 复制按钮） ----------

function onSortActivate(tableKey, key) {
  const s = state.sort[tableKey];
  if (s.key === key) s.dir = s.dir === "asc" ? "desc" : "asc";
  else { s.key = key; s.dir = CPP_KEYS.has(key) ? "asc" : (numericKeys.has(key) ? "desc" : "asc"); }
  renderAll();
}

export function setupTableInteractions() {
  for (const [boxId, tableKey] of [["summaryBox", "summary"], ["detailBox", "detail"]]) {
    const box = $(boxId);
    box.addEventListener("click", async e => {
      const btn = e.target.closest(".copyBtn");
      if (btn) {
        const wallet = btn.dataset.wallet; if (!wallet) return;
        e.preventDefault(); e.stopPropagation();
        const ok = await copyText(wallet);
        btn.textContent = ok ? "已复制" : "失败";
        if (!ok) toast("复制失败，浏览器可能不允许剪贴板权限。", "error");
        setTimeout(() => btn.textContent = "复制", 1200);
        return;
      }
      const th = e.target.closest("th.sortable");
      if (th && th.dataset.key) onSortActivate(tableKey, th.dataset.key);
    });
    box.addEventListener("keydown", e => {
      if (e.key !== "Enter" && e.key !== " ") return;
      const th = e.target.closest && e.target.closest("th.sortable");
      if (th && th.dataset.key) { e.preventDefault(); onSortActivate(tableKey, th.dataset.key); }
    });
  }
}
