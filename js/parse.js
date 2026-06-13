// 输入解析：钱包地址提取、周数表达式。

export function extractWallets(text) {
  const matches = String(text || "").match(/0x[a-fA-F0-9]{40}/g) || [];
  const seen = new Set();
  const wallets = [];
  for (const w of matches) {
    const lower = w.toLowerCase();
    if (!seen.has(lower)) { seen.add(lower); wallets.push(lower); }
  }
  return wallets;
}

// 支持 "17,18" / "10-12" / 混合，返回升序去重数组；空输入返回 null（= 全部周）。
export function parseWeeks(input) {
  const s = String(input || "").trim();
  if (!s) return null;
  const result = new Set();
  for (const raw of s.split(",")) {
    const part = raw.trim();
    if (!part) continue;
    if (part.includes("-")) {
      const pair = part.split("-").map(x => Number(x.trim()));
      if (pair.length !== 2 || !Number.isInteger(pair[0]) || !Number.isInteger(pair[1])) throw new Error(`周数格式错误：${part}`);
      let [start, end] = pair;
      if (start > end) [start, end] = [end, start];
      for (let i = start; i <= end; i++) result.add(i);
    } else {
      const n = Number(part);
      if (!Number.isInteger(n)) throw new Error(`周数格式错误：${part}`);
      result.add(n);
    }
  }
  return [...result].sort((a, b) => a - b);
}
