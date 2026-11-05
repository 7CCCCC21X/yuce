// Vercel Serverless Function: /api/positions-value
// 用 Predict 官方 REST（api.predict.fun，x-api-key）按地址翻完所有持仓页，
// 汇总成一个「持仓金额」，替代被 Cloudflare 拦掉的 GraphQL GetPortfolio。
//
// 真实响应结构（2026-10 实测）：
//   { success: true, cursor: "<下一页游标或 null>", data: [ {
//       id, amount: "300074213786861026296"   ← wei，份额 × 1e18
//       averageBuyPriceUsd: "0.91",             ← 普通小数
//       market: { id, outcomes: [ { bestAsk: { price, size }, bestBid: {...}, ... } ], ... },
//       ...（其余字段按出现情况取价）
//   } ] }
//
// 持仓金额 = Σ 每个持仓的价值：
//   1. 持仓自带 valueUsd / currentValueUsd 之类直接字段 → 直接用（wei 则换算）
//   2. 否则 份额 × 当前价（持仓自带价格字段，或所属 outcome 的 bestBid，
//      或市场最新成交价）
// 同时给出成本（份额 × 均价）与未实现盈亏（市值 − 成本），供需要时取用。
//
// Response: { success, address, positionsValueUsd, costUsd, unrealizedPnlUsd,
//             positionCount, pages, truncated?, source, error? }
// ?debug=1 额外返回每个持仓的取价明细 breakdown 与首页原始 raw。
//
// Env: PREDICT_API_KEY（必需）, PREDICT_API_BASE（可选）, PREDICT_UPSTREAM_TIMEOUT_MS

const { ETH_RE, send, logError, UPSTREAM_TIMEOUT_MS } = require('./_predict-graphql');

const DEFAULT_MAINNET_BASE = 'https://api.predict.fun';
const WEI_DECIMALS = 18;
const MAX_PAGES = 20;

function firstQueryValue(value) {
  return Array.isArray(value) ? value[0] : value;
}

// 数字字段：wei 整数字符串（很大、无小数点）按 1e18 换算，其余按普通小数解析。
function toAmount(value, { weiHint = true } = {}) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value === 'object') return null;
  const s = String(value).trim();
  if (!s) return null;
  if (weiHint && /^-?\d+$/.test(s) && s.replace('-', '').length >= WEI_DECIMALS - 2) {
    const neg = s.startsWith('-');
    const digits = s.replace('-', '').padStart(WEI_DECIMALS + 1, '0');
    const int = digits.slice(0, -WEI_DECIMALS);
    const frac = digits.slice(-WEI_DECIMALS);
    const n = Number(`${neg ? '-' : ''}${int}.${frac}`);
    return Number.isFinite(n) ? n : null;
  }
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function pick(obj, keys) {
  for (const k of keys) {
    const v = obj && obj[k];
    if (v !== undefined && v !== null && v !== '') return { key: k, value: v };
  }
  return null;
}

// 找到持仓对应的 outcome（按 index / id / 名称），用于取 bestBid。
function findOutcome(position) {
  const outcomes = Array.isArray(position?.market?.outcomes) ? position.market.outcomes : [];
  if (!outcomes.length) return null;
  const idx = pick(position, ['outcomeIndex', 'outcome_index', 'indexSet']);
  if (idx && Number.isInteger(Number(idx.value))) {
    const i = Number(idx.value);
    // indexSet 是位掩码（1 = 第 0 个结果，2 = 第 1 个）；outcomeIndex 是下标。
    const byIndex = idx.key === 'indexSet' ? outcomes[Math.log2(i)] : outcomes[i];
    if (byIndex) return byIndex;
  }
  const id = pick(position, ['outcomeId', 'outcome_id']);
  if (id) {
    const hit = outcomes.find(o => String(o?.id) === String(id.value));
    if (hit) return hit;
  }
  const name = typeof position?.outcome === 'string' ? position.outcome : position?.outcome?.name;
  if (name) {
    const hit = outcomes.find(o => String(o?.name || '').toLowerCase() === String(name).toLowerCase());
    if (hit) return hit;
  }
  if (position?.outcome && typeof position.outcome === 'object') return position.outcome;
  return null;
}

// 单个持仓的估值。返回 { shares, price, priceSource, value, cost, avgBuy }。
function valuePosition(position) {
  const shares = toAmount(pick(position, ['amount', 'shares', 'size', 'balance'])?.value);
  const avgBuy = toAmount(pick(position, ['averageBuyPriceUsd', 'avgBuyPriceUsd', 'averagePriceUsd', 'avgPrice'])?.value, { weiHint: false });

  // 1) 直接的价值字段
  const direct = pick(position, ['valueUsd', 'currentValueUsd', 'valueUsdt', 'value_usd', 'marketValueUsd']);
  if (direct) {
    const value = toAmount(direct.value);
    if (value !== null) {
      const cost = shares !== null && avgBuy !== null ? shares * avgBuy : null;
      return { shares, price: shares ? value / shares : null, priceSource: direct.key, value, cost, avgBuy };
    }
  }

  if (shares === null) return { shares: null, price: null, priceSource: 'none', value: null, cost: null, avgBuy };

  // 2) 份额 × 当前价
  let price = null;
  let priceSource = '';
  const own = pick(position, ['currentPriceUsd', 'currentPrice', 'priceUsd', 'markPriceUsd', 'lastPriceUsd', 'price']);
  if (own) { price = toAmount(own.value, { weiHint: false }); priceSource = own.key; }
  if (price === null) {
    const outcome = findOutcome(position);
    const bid = outcome?.bestBid?.price ?? outcome?.price ?? outcome?.lastPrice ?? null;
    if (bid !== null && bid !== undefined) { price = toAmount(bid, { weiHint: false }); priceSource = 'outcome.bestBid.price'; }
    if (price === null) {
      const ask = outcome?.bestAsk?.price;
      if (ask !== null && ask !== undefined) { price = toAmount(ask, { weiHint: false }); priceSource = 'outcome.bestAsk.price'; }
    }
  }
  if (price === null) {
    const mk = pick(position?.market || {}, ['lastTradePrice', 'lastPrice', 'price']);
    if (mk) { price = toAmount(mk.value, { weiHint: false }); priceSource = `market.${mk.key}`; }
  }
  if (price === null) return { shares, price: null, priceSource: 'none', value: null, cost: avgBuy !== null ? shares * avgBuy : null, avgBuy };

  return { shares, price, priceSource, value: shares * price, cost: avgBuy !== null ? shares * avgBuy : null, avgBuy };
}

