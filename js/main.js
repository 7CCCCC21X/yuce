// 入口：事件绑定与查询调度。

import { $, debounce, copyText } from "./dom.js";
import { toast } from "./toast.js";
import { log, setLog } from "./log.js";
import { state, summaryColumns, detailColumns, summaryExportColumns, detailExportColumns } from "./state.js";
import { csvEscape } from "./format.js";
import { extractWallets, parseWeeks } from "./parse.js";
import { rateLimiter, fetchWallet, fetchPositionValue, fetchUsdtBalance, fetchOfficialPortfolioPnl, shouldQueryPnl, shouldQueryShares, shouldQueryHoldings, shouldQueryBalance } from "./api.js";
import { buildRows, buildErrorDetailRow, buildSummaryRows } from "./rows.js";
import { renderAll, scheduleRender, updateProgressOnly, refreshSummaryRows, getSortedRows, setupTableInteractions } from "./table.js";
import { setupWeekSelector, setWeekSelection } from "./week.js";
import { loadConfig, saveConfig, attachConfigPersistence, exportConfig, importConfigFile, resetConfig } from "./config.js";

const EMPTY_PNL = { pnl: "", error: "" };

// ---------- 查询单个钱包 ----------

async function queryWallet(wallet, selectedWeeks) {
  const [pointsRes, holdingRes, balanceRes] = await Promise.allSettled([
    fetchWallet(wallet),
    fetchPositionValue(wallet),
    fetchUsdtBalance(wallet)
  ]);
  const holding = holdingRes.status === "fulfilled" ? holdingRes.value : { holding_amount_usdt: "", error: holdingRes.reason?.message || "持仓接口失败" };
  const balance = balanceRes.status === "fulfilled" ? balanceRes.value : { available_balance_usdt: "", error: balanceRes.reason?.message || "余额查询失败" };
  if (pointsRes.status !== "fulfilled") return [buildErrorDetailRow(wallet, pointsRes.reason?.message || "积分接口失败", holding, balance, EMPTY_PNL)];
  return buildRows(wallet, pointsRes.value, selectedWeeks, holding, balance, EMPTY_PNL);
}

// 官网 PNL 单独异步回填，不阻塞主结果渲染。
function patchWalletPnl(wallet, pnlValue) {
  const s = state.summaryMap.get(wallet);
  if (s) { s.pnl = pnlValue; s._search = null; }
  for (const r of state.detailRows) if (r.wallet === wallet) { r.pnl = pnlValue; r._search = null; }
}

async function queryWalletPnl(wallet) {
  if (!shouldQueryPnl()) return;
  let res;
  try { res = await fetchOfficialPortfolioPnl(wallet); }
  catch { return; }
  if (res && res.pnl !== "" && res.pnl !== null && res.pnl !== undefined) {
    patchWalletPnl(wallet, res.pnl);
    if ($("liveRender").checked) scheduleRender();
  }
}

function appendWalletRows(wallet, rows) {
  state.detailRows.push(...rows);
  const summary = buildSummaryRows(rows)[0];
  if (summary) state.summaryMap.set(wallet, summary);
  refreshSummaryRows();
}

// ---------- 并发批量查询（开始查询 / 重试失败共用同一套 worker 逻辑） ----------

