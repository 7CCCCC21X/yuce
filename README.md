# yuce — OPINX Predict 积分批量查询

批量查询钱包的 OPINX 积分、Predict 持仓价值、官方 PNL 与链上 USDT 余额的小工具。
纯静态前端（无构建步骤）+ Vercel Serverless API。

## 文件结构

```
.
├── index.html              # 页面骨架（仅标记，无内联 JS/CSS）
├── styles.css              # 全部样式
├── js/                     # 前端 ES 模块（无打包，浏览器原生加载）
│   ├── main.js             # 入口：查询主流程、事件绑定、初始化
│   ├── state.js            # 全局状态与列定义
│   ├── api.js              # 请求层：限流、超时、重试、可取消
│   ├── rows.js             # 行构建与汇总聚合
│   ├── table.js            # 表格渲染 / 排序 / 过滤（事件委托）
│   ├── week.js             # 周选择器
│   ├── config.js           # 配置持久化（localStorage / 导入导出）
│   ├── decimal.js          # 高精度十进制运算（BigInt）
│   ├── format.js           # 数值 / 金额 / 时间格式化
│   ├── parse.js            # 钱包与周数解析
│   ├── dom.js / toast.js / log.js
├── api/                    # Vercel Serverless Functions（CommonJS）
│   ├── _predict-graphql.js # 公共：keccak256、EIP-55、GraphQL 代理、日志
│   ├── portfolio.js        # 持仓价值（GetPortfolio）
│   ├── portfolio-pnl.js    # 官方 PNL 时序（GetAccountPnlTimeseries）
│   └── predict.js          # Predict REST 透明代理（仅 /v1/positions）
├── test/checksum.test.js   # keccak256 / EIP-55 单元测试
├── vercel.json             # 函数 maxDuration 配置
└── package.json
```

## 部署

直接部署到 Vercel：导入仓库即可，无需构建命令。`vercel.json` 已将
API 函数 `maxDuration` 设为 15s。

## 环境变量

| 变量 | 用途 |
| --- | --- |
| `PREDICT_API_KEY` | Predict REST API key（`/api/predict` 代理用） |
| `PREDICT_API_BASE` | Predict REST 主网 base URL（默认内置） |
| `PREDICT_TESTNET_API_BASE` | Predict REST 测试网 base URL |
| `PREDICT_TESTNET_API_KEY` | 测试网 API key |
| `PREDICT_GRAPHQL_URL` | Predict GraphQL endpoint（默认内置） |
| `PREDICT_GRAPHQL_AUTH` | GraphQL `authorization` 请求头的值 |
| `PREDICT_GRAPHQL_COOKIE` | GraphQL `cookie` 请求头的值 |
| `PREDICT_GRAPHQL_RELAY_URL` | GraphQL 中继地址（Railway 上的 `relay/`，见下）；设置后 GraphQL 请求改经中继发出 |
| `PREDICT_GRAPHQL_RELAY_TOKEN` | 中继共享密钥，与中继的 `RELAY_TOKEN` 一致 |
| `PREDICT_UPSTREAM_TIMEOUT_MS` | 上游请求超时毫秒数（默认 8000） |

### GraphQL 会话凭证刷新

`PREDICT_GRAPHQL_AUTH` / `PREDICT_GRAPHQL_COOKIE` 是会话凭证，会过期。
过期时 `/api/portfolio` 会返回明确的 502 错误提示。刷新方法：

1. 浏览器登录 predict.fun，打开 DevTools → Network；
2. 找到任意 GraphQL 请求，复制请求头中的 `authorization` 和 `cookie`；
3. 更新 Vercel 项目环境变量并重新部署（或 redeploy）。

凭证缺失时函数仍会以匿名身份请求（公开数据可能可用），并在日志里
输出一次性警告。

## GraphQL 中继（relay/）：绕开 Cloudflare 对 Vercel 出口的拦截

2026-10 起，predict.fun 前置的 Cloudflare 把从 Vercel 出口发往
`graphql.predict.fun` 的请求整段拦下（403 + 「Attention Required!」页），
换区域、换请求头都无效；`/api/portfolio`（持仓金额 + 用户名）与
`/api/portfolio-pnl`（官网 PNL）因此失效。而同样的请求从 Railway 用 Python
httpx 发出能正常通过（`predict_whale_bot` 就是这样查用户名的）。

