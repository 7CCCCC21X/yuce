// 周选择器（多选下拉）。

import { $ } from "./dom.js";
import { parseWeeks } from "./parse.js";

// 周锚点：W1 的起始时间（UTC 秒）。对应 2025-12-16 14:00 UTC（活动第一周起点），
// 周长 7 天；本地推算的「本周」会与 localStorage 里见过的最大周号取 max。
const WEEK_ANCHOR_START_TS = 1765893600;
const WEEK_SECONDS = 604800;

export function currentWeekNumber() {
  const now = Math.floor(Date.now() / 1000);
  return Math.max(1, Math.floor((now - WEEK_ANCHOR_START_TS) / WEEK_SECONDS) + 1);
}

export function maxAvailableWeek() {
  let w = currentWeekNumber();
  try {
    const saved = Number(localStorage.getItem("yuce.latestWeek") || "0");
    if (Number.isFinite(saved) && saved > w) w = saved;
  } catch {}
  return w;
}

function buildWeekPanel() {
  const panel = $("weekPanel");
  if (!panel) return;
  const maxW = maxAvailableWeek();
  const currentW = currentWeekNumber();
  let html = "";
  html += `<label class="week-option"><input type="checkbox" id="weekAll" />全部周</label>`;
  html += `<label class="week-option"><input type="checkbox" id="weekCurrentOnly" />仅本周（W${currentW}）</label>`;
  html += `<div class="week-divider"></div>`;
  for (let w = maxW; w >= 1; w--) {
    const tag = w === currentW ? `<span class="week-tag">本周</span>` : "";
    html += `<label class="week-option" data-week-option="${w}"><input type="checkbox" data-week="${w}" />W${w}${tag}</label>`;
  }
  html += `<div class="week-actions"><button type="button" id="weekClearBtn" class="secondary">清空</button><button type="button" id="weekDoneBtn">完成</button></div>`;
  panel.innerHTML = html;
}

function readWeekSelection() {
  const allCb = $("weekAll");
  if (allCb && allCb.checked) return { all: true, weeks: [] };
  const checked = [...$("weekPanel").querySelectorAll('input[data-week]:checked')].map(el => Number(el.dataset.week));
  checked.sort((a, b) => a - b);
  return { all: false, weeks: checked };
}

function updateWeekUI() {
  const sel = readWeekSelection();
  const panel = $("weekPanel");
  const label = $("weekTriggerLabel");
  const hidden = $("weeks");
  const currentW = currentWeekNumber();
  const currentOnlyCb = $("weekCurrentOnly");
  if (currentOnlyCb) currentOnlyCb.checked = !sel.all && sel.weeks.length === 1 && sel.weeks[0] === currentW;
  panel.querySelectorAll(".week-option").forEach(o => {
    if (o.dataset.weekOption) o.classList.toggle("disabled", sel.all);
  });
  panel.querySelectorAll('input[data-week]').forEach(el => { el.disabled = sel.all; });
  if (sel.all) {
    label.textContent = "全部周";
    hidden.value = "";
  } else if (!sel.weeks.length) {
    label.textContent = "请选择周";
    hidden.value = "";
  } else if (sel.weeks.length === 1) {
    label.textContent = `W${sel.weeks[0]}${sel.weeks[0] === currentW ? "（本周）" : ""}`;
    hidden.value = String(sel.weeks[0]);
  } else if (sel.weeks.length <= 3) {
    label.textContent = sel.weeks.map(w => `W${w}`).join(", ");
    hidden.value = sel.weeks.join(",");
  } else {
    label.textContent = `已选 ${sel.weeks.length} 周`;
    hidden.value = sel.weeks.join(",");
  }
}

export function isAllWeeksSelected() { return $("weekAll")?.checked === true; }

export function setWeekSelection(weeksStr) {
  const raw = String(weeksStr || "").trim();
  const panel = $("weekPanel");
  if (!panel) return;
  panel.querySelectorAll('input[data-week]').forEach(el => { el.checked = false; });
  const allCb = $("weekAll");
  if (allCb) allCb.checked = false;
  if (!raw) { if (allCb) allCb.checked = true; updateWeekUI(); return; }
  let target = null;
  try { target = parseWeeks(raw); } catch { target = null; }
  if (!target || !target.length) { if (allCb) allCb.checked = true; updateWeekUI(); return; }
  const maxW = maxAvailableWeek();
  for (const w of target) {
    if (w < 1 || w > maxW) continue;
    const cb = panel.querySelector(`input[data-week="${w}"]`);
    if (cb) cb.checked = true;
  }
  updateWeekUI();
}

export function setupWeekSelector() {
  const wrap = $("weekSelector");
  if (!wrap) return;
  buildWeekPanel();
  const defaultWeek = maxAvailableWeek();
  setWeekSelection(String(defaultWeek));
  const trigger = $("weekTrigger");
  trigger.setAttribute("aria-haspopup", "listbox");
  trigger.setAttribute("aria-expanded", "false");
  trigger.addEventListener("click", e => {
    e.stopPropagation();
    if (!wrap.classList.contains("open")) {
      const current = $("weeks").value;
      const allChecked = $("weekAll")?.checked;
      buildWeekPanel();
      setWeekSelection(allChecked ? "" : current);
    }
    wrap.classList.toggle("open");
    trigger.setAttribute("aria-expanded", wrap.classList.contains("open") ? "true" : "false");
  });
  document.addEventListener("click", e => {
    if (!wrap.contains(e.target)) { wrap.classList.remove("open"); trigger.setAttribute("aria-expanded", "false"); }
  });
  document.addEventListener("keydown", e => {
    if (e.key === "Escape" && wrap.classList.contains("open")) { wrap.classList.remove("open"); trigger.setAttribute("aria-expanded", "false"); }
  });
  $("weekPanel").addEventListener("change", e => {
    const t = e.target;
    if (t.id === "weekAll") {
      if (t.checked) $("weekPanel").querySelectorAll('input[data-week]').forEach(el => el.checked = false);
      else if (!$("weekPanel").querySelectorAll('input[data-week]:checked').length) t.checked = true;
    } else if (t.id === "weekCurrentOnly") {
      const cur = currentWeekNumber();
      $("weekPanel").querySelectorAll('input[data-week]').forEach(el => { el.checked = Number(el.dataset.week) === cur; });
      $("weekAll").checked = false;
    } else if (t.dataset.week) {
      if (t.checked) $("weekAll").checked = false;
      if (!$("weekPanel").querySelectorAll('input[data-week]:checked').length) $("weekAll").checked = true;
    }
    updateWeekUI();
  });
  $("weekPanel").addEventListener("click", e => {
    if (e.target.id === "weekClearBtn") {
      $("weekPanel").querySelectorAll('input[data-week]').forEach(el => el.checked = false);
      $("weekAll").checked = true;
      updateWeekUI();
    } else if (e.target.id === "weekDoneBtn") { wrap.classList.remove("open"); trigger.setAttribute("aria-expanded", "false"); }
  });
}
