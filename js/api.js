// 网络层：限流、超时、重试、各数据源请求。
// 所有请求都挂在 state.runController 上，点「停止」会立刻中断在途请求。

import { $, sleep } from "./dom.js";
import { state } from "./state.js";
import { normalizeDecimal, decimalSum, formatScaled } from "./decimal.js";

export const rateLimiter = {
  times: [],
  qps: 0,
  // 每次查询开始时配置一次，避免每个请求都读 DOM。
  configure(qps) {
    this.qps = Number.isFinite(qps) && qps > 0 ? qps : 0;
    this.times = [];
  },
  async acquire() {
    if (!this.qps) return;
    const windowMs = 1000;
    while (true) {
      const now = performance.now();
      this.times = this.times.filter(t => now - t < windowMs);
      if (this.times.length < this.qps) { this.times.push(now); return; }
      await sleep(Math.max(0, windowMs - (now - this.times[0]) + 1));
    }
  }
};

// 合并多个 AbortSignal（兼容没有 AbortSignal.any 的浏览器）。
function anySignal(signals) {
  const list = signals.filter(Boolean);
  if (list.length <= 1) return list[0];
  if (typeof AbortSignal.any === "function") return AbortSignal.any(list);
  const controller = new AbortController();
  for (const s of list) {
    if (s.aborted) { controller.abort(s.reason); break; }
    s.addEventListener("abort", () => controller.abort(s.reason), { once: true });
  }
  return controller.signal;
}

function normalizeAbortError(err) {
  if (state.abort) return new Error("已停止");
  if (err && (err.name === "AbortError" || err.name === "TimeoutError")) return new Error("请求超时");
  return err instanceof Error ? err : new Error(String(err));
}

export function applyProxy(realUrl) {
  const proxyPrefix = $("proxyPrefix").value.trim();
  if (!proxyPrefix) return realUrl;
  if (String(realUrl).startsWith("/")) return realUrl;
  return proxyPrefix.includes("{url}") ? proxyPrefix.replaceAll("{url}", encodeURIComponent(realUrl)) : proxyPrefix + encodeURIComponent(realUrl);
}

export async function fetchJsonWithTimeout(url, timeoutMs, extraHeaders = {}) {
  const timeoutController = new AbortController();
  const timer = setTimeout(() => timeoutController.abort(), timeoutMs);
  const signal = anySignal([timeoutController.signal, state.runController?.signal]);
  try {
    const res = await fetch(url, { method: "GET", headers: { "Accept": "application/json", ...extraHeaders }, cache: "no-store", signal });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`HTTP ${res.status} ${res.statusText}${text ? " - " + text.slice(0, 160) : ""}`);
    }
    const text = await res.text();
    return text ? JSON.parse(text) : null;
  } catch (err) {
    throw normalizeAbortError(err);
  } finally { clearTimeout(timer); }
}

export async function fetchWithRetries(url, extraHeaders = {}) {
  const retries = Math.max(0, Number($("retries").value || 0));
  const timeoutMs = Math.max(3000, Number($("timeoutMs").value || 20000));
  let lastError = "";
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (state.abort) throw new Error("已停止");
    await rateLimiter.acquire();
    if (state.abort) throw new Error("已停止");
    try { return await fetchJsonWithTimeout(applyProxy(url), timeoutMs, extraHeaders); }
    catch (err) {
      lastError = err && err.message ? err.message : String(err);
      if (lastError === "已停止") throw err;
      if (attempt < retries) await sleep(700 * (attempt + 1));
    }
  }
  throw new Error(lastError || "请求失败");
}

// ---------- JSON 路径取值 ----------

export function pathValues(obj, path) {
  const parts = String(path || "").split(".").map(x => x.trim()).filter(Boolean);
  let current = [obj];
  for (const part of parts) {
    const isArray = part.endsWith("[]");
    const key = isArray ? part.slice(0, -2) : part;
    const next = [];
    for (const item of current) {
      if (item === null || item === undefined) continue;
      const value = key ? item[key] : item;
      if (isArray) { if (Array.isArray(value)) next.push(...value); }
      else next.push(value);
    }
    current = next;
  }
  return current.filter(v => v !== undefined && v !== null && v !== "");
}

export function firstValueFromPaths(obj, paths) {
  for (const path of paths) {
    const values = pathValues(obj, path);
    if (values.length) return values[0];
  }
  return undefined;
}

export function valuesFromPathText(obj, pathText) {
  const paths = String(pathText || "").split(",").map(x => x.trim()).filter(Boolean);
  for (const path of paths) {
    const values = pathValues(obj, path);
    if (values.length) return values.map(v => normalizeDecimal(v));
  }
  return [];
}

