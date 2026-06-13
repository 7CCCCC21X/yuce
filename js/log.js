// 页面底部的运行日志。

import { $ } from "./dom.js";

const MAX_LOG_LINES = 300;
let logLines = ["等待开始..."];

export function log(message) {
  const el = $("log");
  const now = new Date().toLocaleTimeString();
  logLines.push(`[${now}] ${message}`);
  if (logLines.length > MAX_LOG_LINES) logLines = logLines.slice(-MAX_LOG_LINES);
  el.textContent = logLines.join("\n");
  el.scrollTop = el.scrollHeight;
}

export function setLog(message) {
  logLines = [message];
  $("log").textContent = message;
}
