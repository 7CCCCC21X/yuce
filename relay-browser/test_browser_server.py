"""relay-browser/browser_server.py 测试：本地假站点（页面 + 同源 /graphql）验证
页面内 fetch 转发、鉴权、错误分类、挑战页等待。需要 Playwright 与 Chromium。
运行：python3 -m unittest relay-browser/test_browser_server.py
"""

from __future__ import annotations

import json
import threading
import time
import unittest
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import browser_server as relay


class FakeSite(BaseHTTPRequestHandler):
    """GET / → 普通页面（或先给一次「Just a moment」挑战页再给正常页）；POST /graphql → 回显。"""

    challenge_once = False
    received: list[dict] = []
    protocol_version = "HTTP/1.1"

    def _html(self, title: str) -> None:
        body = f"<!doctype html><html><head><title>{title}</title></head><body>ok</body></html>".encode()
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):  # noqa: N802
        if self.path == "/" and FakeSite.challenge_once:
            FakeSite.challenge_once = False
            # 模拟 Cloudflare 挑战页：2 秒后自己跳到正常页。
            body = b"<!doctype html><html><head><title>Just a moment...</title><meta http-equiv='refresh' content='2;url=/'></head><body></body></html>"
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        self._html("predict.fun fake")

    def do_POST(self):  # noqa: N802
        length = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(length)
        FakeSite.received.append({"path": self.path, "headers": {k.lower(): v for k, v in self.headers.items()}, "body": body.decode()})
        if self.path.endswith("/block"):
            html = b"<!DOCTYPE html><html><head><title>Attention Required! | Cloudflare</title></head><body></body></html>"
            self.send_response(403)
            self.send_header("Content-Type", "text/html")
            self.send_header("cf-ray", "deadbeef0000-HKG")
            self.send_header("Content-Length", str(len(html)))
            self.end_headers()
            self.wfile.write(html)
            return
        payload = json.loads(body)
        data = json.dumps({"data": {"account": {"name": "alice"}}, "echo": payload}).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, *a):
        pass


def start(server):
    threading.Thread(target=server.serve_forever, daemon=True).start()


def http(method, url, body=None, headers=None):
    req = urllib.request.Request(url, data=body, method=method, headers=headers or {})
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            return resp.status, dict(resp.headers), resp.read().decode()
    except urllib.error.HTTPError as e:
        return e.code, dict(e.headers), e.read().decode()


class BrowserRelayTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.site = ThreadingHTTPServer(("127.0.0.1", 0), FakeSite)
        start(cls.site)
        cls.site_url = f"http://127.0.0.1:{cls.site.server_address[1]}"
        FakeSite.challenge_once = True  # 第一次打开先给挑战页，验证等待逻辑
        cfg = relay.Config({"RELAY_PAGE_URL": cls.site_url + "/", "PREDICT_GRAPHQL_URL": cls.site_url + "/graphql", "RELAY_TOKEN": "s3cret", "RELAY_CONCURRENCY": "3"})
        cls.browser = relay.Browser(cfg)
        cls.browser.start()
        cls.server = relay.serve("127.0.0.1", 0, cfg, cls.browser)
        start(cls.server)
        cls.base = f"http://127.0.0.1:{cls.server.server_address[1]}"

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown(); cls.server.server_close()
        cls.site.shutdown(); cls.site.server_close()

    def setUp(self):
        FakeSite.received.clear()

    def test_healthz_ready_after_challenge(self):
        status, _, body = http("GET", f"{self.base}/healthz")
        self.assertEqual(status, 200, body)
        data = json.loads(body)
        self.assertTrue(data["ready"])
        self.assertEqual(data["mode"], "browser")
        self.assertEqual(data["page_title"], "predict.fun fake")

    def test_forwards_from_page_context(self):
        payload = {"query": "query G($a: Address!) { account(address: $a) { name } }", "variables": {"a": "0xAbC"}, "operationName": "G"}
        status, headers, body = http("POST", f"{self.base}/graphql", json.dumps(payload).encode(), {"content-type": "application/json", "x-relay-token": "s3cret"})
        self.assertEqual(status, 200, body)
        self.assertEqual(headers.get("x-upstream-status"), "200")
        data = json.loads(body)
        self.assertEqual(data["data"]["account"]["name"], "alice")
        self.assertEqual(data["echo"], payload)
        sent = FakeSite.received[-1]
        self.assertEqual(sent["headers"]["content-type"], "application/json")
        # 请求确实来自页面：带浏览器 UA 与同源 Origin
        self.assertIn("Chrome/", sent["headers"]["user-agent"])
        self.assertNotIn("HeadlessChrome", sent["headers"]["user-agent"])
        self.assertEqual(sent["headers"].get("origin"), self.site_url)

    def test_parallel_requests(self):
        results = []
        def one(i):
            s, _, b = http("POST", f"{self.base}/graphql?token=s3cret", json.dumps({"query": "{__typename}", "variables": {"i": i}}).encode(), {"content-type": "application/json"})
            results.append((s, json.loads(b)["echo"]["variables"]["i"]))
        threads = [threading.Thread(target=one, args=(i,)) for i in range(6)]
        for t in threads: t.start()
        for t in threads: t.join(60)
        self.assertEqual(sorted(r[1] for r in results), list(range(6)))
        self.assertTrue(all(r[0] == 200 for r in results))

    def test_auth_and_bad_body(self):
        s, h, b = http("POST", f"{self.base}/graphql", b'{"query":"{x}"}', {"content-type": "application/json", "x-relay-token": "wrong"})
        self.assertEqual(s, 401); self.assertEqual(h.get("x-relay-error"), "1"); self.assertTrue(json.loads(b)["relay"])
        s, _, _ = http("POST", f"{self.base}/graphql", b"nope", {"content-type": "application/json", "x-relay-token": "s3cret"})
        self.assertEqual(s, 400)
        s, _, _ = http("POST", f"{self.base}/other", b'{"query":"{x}"}', {"content-type": "application/json", "x-relay-token": "s3cret"})
        self.assertEqual(s, 404)
        self.assertEqual(FakeSite.received, [])

    def test_upstream_block_passes_through(self):
        cfg = relay.Config({"RELAY_PAGE_URL": self.site_url + "/", "PREDICT_GRAPHQL_URL": self.site_url + "/graphql/block"})
        b = relay.Browser(cfg); b.start()
        srv = relay.serve("127.0.0.1", 0, cfg, b); start(srv)
        try:
            s, h, body = http("POST", f"http://127.0.0.1:{srv.server_address[1]}/graphql", b'{"query":"{x}"}', {"content-type": "application/json"})
            self.assertEqual(s, 403)
            self.assertIsNone(h.get("x-relay-error"))
            self.assertEqual(h.get("x-upstream-cf-ray"), "deadbeef0000-HKG")
            self.assertIn("Attention Required", body)
        finally:
            srv.shutdown(); srv.server_close()


if __name__ == "__main__":
    unittest.main()