`relay/server.py` 是一个零业务逻辑的中继：`POST /graphql` 把请求体原样转给
`graphql.predict.fun`，把上游状态码与响应体原样返回（另带
`x-upstream-cf-ray` 等诊断头）。Vercel 函数配置了
`PREDICT_GRAPHQL_RELAY_URL` 后，只是把 POST 目标换成中继，其余逻辑不变。

部署步骤：

1. Railway → New Service → GitHub Repo 选本仓库；Settings → Root Directory
   填 `relay`；Variables 加 `RELAY_TOKEN=<随机长字符串>`；Networking 生成域名。
   启动后访问 `https://<域名>/healthz` 应返回 `{"ok":true,...}`。
2. Vercel → 项目 Environment Variables 加 `PREDICT_GRAPHQL_RELAY_URL=https://<域名>`
   与 `PREDICT_GRAPHQL_RELAY_TOKEN=<同一个密钥>`，然后 Redeploy。
3. 验证：`/api/portfolio?address=0x…` 返回 `success: true` 与 `name`。

中继自身的错误（密钥不对、连不上上游）会带 `x-relay-error` 头，Vercel 端
报错写明「GraphQL relay … failed」；上游的 403 仍原样透传并按拦截 / 凭证
问题分类。`relay/test_server.py` 用本地假上游覆盖了转发、鉴权与透传。

## 持仓金额备选：REST 汇总（/api/positions-value）

predict.fun 前置的 Cloudflare 会拦下 Vercel 出口发往 GraphQL 的请求（403 +
「Attention Required!」页，换区域、换请求头都无效），`/api/portfolio` 与
`/api/portfolio-pnl` 因此在 Vercel 上不可用。`api.predict.fun` 的官方 REST
接口是给程序调用的，不受此限制。

持仓金额默认仍走 `/api/portfolio`（官网口径）。`/api/positions-value?address=0x…`
是不依赖 GraphQL 的备选：服务端用
`PREDICT_API_KEY` 调 `GET /v1/positions/{address}`，跟随响应里的 `cursor`
翻完所有分页，对每个持仓估值后汇总。实测响应里 `amount` 是 wei
（份额 × 1e18），`averageBuyPriceUsd` 是普通小数，估值规则：

1. 持仓自带 `valueUsd` 之类直接字段 → 直接用（wei 则换算）；
2. 否则 份额 × 当前价（持仓自带价格字段 → 所属 outcome 的 `bestBid.price`
   → `bestAsk.price` → 市场最新成交价）。

同时返回 `costUsd`（份额 × 均价）与 `unrealizedPnlUsd`（市值 − 成本）；
`?debug=1` 可看每个持仓的取价明细（`breakdown`）与首页原始响应，用来核对
口径。空持仓列表记为 0。注意它的口径是「份额 × 当前最优买价」，与官网
Portfolio 卡片的 `positionsValueUsd` 不完全一致，且没有用户名。旧配置里
仍是该模板的，加载 / 导入时自动改回 `/api/portfolio?address={wallet}`。

## API 约定

- 响应统一为 `{ success: true, ... }` / `{ success: false, error: "..." }`。
- 「账户不存在」按约定返回 **HTTP 200 + `success: false`**（而不是 404），
  避免前端把查询未命中当作可重试错误。
- 上游原始响应（`raw`）默认不返回；调试时加 `?debug=1`。
- 上游超时 → 504；会话凭证被拒（401/403）→ 502 并附带刷新提示。
- 函数日志为结构化 JSON（`console.error`），不会记录任何凭证。

## 本地开发

中继本地跑：`cd relay && pip install -r requirements.txt && RELAY_TOKEN=x python server.py`，
测试：`python -m unittest relay/test_server.py`。


前端使用原生 ES 模块，**必须通过 HTTP 访问**（`file://` 打不开）：

```bash
npx serve .        # 仅前端静态页
# 或
vercel dev         # 前端 + api/ 函数一起跑
```

## 测试

```bash
npm test           # node --test test/，覆盖 keccak256 与 EIP-55 校验和
```
