// 浏览器直连 Predict.fun GraphQL。
//
// 背景：/api/portfolio 与 /api/portfolio-pnl 是 Vercel 函数，从 Vercel 出口请求
// graphql.predict.fun 会被 Cloudflare 的机器人规则整段拦掉（403 + Attention
// Required 页）。用户自己的浏览器能正常打开 predict.fun，说明它已经通过了
// Cloudflare 的校验，所以把这两个查询搬到浏览器里直接发，是最稳的绕法。
//
// 这里只负责「发什么、怎么翻页、把结果整理成和同域代理一模一样的信封」，
// 真正的 HTTP 发送由调用方注入 `post({ query, variables, operationName })`，
// 这样限流 / 超时 / 重试 / 停止仍统一走 api.js，单元测试也可以注入假的 post。
//
// 信封与 api/portfolio.js、api/portfolio-pnl.js 保持一致，api.js 里原有的
// 字段路径取值（positionsValueUsd / pnlUsd / points）无需任何改动。

import { toChecksumAddress } from "./checksum.js";

export const DEFAULT_GRAPHQL_URL = "https://graphql.predict.fun/graphql";

export const PORTFOLIO_QUERY = `query GetPortfolio($address: Address!) {
  account(address: $address) {
    name
    referralCode
    pointsEarningRatio
    leaderboard {
      totalPoints
      rank
    }
    statistics {
      volumeUsd
      positionsValueUsd
      pnlUsd
      marketsCount
      marketsCountByTag {
        name
        marketsCount
      }
    }
  }
}`;

export const PNL_QUERY = `query GetAccountPnlTimeseries($address: Address!, $filter: TimeseriesFilterInput!, $pagination: ForwardPaginationInput) {
  account(address: $address) {
    pnlTimeseries(filter: $filter, pagination: $pagination) {
      pageInfo {
        hasNextPage
        startCursor
        endCursor
      }
      edges {
        cursor
        node {
          x
          y
        }
      }
    }
  }
}`;

// 官网「全部（ALL）」档实际发送的枚举名是 MAX；保留候选回退链以防上游改名。
const ALL_INTERVAL_CANDIDATES = ["MAX", "ALL", "_ALL", "_MAX", "ALL_TIME"];
let resolvedAllInterval = "MAX";

// 分页保护上限：足够覆盖很长的时序，同时防止上游异常时无限翻页。
export const MAX_PAGES = 25;

const ETH_RE = /^0x[0-9a-fA-F]{40}$/;

export function normalizeInterval(value) {
  const interval = String(value == null ? "" : value).trim().toUpperCase();
  if (!interval) return "ALL";
  if (/^_\d+[A-Z]$/.test(interval)) return interval;
  if (/^\d+[A-Z]$/.test(interval)) return `_${interval}`;
  if (/^_?[A-Z][A-Z_]*$/.test(interval)) return interval;
  return "ALL";
}

export function isAllInterval(interval) {
  return ALL_INTERVAL_CANDIDATES.includes(interval);
}

// GraphQL 枚举校验错误（interval 值不被上游认识）的粗略判定。
export function isIntervalEnumError(err) {
  const messages = [err?.message];
  const rawErrors = err?.raw?.errors;
  if (Array.isArray(rawErrors)) for (const e of rawErrors) messages.push(e?.message);
  return messages.some(m =>
    typeof m === "string" &&
    /interval|TimeseriesInterval|enum/i.test(m) &&
    /invalid|does not exist|cannot represent|expected/i.test(m)
  );
}

function checksum(wallet) {
  const raw = String(wallet || "").trim();
  if (!ETH_RE.test(raw)) throw new Error(`钱包地址格式错误：${wallet}`);
  return toChecksumAddress(raw);
}

// ---------- GetPortfolio ----------

