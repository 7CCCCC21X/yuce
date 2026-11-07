// yuce · predict.fun 官网数据批量导出脚本
//
// 用法：
//   1. 浏览器登录 https://predict.fun，按 F12 打开 DevTools → Console。
//   2. 把这个文件的全部内容粘贴到 Console 回车（Chrome 第一次会要求先输入 allow pasting）。
//   3. 页面右下角会出现一个面板：粘贴钱包地址（每行一个），点「开始」。
//   4. 跑完自动下载 yuce-portfolio-export-<时间>.json；回到 yuce 页面，
//      设置 → 「导入官网数据」选择这个文件即可。
//
// 为什么要在 predict.fun 页面上跑：它的 GraphQL 只允许 predict.fun 自己的来源跨域调用，
// 而你的浏览器又能通过 Cloudflare；从 Vercel 或别的网站发同样的请求都会被拦。
//
// 查询内容（与 yuce 服务端 /api/portfolio、/api/portfolio-pnl 完全相同的口径）：
//   GetPortfolio             → 用户名、持仓金额 positionsValueUsd、pnlUsd、交易量、总积分、排名
//   GetAccountPnlTimeseries  → 累计 PNL 时序（interval MAX，首页 750 条，跟随 hasNextPage 翻页）
//
// 本脚本只读，不发任何写操作，不碰钱包签名。

