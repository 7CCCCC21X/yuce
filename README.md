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
| `PREDICT_UPSTREAM_TIMEOUT_MS` | 上游请求超时毫秒数（默认 8000） |

### GraphQL 会话凭证刷新

`PREDICT_GRAPHQL_AUTH` / `PREDICT_GRAPHQL_COOKIE` 是会话凭证，会过期。
过期时 `/api/portfolio` 会返回明确的 502 错误提示。刷新方法：

1. 浏览器登录 predict.fun，打开 DevTools → Network；
2. 找到任意 GraphQL 请求，复制请求头中的 `authorization` 和 `cookie`；
3. 更新 Vercel 项目环境变量并重新部署（或 redeploy）。

凭证缺失时函数仍会以匿名身份请求（公开数据可能可用），并在日志里
输出一次性警告。

## API 约定

- 响应统一为 `{ success: true, ... }` / `{ success: false, error: "..." }`。
- 「账户不存在」按约定返回 **HTTP 200 + `success: false`**（而不是 404），
  避免前端把查询未命中当作可重试错误。
- 上游原始响应（`raw`）默认不返回；调试时加 `?debug=1`。
- 上游超时 → 504；会话凭证被拒（401/403）→ 502 并附带刷新提示。
- 函数日志为结构化 JSON（`console.error`），不会记录任何凭证。

## 本地开发

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