async function runWalletBatch(wallets, selectedWeeks, { retry = false } = {}) {
  const concurrency = Math.max(1, Math.min(30, Number($("concurrency").value || 5), wallets.length));
  state.abort = false;
  state.running = true;
  state.runController = new AbortController();
  rateLimiter.configure(Number($("maxQps").value || 0));
  $("startBtn").disabled = true; $("stopBtn").disabled = false;
  let cursor = 0;
  const pnlPromises = [];

  async function worker() {
    while (!state.abort) {
      const idx = cursor++;
      if (idx >= wallets.length) break;
      const wallet = wallets[idx];
      try {
        if (idx === 0 || (idx + 1) % 50 === 0) log(`${retry ? "重试中" : "查询中"} ${idx + 1}/${wallets.length}: ${wallet}`);
        const rows = await queryWallet(wallet, selectedWeeks);
        appendWalletRows(wallet, rows);
        if (rows.some(r => r.status === "ok" || r.status === "week_not_found")) state.successWallets += 1;
        else state.failedWallets += 1;
        pnlPromises.push(queryWalletPnl(wallet));
        if ((idx + 1) % 50 === 0 || idx + 1 === wallets.length) log(`完成 ${idx + 1}/${wallets.length}: ${wallet}`);
      } catch (err) {
        const message = err && err.message ? err.message : String(err);
        appendWalletRows(wallet, [buildErrorDetailRow(wallet, message)]);
        state.failedWallets += 1;
        log(`${retry ? "重试失败" : "失败"} ${idx + 1}/${wallets.length}: ${wallet} | ${message}`);
      } finally {
        state.completedWallets += 1;
        updateProgressOnly();
        if ($("liveRender").checked) scheduleRender();
      }
    }
  }

  try { await Promise.all(Array.from({ length: concurrency }, worker)); }
  finally {
    state.running = false;
    $("startBtn").disabled = false; $("stopBtn").disabled = true;
    log(state.abort ? (retry ? "重试已停止。" : "已停止。") : (retry ? "重试完成。" : "全部完成。"));
    scheduleRender(true);
    Promise.allSettled(pnlPromises).then(() => {
      if (!state.abort) log("官网PNL 回填完成。");
      scheduleRender(true);
    });
  }
}

async function runQuery() {
  if (state.running) return;
  const wallets = extractWallets($("wallets").value);
  if (!wallets.length) { toast("没有识别到有效钱包地址", "error"); return; }
  let selectedWeeks = null;
  try { selectedWeeks = parseWeeks($("weeks").value); } catch (err) { toast(err.message || String(err), "error"); return; }
  saveConfig();
  state.totalWallets = wallets.length; state.completedWallets = 0; state.successWallets = 0; state.failedWallets = 0;
  state.detailRows = []; state.summaryRows = []; state.summaryMap = new Map();
  setLog(`开始查询：${wallets.length} 个钱包，并发 ${Math.max(1, Math.min(30, Number($("concurrency").value || 5), wallets.length))}，周数：${selectedWeeks === null ? "全部周" : selectedWeeks.join(",")}，份额：${shouldQueryShares() ? "开" : "关"}，持仓：${shouldQueryHoldings() ? "开" : "关"}，余额：${shouldQueryBalance() ? "开" : "关"}，官网PNL：${shouldQueryPnl() ? "开" : "关"}`);
  renderAll();
  await runWalletBatch(wallets, selectedWeeks);
}

async function retryFailed() {
  if (state.running) return;
  const failedWallets = state.summaryRows.filter(r => r.status === "error").map(r => r.wallet);
  if (!failedWallets.length) return;
  let selectedWeeks = null;
  try { selectedWeeks = parseWeeks($("weeks").value); } catch (err) { toast(err.message || String(err), "error"); return; }
  const failedSet = new Set(failedWallets);
  for (const w of failedWallets) state.summaryMap.delete(w);
  state.detailRows = state.detailRows.filter(r => !failedSet.has(r.wallet));
  refreshSummaryRows();
  state.failedWallets = 0;
  state.completedWallets = Math.max(0, state.completedWallets - failedWallets.length);
  state.totalWallets = state.completedWallets + failedWallets.length;
  log(`重试 ${failedWallets.length} 个失败钱包...`);
  await runWalletBatch(failedWallets, selectedWeeks, { retry: true });
}

function stopQuery() {
  state.abort = true;
  // 立刻中断在途请求，而不是等它们自然返回 / 超时。
  state.runController?.abort();
  log("正在停止，已中断在途请求...");
}

function clearResults() {
  if (state.running) stopQuery();
  state.abort = false; state.running = false;
  state.totalWallets = 0; state.completedWallets = 0; state.successWallets = 0; state.failedWallets = 0;
  state.detailRows = []; state.summaryRows = []; state.summaryMap = new Map();
  $("progressBar").style.width = "0%"; setLog("已清空结果。等待开始..."); renderAll();
}

// ---------- 导出 / 复制 ----------

