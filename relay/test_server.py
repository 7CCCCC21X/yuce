"""relay/server.py 单元测试：用本地假上游验证转发、鉴权、错误分类。
运行：python3 -m unittest relay/test_server.py
"""

from __future__ import annotations

import json
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import httpx

import server as relay


class FakeUpstream(BaseHTTPRequestHandler):
    """回显收到的请求体与请求头；路径 /block 模拟 Cloudflare 403 页。"""

    received: list[dict] = []
    protocol_version = "HTTP/1.1"

    def do_POST(self):  # noqa: N802
        length = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(length)
        FakeUpstream.received.append({"path": self.path, "headers": {k.lower(): v for k, v in self.headers.items()}, "body": body.decode()})
        if self.path.endswith("/block"):
            html = b"<!DOCTYPE html><html><head><title>Attention Required! | Cloudflare</title></head><body></body></html>"
            self.send_response(403)
            self.send_header("Content-Type", "text/html")
            self.send_header("cf-ray", "deadbeef0000-SIN")
            self.send_header("server", "cloudflare")
            self.send_header("Content-Length", str(len(html)))
            self.end_headers()
            self.wfile.write(html)
            return
        data = json.dumps({"data": {"account": {"name": "alice"}}, "echo": json.loads(body)}).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, *a):  # 静音
        pass


def start(server):
    t = threading.Thread(target=server.serve_forever, daemon=True)
    t.start()
    return t


class RelayTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.upstream = ThreadingHTTPServer(("127.0.0.1", 0), FakeUpstream)
        start(cls.upstream)
        cls.upstream_url = f"http://127.0.0.1:{cls.upstream.server_address[1]}/graphql"
        cfg = relay.RelayConfig({"PREDICT_GRAPHQL_URL": cls.upstream_url, "RELAY_TOKEN": "s3cret", "PREDICT_GRAPHQL_AUTH": "Bearer abc"})
        cls.relay = relay.serve("127.0.0.1", 0, cfg)
        start(cls.relay)
        cls.base = f"http://127.0.0.1:{cls.relay.server_address[1]}"
        # 无 token 的中继，用来验证"不设密钥就放行"。
        cls.open_relay = relay.serve("127.0.0.1", 0, relay.RelayConfig({"PREDICT_GRAPHQL_URL": cls.upstream_url}))
        start(cls.open_relay)
        cls.open_base = f"http://127.0.0.1:{cls.open_relay.server_address[1]}"

    @classmethod
    def tearDownClass(cls):
        for s in (cls.relay, cls.open_relay, cls.upstream):
            s.shutdown()
            s.server_close()

    def setUp(self):
        FakeUpstream.received.clear()

    def test_healthz(self):
        r = httpx.get(f"{self.base}/healthz")
        self.assertEqual(r.status_code, 200)
        body = r.json()
        self.assertTrue(body["ok"])
        self.assertTrue(body["token_required"])
        self.assertEqual(body["upstream"], self.upstream_url)

    def test_forwards_graphql_with_token_header(self):
        payload = {"query": "query G($a: Address!) { account(address: $a) { name } }", "variables": {"a": "0xAbC"}, "operationName": "G"}
        r = httpx.post(f"{self.base}/graphql", json=payload, headers={"x-relay-token": "s3cret"})
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.headers.get("x-upstream-status"), "200")
        self.assertEqual(r.headers.get("access-control-allow-origin"), "*")
        self.assertEqual(r.json()["data"]["account"]["name"], "alice")
        self.assertEqual(r.json()["echo"], payload)
        sent = FakeUpstream.received[-1]
        self.assertEqual(sent["headers"]["content-type"], "application/json")
        self.assertEqual(sent["headers"]["authorization"], "Bearer abc")
        self.assertEqual(sent["headers"]["user-agent"], "yuce-relay/1.0")
        # 入站的 x-relay-token 绝不转发给上游。
        self.assertNotIn("x-relay-token", sent["headers"])

    def test_token_via_query_string(self):
        r = httpx.post(f"{self.base}/graphql?token=s3cret", json={"query": "{__typename}"})
        self.assertEqual(r.status_code, 200)

    def test_rejects_bad_token_with_relay_marker(self):
        r = httpx.post(f"{self.base}/graphql", json={"query": "{__typename}"}, headers={"x-relay-token": "wrong"})
        self.assertEqual(r.status_code, 401)
        self.assertEqual(r.headers.get("x-relay-error"), "1")
        self.assertTrue(r.json()["relay"])
        self.assertEqual(FakeUpstream.received, [])

    def test_keep_alive_after_rejected_request(self):
        """同一条长连接上：被拒（401 / 404）之后的下一个请求必须正常，说明请求体被读完了。"""
        with httpx.Client() as c:
            r1 = c.post(f"{self.base}/graphql", json={"query": "{__typename}", "variables": {"pad": "x" * 2000}}, headers={"x-relay-token": "wrong"})
            self.assertEqual(r1.status_code, 401)
            r2 = c.post(f"{self.base}/other", json={"query": "{__typename}", "variables": {"pad": "y" * 2000}}, headers={"x-relay-token": "s3cret"})
            self.assertEqual(r2.status_code, 404)
            r3 = c.post(f"{self.base}/graphql", json={"query": "{__typename}"}, headers={"x-relay-token": "s3cret"})
            self.assertEqual(r3.status_code, 200)
            self.assertEqual(r3.json()["data"]["account"]["name"], "alice")

    def test_open_relay_without_token(self):
        r = httpx.post(f"{self.open_base}/graphql", json={"query": "{__typename}"})
        self.assertEqual(r.status_code, 200)
        self.assertNotIn("authorization", FakeUpstream.received[-1]["headers"])

    def test_bad_body_and_routes(self):
        r = httpx.post(f"{self.base}/graphql", content=b"not json", headers={"x-relay-token": "s3cret", "content-type": "application/json"})
        self.assertEqual(r.status_code, 400)
        r = httpx.post(f"{self.base}/graphql", json={"variables": {}}, headers={"x-relay-token": "s3cret"})
        self.assertEqual(r.status_code, 400)
        self.assertEqual(httpx.post(f"{self.base}/other", json={"query": "{x}"}, headers={"x-relay-token": "s3cret"}).status_code, 404)
        self.assertEqual(httpx.get(f"{self.base}/graphql").status_code, 404)
        self.assertEqual(httpx.options(f"{self.base}/graphql").status_code, 204)

    def test_upstream_block_page_passes_through_with_ray(self):
        cfg = relay.RelayConfig({"PREDICT_GRAPHQL_URL": self.upstream_url.replace("/graphql", "/block")})
        srv = relay.serve("127.0.0.1", 0, cfg)
        start(srv)
        try:
            r = httpx.post(f"http://127.0.0.1:{srv.server_address[1]}/graphql", json={"query": "{x}"})
            self.assertEqual(r.status_code, 403)
            self.assertIsNone(r.headers.get("x-relay-error"))
            self.assertEqual(r.headers.get("x-upstream-cf-ray"), "deadbeef0000-SIN")
            self.assertIn("Attention Required", r.text)
        finally:
            srv.shutdown()
            srv.server_close()


if __name__ == "__main__":
    unittest.main()
