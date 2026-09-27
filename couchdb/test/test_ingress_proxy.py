#!/usr/bin/env python3
"""Self-running tests for the ingress auth proxy (stdlib only, loopback)."""

import base64
import json
import sys
import threading
import unittest
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from ingress_proxy import make_handler  # noqa: E402

CREDS = "admin:pw"


class Upstream(BaseHTTPRequestHandler):
    seen = {}

    def do_GET(self):
        Upstream.seen["auth"] = self.headers.get("Authorization")
        Upstream.seen["path"] = self.path
        body = b'{"ok":true}'
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *a):
        return


class TestIngressProxy(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.upstream = ThreadingHTTPServer(("127.0.0.1", 0), Upstream)
        threading.Thread(target=cls.upstream.serve_forever, daemon=True).start()
        up = f"http://127.0.0.1:{cls.upstream.server_address[1]}"
        cls.proxy = ThreadingHTTPServer(("127.0.0.1", 0), make_handler(up, CREDS))
        threading.Thread(target=cls.proxy.serve_forever, daemon=True).start()
        cls.url = f"http://127.0.0.1:{cls.proxy.server_address[1]}"

    @classmethod
    def tearDownClass(cls):
        cls.upstream.shutdown()
        cls.proxy.shutdown()

    def test_forwards_with_injected_basic_auth(self):
        req = urllib.request.Request(self.url + "/_utils", headers={
            "X-Hass-Source": "core_ingress", "X-Remote-User-Id": "ha-user-1", "X-Remote-User-Name": "flip"})
        with urllib.request.urlopen(req, timeout=10) as r:
            self.assertEqual(json.loads(r.read())["ok"], True)
        self.assertEqual(Upstream.seen["path"], "/_utils")
        expected = "Basic " + base64.b64encode(CREDS.encode()).decode()
        self.assertEqual(Upstream.seen["auth"], expected)

    def test_dashboard_assets_rewritten_with_utils_prefix(self):
        req = urllib.request.Request(
            self.url + "/dashboard.assets/js/bundle.js",
            headers={"X-Hass-Source": "core_ingress", "X-Remote-User-Id": "u1"})
        with urllib.request.urlopen(req, timeout=10):
            pass
        self.assertEqual(Upstream.seen["path"], "/_utils/dashboard.assets/js/bundle.js")

    def test_rejects_requests_without_hassio_key(self):
        req = urllib.request.Request(self.url + "/x")  # no ingress headers at all
        try:
            urllib.request.urlopen(req, timeout=10)
            self.fail("expected 403")
        except urllib.error.HTTPError as e:
            self.assertEqual(e.code, 403)


if __name__ == "__main__":
    unittest.main(verbosity=2)
