#!/usr/bin/env python3
"""yuce 浏览器中继：在服务器上跑一个真 Chromium，打开 predict.fun 页面，
在页面环境里替 Vercel 函数发 GraphQL 请求。对外接口与 relay/server.py 完全相同：

    POST /graphql    请求体即 GraphQL JSON，原样在页面里 fetch，原样返回上游状态与响应体
    GET  /healthz    浏览器 / 页面状态

为什么要这样
    predict.fun 的 GraphQL 不需要登录就能查，但 Cloudflare 只放行「真浏览器」。
    用户在 predict.fun 页面 Console 里跑脚本能查，是因为请求从真浏览器、真页面发出。
    这里把同一件事自动化：Playwright 启动 Chromium → 打开 predict.fun → 收到请求时
    page.evaluate(fetch(...)) → 把结果吐回去。Vercel 配 PREDICT_GRAPHQL_RELAY_URL 指向
    这里即可，和纯 HTTP 中继切换无需改任何别的东西。

环境变量
    PORT                    监听端口（Railway 注入）
    RELAY_TOKEN             共享密钥，强烈建议设置（x-relay-token 头或 ?token=）
    RELAY_PAGE_URL          打开的页面，默认 https://predict.fun/
    PREDICT_GRAPHQL_URL     页面里 fetch 的目标，默认 https://graphql.predict.fun/graphql
    RELAY_USER_AGENT        浏览器 UA，默认一个普通 Chrome UA（无头 Chromium 默认 UA 含 HeadlessChrome）
    RELAY_LOCALE            默认 zh-CN
    RELAY_RELOAD_SEC        页面定期重开间隔，默认 1800
    RELAY_CONCURRENCY       同时在页面里跑的 fetch 数，默认 4
    UPSTREAM_TIMEOUT_SEC    单个请求超时，默认 20
    RELAY_HEADLESS          1（默认）/ 0
    RELAY_CHROMIUM_PATH     可选，自带的 Chromium 可执行文件路径

部署到 Railway
    New Service → GitHub Repo 选 yuce → Root Directory 填 relay-browser（目录里有 Dockerfile，
    Railway 自动用它构建）→ Variables 加 RELAY_TOKEN → 生成域名 → /healthz 看 ready 为 true。
    然后 Vercel：PREDICT_GRAPHQL_RELAY_URL=https://<域名>，PREDICT_GRAPHQL_RELAY_TOKEN=<同一密钥>，Redeploy。
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlsplit

LOG = logging.getLogger("browser-relay")

DEFAULT_PAGE_URL = "https://predict.fun/"
DEFAULT_UPSTREAM = "https://graphql.predict.fun/graphql"
DEFAULT_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36"
MAX_BODY_BYTES = 64 * 1024
CHALLENGE_TITLES = ("just a moment", "attention required", "请稍候", "verify you are human")

# 在页面环境里执行的 fetch：和用户在 Console 里跑的脚本一样（同站、带 cookie）。
PAGE_FETCH_JS = """
async ({ url, body, timeoutMs }) => {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json", accept: "application/graphql-response+json, application/json" },
      body,
      signal: ctrl.signal,
    });
    const text = await res.text();
    const headers = {};
    for (const k of ["content-type", "cf-ray", "server", "cf-mitigated"]) { const v = res.headers.get(k); if (v) headers[k] = v; }
    return { ok: true, status: res.status, text, headers };
  } catch (e) {
    return { ok: false, error: String(e && e.message || e), name: e && e.name };
  } finally { clearTimeout(timer); }
}
"""


class Config:
    def __init__(self, env=None) -> None:
        env = os.environ if env is None else env
        self.page_url = env.get("RELAY_PAGE_URL", DEFAULT_PAGE_URL).strip() or DEFAULT_PAGE_URL
        self.upstream = env.get("PREDICT_GRAPHQL_URL", DEFAULT_UPSTREAM).strip() or DEFAULT_UPSTREAM
        self.token = env.get("RELAY_TOKEN", "").strip()
        self.user_agent = env.get("RELAY_USER_AGENT", DEFAULT_UA).strip() or DEFAULT_UA
        self.locale = env.get("RELAY_LOCALE", "zh-CN").strip() or "zh-CN"
        self.reload_sec = float(env.get("RELAY_RELOAD_SEC", "1800") or 1800)
        self.concurrency = max(1, int(env.get("RELAY_CONCURRENCY", "4") or 4))
        self.timeout = float(env.get("UPSTREAM_TIMEOUT_SEC", "20") or 20)
        self.headless = env.get("RELAY_HEADLESS", "1").strip() not in {"0", "false", "no"}
        self.chromium_path = env.get("RELAY_CHROMIUM_PATH", "").strip()


class Browser:
    """单线程 asyncio 事件循环里持有 Playwright 浏览器与一个常驻页面；
    HTTP 线程通过 run_coroutine_threadsafe 把请求交进来。"""

    def __init__(self, cfg: Config) -> None:
        self.cfg = cfg
        self.loop = asyncio.new_event_loop()
        self.thread = threading.Thread(target=self._run_loop, name="browser-loop", daemon=True)
        self._pw = None
        self._browser = None
        self._context = None
        self._page = None
        self._sem = None
        self._page_lock = None
        self.ready = False
        self.last_error = ""
        self.page_title = ""
        self.opened_at = 0.0
        self.requests = 0
        self.failures = 0

    # ---- 生命周期 ----
    def start(self) -> None:
        self.thread.start()
        fut = asyncio.run_coroutine_threadsafe(self._open(), self.loop)
        fut.result(timeout=120)

    def _run_loop(self) -> None:
        asyncio.set_event_loop(self.loop)
        self.loop.run_forever()

    async def _open(self) -> None:
        from playwright.async_api import async_playwright

        if self._pw is None:
            self._pw = await async_playwright().start()
            self._sem = asyncio.Semaphore(self.cfg.concurrency)
            self._page_lock = asyncio.Lock()
        if self._browser is None:
            launch = {
                "headless": self.cfg.headless,
                "args": ["--disable-blink-features=AutomationControlled", "--no-sandbox", "--disable-dev-shm-usage"],
            }
            if self.cfg.chromium_path:
                launch["executable_path"] = self.cfg.chromium_path
            self._browser = await self._pw.chromium.launch(**launch)
        await self._reopen_page()

    async def _reopen_page(self) -> None:
        async with self._page_lock:
            if self._context is not None:
                try:
                    await self._context.close()
                except Exception:  # noqa: BLE001
                    pass
            self._context = await self._browser.new_context(
                user_agent=self.cfg.user_agent,
                locale=self.cfg.locale,
                viewport={"width": 1366, "height": 850},
            )
            # 无头 Chromium 会把 navigator.webdriver 设为 true，Cloudflare 看得到。
            await self._context.add_init_script("Object.defineProperty(navigator, 'webdriver', { get: () => undefined });")
            self._page = await self._context.new_page()
            self.ready = False
            try:
                await self._page.goto(self.cfg.page_url, wait_until="domcontentloaded", timeout=60_000)
                # Cloudflare 的人机挑战页会自己跳转；给它一点时间。
                for _ in range(12):
                    title = (await self._page.title()) or ""
                    self.page_title = title
                    if not any(t in title.lower() for t in CHALLENGE_TITLES):
                        break
                    LOG.warning("页面标题 %r，像是 Cloudflare 挑战页，等待…", title)
                    await asyncio.sleep(2.5)
                self.opened_at = time.monotonic()
                self.ready = True
                self.last_error = ""
                LOG.info("页面已打开：%s（标题 %r）", self.cfg.page_url, self.page_title)
            except Exception as exc:  # noqa: BLE001
                self.last_error = f"open page failed: {exc}"
                LOG.error(self.last_error)

    # ---- 请求 ----
    async def _fetch(self, body: bytes) -> dict:
        if time.monotonic() - self.opened_at > self.cfg.reload_sec:
            await self._reopen_page()
        if not self.ready or self._page is None:
            await self._reopen_page()
        if not self.ready:
            return {"ok": False, "error": self.last_error or "page not ready"}
        async with self._sem:
            args = {"url": self.cfg.upstream, "body": body.decode("utf-8"), "timeoutMs": int(self.cfg.timeout * 1000)}
            try:
                result = await asyncio.wait_for(self._page.evaluate(PAGE_FETCH_JS, args), timeout=self.cfg.timeout + 5)
            except Exception as exc:  # noqa: BLE001  页面崩了 / 上下文没了：重开一次再试
                LOG.warning("evaluate 失败（%s），重开页面重试", exc)
                await self._reopen_page()
                if not self.ready:
                    return {"ok": False, "error": self.last_error or str(exc)}
                try:
                    result = await asyncio.wait_for(self._page.evaluate(PAGE_FETCH_JS, args), timeout=self.cfg.timeout + 5)
                except Exception as exc2:  # noqa: BLE001
                    return {"ok": False, "error": f"page evaluate failed: {exc2}"}
        # 页面里 fetch 抛 TypeError（CORS / 网络）→ 可能页面被重定向到挑战页，重开再试一次。
        if not result.get("ok") and result.get("name") == "TypeError":
            LOG.warning("页面内 fetch 失败（%s），重开页面重试", result.get("error"))
            await self._reopen_page()
            if self.ready:
                async with self._sem:
                    try:
                        result = await asyncio.wait_for(self._page.evaluate(PAGE_FETCH_JS, args), timeout=self.cfg.timeout + 5)
                    except Exception as exc:  # noqa: BLE001
                        return {"ok": False, "error": f"page evaluate failed: {exc}"}
        return result

    def fetch(self, body: bytes, timeout: float) -> dict:
        fut = asyncio.run_coroutine_threadsafe(self._fetch(body), self.loop)
        return fut.result(timeout=timeout)

    def status(self) -> dict:
        return {
            "ready": self.ready, "page_url": self.cfg.page_url, "page_title": self.page_title, "upstream": self.cfg.upstream,
            "headless": self.cfg.headless, "opened_seconds_ago": int(time.monotonic() - self.opened_at) if self.opened_at else None,
            "requests": self.requests, "failures": self.failures, "last_error": self.last_error,
        }


def make_handler(cfg: Config, browser: Browser):
    class Handler(BaseHTTPRequestHandler):
        server_version = "yuce-browser-relay/1.0"
        protocol_version = "HTTP/1.1"

        def _cors(self) -> None:
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Access-Control-Allow-Methods", "POST, GET, OPTIONS")
            self.send_header("Access-Control-Allow-Headers", "Content-Type, Accept, x-relay-token")
            self.send_header("Cache-Control", "no-store")

        def _send(self, status: int, data: bytes, content_type: str, extra: dict | None = None) -> None:
            self.send_response(status)
            self._cors()
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(data)))
            for k, v in (extra or {}).items():
                self.send_header(k, v)
            self.end_headers()
            self.wfile.write(data)

        def _json(self, status: int, body: dict, extra: dict | None = None) -> None:
            self._send(status, json.dumps(body, ensure_ascii=False).encode("utf-8"), "application/json; charset=utf-8", extra)

        def _relay_error(self, status: int, message: str) -> None:
            self._json(status, {"success": False, "error": message, "relay": True}, {"x-relay-error": "1"})

        def _authorized(self, url) -> bool:
            if not cfg.token:
                return True
            return self.headers.get("x-relay-token", "") == cfg.token or parse_qs(url.query).get("token", [""])[0] == cfg.token

        def log_message(self, fmt: str, *args) -> None:
            LOG.info("%s %s", self.address_string(), fmt % args)

        def do_OPTIONS(self) -> None:  # noqa: N802
            self.send_response(204)
            self._cors()
            self.send_header("Content-Length", "0")
            self.end_headers()

        def do_GET(self) -> None:  # noqa: N802
            url = urlsplit(self.path)
            if url.path == "/healthz":
                st = browser.status()
                return self._json(200 if st["ready"] else 503, {"ok": st["ready"], "token_required": bool(cfg.token), "mode": "browser", **st})
            return self._relay_error(404, f"no such route: GET {url.path}")

        def do_POST(self) -> None:  # noqa: N802
            url = urlsplit(self.path)
            try:
                length = int(self.headers.get("Content-Length") or 0)
            except ValueError:
                length = 0
            if length <= 0 or length > MAX_BODY_BYTES:
                self.close_connection = True
                return self._relay_error(413 if length > MAX_BODY_BYTES else 400, f"body length {length} not acceptable")
            body = self.rfile.read(length)
            if url.path != "/graphql":
                return self._relay_error(404, f"no such route: POST {url.path}")
            if not self._authorized(url):
                return self._relay_error(401, "relay token missing or invalid (set RELAY_TOKEN on both sides)")
            try:
                payload = json.loads(body)
            except ValueError:
                return self._relay_error(400, "body is not JSON")
            if not isinstance(payload, dict) or not isinstance(payload.get("query"), str):
                return self._relay_error(400, "body must be a GraphQL request object with a string `query`")

            started = time.monotonic()
            browser.requests += 1
            try:
                result = browser.fetch(body, timeout=cfg.timeout + 15)
            except Exception as exc:  # noqa: BLE001
                browser.failures += 1
                return self._relay_error(504, f"browser relay timed out or crashed: {exc}")
            elapsed = int((time.monotonic() - started) * 1000)
            op = payload.get("operationName") or "-"
            if not result.get("ok"):
                browser.failures += 1
                LOG.warning("relay %s -> 页面内 fetch 失败 (%d ms): %s", op, elapsed, result.get("error"))
                return self._relay_error(502, f"in-page fetch failed: {result.get('error')}")
            text = result.get("text") or ""
            status = int(result.get("status") or 502)
            headers = result.get("headers") or {}
            LOG.info("relay %s -> %s (%d ms, %d bytes)", op, status, elapsed, len(text))
            extra = {"x-upstream-status": str(status)}
            for k, v in headers.items():
                if k != "content-type":
                    extra[f"x-upstream-{k}"] = v
            self._send(status, text.encode("utf-8"), headers.get("content-type", "application/json; charset=utf-8"), extra)

    return Handler


def serve(host: str, port: int, cfg: Config | None = None, browser: Browser | None = None) -> ThreadingHTTPServer:
    cfg = cfg or Config()
    if browser is None:
        browser = Browser(cfg)
        browser.start()
    server = ThreadingHTTPServer((host, port), make_handler(cfg, browser))
    server.daemon_threads = True
    server.relay_browser = browser  # type: ignore[attr-defined]
    return server


def main() -> int:
    logging.basicConfig(level=os.getenv("LOG_LEVEL", "INFO"), format="%(asctime)s %(levelname)s %(message)s", stream=sys.stdout)
    cfg = Config()
    port = int(os.getenv("PORT", "8080"))
    server = serve("0.0.0.0", port, cfg)
    st = server.relay_browser.status()  # type: ignore[attr-defined]
    LOG.info("browser relay listening on :%d → page %s / upstream %s (ready=%s, token_required=%s)", port, cfg.page_url, cfg.upstream, st["ready"], bool(cfg.token))
    if not cfg.token:
        LOG.warning("RELAY_TOKEN 未设置：任何人都能通过这个中继发请求，建议尽快设置。")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
