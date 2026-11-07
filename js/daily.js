// 每日盈亏页：读取导入的官网数据，按北京时间切日，展示每日明细与星期汇总。

import { $, copyText } from "./dom.js";
import { toast } from "./toast.js";
import { csvEscape } from "./format.js";
import { restoreImported, importedEntries } from "./imported.js";
import { restoreDaily, addDailyFile, addDailyEntries, clearDaily, removeDaily, dailyEntries, describeDaily } from "./daily-store.js";
import { dailyPnlFromPoints, mergeDailyRows, weekdaySummary, medianIntervalSec } from "./daily-pnl.js";

const shortAddr = a => (a && a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a || "");
const money = n => (n === null || n === undefined || !Number.isFinite(Number(n)) ? "—" : Number(n).toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
const signed = n => (n === null || n === undefined ? "—" : (n > 0 ? "+" : "") + money(n));
const cls = n => (n > 0 ? "pos" : n < 0 ? "neg" : "muted");
const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

let current = { daily: [], weekday: [] };
// 单独查询得到、但没写进导入存储的地址（本页会话内有效）。
const adhoc = new Map();
const allEntries = () => {
  const m = new Map(dailyEntries());
  for (const [a, e] of adhoc) if (!m.has(a)) m.set(a, e);
  return [...m.entries()];
};

function walletLabel(addr, entry) { return entry.name ? `${entry.name}（${shortAddr(addr)}）` : shortAddr(addr); }

function refreshWalletSelect() {
  const sel = $("walletSelect");
  const keep = sel.value;
  const entries = allEntries().filter(([, e]) => e.pnl_points && e.pnl_points.length);
  sel.innerHTML = `<option value="__all__">全部地址合并（${entries.length}）</option>` +
    entries.map(([a, e]) => `<option value="${esc(a)}">${esc(walletLabel(a, e))} · ${e.pnl_points.length} 点</option>`).join("");
  if ([...sel.options].some(o => o.value === keep)) sel.value = keep;
}

function compute() {
  const tol = Math.max(0, Number($("toleranceHours").value || 3)) * 3600;
  const sel = $("walletSelect").value;
  const entries = allEntries().filter(([, e]) => e.pnl_points && e.pnl_points.length);
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

function refreshAll() {
  $("importStatus").textContent = describeDaily();
  const mainCount = importedEntries().filter(([, e]) => e.pnl_points && e.pnl_points.length).length;
  $("useMainDataBtn").hidden = !mainCount;
  $("useMainDataBtn").textContent = `带入主页面已导入的 ${mainCount} 个地址`;
  $("removeOneBtn").hidden = $("walletSelect").value === "__all__";
  refreshWalletSelect(); render();
}

// ---------- 输入地址单独查询 ----------
// 顺序：已导入 → 服务端 /api/portfolio-pnl（GraphQL 可用时直接出结果）→ 给出预填地址的导出脚本。
let lastMissAddr = "";
async function queryAddress() {
  const raw = ($("addrInput").value || "").trim();
  const m = raw.match(/0x[0-9a-fA-F]{40}/);
  const hint = $("queryHint");
  $("copyAddrScriptBtn").hidden = true;
  if (!m) { hint.textContent = "请输入完整的 0x 开头 40 位钱包地址。"; return; }
  const addr = m[0].toLowerCase();
  const show = () => { refreshWalletSelect(); $("walletSelect").value = addr; render(); };
  const known = allEntries().find(([a, e]) => a === addr && e.pnl_points && e.pnl_points.length);
  if (known) { hint.textContent = "已在导入数据中，直接显示。"; show(); return; }
  hint.textContent = "导入数据里没有这个地址，正在通过服务端查询…";
  try {
    const res = await fetch(`/api/portfolio-pnl?address=${addr}&interval=ALL&full=1`, { cache: "no-store" });
    const data = await res.json().catch(() => null);
    if (data && data.success && Array.isArray(data.points) && data.points.length) {
      addDailyEntries([[addr, { address: m[0], name: "", pnl_points: data.points, pnlUsd: String(data.pnlUsd ?? ""), error: "" }]], "服务端查询");
      hint.textContent = `服务端查询成功（${data.points.length} 个时序点）。`;
      show(); return;
    }
    throw new Error((data && data.error) || `HTTP ${res.status}`);
  } catch (err) {
    lastMissAddr = m[0];
    $("copyAddrScriptBtn").hidden = false;
    hint.textContent = `服务端查不到（${String(err && err.message || err).slice(0, 120)}）。点「复制该地址的导出脚本」，到 predict.fun 页面 F12 → Console 粘贴回车，会自动开始查询并下载 JSON，再点上面「导入数据文件」。`;
  }
}

async function copyAddrScript() {
  if (!lastMissAddr) return;
  try {
    const res = await fetch("scripts/predict-console-export.js", { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = `window.__YUCE_EXPORT_ADDRS = ${JSON.stringify([lastMissAddr])};\n` + await res.text();
    const ok = await copyText(text);
    toast(ok ? "脚本已复制（已预填该地址，粘贴后自动开始）。" : "复制失败，请手动打开导出脚本。", ok ? "success" : "error");
  } catch (err) { toast(`读取脚本失败：${err && err.message ? err.message : err}`, "error"); }
}

$("queryAddrBtn").addEventListener("click", queryAddress);
$("addrInput").addEventListener("keydown", e => { if (e.key === "Enter") queryAddress(); });
$("copyAddrScriptBtn").addEventListener("click", copyAddrScript);

$("importBtn").addEventListener("click", () => $("importFile").click());
$("importFile").addEventListener("change", async e => {
  const file = e.target.files && e.target.files[0];
  e.target.value = "";
  if (!file) return;
  try {
    const r = await addDailyFile(file);
    toast(`导入完成：新增 ${r.added} 个、更新 ${r.updated} 个，本页共 ${r.total} 个地址。${r.persisted ? "" : "（数据较大，刷新后需重新导入）"}`, "success");
    refreshAll();
  }
  catch (err) { toast(`导入失败：${err && err.message ? err.message : err}`, "error"); }
});
for (const id of ["walletSelect", "onlyComplete", "toleranceHours"]) $(id).addEventListener("change", render);
$("exportDailyBtn").addEventListener("click", exportDaily);
$("exportWeekdayBtn").addEventListener("click", exportWeekday);

$("clearDailyBtn").addEventListener("click", () => { if (!confirm("清空本页的全部数据？（不影响主页面）")) return; clearDaily(); adhoc.clear(); refreshAll(); toast("已清空本页数据。", "info"); });
$("useMainDataBtn").addEventListener("click", () => { const n = addDailyEntries(importedEntries()); toast(`已带入 ${n} 个地址。`, "success"); refreshAll(); });
$("removeOneBtn").addEventListener("click", () => { const a = $("walletSelect").value; if (a === "__all__") return; removeDaily(a); adhoc.delete(a); $("walletSelect").value = "__all__"; refreshAll(); });
$("walletSelect").addEventListener("change", () => { $("removeOneBtn").hidden = $("walletSelect").value === "__all__"; });

restoreImported(); // 只用于「带入主页面数据」按钮，不会自动混进本页
restoreDaily();
refreshAll();
