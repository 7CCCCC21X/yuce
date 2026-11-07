// 每日盈亏页：读取导入的官网数据，按北京时间切日，展示每日明细与星期汇总。

import { $ } from "./dom.js";
import { toast } from "./toast.js";
import { csvEscape } from "./format.js";
import { loadImportedFile, restoreImported, importedEntries, describeImported } from "./imported.js";
import { dailyPnlFromPoints, mergeDailyRows, weekdaySummary, medianIntervalSec } from "./daily-pnl.js";

const shortAddr = a => (a && a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a || "");
const money = n => (n === null || n === undefined || !Number.isFinite(Number(n)) ? "—" : Number(n).toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
const signed = n => (n === null || n === undefined ? "—" : (n > 0 ? "+" : "") + money(n));
const cls = n => (n > 0 ? "pos" : n < 0 ? "neg" : "muted");
const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

let current = { daily: [], weekday: [] };

function walletLabel(addr, entry) { return entry.name ? `${entry.name}（${shortAddr(addr)}）` : shortAddr(addr); }

function refreshWalletSelect() {
  const sel = $("walletSelect");
  const keep = sel.value;
  const entries = importedEntries().filter(([, e]) => e.pnl_points && e.pnl_points.length);
  sel.innerHTML = `<option value="__all__">全部地址合并（${entries.length}）</option>` +
    entries.map(([a, e]) => `<option value="${esc(a)}">${esc(walletLabel(a, e))} · ${e.pnl_points.length} 点</option>`).join("");
  if ([...sel.options].some(o => o.value === keep)) sel.value = keep;
}

function compute() {
  const tol = Math.max(0, Number($("toleranceHours").value || 3)) * 3600;
  const sel = $("walletSelect").value;
  const entries = importedEntries().filter(([, e]) => e.pnl_points && e.pnl_points.length);
  const chosen = sel === "__all__" ? entries : entries.filter(([a]) => a === sel);
  const perWallet = chosen.map(([a, e]) => ({ addr: a, entry: e, rows: dailyPnlFromPoints(e.pnl_points, { toleranceSec: tol }) }));
  const daily = sel === "__all__"
    ? mergeDailyRows(perWallet.map(w => w.rows))
    : (perWallet[0]?.rows || []).map(r => ({ ...r, wallets: 1 }));
  const weekday = weekdaySummary(daily, { onlyComplete: $("onlyComplete").checked });
  const gaps = perWallet.map(w => medianIntervalSec(w.entry.pnl_points)).filter(g => g !== null).sort((a, b) => a - b);
  const medianGap = gaps.length ? gaps[Math.floor(gaps.length / 2)] : null;
  current = { daily, weekday, label: sel === "__all__" ? "all" : sel, perWallet, medianGap };
}

function render() {
  compute();
  const { daily, weekday, medianGap } = current;
  const complete = daily.filter(r => r.complete);
  const net = complete.reduce((s, r) => s + r.pnl, 0);
  const worst = complete.reduce((m, r) => (m === null || r.pnl < m.pnl ? r : m), null);
  const best = complete.reduce((m, r) => (m === null || r.pnl > m.pnl ? r : m), null);
  // 亏损集中度：最差的 3 天占全部亏损的比例。
  const losses = complete.filter(r => r.pnl < 0).map(r => r.pnl).sort((a, b) => a - b);
  const lossTotal = losses.reduce((s, v) => s + v, 0);
  const top3 = losses.slice(0, 3).reduce((s, v) => s + v, 0);
  const card = (label, value, extra = "") => `<div class="stat-card"><div class="stat-label">${label}</div><div class="stat-value">${value}</div>${extra ? `<div class="help">${extra}</div>` : ""}</div>`;
  $("stats").innerHTML = [
    card("完整天数 / 全部天数", `${complete.length} / ${daily.length}`),
    card("完整天净盈亏", `<span class="${cls(net)}">${signed(net)}</span>`),
    card("最差一天", worst ? `<span class="neg">${signed(worst.pnl)}</span>` : "—", worst ? `${worst.date} ${worst.weekday_name}` : ""),
    card("最好一天", best ? `<span class="pos">${signed(best.pnl)}</span>` : "—", best ? `${best.date} ${best.weekday_name}` : ""),
    card("最差 3 天占总亏损", lossTotal < 0 ? `${Math.round((top3 / lossTotal) * 100)}%` : "—", "比例越高，越是少数几天的大亏造成"),
  ].join("");
  const gapText = medianGap === null ? "" : medianGap >= 20 * 3600
    ? `⚠ 时序中位间隔约 ${(medianGap / 3600).toFixed(1)} 小时，接近每天一个点，北京时间切日不可靠，请重点看「边界粗」标记。`
    : `时序中位间隔约 ${medianGap >= 3600 ? (medianGap / 3600).toFixed(1) + " 小时" : Math.round(medianGap / 60) + " 分钟"}。`;
  $("granularity").textContent = gapText;

  const maxAbs = Math.max(1, ...weekday.map(w => Math.abs(w.net)));
  $("weekdayTable").innerHTML = `<thead><tr><th>星期</th><th class="num">有效天数</th><th class="num">盈利天数</th><th class="num">亏损天数</th><th class="num">盈利合计</th><th class="num">亏损合计</th><th class="num">净盈亏</th><th class="num">平均每日</th><th>最差一天</th><th>最好一天</th></tr></thead><tbody>` +
    weekday.map(w => `<tr><td>${w.weekday_name}</td><td class="num">${w.days}</td><td class="num">${w.profit_days}</td><td class="num">${w.loss_days}</td>` +
      `<td class="num pos">${w.days ? money(w.profit_sum) : "—"}</td><td class="num neg">${w.days ? money(w.loss_sum) : "—"}</td>` +
      `<td class="num ${cls(w.net)}">${w.days ? signed(w.net) : "—"}<span class="bar ${w.net >= 0 ? "pos" : "neg"}" style="width:${Math.round((Math.abs(w.net) / maxAbs) * 60)}px"></span></td>` +
      `<td class="num ${cls(w.avg)}">${w.avg === null ? "—" : signed(w.avg)}</td>` +
      `<td>${w.worst ? `${w.worst.date} <span class="${cls(w.worst.pnl)}">${signed(w.worst.pnl)}</span>` : "—"}</td>` +
      `<td>${w.best ? `${w.best.date} <span class="${cls(w.best.pnl)}">${signed(w.best.pnl)}</span>` : "—"}</td></tr>`).join("") + "</tbody>";

  const rows = [...daily].reverse();
  const multi = $("walletSelect").value === "__all__";
  $("dailyTable").innerHTML = `<thead><tr><th>北京日期</th><th>星期</th><th class="num">当天盈亏</th><th class="num">累计盈亏（日终）</th>${multi ? '<th class="num">地址数</th>' : ""}<th>数据</th></tr></thead><tbody>` +
    (rows.length ? rows.map(r => `<tr><td>${r.date}</td><td>${r.weekday_name}</td><td class="num ${cls(r.pnl)}">${signed(r.pnl)}</td><td class="num ${cls(r.cumulative)}">${signed(r.cumulative)}</td>${multi ? `<td class="num">${r.wallets}</td>` : ""}<td class="${r.complete ? "muted" : "neg"}">${r.complete ? "完整" : esc(r.flags)}</td></tr>`).join("")
      : `<tr><td colspan="6" class="muted">没有数据。先导入导出文件（需要包含 pnl_points）。</td></tr>`) + "</tbody>";
}

function download(name, rows, cols) {
  const text = "﻿" + [cols.map(c => c[1]).join(","), ...rows.map(r => cols.map(c => csvEscape(typeof c[0] === "function" ? c[0](r) : r[c[0]])).join(","))].join("\n");
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([text], { type: "text/csv;charset=utf-8" }));
  a.download = name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function exportDaily() {
  // 合并视图导出合并结果；同时附上逐地址明细，方便自己透视。
  const rows = [];
  for (const w of current.perWallet) for (const r of w.rows) rows.push({ ...r, address: w.addr, name: w.entry.name || "" });
  download(`daily-pnl-${current.label}.csv`, rows, [
    ["address", "地址"], ["name", "用户名"], ["date", "北京日期"], ["weekday_name", "星期"],
    ["pnl", "当天盈亏"], ["cumulative", "累计盈亏（日终）"], [r => (r.complete ? "完整" : r.flags), "数据"],
  ]);
}

function exportWeekday() {
  download(`weekday-pnl-${current.label}.csv`, current.weekday, [
    ["weekday_name", "星期"], ["days", "有效天数"], ["profit_days", "盈利天数"], ["loss_days", "亏损天数"],
    ["profit_sum", "盈利合计"], ["loss_sum", "亏损合计"], ["net", "净盈亏"], ["avg", "平均每日"],
    [r => (r.worst ? `${r.worst.date} ${r.worst.pnl}` : ""), "最差一天"], [r => (r.best ? `${r.best.date} ${r.best.pnl}` : ""), "最好一天"],
  ]);
}

function refreshAll() { $("importStatus").textContent = describeImported(); refreshWalletSelect(); render(); }

$("importBtn").addEventListener("click", () => $("importFile").click());
$("importFile").addEventListener("change", async e => {
  const file = e.target.files && e.target.files[0];
  e.target.value = "";
  if (!file) return;
  try { const n = await loadImportedFile(file); toast(`已导入 ${n} 个钱包。`, "success"); refreshAll(); }
  catch (err) { toast(`导入失败：${err && err.message ? err.message : err}`, "error"); }
});
for (const id of ["walletSelect", "onlyComplete", "toleranceHours"]) $(id).addEventListener("change", render);
$("exportDailyBtn").addEventListener("click", exportDaily);
$("exportWeekdayBtn").addEventListener("click", exportWeekday);

restoreImported();
refreshAll();