// ---------- URL 模板 ----------

export function makeUrl(wallet) {
  const template = $("apiTemplate").value.trim();
  if (!template.includes("{wallet}")) throw new Error("积分 API 模板必须包含 {wallet}");
  return template.replaceAll("{wallet}", wallet);
}

export function makeTradesUrl(wallet, startTime, endTime) {
  const template = $("tradesApiTemplate").value.trim();
  if (!template.includes("{wallet}") || !template.includes("{start_time}") || !template.includes("{end_time}")) throw new Error("份额 API 模板必须包含 {wallet}、{start_time}、{end_time}");
  return template.replaceAll("{wallet}", wallet).replaceAll("{start_time}", String(startTime)).replaceAll("{end_time}", String(endTime));
}

export function makePositionUrl(wallet) {
  const template = $("positionApiTemplate").value.trim();
  if (!template) throw new Error("持仓 API 模板不能为空");
  if (!template.includes("{wallet}") && !template.includes("{address}")) throw new Error("持仓 API 模板必须包含 {wallet} 或 {address}");
  return template.replaceAll("{wallet}", wallet).replaceAll("{address}", wallet);
}

export function makePnlUrl(wallet) {
  const template = ($("pnlApiTemplate") && $("pnlApiTemplate").value || "").trim();
  if (!template) throw new Error("官网 PNL API 模板不能为空");
  if (!template.includes("{wallet}") && !template.includes("{address}")) throw new Error("官网 PNL API 模板必须包含 {wallet} 或 {address}");
  return template.replaceAll("{wallet}", wallet).replaceAll("{address}", wallet);
}

// ---------- 开关 ----------

export function shouldQueryShares() { const el = $("queryShares"); return !el || el.checked; }
export function shouldQueryHoldings() { const el = $("queryHoldings"); return !el || el.checked; }
export function shouldQueryBalance() { const el = $("queryBalance"); return !el || el.checked; }
export function shouldQueryPnl() { const el = $("queryPnl"); return !el || el.checked; }

// ---------- 各数据源 ----------

export async function fetchWallet(wallet) { return fetchWithRetries(makeUrl(wallet)); }

export async function fetchTradeShares(wallet, startTime, endTime) {
  if (!shouldQueryShares()) return { shares: "", error: "" };
  if (startTime === "" || endTime === "" || startTime === null || endTime === null || startTime === undefined || endTime === undefined) return { shares: "", error: "缺少 week_start / week_end，无法查询份额" };
  try {
    const data = await fetchWithRetries(makeTradesUrl(wallet, startTime, endTime));
    const v = firstValueFromPaths(data, ["total_volume_shares", "data.total_volume_shares", "result.total_volume_shares"]);
    return { shares: normalizeDecimal(v != null ? v : "0"), error: "" };
  } catch (err) {
    const message = err && err.message ? err.message : String(err);
    if (state.abort || message === "已停止") throw err;
    return { shares: "", error: `份额接口失败: ${message}` };
  }
}

export async function fetchPositionValue(wallet) {
  if (!shouldQueryHoldings()) return { holding_amount_usdt: "", name: "", error: "" };
  try {
    const data = await fetchWithRetries(makePositionUrl(wallet));
    const pathText = $("positionValuePaths").value || "positionsValueUsd";
    // 官网口径的「持仓金额」就是 GetPortfolio 的 statistics.positionsValueUsd，
    // 不是把每笔 /v1/positions 的 valueUsd 相加。
    let values = valuesFromPathText(data, pathText);
    if (!values.length) {
      const v = firstValueFromPaths(data, ["positionsValueUsd", "statistics.positionsValueUsd", "data.statistics.positionsValueUsd", "data.account.statistics.positionsValueUsd"]);
      if (v !== undefined && v !== null && v !== "") values = [normalizeDecimal(v)];
    }
    // 用户名（官网展示的 name）。
    const nameRaw = firstValueFromPaths(data, ["name", "account.name", "data.name", "data.account.name"]);
    const name = nameRaw !== undefined && nameRaw !== null ? String(nameRaw) : "";
    if (!values.length) {
      const err = data && data.error ? String(data.error) : "持仓接口返回了数据，但没有取到持仓金额(positionsValueUsd)";
      return { holding_amount_usdt: "", name, error: err };
    }
    // 正常情况下 positionsValueUsd 是单个数值；decimalSum 兼容路径命中多个值的情况。
    return { holding_amount_usdt: decimalSum(values), name, error: "" };
  } catch (err) {
    const message = err && err.message ? err.message : String(err);
    if (state.abort || message === "已停止") throw err;
    return { holding_amount_usdt: "", name: "", error: `持仓接口失败: ${message}` };
  }
}

