// 全局状态与表格列定义。

export const state = {
  abort: false,
  running: false,
  // 本次查询的 AbortController：停止时立刻中断在途请求。
  runController: null,
  totalWallets: 0,
  completedWallets: 0,
  successWallets: 0,
  failedWallets: 0,
  detailRows: [],
  summaryRows: [],
  summaryMap: new Map(),
  activeTab: "summary",
  filterText: "",
  onlyCalculated: false,
  minPoints: 0,
  minBalance: 0,
  minHolding: 0,
  maxHolding: 0,
  minNetAsset: 0,
  maxNetAsset: 0,
  maxReferralPoints: 0,
  maxCpp: 0,
  onlyFailed: false,
  sort: {
    summary: { key: "cost_per_point", dir: "asc" },
    detail: { key: "cost_per_point", dir: "asc" },
  },
  bestWallet: null,
};

export const numericKeys = new Set([
  "total_points", "allocation_round_points",
  "week", "trade_count",
  "paid_volume_usdt", "free_volume_usdt", "total_volume_usdt",
  "paid_fee_usdt", "cost_usdt", "points", "referral_points",
  "cost_per_point", "holding_amount_usdt", "available_balance_usdt", "net_asset_usdt", "pnl",
  "total_volume_shares", "shares_per_point",
  "total_volume_per_point", "paid_volume_per_point", "free_volume_per_point",
  "week_start_ts", "week_end_ts"
]);

export const CPP_KEYS = new Set(["cost_per_point"]);
export const VPP_KEYS = new Set(["total_volume_per_point", "paid_volume_per_point", "free_volume_per_point", "shares_per_point"]);
export const MONEY_KEYS = new Set([
  "paid_volume_usdt", "free_volume_usdt", "total_volume_usdt", "total_volume_shares",
  "cost_usdt", "paid_fee_usdt", "holding_amount_usdt", "available_balance_usdt", "net_asset_usdt"
]);
export const PNL_KEYS = new Set(["pnl"]);
export const TWO_DECIMAL_KEYS = new Set(["points", "total_points"]);

export const detailColumns = [
  ["wallet", "钱包"],
  ["name", "用户名"],
  ["status", "状态"],
  ["week", "周"],
  ["calculated", "已结算"],
  ["points", "本周积分"],
  ["cost_usdt", "手续费"],
  ["cost_per_point", "积分成本 $/积分"],
  ["holding_amount_usdt", "持仓金额"],
  ["available_balance_usdt", "可用余额"],
  ["net_asset_usdt", "净资产"],
  ["pnl", "官网PNL"],
  ["trade_count", "交易次数"],
  ["paid_volume_usdt", "付费交易量"],
  ["free_volume_usdt", "免费交易量"],
  ["total_volume_usdt", "总交易量"],
  ["total_volume_shares", "份额"],
  ["total_volume_per_point", "总量/分"],
  ["shares_per_point", "份额/分"],
  ["total_points", "钱包总积分"],
  ["allocation_round_points", "本轮积分"],
  ["week_start_ts", "开始时间戳"],
  ["week_end_ts", "结束时间戳"],
  ["week_start_utc8", "开始时间 UTC+8"],
  ["week_end_utc8", "结束时间 UTC+8"],
  ["referral_points", "推荐积分"],
  ["error", "错误"]
];

export const summaryColumns = [
  ["wallet", "钱包"],
  ["name", "用户名"],
  ["status", "状态"],
  ["points", "选中周积分"],
  ["cost_usdt", "手续费"],
  ["cost_per_point", "积分成本 $/积分"],
  ["holding_amount_usdt", "持仓金额"],
  ["available_balance_usdt", "可用余额"],
  ["net_asset_usdt", "净资产"],
  ["pnl", "官网PNL"],
  ["trade_count", "交易次数"],
  ["paid_volume_usdt", "付费交易量"],
  ["free_volume_usdt", "免费交易量"],
  ["total_volume_usdt", "总交易量"],
  ["total_volume_shares", "份额"],
  ["total_volume_per_point", "总量/分"],
  ["shares_per_point", "份额/分"],
  ["selected_weeks", "统计周数"],
  ["calculated_all", "全部已结算"],
  ["total_points", "钱包总积分"],
  ["referral_points", "推荐积分"],
  ["error", "错误"]
];

export const MAX_RENDER_ROWS = { summary: 1000, detail: 500 };
export const RENDER_INTERVAL_MS = 600;
