// Vercel Serverless Function: /api/portfolio-pnl
// Proxies Predict.fun GraphQL GetAccountPnlTimeseries and returns the latest
// pnlTimeseries point as { pnlUsd, timestamp, cursor, source }.
// Official Portfolio PNL = latest edges[].node.y. Not positions.pnlUsd, not trade replay.
//
// interval 支持官网所有档位：
//   _1H / _1D / _1W / _1M ... 这类窗口值，以及 ALL（全部/累计盈亏，默认值）。
//   也接受不带下划线（1D）和小写（all、1d）的写法。
// 上游 ALL 档的枚举名未在文档公开，这里按候选名逐个尝试并缓存命中的那个。
//
// Response envelope: { success, address, interval, ...fields, error?, source }.
// `raw` (upstream timeseries) is only included when called with ?debug=1.
// ?full=1 时额外返回完整时序 points: [{ x, y }]。
//
// Optional env vars: PREDICT_GRAPHQL_URL, PREDICT_GRAPHQL_AUTH, PREDICT_GRAPHQL_COOKIE

const { ETH_RE, toChecksumAddress, send, predictGraphql, logError } = require('./_predict-graphql');

const QUERY = `query GetAccountPnlTimeseries($address: Address!, $filter: TimeseriesFilterInput!, $pagination: ForwardPaginationInput) {
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

// 官网“全部（ALL）”档实际发送的枚举名是 MAX（已从真实请求荷载确认）。
// 保留候选回退链，以防上游将来改枚举名。
const ALL_INTERVAL_CANDIDATES = ['MAX', 'ALL', '_ALL', '_MAX', 'ALL_TIME'];

// 命中过的“全部”枚举名缓存在模块级，同一实例后续请求不再重试。
let resolvedAllInterval = 'MAX';

// 分页保护上限：足够覆盖很长的时序，同时防止上游异常时无限翻页。
const MAX_PAGES = 25;

function normalizeInterval(value) {
  const interval = String(value == null ? '' : value).trim().toUpperCase();

  // 默认查“全部”（官网 ALL 档，累计盈亏）。
  if (!interval) return 'ALL';

  // _1H / _1D / _1W / _1M 这类窗口值；也接受不带下划线的 1D 写法。
  if (/^_\d+[A-Z]$/.test(interval)) return interval;
  if (/^\d+[A-Z]$/.test(interval)) return `_${interval}`;

  // ALL / MAX 这类词形枚举。
  if (/^_?[A-Z][A-Z_]*$/.test(interval)) return interval;

  return 'ALL';
}

function isAllInterval(interval) {
  return ALL_INTERVAL_CANDIDATES.includes(interval);
}

// GraphQL 枚举校验错误（interval 值不被上游认识）的粗略判定，
// 用于区分“换个枚举名再试”和“真正的请求失败”。
function isIntervalEnumError(err) {
  const messages = [err?.message];
  const rawErrors = err?.raw?.errors;
  if (Array.isArray(rawErrors)) {
    for (const e of rawErrors) messages.push(e?.message);
  }
  return messages.some(m =>
    typeof m === 'string' &&
    /interval|TimeseriesInterval|enum/i.test(m) &&
    /invalid|does not exist|cannot represent|expected/i.test(m)
  );
}

function pointsFromEdges(edges) {
  if (!Array.isArray(edges)) return [];

  return edges
    .map(edge => {
      const x = Number(edge?.node?.x ?? edge?.cursor);
      const y = Number(edge?.node?.y);

      return {
        x,
        y,
        cursor: edge?.cursor ?? null,
      };
    })
    .filter(point => Number.isFinite(point.x) && Number.isFinite(point.y));
}

// 跟随 hasNextPage 翻页取完整时序，保证“最新一个点”不会因为分页被截断。
async function fetchPnlTimeseries(address, interval) {
  const points = [];
  let after = null;
  let pages = 0;
  let lastPayload = null;
  let truncated = false;

  while (pages < MAX_PAGES) {
    const json = await predictGraphql({
      query: QUERY,
      variables: {
        address,
        filter: { interval },
        ...(after ? { pagination: { after } } : {}),
      },
      operationName: 'GetAccountPnlTimeseries',
    });

    lastPayload = json;
    pages += 1;

    const ts = json?.data?.account?.pnlTimeseries;
    points.push(...pointsFromEdges(ts?.edges));

    const pageInfo = ts?.pageInfo;
    if (!pageInfo?.hasNextPage || !pageInfo?.endCursor) break;
    after = pageInfo.endCursor;

    if (pages >= MAX_PAGES) truncated = true;
  }

  points.sort((a, b) => a.x - b.x);

  return { points, lastPayload, pages, truncated };
}

// interval=ALL 时上游枚举名不确定，按候选逐个试；命中后缓存。
async function fetchWithAllFallback(address, interval) {
  if (!isAllInterval(interval)) {
    const result = await fetchPnlTimeseries(address, interval);
    return { ...result, interval };
  }

  // 已命中的枚举名放最前，其余候选保留兜底（上游改枚举名时自动重新探测）。
  const candidates = [...new Set([resolvedAllInterval, interval, ...ALL_INTERVAL_CANDIDATES].filter(Boolean))];

  let lastErr = null;
  for (const candidate of candidates) {
    try {
      const result = await fetchPnlTimeseries(address, candidate);
      resolvedAllInterval = candidate;
      return { ...result, interval: candidate };
    } catch (err) {
      lastErr = err;
      if (!isIntervalEnumError(err)) throw err;
    }
  }

  throw lastErr;
}

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    return send(res, 204, '');
  }

  if (req.method !== 'GET') {
    return send(res, 405, {
      success: false,
      error: 'Method not allowed',
    });
  }

  const rawAddress = String(req.query.address || '').trim();
  const requestedInterval = normalizeInterval(req.query.interval);
  const debug = String(req.query.debug || '') === '1';
  const full = String(req.query.full || '') === '1';

  if (!ETH_RE.test(rawAddress)) {
    return send(res, 400, {
      success: false,
      error: 'Invalid address',
    });
  }

  // GraphQL account(address:) needs the EIP-55 checksummed address.
  const address = toChecksumAddress(rawAddress);

  try {
    const { points, lastPayload, truncated, interval } = await fetchWithAllFallback(address, requestedInterval);

    if (!points.length) {
      const ts = lastPayload?.data?.account?.pnlTimeseries;
      return send(res, 200, {
        success: false,
        address,
        interval,
        error: 'No PNL timeseries point found',
        source: 'predict_graphql_GetAccountPnlTimeseries',
        diag: {
          hasData: !!lastPayload?.data,
          accountPresent: lastPayload?.data ? lastPayload.data.account !== null && lastPayload.data.account !== undefined : false,
          pnlTimeseriesPresent: !!ts,
          edgeCount: Array.isArray(ts?.edges) ? ts.edges.length : null,
        },
        ...(debug ? { raw: lastPayload ?? null } : {}),
      });
    }

    const latest = points[points.length - 1];

    return send(res, 200, {
      success: true,
      address,
      interval,

      // 这个就是官网 Portfolio 卡片口径的 PNL：
      // GetAccountPnlTimeseries 最新 edges[].node.y
      pnlUsd: latest.y,

      timestamp: latest.x,
      cursor: latest.cursor,
      pointCount: points.length,
      ...(truncated ? { truncated: true } : {}),
      ...(full ? { points: points.map(({ x, y }) => ({ x, y })) } : {}),
      source: 'predict_graphql_GetAccountPnlTimeseries',
      ...(debug ? { raw: lastPayload?.data?.account?.pnlTimeseries || null } : {}),
    });
  } catch (err) {
    logError('portfolio-pnl', {
      address,
      interval: requestedInterval,
      status: err?.status || 500,
      message: err?.message || 'Portfolio PNL proxy failed',
    });
    return send(res, err?.status || 500, {
      success: false,
      address,
      interval: requestedInterval,
      error: err?.message || 'Portfolio PNL proxy failed',
      source: 'predict_graphql_GetAccountPnlTimeseries',
      ...(debug ? { raw: err?.raw || null } : {}),
    });
  }
};
