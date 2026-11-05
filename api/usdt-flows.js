// Vercel Serverless Function: /api/usdt-flows
// 钱包在 BSC 链上的 USDT 充值 / 提现汇总，逻辑照搬 Dune 查询：
//   - 取该地址所有 USDT（0x55d3…7955）转账，to = 钱包 → 充值(IN)，否则 → 提现(OUT)
//   - 对手方是 Predict 市场合约（下面 MARKET_CONTRACTS）的一律剔除（那是交易资金流，不是充提）
//   - 对手方是 RewardDistributor / RedeemSettlement 的「充值」剔除（奖励发放与结算回款不算入金）
//   - 金额 < 10 USDT 的剔除（粉尘 / 测试）
// 数据源：Etherscan V2 统一接口（chainid=56 即 BSC）的 account.tokentx，需要免费 API key。
//
// Response: { success, address, deposit_usdt, withdraw_usdt, net_usdt,
//             transfer_count, scanned_count, truncated?, source, error? }
// ?full=1 额外返回筛选后的明细 flows[]（按时间倒序，最多 FULL_LIMIT 条）。
//
// Env: ETHERSCAN_API_KEY（必需；也接受 BSCSCAN_API_KEY），
//      USDT_FLOWS_MIN_AMOUNT（默认 10），
//      USDT_FLOWS_EXTRA_MARKET_CONTRACTS / USDT_FLOWS_EXTRA_EXCLUDE_INFLOW（逗号分隔，追加地址），
//      PREDICT_UPSTREAM_TIMEOUT_MS

const { ETH_RE, send, logError, UPSTREAM_TIMEOUT_MS } = require('./_predict-graphql');

const ETHERSCAN_V2 = 'https://api.etherscan.io/v2/api';
const BSC_CHAIN_ID = '56';
const USDT_CONTRACT = '0x55d398326f99059fF775485246999027B3197955';
const USDT_DECIMALS = 18;
const PAGE_SIZE = 10000;      // Etherscan 单次最多 10000 条
const MAX_WINDOWS = 10;       // 按区块窗口最多翻 10 次（10 万条转账）
const FULL_LIMIT = 2000;

// Predict 市场相关合约：与它们之间的 USDT 流动是下单 / 结算，不是充提。
const MARKET_CONTRACTS = {
  '0x76f42e5520e62ad88f8fe583cbb4bff27eec2531': 'UmaOptimisticOracle',
  '0x09f683d8a144c4ac296d770f839098c3377410c5': 'Vault',
  '0x9400f8ad57e9e0f352345935d6d3175975eb1d9f': 'YB_ConditionalTokens',
  '0x947cc06d38d3cb0a2bb5adfb668b99b4ff53d7b4': 'YB_UmaCtfAdapter',
  '0x6beb5a40c032afc305961162d8204cda16decfa5': 'YB_CTFExchange',
  '0xf64b0b318aaf83bd9071110af24d24445719a07f': 'YB_NegRiskConditionalTokens',
  '0x41dce1a4b8fb5e6327701750af6231b7cd0b2a40': 'YB_NegRiskAdapter',
  '0xcfb9bef5f7b748ac72311f057f3a888bc73334d9': 'YB_WrappedCollateral',
  '0x8a289d458f5a134ba40015085a8f50ffb681b41d': 'YB_NegRiskCtfExchange',
  '0xbb7250101e0e3611d7e136ffe73bc24b98e3e175': 'YB_NegRiskOperator',
  '0x26b366ab634c43bda6d784fdce34f24a37df8172': 'YB_NegRiskUmaAdapter',
  '0xfbc2259abb3f01c019ece1d0200ee673bb7ba34f': 'YB_FeeModuleV2',
  '0xd172f3fbabe763ee8e52d8b32421574236da6057': 'YB_NegRiskFeeModuleV2',
  '0xb4d9f13738a50e88e0ade2eccc89254ef1645f6e': 'YB_CtfFeesHandler',
  '0xa48c26abd9024a5cc5a869bbd97a6a3d6b9c2089': 'YB_RegisterTokenHelper',
  '0x22da1810b194ca018378464a58f6ac2b10c9d244': 'NYB_ConditionalTokens',
  '0x242e1ba24f6fc524bfb410062ca5689a9622613d': 'NYB_UmaCtfAdapter',
  '0x8bc070bedab741406f4b1eb65a72bee27894b689': 'NYB_CTFExchange',
  '0xc3cf7c252f65e0d8d88537df96569ae94a7f1a6e': 'NYB_NegRiskAdapter',
  '0x66239b70133773a72a0d589e5564e88a50cd39e7': 'NYB_WrappedCollateral',
  '0x365fb81bd4a24d6303cd2f19c349de6894d8d58a': 'NYB_NegRiskCtfExchange',
  '0x56020f5024641d577cb54032af70a23a986ecffd': 'NYB_NegRiskOperator',
  '0xf61198a64c2e4cad8ccaf218f3f2ecefb017902f': 'NYB_NegRiskUmaAdapter',
  '0xf1f8f5c641f20c48526269ef7dff19172efa9783': 'NYB_FeeModuleV2',
  '0xf2311c668aaa8dec48d5da577d3018eb94b3132f': 'NYB_NegRiskFeeModuleV2',
  '0xd63206243192f1af3d6fc4442db4e3cf25e64030': 'NYB_CtfFeesHandler',
  '0x89f92c3c27f18080af1361024c6a892144fd8e5e': 'NYB_RegisterTokenHelper',
};

