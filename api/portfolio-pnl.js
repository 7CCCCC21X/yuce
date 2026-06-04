// Vercel Serverless Function: /api/portfolio-pnl
// Proxies Predict.fun GraphQL GetAccountPnlTimeseries and returns the latest
// pnlTimeseries point as { pnlUsd, timestamp, cursor, source }.
// Official Portfolio PNL = latest edges[].node.y. Not positions.pnlUsd, not trade replay.
// Optional env vars: PREDICT_GRAPHQL_URL, PREDICT_GRAPHQL_AUTH, PREDICT_GRAPHQL_COOKIE

const { ETH_RE, toChecksumAddress, send, predictGraphql } = require('./_predict-graphql');

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
  const interval = normalizeInterval(req.query.interval);

  if (!ETH_RE.test(rawAddress)) {
    return send(res, 400, {
      success: false,
      error: 'Invalid address',
    });
  }

  // GraphQL account(address:) needs the EIP-55 checksummed address.
  const address = toChecksumAddress(rawAddress);

  try {
    const json = await predictGraphql({
      query: QUERY,
      variables: {
        address,
        filter: { interval },
      },
      operationName: 'GetAccountPnlTimeseries',
    });

    const latest = latestPnlPointFromPayload(json);

    if (!latest) {
      const ts = json?.data?.account?.pnlTimeseries;
      return send(res, 200, {
        success: false,
        address,
        interval,
        error: 'No PNL timeseries point found',
        source: 'predict_graphql_GetAccountPnlTimeseries',
        diag: {
          hasData: !!json?.data,
          accountPresent: json?.data ? json.data.account !== null && json.data.account !== undefined : false,
          pnlTimeseriesPresent: !!ts,
          edgeCount: Array.isArray(ts?.edges) ? ts.edges.length : null,
        },
        raw: json ?? null,
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
