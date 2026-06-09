// DOM / 通用小工具。

export const $ = (id) => document.getElementById(id);

export function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

export function debounce(fn, ms = 200) {
  let timer = null;
  return (...args) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { timer = null; fn(...args); }, ms);
  };
}

// 复制文本：优先 Clipboard API，失败时降级到 execCommand（HTTP 环境下可用）。
export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch { /* fall through */ }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.left = "-9999px";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}
