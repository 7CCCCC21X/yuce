// 高精度十进制运算（基于 BigInt 的定点字符串运算），避免浮点误差。

export function expandExponential(value) {
  const s = String(value).trim();
  if (!/[eE]/.test(s)) return s;
  const n = Number(s);
  if (!Number.isFinite(n)) return "0";
  return n.toFixed(30).replace(/0+$/, "").replace(/\.$/, "");
}

export function normalizeDecimal(value) {
  if (value === null || value === undefined || value === "") return "0";
  let s = expandExponential(value).replace(/,/g, "").trim();
  if (!s || s === ".") return "0";
  let sign = "";
  if (s[0] === "-") { sign = "-"; s = s.slice(1); }
  else if (s[0] === "+") { s = s.slice(1); }
  if (!/^\d*(\.\d*)?$/.test(s)) return "0";
  let [intPart, fracPart = ""] = s.split(".");
  intPart = intPart.replace(/^0+(?=\d)/, "") || "0";
  fracPart = fracPart.replace(/0+$/, "");
  const out = fracPart ? `${intPart}.${fracPart}` : intPart;
  return sign && out !== "0" ? sign + out : out;
}

export function toScaled(value) {
  const s = normalizeDecimal(value);
  const negative = s.startsWith("-");
  const body = negative ? s.slice(1) : s;
  const [intPart, fracPart = ""] = body.split(".");
  const digits = BigInt((intPart + fracPart).replace(/^0+(?=\d)/, "") || "0") * (negative ? -1n : 1n);
  return { n: digits, scale: fracPart.length };
}

export function pow10(n) { return 10n ** BigInt(n); }

export function formatScaled(n, scale) {
  const negative = n < 0n;
  let s = (negative ? -n : n).toString();
  if (scale > 0) {
    if (s.length <= scale) s = "0".repeat(scale - s.length + 1) + s;
    const idx = s.length - scale;
    s = s.slice(0, idx) + "." + s.slice(idx);
  }
  s = s.replace(/\.0+$/, "").replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "");
  if (!s) s = "0";
  return negative && s !== "0" ? "-" + s : s;
}

export function decimalAdd(a, b) {
  const A = toScaled(a), B = toScaled(b);
  const scale = Math.max(A.scale, B.scale);
  const n = A.n * pow10(scale - A.scale) + B.n * pow10(scale - B.scale);
  return formatScaled(n, scale);
}

export function decimalSum(values) { return values.reduce((acc, v) => decimalAdd(acc, v), "0"); }

export function decimalMul(value, multiplierText) {
  const A = toScaled(value), M = toScaled(multiplierText);
  return formatScaled(A.n * M.n, A.scale + M.scale);
}

export function negateDecimal(v) { const s = normalizeDecimal(v); return s === "0" ? "0" : (s.startsWith("-") ? s.slice(1) : "-" + s); }

export function decimalSub(a, b) { return decimalAdd(a, negateDecimal(b)); }

export function shortDecimal(value, maxDp = 6) {
  const s = normalizeDecimal(value);
  if (!s.includes(".")) return s;
  const negative = s.startsWith("-");
  const body = negative ? s.slice(1) : s;
  const [i, f = ""] = body.split(".");
  const cut = f.slice(0, maxDp).replace(/0+$/, "");
  const out = cut ? `${i}.${cut}` : i;
  return negative ? "-" + out : out;
}
