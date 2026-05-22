// Vercel Serverless Function: /api/portfolio-pnl
// Proxies Predict.fun GraphQL GetAccountPnlTimeseries and returns the latest
// pnlTimeseries point as { pnlUsd, timestamp, cursor, source }.
// Official Portfolio PNL = latest edges[].node.y. Not positions.pnlUsd, not trade replay.
// Optional env var: PREDICT_GRAPHQL_URL

const ETH_RE = /^0x[0-9a-fA-F]{40}$/;
const DEFAULT_GRAPHQL_URL = 'https://graphql.predict.fun/graphql';

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

function send(res, status, body, extraHeaders = {}) {
  res.statusCode = status;

  for (const [key, value] of Object.entries({
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Cache-Control': 'no-store',
    ...extraHeaders,
  })) {
    res.setHeader(key, value);
  }

  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}

function normalizeInterval(value) {
  const interval = String(value || '_1D').trim();

  // 目前按你抓到的官网请求默认用 _1D。
  // 这里允许 _1H / _1D / _1W 这种格式，避免乱传。
  if (/^_\d+[A-Z]$/.test(interval)) return interval;

  return '_1D';
}

function latestPnlPointFromPayload(payload) {
  const edges = payload?.data?.account?.pnlTimeseries?.edges;

  if (!Array.isArray(edges) || edges.length === 0) {
    return null;
  }

  const points = edges
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

  if (!points.length) return null;

  points.sort((a, b) => b.x - a.x);

  return points[0];
}

async function fetchPnlTimeseries({ graphqlUrl, address, interval }) {
  const body = {
    query: QUERY,
    variables: {
      address,
      filter: {
        interval,
      },
    },
    operationName: 'GetAccountPnlTimeseries',
  };

  const upstream = await fetch(graphqlUrl, {
    method: 'POST',
    headers: {
      Accept: 'application/graphql-response+json, application/json',
      'Content-Type': 'application/json',
      Origin: 'https://predict.fun',
      Referer: 'https://predict.fun/',
      'x-accept-language': 'zh-CN',
    },
    body: JSON.stringify(body),
  });

  const text = await upstream.text();

  let json = null;

  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    const err = new Error('GraphQL returned non-JSON response');
    err.status = upstream.status || 502;
    err.raw = text.slice(0, 800);
    throw err;
  }

  if (!upstream.ok || Array.isArray(json?.errors)) {
    const err = new Error(
      json?.errors?.[0]?.message ||
      upstream.statusText ||
      'GraphQL request failed'
    );
    err.status = upstream.status || 502;
    err.raw = json;
    throw err;
  }

  return json;
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

  const address = String(req.query.address || '').trim();
  const interval = normalizeInterval(req.query.interval);

  if (!ETH_RE.test(address)) {
    return send(res, 400, {
      success: false,
      error: 'Invalid address',
    });
  }

  const graphqlUrl = process.env.PREDICT_GRAPHQL_URL || DEFAULT_GRAPHQL_URL;

  try {
    const json = await fetchPnlTimeseries({
      graphqlUrl,
      address,
      interval,
    });

    const latest = latestPnlPointFromPayload(json);

    if (!latest) {
      return send(res, 200, {
        success: false,
        address,
        interval,
        error: 'No PNL timeseries point found',
        source: 'predict_graphql_GetAccountPnlTimeseries',
        raw: json?.data?.account?.pnlTimeseries || null,
      });
    }

    return send(res, 200, {
      success: true,
      address,
      interval,

      // 这个就是官网 Portfolio 卡片口径的 PNL：
      // GetAccountPnlTimeseries 最新 edges[].node.y
      pnlUsd: latest.y,

      timestamp: latest.x,
      cursor: latest.cursor,
      source: 'predict_graphql_GetAccountPnlTimeseries',
      raw: json?.data?.account?.pnlTimeseries || null,
    });
  } catch (err) {
    return send(res, err?.status || 500, {
      success: false,
      address,
      interval,
      error: err?.message || 'Portfolio PNL proxy failed',
      source: 'predict_graphql_GetAccountPnlTimeseries',
      raw: err?.raw || null,
    });
  }
};
