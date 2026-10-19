#!/usr/bin/env node
// 本地一体化服务：静态页面 + api/ 函数，用你自己的网络出口访问 Predict.fun。
//
// 为什么需要它：graphql.predict.fun 前置的 Cloudflare 把 Vercel 的出口整段
// 拦掉（换区域、换请求头都没用），而你自己电脑的住宅 IP 是能正常访问的。
// 这个脚本把 index.html / js / styles.css 和 api/*.js 函数一起跑在本机，
// 页面与 /api/ 同源，没有 CORS、混合内容、私有网络访问之类的浏览器限制。
//
// 用法：
//   node tools/local-server.js            # http://localhost:3000
//   PORT=8080 node tools/local-server.js
//   PREDICT_API_KEY=xxx node tools/local-server.js   # /api/predict（REST 持仓）需要
//
// 走代理（Clash 等本地代理的 http 端口），三种写法任选其一：
//   node tools/local-server.js --proxy http://127.0.0.1:7897
//   HTTPS_PROXY=http://127.0.0.1:7897 node tools/local-server.js
//   PROXY=http://127.0.0.1:7897 npm run dev
// Node 自带的 fetch 不读系统代理，这里用 tools/proxy-fetch.js 自己建 CONNECT 隧道，
// 不需要 TUN 模式，也不需要升级 Node。
//
// 也可以只用它提供 /api/，线上页面的「持仓 API 模板」「官网 PNL API 模板」
// 填 http://localhost:3000/api/portfolio?address={wallet} 之类；响应带 CORS 头。

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const { installProxyFetch } = require('./proxy-fetch');

const ROOT = path.resolve(__dirname, '..');
const API_DIR = path.join(ROOT, 'api');
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '127.0.0.1';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};

// 线上页面跨域调用本地 /api/ 时需要这些头（含 Chrome 的私有网络访问预检）。
function corsHeaders(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept');
  res.setHeader('Access-Control-Allow-Private-Network', 'true');
}

function sendJson(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(body));
}

// Vercel 函数名 → 模块。"_" 开头的是共享模块，不暴露为接口。
function resolveApi(name) {
  if (!/^[a-z0-9-]+$/i.test(name) || name.startsWith('_')) return null;
  const file = path.join(API_DIR, `${name}.js`);
  if (!fs.existsSync(file)) return null;
  // 不缓存，改了函数文件重启即可（require 缓存只影响同一进程）。
  return require(file);
}

async function handleApi(req, res, url) {
  corsHeaders(res);
  if (req.method === 'OPTIONS') { res.statusCode = 204; return res.end(); }
  const name = url.pathname.slice('/api/'.length).replace(/\/+$/, '');
  const handler = resolveApi(name);
  if (!handler) return sendJson(res, 404, { success: false, error: `No such API: /api/${name}` });
  // Vercel 会把查询串解析到 req.query；重复的 key 变成数组，这里保持一致。
  const query = {};
  for (const [k, v] of url.searchParams) {
    if (k in query) query[k] = [].concat(query[k], v);
    else query[k] = v;
  }
  req.query = query;
  try {
    await handler(req, res);
  } catch (err) {
    if (!res.headersSent) sendJson(res, 500, { success: false, error: err && err.message ? err.message : String(err) });
    else res.end();
  }
}

function handleStatic(req, res, url) {
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.statusCode = 405; return res.end('Method not allowed'); }
  let pathname = decodeURIComponent(url.pathname);
  if (pathname === '/') pathname = '/index.html';
  const file = path.normalize(path.join(ROOT, pathname));
  // 只允许仓库根目录下的文件，且不暴露 api/ tools/ test/ 与隐藏文件。
  const rel = path.relative(ROOT, file);
  if (rel.startsWith('..') || path.isAbsolute(rel) || /^(api|tools|test|node_modules|\.)/.test(rel)) {
    res.statusCode = 404; return res.end('Not found');
  }
  fs.stat(file, (err, stat) => {
    if (err || !stat.isFile()) { res.statusCode = 404; return res.end('Not found'); }
    res.statusCode = 200;
    res.setHeader('Content-Type', MIME[path.extname(file).toLowerCase()] || 'application/octet-stream');
    res.setHeader('Cache-Control', 'no-store');
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).pipe(res);
  });
}

function createServer() {
  return http.createServer((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    if (url.pathname === '/api' || url.pathname.startsWith('/api/')) return handleApi(req, res, url);
    return handleStatic(req, res, url);
  });
}

module.exports = { createServer };

function proxyFromArgs(argv) {
  const i = argv.indexOf('--proxy');
  if (i !== -1 && argv[i + 1]) return argv[i + 1];
  const eq = argv.find(a => a.startsWith('--proxy='));
  if (eq) return eq.slice('--proxy='.length);
  return process.env.PROXY || process.env.HTTPS_PROXY || process.env.https_proxy || process.env.ALL_PROXY || process.env.all_proxy || '';
}

if (require.main === module) {
  const proxyUrl = proxyFromArgs(process.argv.slice(2));
  if (proxyUrl) {
    installProxyFetch(proxyUrl);
    console.log(`对外请求经由代理：${proxyUrl}`);
  }
  const server = createServer();
  server.listen(PORT, HOST, () => {
    console.log(`yuce 本地服务已启动：http://localhost:${PORT}`);
    console.log(`  页面  http://localhost:${PORT}/`);
    console.log(`  接口  http://localhost:${PORT}/api/portfolio?address=0x...`);
    console.log(`        http://localhost:${PORT}/api/portfolio-pnl?address=0x...&interval=ALL&full=1`);
    if (!process.env.PREDICT_API_KEY) console.log('  提示  未设置 PREDICT_API_KEY，/api/predict（REST 持仓）会以匿名身份请求。');
    if (!proxyUrl) console.log('  提示  未配置代理，将直接连接 predict.fun；需要走 Clash 等代理时加 --proxy http://127.0.0.1:7897。');
  });
}
