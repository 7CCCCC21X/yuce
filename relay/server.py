#!/usr/bin/env python3
"""yuce GraphQL 中继：把 Vercel 函数发来的 GraphQL 请求原样转发给 graphql.predict.fun。

为什么需要它
    predict.fun 前置的 Cloudflare 会拦下从 Vercel 出口发往 GraphQL 的请求
    （403 + "Attention Required!"），换区域、换请求头都无效；而同一类请求从
    Railway 用 Python httpx 发出能正常通过（predict_whale_bot 就是这样查用户名的）。
    于是把"最后一跳"搬到 Railway：Vercel 的 /api/portfolio、/api/portfolio-pnl
    逻辑不变，只是把 POST 的目标从 graphql.predict.fun 换成这个中继。

接口
    POST /graphql      请求体即 GraphQL JSON（query / variables / operationName），
                       原样转发，返回上游的状态码与响应体。
    GET  /healthz      {"ok": true, ...}
    其余               404

环境变量
    PORT                     监听端口（Railway 自动注入）
    RELAY_TOKEN              共享密钥。设置后，请求必须带 x-relay-token 头或 ?token=。
                             强烈建议设置，否则任何人都能借你的出口发请求。
    PREDICT_GRAPHQL_URL      上游地址，默认 https://graphql.predict.fun/graphql
    PREDICT_GRAPHQL_AUTH     可选，转发时附带的 authorization 头
    PREDICT_GRAPHQL_COOKIE   可选，转发时附带的 cookie 头
    RELAY_USER_AGENT         转发时的 User-Agent，默认 yuce-relay/1.0
    UPSTREAM_TIMEOUT_SEC     上游超时秒数，默认 10

部署到 Railway
    New Service → GitHub Repo 选 yuce → Settings 里 Root Directory 填 relay →
    Variables 里加 RELAY_TOKEN → 生成域名。然后在 Vercel 加两个环境变量：
    PREDICT_GRAPHQL_RELAY_URL=https://<railway 域名>、PREDICT_GRAPHQL_RELAY_TOKEN=<同一个密钥>，
    Redeploy 即可。
"""

from __future__ import annotations

import json
import logging
import os
import sys
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlsplit

import httpx

try:  # http2 需要 h2 包；requirements 里装了，缺失时自动降级。
    import h2  # noqa: F401

    HTTP2 = True
except ImportError:  # pragma: no cover
    HTTP2 = False

LOG = logging.getLogger("relay")

DEFAULT_UPSTREAM = "https://graphql.predict.fun/graphql"
MAX_BODY_BYTES = 64 * 1024
HOP_BY_HOP = {"connection", "keep-alive", "transfer-encoding", "content-encoding", "content-length", "te", "trailer", "upgrade"}
# 上游响应头里值得透传的：Cloudflare 的 Ray ID / server，便于 Vercel 那边定位拦截。
PASS_THROUGH_HEADERS = ("content-type", "cf-ray", "server", "cf-mitigated")


def build_client(timeout: float, user_agent: str) -> httpx.Client:
    return httpx.Client(
        http2=HTTP2,
        timeout=httpx.Timeout(timeout),
        headers={"User-Agent": user_agent},
        limits=httpx.Limits(max_connections=50, max_keepalive_connections=20, keepalive_expiry=60),
    )


class RelayConfig:
    def __init__(self, env: dict[str, str] | None = None) -> None:
        env = os.environ if env is None else env
        self.upstream = env.get("PREDICT_GRAPHQL_URL", DEFAULT_UPSTREAM).strip() or DEFAULT_UPSTREAM
        self.token = env.get("RELAY_TOKEN", "").strip()
        self.auth = env.get("PREDICT_GRAPHQL_AUTH", "").strip()
        self.cookie = env.get("PREDICT_GRAPHQL_COOKIE", "").strip()
        self.user_agent = env.get("RELAY_USER_AGENT", "yuce-relay/1.0").strip() or "yuce-relay/1.0"
        self.timeout = float(env.get("UPSTREAM_TIMEOUT_SEC", "10") or 10)