function downloadCsv(filename, rows, columns) {
  if (!rows.length) return;
  const header = columns.map(([, label]) => csvEscape(label)).join(",");
  const lines = rows.map(row => columns.map(([key]) => csvEscape(row[key] ?? "")).join(","));
  const blob = new Blob(["\ufeff" + [header, ...lines].join("\n")], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob); const a = document.createElement("a"); a.href = url; a.download = filename; document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
}

async function copySummary() {
  if (!state.summaryRows.length) return;
  const header = summaryExportColumns.map(([, label]) => label).join("\t");
  const lines = state.summaryRows.map(row => summaryExportColumns.map(([key]) => row[key] ?? "").join("\t"));
  if (await copyText([header, ...lines].join("\n"))) log("已复制汇总表。");
  else toast("复制失败，浏览器可能不允许剪贴板权限。可以改用导出 CSV。", "error");
}

async function copyFilteredWallets() {
  const rows = getSortedRows(state.summaryRows, "summary").sorted;
  const wallets = [...new Set(rows.map(r => String(r.wallet || "").toLowerCase()).filter(Boolean))];
  if (!wallets.length) return;
  if (await copyText(wallets.join("\n"))) log(`已复制当前筛选后的 ${wallets.length} 个钱包地址。`);
  else toast("复制失败，浏览器可能不允许剪贴板权限。", "error");
}

function fillSample() {
  $("wallets").value = ["0x1111111111111111111111111111111111111111", "0x2222222222222222222222222222222222222222", "0x3333333333333333333333333333333333333333"].join("\n");
  setWeekSelection("17,18");
  updateWalletCountHint();
  setLog("已填入示例。把示例钱包替换成你自己的即可。");
}

// ---------- 输入与筛选 ----------

function readMinInput(el) { const raw = (el.value || "").trim(); const n = Number(raw); return raw && isFinite(n) && n > 0 ? n : 0; }

function updateWalletCountHint() {
  const el = $("walletCountHint"); if (!el) return;
  const ws = extractWallets($("wallets").value);
  el.textContent = ws.length
    ? `已识别 ${ws.length} 个钱包地址（自动去重）。`
    : "每行一个钱包地址，支持粘贴多个地址（自动去重）。";
}

