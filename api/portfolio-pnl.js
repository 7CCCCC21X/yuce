// Vercel Serverless Function: /api/portfolio-pnl
// Proxies Predict.fun GraphQL GetAccountPnlTimeseries and returns the latest
// pnlTimeseries point as { pnlUsd, timestamp, cursor, source }.
// Official Portfolio PNL = latest edges[].node.y. Not positions.pnlUsd, not trade replay.
// Optional env var: PREDICT_GRAPHQL_URL

const ETH_RE = /^0x[0-9a-fA-F]{40}$/;
const DEFAULT_GRAPHQL_URL = 'https://graphql.predict.fun/graphql';

// Predict.fun GraphQL `account(address: Address!)` resolves to null for a
// lowercase address; it needs the EIP-55 checksummed form. Compute it here so
// the proxy works regardless of the case sent by the client.
const KECCAK_RC = [
  0x0000000000000001n, 0x0000000000008082n, 0x800000000000808An, 0x8000000080008000n,
  0x000000000000808Bn, 0x0000000080000001n, 0x8000000080008081n, 0x8000000000008009n,
  0x000000000000008An, 0x0000000000000088n, 0x0000000080008009n, 0x000000008000000An,
  0x000000008000808Bn, 0x800000000000008Bn, 0x8000000000008089n, 0x8000000000008003n,
  0x8000000000008002n, 0x8000000000000080n, 0x000000000000800An, 0x800000008000000An,
  0x8000000080008081n, 0x8000000000008080n, 0x0000000080000001n, 0x8000000080008008n,
];
const KECCAK_ROTC = [1, 3, 6, 10, 15, 21, 28, 36, 45, 55, 2, 14, 27, 41, 56, 8, 25, 43, 62, 18, 39, 61, 20, 44];
const KECCAK_PILN = [10, 7, 11, 17, 18, 3, 5, 16, 8, 21, 24, 4, 15, 23, 19, 13, 12, 2, 20, 14, 22, 9, 6, 1];
const U64 = (1n << 64n) - 1n;

function keccak256(bytes) {
  const rotl = (x, n) => { n = BigInt(n % 64); return n === 0n ? x : ((x << n) | (x >> (64n - n))) & U64; };
  const rate = 136;
  const p = [...bytes, 0x01];
  while (p.length % rate !== 0) p.push(0);
  p[p.length - 1] |= 0x80;
  const st = new Array(25).fill(0n);
  for (let off = 0; off < p.length; off += rate) {
    for (let i = 0; i < rate / 8; i++) {
      let lane = 0n;
      for (let j = 0; j < 8; j++) lane |= BigInt(p[off + i * 8 + j]) << (8n * BigInt(j));
      st[i] ^= lane;
    }
    for (let round = 0; round < 24; round++) {
      const bc = new Array(5);
      for (let i = 0; i < 5; i++) bc[i] = st[i] ^ st[i + 5] ^ st[i + 10] ^ st[i + 15] ^ st[i + 20];
      for (let i = 0; i < 5; i++) { const t = bc[(i + 4) % 5] ^ rotl(bc[(i + 1) % 5], 1); for (let j = 0; j < 25; j += 5) st[j + i] ^= t; }
      let t = st[1];
      for (let i = 0; i < 24; i++) { const j = KECCAK_PILN[i]; const tmp = st[j]; st[j] = rotl(t, KECCAK_ROTC[i]); t = tmp; }
      for (let j = 0; j < 25; j += 5) {
        const c = [st[j], st[j + 1], st[j + 2], st[j + 3], st[j + 4]];
        for (let i = 0; i < 5; i++) st[j + i] = c[i] ^ ((~c[(i + 1) % 5] & U64) & c[(i + 2) % 5]);
      }
      st[0] ^= KECCAK_RC[round];
    }
  }
  let out = '';
  for (let i = 0; i < 32; i++) out += Number((st[i >> 3] >> (8n * BigInt(i & 7))) & 0xffn).toString(16).padStart(2, '0');
  return out;
}

function toChecksumAddress(address) {
  const lower = String(address).toLowerCase().replace(/^0x/, '');
  const hash = keccak256([...lower].map(c => c.charCodeAt(0)));
  let out = '0x';
  for (let i = 0; i < lower.length; i++) {
    const c = lower[i];
    out += (/[a-f]/.test(c) && parseInt(hash[i], 16) >= 8) ? c.toUpperCase() : c;
  }
  return out;
}

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
  const graphqlUrl = process.env.PREDICT_GRAPHQL_URL || DEFAULT_GRAPHQL_URL;

  try {
    const json = await fetchPnlTimeseries({
      graphqlUrl,
      address,
      interval,
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