export function portfolioEnvelope(address, json) {
  const account = json?.data?.account ?? null;
  if (!account) {
    return { success: false, address, error: "No account found for address", source: "predict_graphql_GetPortfolio" };
  }
  const stats = account.statistics || null;
  const leaderboard = account.leaderboard || null;
  return {
    success: true,
    address,
    name: account.name ?? null,
    positionsValueUsd: stats?.positionsValueUsd ?? null,
    pnlUsd: stats?.pnlUsd ?? null,
    volumeUsd: stats?.volumeUsd ?? null,
    marketsCount: stats?.marketsCount ?? null,
    pointsEarningRatio: account.pointsEarningRatio ?? null,
    totalPoints: leaderboard?.totalPoints ?? null,
    rank: leaderboard?.rank ?? null,
    source: "predict_graphql_GetPortfolio"
  };
}

export async function fetchPortfolioDirect(post, wallet) {
  const address = checksum(wallet);
  const json = await post({ query: PORTFOLIO_QUERY, variables: { address }, operationName: "GetPortfolio" });
  return portfolioEnvelope(address, json);
}

// ---------- GetAccountPnlTimeseries ----------

export function pointsFromEdges(edges) {
  if (!Array.isArray(edges)) return [];
  return edges
    .map(edge => ({ x: Number(edge?.node?.x ?? edge?.cursor), y: Number(edge?.node?.y), cursor: edge?.cursor ?? null }))
    .filter(p => Number.isFinite(p.x) && Number.isFinite(p.y));
}

// 跟随 hasNextPage 翻页取完整时序，保证「最新一个点」不会因为分页被截断。
// 变量形状与 api/portfolio-pnl.js 完全一致（首页不带 pagination 字段）。
async function fetchPnlPoints(post, address, interval) {
  const points = [];
  let after = null;
  let lastPayload = null;
  let pages = 0;
  let truncated = false;
  while (pages < MAX_PAGES) {
    const variables = { address, filter: { interval }, ...(after ? { pagination: { after } } : {}) };
    const json = await post({ query: PNL_QUERY, variables, operationName: "GetAccountPnlTimeseries" });
    lastPayload = json;
    pages += 1;
    const ts = json?.data?.account?.pnlTimeseries;
    points.push(...pointsFromEdges(ts?.edges));
    const pageInfo = ts?.pageInfo;
    if (!pageInfo?.hasNextPage || !pageInfo?.endCursor || pageInfo.endCursor === after) break;
    after = pageInfo.endCursor;
    if (pages >= MAX_PAGES) truncated = true;
  }
  points.sort((a, b) => a.x - b.x);
  return { points, lastPayload, pages, truncated };
}

// interval=ALL 时上游枚举名不确定，按候选逐个试；命中后缓存。
export async function fetchPnlWithAllFallback(post, address, interval) {
  if (!isAllInterval(interval)) {
    const result = await fetchPnlPoints(post, address, interval);
    return { ...result, interval };
  }
  const candidates = [...new Set([resolvedAllInterval, interval, ...ALL_INTERVAL_CANDIDATES].filter(Boolean))];
  let lastErr = null;
  for (const candidate of candidates) {
    try {
      const result = await fetchPnlPoints(post, address, candidate);
      resolvedAllInterval = candidate;
      return { ...result, interval: candidate };
    } catch (err) {
      lastErr = err;
      if (!isIntervalEnumError(err)) throw err;
    }
  }
  throw lastErr;
}

export function pnlEnvelope(address, { points, interval, truncated }) {
  const source = "predict_graphql_GetAccountPnlTimeseries";
  if (!points.length) {
    return { success: false, address, interval, error: "No PNL timeseries point found", source };
  }
  const latest = points[points.length - 1];
  return {
    success: true,
    address,
    interval,
    pnlUsd: latest.y,
    timestamp: latest.x,
    cursor: latest.cursor,
    pointCount: points.length,
    ...(truncated ? { truncated: true } : {}),
    points: points.map(({ x, y }) => ({ x, y })),
    source
  };
}

export async function fetchPnlDirect(post, wallet, interval) {
  const address = checksum(wallet);
  const result = await fetchPnlWithAllFallback(post, address, normalizeInterval(interval));
  return pnlEnvelope(address, result);
}