export async function fetchOfficialPortfolioPnl(wallet) {
  if (!shouldQueryPnl()) return { pnl: "", error: "" };
  try {
    const data = await fetchWithRetries(makePnlUrl(wallet));
    const v = firstValueFromPaths(data, ["pnlUsd", "pnl", "data.pnlUsd", "data.pnl", "result.pnlUsd"]);
    if (v === undefined || v === null || v === "") {
      return { pnl: "", error: data && data.error ? String(data.error) : "未取到官网PNL" };
    }
    const n = Number(v);
    if (!Number.isFinite(n)) return { pnl: "", error: "官网PNL非数字" };
    return { pnl: normalizeDecimal(v), error: "" };
  } catch (err) {
    const message = err && err.message ? err.message : String(err);
    if (state.abort || message === "已停止") throw err;
    return { pnl: "", error: `官网PNL失败: ${message}` };
  }
}

// ---------- BSC RPC 余额 ----------

export function cleanAddress(addr) { return String(addr || "").trim().toLowerCase().replace(/^0x/, ""); }

export function makeBalanceOfCalldata(wallet) {
  const clean = cleanAddress(wallet);
  if (!/^[a-f0-9]{40}$/.test(clean)) throw new Error(`钱包地址格式错误：${wallet}`);
  return "0x70a08231" + clean.padStart(64, "0");
}

export function rawTokenAmountToDecimal(rawValue, decimals) {
  if (rawValue === "" || rawValue === undefined || rawValue === null) return "";
  const s = String(rawValue).trim();
  let n;
  if (/^0x[0-9a-fA-F]+$/.test(s)) n = BigInt(s);
  else if (/^\d+$/.test(s)) n = BigInt(s);
  else return normalizeDecimal(s);
  return formatScaled(n, Math.max(0, Number(decimals || 0)));
}

export function rpcUrlList() {
  return String($("rpcUrls").value || "").split(/[\n,]+/).map(x => x.trim()).filter(Boolean);
}

async function rpcFetchJson(url, body, timeoutMs) {
  const timeoutController = new AbortController();
  const timer = setTimeout(() => timeoutController.abort(), timeoutMs);
  const signal = anySignal([timeoutController.signal, state.runController?.signal]);
  try {
    const res = await fetch(applyProxy(url), {
      method: "POST",
      headers: { "Content-Type": "application/json", "Accept": "application/json" },
      body: JSON.stringify(body),
      cache: "no-store",
      signal
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`HTTP ${res.status} ${res.statusText}${text ? " - " + text.slice(0, 120) : ""}`);
    }
    return await res.json();
  } catch (err) {
    throw normalizeAbortError(err);
  } finally { clearTimeout(timer); }
}

export async function rpcEthCall(payload) {
  const urls = rpcUrlList();
  if (!urls.length) throw new Error("未填写 BSC RPC URL");
  const timeoutMs = Math.max(3000, Number($("timeoutMs").value || 20000));
  let lastError = "";
  for (const url of urls) {
    if (state.abort) throw new Error("已停止");
    await rateLimiter.acquire();
    try {
      const data = await rpcFetchJson(url, payload, timeoutMs);
      if (data && data.error) throw new Error(data.error.message || JSON.stringify(data.error));
      const result = Array.isArray(data) ? data[0]?.result : data?.result;
      if (typeof result === "string" && result.startsWith("0x")) return result;
      throw new Error("RPC 未返回 eth_call result");
    } catch (err) {
      lastError = err && err.message ? err.message : String(err);
      if (state.abort || lastError === "已停止") throw err;
    }
  }
  throw new Error(lastError || "RPC 请求失败");
}

export async function fetchUsdtBalance(wallet) {
  if (!shouldQueryBalance()) return { available_balance_usdt: "", error: "" };
  try {
    const token = ($("usdtAddress").value || "").trim();
    if (!/^0x[a-fA-F0-9]{40}$/.test(token)) throw new Error("USDT 合约地址格式错误");
    const decimals = Number($("usdtDecimals").value || 18);
    const hex = await rpcEthCall({ jsonrpc: "2.0", id: Date.now(), method: "eth_call", params: [{ to: token, data: makeBalanceOfCalldata(wallet) }, "latest"] });
    return { available_balance_usdt: rawTokenAmountToDecimal(hex === "0x" ? "0x0" : hex, decimals), error: "" };
  } catch (err) {
    const message = err && err.message ? err.message : String(err);
    if (state.abort || message === "已停止") throw err;
    return { available_balance_usdt: "", error: `余额查询失败: ${message}` };
  }
}