function round(n, places = 6) {
  if (n === null || n === undefined || !Number.isFinite(n)) return null;
  return String(Number(n.toFixed(places)));
}

// 汇总多页持仓。fetchPage(cursor) → 上游 JSON；可注入以便测试。
async function aggregatePositions(fetchPage) {
  const breakdown = [];
  let cursor = null;
  let pages = 0;
  let truncated = false;
  let firstPage = null;
  const seenCursors = new Set();
  while (pages < MAX_PAGES) {
    const json = await fetchPage(cursor);
    if (!firstPage) firstPage = json;
    pages += 1;
    const list = Array.isArray(json?.data) ? json.data : Array.isArray(json) ? json : [];
    for (const p of list) breakdown.push({ id: p?.id ?? null, marketId: p?.market?.id ?? p?.marketId ?? null, ...valuePosition(p) });
    const next = json?.cursor ?? json?.nextCursor ?? null;
    if (!next || !list.length || seenCursors.has(next)) break;
    seenCursors.add(next);
    cursor = next;
    if (pages >= MAX_PAGES) truncated = true;
  }
  let value = 0, cost = 0, unpriced = 0, hasCost = false;
  for (const b of breakdown) {
    if (b.value === null) { unpriced += 1; continue; }
    value += b.value;
    if (b.cost !== null) { cost += b.cost; hasCost = true; }
  }
  return { breakdown, pages, truncated, firstPage, value, cost: hasCost ? cost : null, unpriced };
}

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') return send(res, 204, '');
  if (req.method !== 'GET') return send(res, 405, { success: false, error: 'Method not allowed' });

  const rawAddress = String(firstQueryValue(req.query.address) || '').trim();
  const debug = String(firstQueryValue(req.query.debug) || '') === '1';
  if (!ETH_RE.test(rawAddress)) return send(res, 400, { success: false, error: 'Invalid address' });
  const address = rawAddress;

  const base = (process.env.PREDICT_API_BASE || DEFAULT_MAINNET_BASE).replace(/\/+$/, '');
  const apiKey = process.env.PREDICT_API_KEY || '';
  const headers = { Accept: 'application/json' };
  if (apiKey) headers['x-api-key'] = apiKey;

  const fetchPage = async cursor => {
    const url = new URL(`${base}/v1/positions/${address}`);
    if (cursor) url.searchParams.set('cursor', cursor);
    let upstream;
    try {
      upstream = await fetch(url.toString(), { method: 'GET', headers, signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS) });
    } catch (e) {
      const timedOut = e && (e.name === 'TimeoutError' || e.name === 'AbortError');
      const err = new Error(timedOut ? `Upstream timed out after ${UPSTREAM_TIMEOUT_MS}ms` : (e?.message || 'Upstream fetch failed'));
      err.status = 504;
      throw err;
    }
    const text = await upstream.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* 非 JSON，下面按状态码报错 */ }
    if (!upstream.ok) {
      const err = new Error(json?.error || json?.message || `Predict REST HTTP ${upstream.status}${apiKey ? '' : ' (PREDICT_API_KEY not configured)'}`);
      err.status = upstream.status === 401 || upstream.status === 403 ? 502 : upstream.status;
      err.raw = text.slice(0, 800);
      throw err;
    }
    if (json && json.success === false) {
      const err = new Error(json.error || json.message || 'Predict REST returned success:false');
      err.status = 502;
      err.raw = json;
      throw err;
    }
    return json;
  };

  try {
    const agg = await aggregatePositions(fetchPage);
    const unrealized = agg.cost !== null ? agg.value - agg.cost : null;
    return send(res, 200, {
      success: true,
      address,
      positionsValueUsd: round(agg.value),
      costUsd: round(agg.cost),
      unrealizedPnlUsd: round(unrealized),
      positionCount: agg.breakdown.length,
      unpricedCount: agg.unpriced,
      pages: agg.pages,
      ...(agg.truncated ? { truncated: true } : {}),
      source: 'predict_rest_positions',
      ...(debug ? {
        breakdown: agg.breakdown.map(b => ({ ...b, shares: round(b.shares), price: round(b.price), value: round(b.value), cost: round(b.cost), avgBuy: round(b.avgBuy) })),
        raw: agg.firstPage,
      } : {}),
    });
  } catch (err) {
    logError('positions-value', { address, status: err?.status || 500, message: err?.message || 'positions-value failed' });
    return send(res, err?.status || 500, {
      success: false,
      address,
      error: err?.message || 'positions-value failed',
      source: 'predict_rest_positions',
      ...(debug ? { raw: err?.raw ?? null } : {}),
    });
  }
};

module.exports.toAmount = toAmount;
module.exports.valuePosition = valuePosition;
module.exports.aggregatePositions = aggregatePositions;