(() => {
  "use strict";
  const GRAPHQL_URL = "https://graphql.predict.fun/graphql";
  const CONCURRENCY = 3;
  const PAGE_SIZE = 750;
  const MAX_PAGES = 25;
  const PNL_INTERVALS = ["MAX", "ALL", "_ALL", "_MAX", "ALL_TIME"];

  // ---------- EIP-55 校验和（GraphQL 的 account(address:) 对小写地址返回 null）----------
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

  // ---------- GraphQL ----------
  const PORTFOLIO_QUERY = `query GetPortfolio($address: Address!) {
  account(address: $address) {
    name
    referralCode
    pointsEarningRatio
    leaderboard { totalPoints rank }
    statistics { volumeUsd positionsValueUsd pnlUsd marketsCount }
  }
}`;
  const PNL_QUERY = `query GetAccountPnlTimeseries($address: Address!, $filter: TimeseriesFilterInput!, $pagination: ForwardPaginationInput) {
  account(address: $address) {
    pnlTimeseries(filter: $filter, pagination: $pagination) {
      pageInfo { hasNextPage startCursor endCursor }
      edges { cursor node { x y } }
    }
  }
}`;

  async function gql(query, variables, operationName, attempt = 0) {
    const res = await fetch(GRAPHQL_URL, {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json", accept: "application/graphql-response+json, application/json" },
      body: JSON.stringify({ query, variables, operationName }),
    });
    if (res.status === 429 || res.status >= 500) {
      if (attempt < 3) { await sleep(800 * (attempt + 1)); return gql(query, variables, operationName, attempt + 1); }
    }
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { throw new Error(`HTTP ${res.status}：返回不是 JSON（${text.slice(0, 80)}）`); }
    if (!res.ok) throw new Error(`HTTP ${res.status}：${json?.errors?.[0]?.message || json?.message || text.slice(0, 120)}`);
    if (Array.isArray(json.errors) && json.errors.length) {
      const err = new Error(json.errors[0]?.message || "GraphQL 返回错误");
      err.graphqlErrors = json.errors;
      throw err;
    }
    return json;
  }

  const isEnumError = err => /interval|TimeseriesInterval|enum/i.test(err?.message || "") && /invalid|does not exist|cannot represent|expected/i.test(err?.message || "");
  let resolvedInterval = "MAX";

  async function fetchPnlPoints(address) {
    const candidates = [...new Set([resolvedInterval, ...PNL_INTERVALS])];
    let lastErr = null;
    for (const interval of candidates) {
      try {
        const points = [];
        let after = null;
        let pages = 0;
        while (pages < MAX_PAGES) {
          const variables = { address, filter: { interval }, pagination: { first: PAGE_SIZE, ...(after ? { after } : {}) } };
          const json = await gql(PNL_QUERY, variables, "GetAccountPnlTimeseries");
          pages += 1;
          const ts = json?.data?.account?.pnlTimeseries;
          for (const edge of ts?.edges || []) {
            const x = Number(edge?.node?.x ?? edge?.cursor), y = Number(edge?.node?.y);
            if (Number.isFinite(x) && Number.isFinite(y)) points.push({ x, y });
          }
          const pi = ts?.pageInfo;
          if (!pi?.hasNextPage || !pi?.endCursor || pi.endCursor === after) break;
          after = pi.endCursor;
        }
        points.sort((a, b) => a.x - b.x);
        resolvedInterval = interval;
        return { interval, points };
      } catch (err) {
        lastErr = err;
        if (!isEnumError(err)) throw err;
      }
    }
    throw lastErr;
  }

  async function queryWallet(raw) {
    const address = toChecksumAddress(raw);
    const out = { address, name: "", positionsValueUsd: null, pnlUsd: null, volumeUsd: null, marketsCount: null, totalPoints: null, rank: null, pnl_interval: null, pnl_points: [], error: "" };
    try {
      const json = await gql(PORTFOLIO_QUERY, { address }, "GetPortfolio");
      const account = json?.data?.account;
      if (!account) { out.error = "No account found for address"; return out; }
      out.name = account.name ?? "";
      out.positionsValueUsd = account.statistics?.positionsValueUsd ?? null;
      out.pnlUsd = account.statistics?.pnlUsd ?? null;
      out.volumeUsd = account.statistics?.volumeUsd ?? null;
      out.marketsCount = account.statistics?.marketsCount ?? null;
      out.totalPoints = account.leaderboard?.totalPoints ?? null;
      out.rank = account.leaderboard?.rank ?? null;
    } catch (err) { out.error = `GetPortfolio 失败: ${err.message}`; return out; }
    try {
      const { interval, points } = await fetchPnlPoints(address);
      out.pnl_interval = interval;
      out.pnl_points = points;
      // 官网 Portfolio 卡片的 PNL = 时序最后一个点；statistics.pnlUsd 作为备用。
      if (points.length) out.pnlUsd = points[points.length - 1].y;
    } catch (err) { out.error = `PNL 时序失败: ${err.message}`; }
    return out;
  }

  // ---------- 面板 ----------
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const old = document.getElementById("yuce-export-panel");
  if (old) old.remove();
  const panel = document.createElement("div");
  panel.id = "yuce-export-panel";
  panel.style.cssText = "position:fixed;right:16px;bottom:16px;z-index:2147483647;width:380px;max-height:80vh;overflow:auto;background:#111;color:#eee;font:13px/1.5 -apple-system,Segoe UI,Roboto,sans-serif;border:1px solid #444;border-radius:10px;padding:12px;box-shadow:0 8px 30px rgba(0,0,0,.5)";
  panel.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
      <b>yuce · 官网数据导出</b><button id="yx-close" style="background:none;border:0;color:#aaa;font-size:16px;cursor:pointer">✕</button>
    </div>
    <textarea id="yx-addrs" placeholder="钱包地址，每行一个（也可逗号 / 空格分隔）" style="width:100%;height:120px;background:#000;color:#eee;border:1px solid #444;border-radius:6px;padding:6px;box-sizing:border-box;font-family:ui-monospace,monospace;font-size:12px"></textarea>
    <div style="display:flex;gap:8px;margin:8px 0;align-items:center">
      <button id="yx-start" style="background:#4f46e5;color:#fff;border:0;border-radius:6px;padding:6px 14px;cursor:pointer">开始</button>
      <button id="yx-stop" disabled style="background:#333;color:#eee;border:0;border-radius:6px;padding:6px 12px;cursor:pointer">停止</button>
      <button id="yx-csv" disabled style="background:#333;color:#eee;border:0;border-radius:6px;padding:6px 12px;cursor:pointer">再导出 CSV</button>
    </div>
    <div id="yx-status" style="color:#aaa">粘贴地址后点开始。</div>
    <div id="yx-log" style="margin-top:6px;max-height:160px;overflow:auto;font-family:ui-monospace,monospace;font-size:11px;color:#9ca3af;white-space:pre-wrap"></div>`;
  document.body.appendChild(panel);
  const $ = id => panel.querySelector("#" + id);
  const log = msg => { const el = $("yx-log"); el.textContent += msg + "\n"; el.scrollTop = el.scrollHeight; };
  let stop = false;
  let lastResult = null;

  function parseAddresses(text) {
    const seen = new Set();
    const out = [];
    for (const m of String(text).matchAll(/0x[0-9a-fA-F]{40}/g)) {
      const a = m[0].toLowerCase();
      if (!seen.has(a)) { seen.add(a); out.push(m[0]); }
    }
    return out;
  }

  function download(name, text, type) {
    const blob = new Blob([text], { type });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function stamp() { return new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19); }

  function toCsv(result) {
    const esc = v => { const s = v === null || v === undefined ? "" : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
    const rows = [["wallet", "name", "positionsValueUsd", "pnlUsd", "volumeUsd", "marketsCount", "totalPoints", "rank", "pnl_points", "error"]];
    for (const [w, r] of Object.entries(result.wallets)) rows.push([w, r.name, r.positionsValueUsd, r.pnlUsd, r.volumeUsd, r.marketsCount, r.totalPoints, r.rank, r.pnl_points.length, r.error]);
    return "﻿" + rows.map(r => r.map(esc).join(",")).join("\n");
  }

  async function run() {
    const addrs = parseAddresses($("yx-addrs").value);
    if (!addrs.length) { $("yx-status").textContent = "没有识别到钱包地址。"; return; }
    stop = false;
    $("yx-start").disabled = true; $("yx-stop").disabled = false; $("yx-csv").disabled = true;
    $("yx-log").textContent = "";
    const result = { format: "yuce-portfolio-export", version: 1, exported_at: new Date().toISOString(), source: "predict.fun GraphQL via browser console", origin: location.origin, wallets: {} };
    let done = 0, failed = 0, i = 0;
    const started = Date.now();
    const worker = async () => {
      while (!stop && i < addrs.length) {
        const raw = addrs[i++];
        let r;
        try { r = await queryWallet(raw); }
        catch (err) { r = { address: raw, name: "", positionsValueUsd: null, pnlUsd: null, pnl_points: [], error: String(err?.message || err) }; }
        result.wallets[raw.toLowerCase()] = r;
        done += 1; if (r.error) failed += 1;
        $("yx-status").textContent = `进度 ${done}/${addrs.length}，失败 ${failed}，用时 ${Math.round((Date.now() - started) / 1000)}s`;
        if (r.error) log(`✗ ${raw.slice(0, 10)}… ${r.error}`);
        else log(`✓ ${raw.slice(0, 10)}… ${r.name || "(无名)"} 持仓 ${r.positionsValueUsd ?? "-"} PNL ${r.pnlUsd ?? "-"} (${r.pnl_points.length} 点)`);
      }
    };
    await Promise.all(Array.from({ length: CONCURRENCY }, worker));
    lastResult = result;
    const name = `yuce-portfolio-export-${stamp()}.json`;
    download(name, JSON.stringify(result), "application/json");
    $("yx-status").textContent = `${stop ? "已停止" : "完成"}：${done}/${addrs.length}，失败 ${failed}。已下载 ${name}，到 yuce 设置 → 导入官网数据。`;
    $("yx-start").disabled = false; $("yx-stop").disabled = true; $("yx-csv").disabled = false;
  }

  $("yx-start").addEventListener("click", () => run().catch(err => { $("yx-status").textContent = "出错：" + (err?.message || err); $("yx-start").disabled = false; $("yx-stop").disabled = true; }));
  $("yx-stop").addEventListener("click", () => { stop = true; });
  $("yx-csv").addEventListener("click", () => { if (lastResult) download(`yuce-portfolio-export-${stamp()}.csv`, toCsv(lastResult), "text/csv;charset=utf-8"); });
  $("yx-close").addEventListener("click", () => panel.remove());
  // yuce 每日盈亏页「复制该地址的脚本」会在脚本前面预设 window.__YUCE_EXPORT_ADDRS，自动填入并开始。
  const preset = Array.isArray(window.__YUCE_EXPORT_ADDRS) ? window.__YUCE_EXPORT_ADDRS : null;
  try { delete window.__YUCE_EXPORT_ADDRS; } catch { window.__YUCE_EXPORT_ADDRS = undefined; }
  if (preset && preset.length) {
    $("yx-addrs").value = preset.join("\n");
    setTimeout(() => $("yx-start").click(), 0);
  }
  log(`脚本已加载。页面来源 ${location.origin}${location.origin.includes("predict.fun") ? "" : "（注意：不是 predict.fun，GraphQL 可能被 CORS 拒绝）"}`);
})();