// 只剔除「充值」方向：奖励发放、结算回款不是用户自己打进来的钱。
const EXCLUDE_INFLOW = {
  '0x14e3cb02f48818a8fef6bc257059767ca9d436ae': 'RewardDistributor',
  '0xfca64d34859b120c36426d41f941e708ea47cbec': 'RedeemSettlement',
};

function firstQueryValue(value) {
  return Array.isArray(value) ? value[0] : value;
}

function parseExtra(envValue) {
  return String(envValue || '').split(',').map(s => s.trim().toLowerCase()).filter(s => /^0x[0-9a-f]{40}$/.test(s));
}

function buildLists(env = process.env) {
  const market = new Set(Object.keys(MARKET_CONTRACTS));
  for (const a of parseExtra(env.USDT_FLOWS_EXTRA_MARKET_CONTRACTS)) market.add(a);
  const excludeInflow = new Set(Object.keys(EXCLUDE_INFLOW));
  for (const a of parseExtra(env.USDT_FLOWS_EXTRA_EXCLUDE_INFLOW)) excludeInflow.add(a);
  return { market, excludeInflow };
}

// 把 wei 整数（BigInt）格式化成十进制字符串，去掉多余的 0。
function weiToDecimal(wei, decimals = USDT_DECIMALS) {
  const neg = wei < 0n;
  const abs = neg ? -wei : wei;
  const s = abs.toString().padStart(decimals + 1, '0');
  const int = s.slice(0, -decimals);
  const frac = s.slice(-decimals).replace(/0+$/, '');
  return `${neg ? '-' : ''}${int}${frac ? '.' + frac : ''}`;
}

function minAmountWei(env = process.env) {
  const raw = String(env.USDT_FLOWS_MIN_AMOUNT ?? '10').trim();
  const m = raw.match(/^(\d+)(?:\.(\d+))?$/);
  if (!m) return 10n * 10n ** BigInt(USDT_DECIMALS);
  const frac = (m[2] || '').slice(0, USDT_DECIMALS).padEnd(USDT_DECIMALS, '0');
  return BigInt(m[1]) * 10n ** BigInt(USDT_DECIMALS) + BigInt(frac);
}

// 核心规则：把 tokentx 记录分类、过滤、汇总。可独立测试。
function summarizeTransfers(address, transfers, { lists = buildLists(), minWei = minAmountWei() } = {}) {
  const me = String(address).toLowerCase();
  let deposit = 0n;
  let withdraw = 0n;
  const flows = [];
  for (const t of transfers) {
    const from = String(t.from || '').toLowerCase();
    const to = String(t.to || '').toLowerCase();
    if (from !== me && to !== me) continue;
    let value;
    try { value = BigInt(String(t.value || '0')); } catch { continue; }
    const decimals = Number(t.tokenDecimal ?? USDT_DECIMALS);
    // 极少数记录 decimals 不是 18 时按比例换算到 18 位，保证同一口径相加。
    if (Number.isInteger(decimals) && decimals !== USDT_DECIMALS) {
      value = decimals < USDT_DECIMALS ? value * 10n ** BigInt(USDT_DECIMALS - decimals) : value / 10n ** BigInt(decimals - USDT_DECIMALS);
    }
    if (value < minWei) continue;
    const dir = to === me ? 'IN' : 'OUT';
    const counterparty = dir === 'IN' ? from : to;
    if (lists.market.has(counterparty)) continue;
    if (dir === 'IN' && lists.excludeInflow.has(counterparty)) continue;
    if (dir === 'IN') deposit += value; else withdraw += value;
    flows.push({
      block_time: Number.isFinite(Number(t.timeStamp)) ? new Date(Number(t.timeStamp) * 1000).toISOString() : null,
      block_number: Number(t.blockNumber) || null,
      category: dir === 'IN' ? '充值 ←' : '提现 →',
      dir,
      counterparty: t[dir === 'IN' ? 'from' : 'to'],
      amount_usdt: weiToDecimal(value),
      tx_hash: t.hash || null,
    });
  }
  flows.sort((a, b) => (b.block_number || 0) - (a.block_number || 0));
  return { deposit, withdraw, net: deposit - withdraw, flows };
}

