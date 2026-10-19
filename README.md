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
API 函数 `maxDuration` 设为 15s，并把函数区域固定为新加坡 `sin1`：
Vercel 默认区域是美国东部 `iad1`，predict.fun 前置的 Cloudflare 对来自
美国的请求直接返回 403（Ray ID 以 `-IAD` 结尾即是），换到非美国区域才能
到达上游。改了 `regions` 需要重新部署才生效。

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
| `PREDICT_GRAPHQL_USER_AGENT` | 代理请求 GraphQL 时使用的浏览器 UA（默认内置一份 Chrome UA） |
| `PREDICT_UPSTREAM_TIMEOUT_MS` | 上游请求超时毫秒数（默认 8000） |

### GraphQL 会话凭证刷新

`PREDICT_GRAPHQL_AUTH` / `PREDICT_GRAPHQL_COOKIE` 是会话凭证，会过期。
过期时 `/api/portfolio` 会返回明确的 502 错误提示。刷新方法：

1. 浏览器登录 predict.fun，打开 DevTools → Network；
2. 找到任意 GraphQL 请求，复制请求头中的 `authorization` 和 `cookie`；
3. 更新 Vercel 项目环境变量并重新部署（或 redeploy）。

凭证缺失时函数仍会以匿名身份请求（公开数据可能可用），并在日志里
输出一次性警告。

### Cloudflare 拦截

predict.fun 前置了 Cloudflare。Node 自带 fetch 默认的 UA（`node`）会被其
机器人规则直接拒绝，返回 HTTP 403 + 「Attention Required!」HTML 页，而不是
GraphQL 的 JSON。函数默认以浏览器请求头（UA、`sec-ch-ua`、`Sec-Fetch-*` 等）
发请求以通过这类规则；若 Chrome 版本号过旧又开始被拦，可用
`PREDICT_GRAPHQL_USER_AGENT` 覆盖 UA 而无需改代码。

被拦截时错误信息会明确写「Cloudflare blocked the request」并附带 CF 错误码
与 Ray ID（`?debug=1` 可看原始 HTML），与凭证过期的提示区分开。Ray ID 的
三字母后缀是 Cloudflare 节点，也就是函数的出口位置：`-IAD`、`-SFO` 等美国
节点被拒，优先怀疑地区封锁，错误信息会直接提示改 `vercel.json` 的
`regions`。若换到非美国区域仍被拦（按 ASN / TLS 指纹封锁），则靠下面的
浏览器直连。

### 持仓金额：REST 优先

`api.predict.fun` 是给程序调用的 REST 接口（经 `/api/predict` 代理、需
`PREDICT_API_KEY`），不受 Cloudflare 人机拦截。持仓金额默认走
`GET /v1/positions/{wallet}` 累加每个持仓的 `valueUsd`；空列表记为 0。
REST 失败时才回退到 GraphQL GetPortfolio（官网口径 `positionsValueUsd`，
含用户名），回退按下面的「GraphQL 请求方式」走。旧配置里仍是
`/api/portfolio?address={wallet}` 默认值的，加载 / 导入时自动改为 REST；
自定义模板不动。官网 PNL 只有 GraphQL 有，仍走 GraphQL。

### 浏览器直连 GraphQL

设置面板「GraphQL 请求方式（官网 PNL，及持仓回退）」有三档：

| 档位 | 行为 |
| --- | --- |
| 自动（默认） | 先由浏览器直接 POST `graphql.predict.fun/graphql`，失败再走同域代理 |
| 仅浏览器直连 | 只直连，不碰 Vercel 函数 |
| 仅同域代理 | 旧行为，全部走 `/api/portfolio`、`/api/portfolio-pnl` |

直连用的是用户自己浏览器的身份：它已经能正常打开 predict.fun，自然也过得了
Cloudflare，完全不经过 Vercel 出口。查询与翻页逻辑在 `js/predict-graphql.js`，
整理出的信封与两个 Vercel 函数完全一致，所以字段路径等设置不用改。
直连被 CORS 拒绝时（浏览器统一抛 `TypeError`，拿不到状态码），本轮余下钱包
自动改走代理，错误信息会同时写明「直连」与「代理」各自的失败原因。
`GraphQL Authorization` 为可选项，匿名查不到时填登录后的 `authorization`
请求头值，只存本机 localStorage。

## API 约定

- 响应统一为 `{ success: true, ... }` / `{ success: false, error: "..." }`。
- 「账户不存在」按约定返回 **HTTP 200 + `success: false`**（而不是 404），
  避免前端把查询未命中当作可重试错误。
- 上游原始响应（`raw`）默认不返回；调试时加 `?debug=1`。
- 上游超时 → 504；会话凭证被拒（401/403）→ 502 并附带刷新提示。
- 函数日志为结构化 JSON（`console.error`），不会记录任何凭证。

### Vercel 出口被整段封锁时：本机运行

换区域（`-SIN`）后仍被 Cloudflare 403，说明封的是 Vercel 的 IP 段 / TLS
指纹，服务端这条路从 Vercel 出去走不通。此时用 `tools/local-server.js`
把页面和 `api/` 函数一起跑在自己电脑上，用自己的住宅 IP 访问 Predict：

```bash
npm run dev                                   # http://localhost:3000
PREDICT_API_KEY=xxx npm run dev               # REST 持仓代理需要 key
# 走 Clash 等本地代理（http 端口），不需要 TUN 模式：
node tools/local-server.js --proxy http://127.0.0.1:7897
# 等价写法：HTTPS_PROXY=http://127.0.0.1:7897 npm run dev
```

代理支持由 `tools/proxy-fetch.js` 提供：对代理发 CONNECT 建隧道后在隧道上做
TLS，零依赖，`NO_PROXY` 中的主机不走代理。

页面与 `/api/` 同源，没有 CORS 等浏览器限制。也可以只借用它的 `/api/`：
线上页面的持仓 / PNL 模板填 `http://localhost:3000/api/portfolio?address={wallet}`
等，响应已带 CORS 与私有网络访问头。

## 本地开发

前端使用原生 ES 模块，**必须通过 HTTP 访问**（`file://` 打不开）：

```bash
npm run dev        # 前端 + api/ 函数一起跑（tools/local-server.js，零依赖）
# 或
npx serve .        # 仅前端静态页
vercel dev         # Vercel 官方开发服务器
```

## 测试

```bash
npm test           # node --test test/，覆盖 keccak256 与 EIP-55 校验和
```
