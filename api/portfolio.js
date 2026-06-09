// Vercel Serverless Function: /api/portfolio
// Proxies Predict.fun GraphQL GetPortfolio and returns the account's official
// portfolio stats: { name, positionsValueUsd, pnlUsd, volumeUsd, ... }.
//
// Official "持仓金额" (Portfolio holdings value shown on predict.fun) =
// account.statistics.positionsValueUsd from this exact query. It is the value
// the website renders — NOT the sum of /v1/positions[].valueUsd.
//
// Response envelope: { success, address, ...fields, error?, source }.
// `raw` (upstream payload) is only included when called with ?debug=1.
//
// Optional env vars: PREDICT_GRAPHQL_URL, PREDICT_GRAPHQL_AUTH, PREDICT_GRAPHQL_COOKIE

const { ETH_RE, toChecksumAddress, send, predictGraphql, logError } = require('./_predict-graphql');

const QUERY = `query GetPortfolio($address: Address!) {
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
  const debug = String(req.query.debug || '') === '1';

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
      variables: { address },
      operationName: 'GetPortfolio',
    });

    const account = json?.data?.account ?? null;

    if (!account) {
      // Convention: lookup misses are 200 + success:false (client treats them
      // as data-level results, not transport failures worth retrying).
      return send(res, 200, {
        success: false,
        address,
        error: 'No account found for address',
        source: 'predict_graphql_GetPortfolio',
        ...(debug ? { raw: json ?? null } : {}),
      });
    }

    const stats = account.statistics || null;
    const leaderboard = account.leaderboard || null;

    return send(res, 200, {
      success: true,
      address,

      // 用户名（官网展示的名字）。
      name: account.name ?? null,

      // 这个就是官网 Portfolio 卡片口径的「持仓金额」：
      // GetPortfolio → account.statistics.positionsValueUsd
      positionsValueUsd: stats?.positionsValueUsd ?? null,

      pnlUsd: stats?.pnlUsd ?? null,
      volumeUsd: stats?.volumeUsd ?? null,
      marketsCount: stats?.marketsCount ?? null,
      pointsEarningRatio: account.pointsEarningRatio ?? null,
      totalPoints: leaderboard?.totalPoints ?? null,
      rank: leaderboard?.rank ?? null,

      source: 'predict_graphql_GetPortfolio',
      ...(debug ? { raw: account } : {}),
    });
  } catch (err) {
    logError('portfolio', {
      address,
      status: err?.status || 500,
      message: err?.message || 'Portfolio proxy failed',
    });
    return send(res, err?.status || 500, {
      success: false,
      address,
      error: err?.message || 'Portfolio proxy failed',
      source: 'predict_graphql_GetPortfolio',
      ...(debug ? { raw: err?.raw || null } : {}),
    });
  }
};
