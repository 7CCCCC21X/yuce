// 行数据构建：周明细行、错误行、钱包汇总行。

import { $ } from "./dom.js";
import { normalizeDecimal, decimalAdd, decimalMul } from "./decimal.js";
import {
  joinErrors, timestampToUTC8,
  computeCostPerPoint, computeVolumePerPoint, computeOptionalVolumePerPoint,
  isValidCpp, cppSortValue
} from "./format.js";
import { fetchTradeShares } from "./api.js";

export function readMultiplier(id, fallback) {
  const raw = ($(id).value || "").trim();
  if (!raw) return fallback;
  const normalized = normalizeDecimal(raw);
  return normalized === "0" && raw !== "0" ? fallback : normalized;
}

export function assetFields(holdingResult, balanceResult, pnlResult) {
  const holding = holdingResult && holdingResult.holding_amount_usdt !== "" && holdingResult.holding_amount_usdt !== undefined && holdingResult.holding_amount_usdt !== null ? normalizeDecimal(holdingResult.holding_amount_usdt) : "";
  const balance = balanceResult && balanceResult.available_balance_usdt !== "" && balanceResult.available_balance_usdt !== undefined && balanceResult.available_balance_usdt !== null ? normalizeDecimal(balanceResult.available_balance_usdt) : "";
  const pnl = pnlResult && pnlResult.pnl !== "" && pnlResult.pnl !== undefined && pnlResult.pnl !== null ? normalizeDecimal(pnlResult.pnl) : "";
  let net = "";
  if (holding !== "" || balance !== "") net = decimalAdd(holding || "0", balance || "0");
  const name = holdingResult && holdingResult.name ? String(holdingResult.name) : "";
  return { name, holding_amount_usdt: holding, available_balance_usdt: balance, net_asset_usdt: net, pnl };
}

export async function buildRows(wallet, data, selectedWeeks, holdingResult, balanceResult, pnlResult) {
  const leaderboard = data && data.leaderboard ? data.leaderboard : {};
  const weeks = Array.isArray(data && data.weeks) ? data.weeks : [];
  const weekMap = new Map();
  const pointsMul = readMultiplier("pointsMultiplier", "1.1");
  const feeMul = readMultiplier("feeMultiplier", "0.9");
  const assets = assetFields(holdingResult, balanceResult, pnlResult);
  const assetError = joinErrors(holdingResult && holdingResult.error, balanceResult && balanceResult.error, pnlResult && pnlResult.error);
  for (const w of weeks) weekMap.set(Number(w.week), w);
  try {
    if (weekMap.size) {
      const maxW = Math.max(...weekMap.keys());
      if (Number.isFinite(maxW)) {
        const saved = Number(localStorage.getItem("yuce.latestWeek") || "0");
        if (maxW > saved) localStorage.setItem("yuce.latestWeek", String(maxW));
      }
    }
  } catch {}
  const targetWeeks = selectedWeeks === null ? [...weekMap.keys()].sort((a, b) => a - b) : selectedWeeks;

  const entries = targetWeeks.map(weekNo => ({ weekNo, item: weekMap.get(Number(weekNo)) || null }));
  // 各周份额查询并行（受全局限流器约束），多周时显著加速。
  const shareResults = await Promise.all(entries.map(({ item }) =>
    item ? fetchTradeShares(wallet, item.week_start ?? "", item.week_end ?? "") : Promise.resolve(null)
  ));

  return entries.map(({ weekNo, item }, i) => {
    if (!item) {
      return {
        wallet, status: "week_not_found",
        total_points: normalizeDecimal(leaderboard.total_points ?? "0"),
        allocation_round_points: normalizeDecimal(leaderboard.allocation_round_points ?? "0"),
        week: weekNo, calculated: "", week_start_ts: "", week_end_ts: "", week_start_utc8: "", week_end_utc8: "",
        trade_count: "0", paid_volume_usdt: "0", free_volume_usdt: "0", total_volume_usdt: "0", total_volume_shares: "",
        paid_fee_usdt: "0", cost_usdt: "0", points: "0", cost_per_point: "",
        total_volume_per_point: "", paid_volume_per_point: "", free_volume_per_point: "", shares_per_point: "",
        referral_points: "0", ...assets, error: joinErrors("接口没有返回这一周", assetError)
      };
    }

    const paidVolume = normalizeDecimal(item.paid_volume_usdt ?? "0");
    const freeVolume = normalizeDecimal(item.free_volume_usdt ?? "0");
    const totalVolume = decimalAdd(paidVolume, freeVolume);
    const paidFee = decimalMul(normalizeDecimal(item.paid_fee_usdt ?? "0"), feeMul);
    const points = decimalMul(normalizeDecimal(item.points ?? "0"), pointsMul);
    const referralPoints = normalizeDecimal(item.referral_points ?? "0");
    const weekStartTs = item.week_start ?? "";
    const weekEndTs = item.week_end ?? "";
    const shareResult = shareResults[i] || { shares: "", error: "" };
    const totalShares = shareResult.shares;

    return {
      wallet, status: "ok",
      total_points: normalizeDecimal(leaderboard.total_points ?? "0"),
      allocation_round_points: normalizeDecimal(leaderboard.allocation_round_points ?? "0"),
      week: item.week ?? weekNo,
      calculated: item.calculated === true ? "true" : item.calculated === false ? "false" : "",
      week_start_ts: String(weekStartTs ?? ""), week_end_ts: String(weekEndTs ?? ""),
      week_start_utc8: timestampToUTC8(weekStartTs), week_end_utc8: timestampToUTC8(weekEndTs),
      trade_count: String(item.trade_count ?? 0),
      paid_volume_usdt: paidVolume, free_volume_usdt: freeVolume, total_volume_usdt: totalVolume,
      total_volume_shares: totalShares,
      paid_fee_usdt: paidFee, cost_usdt: paidFee, points,
      cost_per_point: computeCostPerPoint(points, paidFee),
      total_volume_per_point: computeVolumePerPoint(points, totalVolume),
      paid_volume_per_point: computeVolumePerPoint(points, paidVolume),
      free_volume_per_point: computeVolumePerPoint(points, freeVolume),
      shares_per_point: computeOptionalVolumePerPoint(points, totalShares),
      referral_points: referralPoints,
      ...assets,
      error: joinErrors(shareResult.error, assetError)
    };
  });
}

