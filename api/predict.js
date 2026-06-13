// Vercel Serverless Function: /api/predict
// Reads Predict.fun API key from Vercel environment variables and proxies allowed GET requests.
// Required env var on mainnet: PREDICT_API_KEY
// Optional env vars: PREDICT_API_BASE, PREDICT_TESTNET_API_BASE, PREDICT_TESTNET_API_KEY,
// PREDICT_UPSTREAM_TIMEOUT_MS

const { send, UPSTREAM_TIMEOUT_MS, logError } = require('./_predict-graphql');

const DEFAULT_MAINNET_BASE = 'https://api.predict.fun';

function firstQueryValue(value) {
  return Array.isArray(value) ? value[0] : value;
}

function isAllowedPath(path) {
  // This page only needs user positions. Keep the proxy narrow so it cannot be abused as a general proxy.
  return path === '/v1/positions' || path.startsWith('/v1/positions/');
}

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') {
    return send(res, 405, { success: false, error: 'Method not allowed' });
  }

  try {
    const network = String(firstQueryValue(req.query.network) || 'mainnet').toLowerCase();
    const path = String(firstQueryValue(req.query.path) || '');

    if (!path.startsWith('/')) {
      return send(res, 400, { success: false, error: 'Missing or invalid path. Example: /api/predict?path=/v1/positions/0x...' });
    }

    if (!isAllowedPath(path)) {
      return send(res, 400, { success: false, error: 'Path is not allowed by this proxy' });
    }

    const base = network === 'testnet'
      ? (process.env.PREDICT_TESTNET_API_BASE || process.env.PREDICT_API_BASE || DEFAULT_MAINNET_BASE)
      : (process.env.PREDICT_API_BASE || DEFAULT_MAINNET_BASE);

    const upstream = new URL(path, base);

    // Forward extra query params except internal proxy params.
    for (const [key, rawValue] of Object.entries(req.query)) {
      if (key === 'path' || key === 'network') continue;
      const values = Array.isArray(rawValue) ? rawValue : [rawValue];
      for (const value of values) {
        if (value !== undefined && value !== null && value !== '') upstream.searchParams.append(key, String(value));
      }
    }

    const apiKey = network === 'testnet'
      ? (process.env.PREDICT_TESTNET_API_KEY || process.env.PREDICT_API_KEY || '')
      : (process.env.PREDICT_API_KEY || '');

    const headers = { Accept: 'application/json' };
    if (apiKey) headers['x-api-key'] = apiKey;

    let upstreamRes;
    try {
      upstreamRes = await fetch(upstream.toString(), {
        method: 'GET',
        headers,
        signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      });
    } catch (e) {
      const timedOut = e && (e.name === 'TimeoutError' || e.name === 'AbortError');
      logError('predict', { path, network, message: timedOut ? 'upstream timeout' : (e?.message || 'fetch failed') });
      return send(res, 504, {
        success: false,
        error: timedOut ? `Upstream timed out after ${UPSTREAM_TIMEOUT_MS}ms` : (e?.message || 'Upstream fetch failed'),
      });
    }

    const text = await upstreamRes.text();

    if (!upstreamRes.ok) {
      logError('predict', { path, network, status: upstreamRes.status, message: upstreamRes.statusText });
    }

    res.statusCode = upstreamRes.status;
    res.setHeader('Content-Type', upstreamRes.headers.get('content-type') || 'application/json; charset=utf-8');
    // Keep browser cache off because balances/positions are time-sensitive.
    res.setHeader('Cache-Control', 'no-store');
    res.end(text);
  } catch (err) {
    logError('predict', { message: err?.message || String(err) });
    send(res, 500, { success: false, error: err && err.message ? err.message : String(err) });
  }
};
