// Vercel Serverless Function: /api/portfolio-pnl
// Proxies the official Predict.fun GraphQL GetAccountPnlTimeseries query and returns
// the latest pnlTimeseries value as { pnlUsd, timestamp, cursor, source }.
//
// Env vars (all optional, sensible defaults below):
//   PORTFOLIO_PNL_GRAPHQL_URL   GraphQL endpoint (default: https://api.predict.fun/graphql)
//   PORTFOLIO_PNL_QUERY         Override the GraphQL query string
//   PORTFOLIO_PNL_OPERATION     operationName (default: GetAccountPnlTimeseries)
//   PREDICT_API_KEY             Forwarded as x-api-key if the GraphQL endpoint needs auth
//
// The response parser is intentionally tolerant: it accepts pnlTimeseries as an array
// of points, or as { points: [...] }, and reads the LAST point's pnl-like field.

const DEFAULT_GRAPHQL_URL = 'https://api.predict.fun/graphql';
const DEFAULT_OPERATION = 'GetAccountPnlTimeseries';
const DEFAULT_QUERY = `query GetAccountPnlTimeseries($address: String!, $interval: PnlTimeseriesInterval!) {
  pnlTimeseries(address: $address, interval: $interval) {
    timestamp
    pnlUsd
    cursor
  }
}`;

function sendJson(res, status, body) {
  res.status(status).setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}

function firstQueryValue(value) {
  return Array.isArray(value) ? value[0] : value;
}

function toNum(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(String(value).replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}

// Pull the timeseries array out of common GraphQL response shapes.
function extractSeries(data) {
  const root = data && data.data ? data.data : data;
  if (!root) return [];
  let series = root.pnlTimeseries;
  if (series && !Array.isArray(series) && Array.isArray(series.points)) series = series.points;
  if (Array.isArray(series)) return series;
  // Fallback: scan one level deep for an array whose items look like timeseries points.
  for (const v of Object.values(root)) {
    if (Array.isArray(v) && v.length && typeof v[0] === 'object') return v;
    if (v && Array.isArray(v.points)) return v.points;
  }
  return [];
}

function pickPnl(point) {
  if (!point || typeof point !== 'object') return null;
  return toNum(point.pnlUsd) ?? toNum(point.pnl) ?? toNum(point.value) ?? toNum(point.cumulativePnlUsd) ?? toNum(point.realizedPnlUsd);
}

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') {
    return sendJson(res, 405, { error: 'Method not allowed' });
  }

  try {
    const address = String(firstQueryValue(req.query.address) || '').trim();
    const interval = String(firstQueryValue(req.query.interval) || '_1D').trim();

    if (!/^0x[a-fA-F0-9]{40}$/.test(address)) {
      return sendJson(res, 400, { error: 'Missing or invalid address. Example: /api/portfolio-pnl?address=0x...&interval=_1D' });
    }

    const graphqlUrl = process.env.PORTFOLIO_PNL_GRAPHQL_URL || DEFAULT_GRAPHQL_URL;
    const operationName = process.env.PORTFOLIO_PNL_OPERATION || DEFAULT_OPERATION;
    const query = process.env.PORTFOLIO_PNL_QUERY || DEFAULT_QUERY;

    const headers = { 'Content-Type': 'application/json', Accept: 'application/json' };
    if (process.env.PREDICT_API_KEY) headers['x-api-key'] = process.env.PREDICT_API_KEY;

    const upstreamRes = await fetch(graphqlUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify({ operationName, query, variables: { address, interval } })
    });

    const text = await upstreamRes.text();
    let json;
    try { json = text ? JSON.parse(text) : null; }
    catch { return sendJson(res, 502, { error: `Upstream returned non-JSON (HTTP ${upstreamRes.status})`, raw: text.slice(0, 300) }); }

    if (json && Array.isArray(json.errors) && json.errors.length) {
      return sendJson(res, 502, { error: json.errors.map(e => e && e.message).filter(Boolean).join('; ') || 'GraphQL error', raw: json });
    }

    const series = extractSeries(json);
    if (!series.length) {
      return sendJson(res, 200, { pnlUsd: null, error: '未取到官网PNL（pnlTimeseries 为空）', source: operationName, raw: json });
    }

    const last = series[series.length - 1];
    const pnlUsd = pickPnl(last);
    const timestamp = toNum(last && (last.timestamp ?? last.time ?? last.ts));
    const cursor = (last && (last.cursor ?? last.id)) || '';

    return sendJson(res, 200, {
      pnlUsd,
      timestamp,
      cursor,
      source: `predict_graphql_${operationName}`,
      ...(pnlUsd === null ? { error: '未取到官网PNL（最新点缺少 pnlUsd 字段）', raw: last } : {})
    });
  } catch (err) {
    sendJson(res, 500, { error: err && err.message ? err.message : String(err) });
  }
};