export function buildErrorDetailRow(wallet, error, holdingResult = {}, balanceResult = {}, pnlResult = {}) {
  const assets = assetFields(holdingResult, balanceResult, pnlResult);
  return {
    wallet, status: "error",
    total_points: "0", allocation_round_points: "0", week: "", calculated: "", week_start_ts: "", week_end_ts: "", week_start_utc8: "", week_end_utc8: "",
    trade_count: "0", paid_volume_usdt: "0", free_volume_usdt: "0", total_volume_usdt: "0", total_volume_shares: "",
    paid_fee_usdt: "0", cost_usdt: "0", points: "0", cost_per_point: "",
    total_volume_per_point: "", paid_volume_per_point: "", free_volume_per_point: "", shares_per_point: "", referral_points: "0",
    ...assets,
    error: joinErrors(error, holdingResult && holdingResult.error, balanceResult && balanceResult.error, pnlResult && pnlResult.error)
  };
}

export function buildSummaryRows(detailRows) {
  const map = new Map();
  for (const row of detailRows) {
    const wallet = row.wallet;
    if (!map.has(wallet)) {
      map.set(wallet, {
        wallet, name: "", status: row.status === "error" ? "error" : "ok", total_points: row.total_points || "0", selected_weeks: [], calculated_all: "true",
        trade_count: "0", paid_volume_usdt: "0", free_volume_usdt: "0", total_volume_usdt: "0", total_volume_shares: "",
        paid_fee_usdt: "0", cost_usdt: "0", points: "0", referral_points: "0",
        holding_amount_usdt: "", available_balance_usdt: "", net_asset_usdt: "", pnl: "", error: ""
      });
    }
    const s = map.get(wallet);
    if (row.name) s.name = String(row.name);
    if (row.holding_amount_usdt !== "" && row.holding_amount_usdt !== undefined && row.holding_amount_usdt !== null) s.holding_amount_usdt = normalizeDecimal(row.holding_amount_usdt);
    if (row.available_balance_usdt !== "" && row.available_balance_usdt !== undefined && row.available_balance_usdt !== null) s.available_balance_usdt = normalizeDecimal(row.available_balance_usdt);
    if (row.pnl !== "" && row.pnl !== undefined && row.pnl !== null) s.pnl = normalizeDecimal(row.pnl);
    if (s.holding_amount_usdt !== "" || s.available_balance_usdt !== "") s.net_asset_usdt = decimalAdd(s.holding_amount_usdt || "0", s.available_balance_usdt || "0");

    if (row.status === "error") { s.status = "error"; s.calculated_all = ""; s.error = joinErrors(s.error, row.error || "请求失败"); continue; }
    if (row.status !== "ok") { if (!s.error) s.error = row.error || row.status; continue; }

    s.total_points = row.total_points || s.total_points;
    s.selected_weeks.push(String(row.week));
    if (String(row.calculated).toLowerCase() !== "true") s.calculated_all = "false";
    s.trade_count = decimalAdd(s.trade_count, row.trade_count || "0");
    s.paid_volume_usdt = decimalAdd(s.paid_volume_usdt, row.paid_volume_usdt || "0");
    s.free_volume_usdt = decimalAdd(s.free_volume_usdt, row.free_volume_usdt || "0");
    s.total_volume_usdt = decimalAdd(s.total_volume_usdt, row.total_volume_usdt || "0");
    if (row.total_volume_shares !== "" && row.total_volume_shares !== undefined && row.total_volume_shares !== null) {
      s.total_volume_shares = s.total_volume_shares === "" ? normalizeDecimal(row.total_volume_shares) : decimalAdd(s.total_volume_shares, row.total_volume_shares || "0");
    }
    s.paid_fee_usdt = decimalAdd(s.paid_fee_usdt, row.paid_fee_usdt || "0");
    s.cost_usdt = decimalAdd(s.cost_usdt, row.cost_usdt || "0");
    s.points = decimalAdd(s.points, row.points || "0");
    s.referral_points = decimalAdd(s.referral_points, row.referral_points || "0");
    if (row.error && !s.error) s.error = row.error;
  }
  return [...map.values()].map(row => ({
    ...row,
    selected_weeks: row.selected_weeks.join(","),
    cost_per_point: computeCostPerPoint(row.points, row.cost_usdt),
    total_volume_per_point: computeVolumePerPoint(row.points, row.total_volume_usdt),
    paid_volume_per_point: computeVolumePerPoint(row.points, row.paid_volume_usdt),
    free_volume_per_point: computeVolumePerPoint(row.points, row.free_volume_usdt),
    shares_per_point: computeOptionalVolumePerPoint(row.points, row.total_volume_shares)
  }));
}

export function findBestWallet(rows) {
  let best = null, bestVal = Number.POSITIVE_INFINITY;
  for (const row of rows) {
    if (row.status !== "ok" || !isValidCpp(row.cost_per_point)) continue;
    const v = cppSortValue(row.cost_per_point);
    if (v < bestVal) { bestVal = v; best = row; }
  }
  return best;
}