def make_handler(cfg: RelayConfig, client: httpx.Client):
    class Handler(BaseHTTPRequestHandler):
        server_version = "yuce-relay/1.0"
        protocol_version = "HTTP/1.1"

        # ---- 工具 ----
        def _cors(self) -> None:
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Access-Control-Allow-Methods", "POST, GET, OPTIONS")
            self.send_header("Access-Control-Allow-Headers", "Content-Type, Accept, x-relay-token")
            self.send_header("Cache-Control", "no-store")

        def _json(self, status: int, body: dict, extra: dict[str, str] | None = None) -> None:
            data = json.dumps(body, ensure_ascii=False).encode("utf-8")
            self.send_response(status)
            self._cors()
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(data)))
            for k, v in (extra or {}).items():
                self.send_header(k, v)
            self.end_headers()
            self.wfile.write(data)

        def _relay_error(self, status: int, message: str) -> None:
            # x-relay-error 让 Vercel 那边把"中继自身的错误"和"上游拒绝"区分开。
            self._json(status, {"success": False, "error": message, "relay": True}, {"x-relay-error": "1"})

        def _authorized(self, url) -> bool:
            if not cfg.token:
                return True
            header = self.headers.get("x-relay-token", "")
            query = parse_qs(url.query).get("token", [""])[0]
            return header == cfg.token or query == cfg.token

        def log_message(self, fmt: str, *args) -> None:  # 精简日志
            LOG.info("%s %s", self.address_string(), fmt % args)

        # ---- 路由 ----
        def do_OPTIONS(self) -> None:  # noqa: N802
            self.send_response(204)
            self._cors()
            self.send_header("Content-Length", "0")
            self.end_headers()

        def do_GET(self) -> None:  # noqa: N802
            url = urlsplit(self.path)
            if url.path == "/healthz":
                return self._json(200, {"ok": True, "upstream": cfg.upstream, "http2": HTTP2, "token_required": bool(cfg.token)})
            return self._relay_error(404, f"no such route: GET {url.path}")

        def do_POST(self) -> None:  # noqa: N802
            url = urlsplit(self.path)
            # 先把请求体读完再回应任何错误：HTTP/1.1 长连接上没读的字节会被当成
            # 下一个请求的起始行解析成垃圾请求。读不了（过大 / 缺长度）就关连接。
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

            # 与 predict_whale_bot 一致的最小请求头：content-type + User-Agent（client 默认头）。
            headers = {
                "content-type": "application/json",
                "accept": "application/graphql-response+json, application/json",
            }
            if cfg.auth:
                headers["authorization"] = cfg.auth
            if cfg.cookie:
                headers["cookie"] = cfg.cookie

            started = time.monotonic()
            try:
                resp = client.post(cfg.upstream, content=body, headers=headers)
            except httpx.TimeoutException:
                return self._relay_error(504, f"upstream timed out after {cfg.timeout}s")
            except httpx.HTTPError as exc:
                return self._relay_error(502, f"upstream request failed: {exc}")

            elapsed_ms = int((time.monotonic() - started) * 1000)
            op = payload.get("operationName") or "-"
            LOG.info("relay %s -> %s (%d ms, %d bytes)", op, resp.status_code, elapsed_ms, len(resp.content))

            self.send_response(resp.status_code)
            self._cors()
            for name in PASS_THROUGH_HEADERS:
                value = resp.headers.get(name)
                if value and name not in HOP_BY_HOP:
                    self.send_header(name if name == "content-type" else f"x-upstream-{name}", value)
            self.send_header("x-upstream-status", str(resp.status_code))
            self.send_header("Content-Length", str(len(resp.content)))
            self.end_headers()
            self.wfile.write(resp.content)

    return Handler


def serve(host: str, port: int, cfg: RelayConfig | None = None) -> ThreadingHTTPServer:
    cfg = cfg or RelayConfig()
    client = build_client(cfg.timeout, cfg.user_agent)
    server = ThreadingHTTPServer((host, port), make_handler(cfg, client))
    server.daemon_threads = True
    server.relay_client = client  # type: ignore[attr-defined]
    return server


def main() -> int:
    logging.basicConfig(level=os.getenv("LOG_LEVEL", "INFO"), format="%(asctime)s %(levelname)s %(message)s", stream=sys.stdout)
    cfg = RelayConfig()
    port = int(os.getenv("PORT", "8080"))
    server = serve("0.0.0.0", port, cfg)
    LOG.info("yuce relay listening on :%d → %s (http2=%s, token_required=%s)", port, cfg.upstream, HTTP2, bool(cfg.token))
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
