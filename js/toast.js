// 非阻塞提示，替代 alert()。

let wrap = null;

function ensureWrap() {
  if (!wrap) {
    wrap = document.createElement("div");
    wrap.className = "toast-wrap";
    wrap.setAttribute("role", "status");
    wrap.setAttribute("aria-live", "polite");
    document.body.appendChild(wrap);
  }
  return wrap;
}

export function toast(message, type = "info", duration = 3600) {
  const el = document.createElement("div");
  el.className = `toast toast-${type}`;
  el.textContent = message;
  ensureWrap().appendChild(el);
  requestAnimationFrame(() => el.classList.add("show"));
  setTimeout(() => {
    el.classList.remove("show");
    setTimeout(() => el.remove(), 300);
  }, duration);
}