function setupListeners() {
  // 筛选输入做去抖，避免每个键击全表重排重渲。
  const debouncedRender = debounce(renderAll, 200);

  $("wallets").addEventListener("input", debounce(updateWalletCountHint, 150));

  $("filterInput").addEventListener("input", e => { state.filterText = e.target.value || ""; debouncedRender(); });
  $("onlyCalculated").addEventListener("change", e => { state.onlyCalculated = e.target.checked; renderAll(); });
  for (const id of ["minPoints", "minBalance", "minHolding", "maxHolding", "minNetAsset", "maxNetAsset", "maxReferralPoints", "maxCpp", "maxCost", "maxAllFee"]) {
    $(id).addEventListener("input", e => { state[id] = readMinInput(e.target); debouncedRender(); });
  }
  $("sortPresetSelect").addEventListener("change", e => { const [key, dir] = String(e.target.value || "cost_per_point:asc").split(":"); state.sort.summary = { key, dir: dir === "asc" ? "asc" : "desc" }; renderAll(); });
  $("quickBestBtn").addEventListener("click", () => { state.minPoints = 10000; state.maxCpp = 0.00005; state.onlyCalculated = true; $("minPoints").value = "10000"; $("maxCpp").value = "0.00005"; $("onlyCalculated").checked = true; state.sort.summary = { key: "cost_per_point", dir: "asc" }; renderAll(); });
  $("resetFiltersBtn").addEventListener("click", () => { state.minPoints = state.minBalance = state.minHolding = state.maxHolding = state.minNetAsset = state.maxNetAsset = state.maxReferralPoints = state.maxCpp = state.maxCost = state.maxAllFee = 0; state.onlyCalculated = false; state.onlyFailed = false; ["minPoints","minBalance","minHolding","maxHolding","minNetAsset","maxNetAsset","maxReferralPoints","maxCpp","maxCost","maxAllFee"].forEach(id => $(id).value = ""); $("onlyCalculated").checked = false; renderAll(); });

  document.querySelectorAll(".tab").forEach(tab => {
    tab.addEventListener("click", () => {
      document.querySelectorAll(".tab").forEach(t => t.classList.remove("active")); tab.classList.add("active");
      const name = tab.dataset.tab; state.activeTab = name;
      $("summaryBox").style.display = name === "summary" ? "block" : "none";
      $("detailBox").style.display = name === "detail" ? "block" : "none";
      renderAll();
    });
  });

  const exportMenuWrap = $("exportMenuWrap");
  if (exportMenuWrap) {
    const menuBtn = $("exportMenuBtn");
    menuBtn.setAttribute("aria-haspopup", "menu");
    menuBtn.setAttribute("aria-expanded", "false");
    menuBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      exportMenuWrap.classList.toggle("open");
      menuBtn.setAttribute("aria-expanded", exportMenuWrap.classList.contains("open") ? "true" : "false");
    });
    document.addEventListener("click", (e) => { if (!exportMenuWrap.contains(e.target)) { exportMenuWrap.classList.remove("open"); menuBtn.setAttribute("aria-expanded", "false"); } });
    document.addEventListener("keydown", (e) => { if (e.key === "Escape") { exportMenuWrap.classList.remove("open"); menuBtn.setAttribute("aria-expanded", "false"); } });
    exportMenuWrap.querySelector(".menu-dropdown").addEventListener("click", () => { exportMenuWrap.classList.remove("open"); menuBtn.setAttribute("aria-expanded", "false"); });
  }

  $("viewFailedLink")?.addEventListener("click", (e) => {
    e.preventDefault();
    state.onlyFailed = true;
    state.activeTab = "summary";
    document.querySelectorAll(".tab").forEach(t => t.classList.toggle("active", t.dataset.tab === "summary"));
    $("summaryBox").style.display = "block";
    $("detailBox").style.display = "none";
    renderAll();
  });

  $("retryFailedLink")?.addEventListener("click", (e) => { e.preventDefault(); retryFailed(); });
  $("retryFailedBtn")?.addEventListener("click", () => retryFailed());

  $("bestCopyBtn").addEventListener("click", async () => {
    const addr = $("bestAddr").dataset.wallet || ""; if (!addr) return;
    if (!(await copyText(addr))) toast("复制失败，浏览器可能不允许剪贴板权限。", "error");
  });

  $("startBtn").addEventListener("click", runQuery);
  $("stopBtn").addEventListener("click", stopQuery);
  $("clearBtn").addEventListener("click", clearResults);
  $("sampleBtn").addEventListener("click", fillSample);
  $("exportSummaryBtn").addEventListener("click", () => downloadCsv("opinx_summary_with_assets.csv", state.summaryRows, summaryExportColumns));
  $("exportDetailBtn").addEventListener("click", () => downloadCsv("opinx_detail_with_assets.csv", state.detailRows, detailExportColumns));
  $("copySummaryBtn").addEventListener("click", copySummary);
  $("copyFilteredWalletsBtn").addEventListener("click", copyFilteredWallets);

  // 配置导入 / 导出 / 恢复默认。
  $("exportConfigBtn")?.addEventListener("click", exportConfig);
  $("importConfigBtn")?.addEventListener("click", () => $("importConfigFile").click());
  $("importConfigFile")?.addEventListener("change", async (e) => {
    const file = e.target.files && e.target.files[0];
    if (file && await importConfigFile(file)) { updateWalletCountHint(); renderAll(); }
    e.target.value = "";
  });
  $("resetConfigBtn")?.addEventListener("click", () => {
    if (confirm("确认清除本地保存的配置并恢复默认吗？")) resetConfig();
  });
}

// ---------- 初始化 ----------

setupWeekSelector();
if (loadConfig()) {
  // 恢复保存的筛选开关到运行时状态。
  state.onlyCalculated = $("onlyCalculated").checked;
}
attachConfigPersistence();
setupTableInteractions();
setupListeners();
updateWalletCountHint();
renderAll();