// 按区块窗口翻页取完整转账列表。fetchPage({ startblock }) → tokentx 的 result 数组；可注入以便测试。
async function fetchAllTransfers(fetchPage) {
  const all = [];
  const seen = new Set();
  let startblock = 0;
  let windows = 0;
  let truncated = false;
  while (windows < MAX_WINDOWS) {
    const page = await fetchPage({ startblock });
    windows += 1;
    for (const t of page) {
      const key = `${t.hash}:${t.from}:${t.to}:${t.value}:${t.timeStamp}`;
      if (seen.has(key)) continue;
      seen.add(key);
      all.push(t);
    }
    if (page.length < PAGE_SIZE) break;
    const lastBlock = Number(page[page.length - 1].blockNumber);
    if (!Number.isFinite(lastBlock) || lastBlock <= startblock) break;
    // 从最后一条所在区块重新开始（同区块的会被 seen 去重），不会漏掉同块后半段。
    startblock = lastBlock;
    if (windows >= MAX_WINDOWS) truncated = true;
  }
  return { transfers: all, windows, truncated };
}

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') return send(res, 204, '');
  if (req.method !== 'GET') return send(res, 405, { success: false, error: 'Method not allowed' });

  const rawAddress = String(firstQueryValue(req.query.address) || '').trim();
  const full = String(firstQueryValue(req.query.full) || '') === '1';
  const debug = String(firstQueryValue(req.query.debug) || '') === '1';
  if (!ETH_RE.test(rawAddress)) return send(res, 400, { success: false, error: 'Invalid address' });
  const address = rawAddress;

  const apiKey = (process.env.ETHERSCAN_API_KEY || process.env.BSCSCAN_API_KEY || '').trim();
  if (!apiKey) {
    return send(res, 500, { success: false, address, error: 'ETHERSCAN_API_KEY not configured (free key at etherscan.io; it covers BSC via chainid=56)', source: 'etherscan_v2_tokentx' });
  }

  const fetchPage = async ({ startblock }) => {
    const url = new URL(ETHERSCAN_V2);
    const params = {
      chainid: BSC_CHAIN_ID, module: 'account', action: 'tokentx', contractaddress: USDT_CONTRACT, address,
      page: '1', offset: String(PAGE_SIZE), startblock: String(startblock), endblock: '999999999', sort: 'asc', apikey: apiKey,
    };
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    for (let attempt = 0; attempt < 3; attempt++) {
      let upstream;
      try {
        upstream = await fetch(url.toString(), { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS) });
      } catch (e) {
        const timedOut = e && (e.name === 'TimeoutError' || e.name === 'AbortError');
        if (attempt < 2) { await new Promise(r => setTimeout(r, 400 * (attempt + 1))); continue; }
        const err = new Error(timedOut ? `Etherscan timed out after ${UPSTREAM_TIMEOUT_MS}ms` : (e?.message || 'Etherscan fetch failed'));
        err.status = 504;
        throw err;
      }
      const text = await upstream.text();
      let json = null;
      try { json = JSON.parse(text); } catch { /* fallthrough */ }
      if (!upstream.ok || !json) {
        const err = new Error(`Etherscan HTTP ${upstream.status}`);
        err.status = 502; err.raw = text.slice(0, 500);
        throw err;
      }
      if (Array.isArray(json.result)) return json.result;
      const message = `${json.message || ''} ${json.result || ''}`.trim();
      if (/no transactions found/i.test(message)) return [];
      if (/rate limit/i.test(message) && attempt < 2) { await new Promise(r => setTimeout(r, 400 * (attempt + 1))); continue; }
      const err = new Error(`Etherscan: ${message || 'unexpected response'}`);
      err.status = /invalid api key/i.test(message) ? 500 : 502;
      err.raw = json;
      throw err;
    }
    throw Object.assign(new Error('Etherscan: rate limited'), { status: 429 });
  };

  try {
    const { transfers, windows, truncated } = await fetchAllTransfers(fetchPage);
    const summary = summarizeTransfers(address, transfers);
    return send(res, 200, {
      success: true,
      address,
      deposit_usdt: weiToDecimal(summary.deposit),
      withdraw_usdt: weiToDecimal(summary.withdraw),
      net_usdt: weiToDecimal(summary.net),
      transfer_count: summary.flows.length,
      scanned_count: transfers.length,
      windows,
      ...(truncated ? { truncated: true } : {}),
      min_amount_usdt: weiToDecimal(minAmountWei()),
      source: 'etherscan_v2_tokentx',
      ...(full ? { flows: summary.flows.slice(0, FULL_LIMIT) } : {}),
      ...(debug ? { market_contracts: MARKET_CONTRACTS, exclude_inflow: EXCLUDE_INFLOW } : {}),
    });
  } catch (err) {
    logError('usdt-flows', { address, status: err?.status || 500, message: err?.message || 'usdt-flows failed' });
    return send(res, err?.status || 500, {
      success: false, address, error: err?.message || 'usdt-flows failed', source: 'etherscan_v2_tokentx',
      ...(debug ? { raw: err?.raw ?? null } : {}),
    });
  }
};

Object.assign(module.exports, { summarizeTransfers, fetchAllTransfers, weiToDecimal, minAmountWei, buildLists, MARKET_CONTRACTS, EXCLUDE_INFLOW, PAGE_SIZE });
