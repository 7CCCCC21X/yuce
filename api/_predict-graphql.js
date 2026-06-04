// Shared helpers for Predict.fun GraphQL proxy serverless functions.
// Files/dirs prefixed with "_" are excluded from Vercel routing, so this is a
// plain module (not an endpoint). Used by /api/portfolio and /api/portfolio-pnl.
// Optional env vars: PREDICT_GRAPHQL_URL, PREDICT_GRAPHQL_AUTH, PREDICT_GRAPHQL_COOKIE

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

// POSTs a GraphQL operation to Predict.fun and returns the parsed JSON.
// Throws an Error with `.status` and `.raw` on transport / GraphQL errors.
async function predictGraphql({ query, variables, operationName }) {
  const graphqlUrl = process.env.PREDICT_GRAPHQL_URL || DEFAULT_GRAPHQL_URL;

  const headers = {
    Accept: 'application/graphql-response+json, application/json',
    'Content-Type': 'application/json',
    Origin: 'https://predict.fun',
    Referer: 'https://predict.fun/',
    'x-accept-language': 'zh-CN',
  };
  // Predict.fun's GraphQL appears to gate account-scoped data behind a session.
  // Forward a token / cookie when provided so the proxy can act as a logged-in client.
  // Capture these from a logged-in predict.fun session (DevTools → Network → the
  // GraphQL request headers) and set them as Vercel env vars.
  if (process.env.PREDICT_GRAPHQL_AUTH) headers.Authorization = process.env.PREDICT_GRAPHQL_AUTH;
  if (process.env.PREDICT_GRAPHQL_COOKIE) headers.Cookie = process.env.PREDICT_GRAPHQL_COOKIE;

  const upstream = await fetch(graphqlUrl, {
    method: 'POST',
    headers,
    body: JSON.stringify({ query, variables, operationName }),
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

module.exports = {
  ETH_RE,
  DEFAULT_GRAPHQL_URL,
  toChecksumAddress,
  send,
  predictGraphql,
};
