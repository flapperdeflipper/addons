"""Real HTTP checks for Ingress routing, CSRF and secret-free public views."""

import json
import sys
import tempfile
import threading
import unittest
from http.client import HTTPConnection
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "rootfs/app"))
from service import UsageService
from test_service import FakeProvider


class WebTests(unittest.TestCase):
    def setUp(self):
        from web import make_server

        self.tmp = tempfile.TemporaryDirectory()
        self.service = UsageService(
            {"claude": FakeProvider(Path(self.tmp.name), "claude")}
        )

        class Publisher:
            def public(self):
                return {
                    "connected": False,
                    "source": "Testing",
                    "topic_root": "ai/usage",
                    "poll_interval": 60,
                    "discovery": True,
                }

        self.server = make_server(
            self.service, Publisher(), ("127.0.0.1", 0), ("127.0.0.1",)
        )
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()
        self.service.close()
        self.tmp.cleanup()

    def request(self, method, path, payload=None, headers=None):
        connection = HTTPConnection(*self.server.server_address, timeout=3)
        connection.request(
            method,
            path,
            body=json.dumps(payload) if payload is not None else None,
            headers=headers or {},
        )
        response = connection.getresponse()
        result = response.status, response.read().decode(), dict(response.getheaders())
        connection.close()
        return result

    def test_dashboard_uses_ingress_prefix_and_no_full_page_refresh(self):
        code, html, headers = self.request(
            "GET", "/", headers={"X-Ingress-Path": "/api/hassio_ingress/demo"}
        )
        self.assertEqual(code, 200)
        self.assertIn("/api/hassio_ingress/demo/assets/dashboard.js", html)
        self.assertNotIn('http-equiv="refresh"', html)
        self.assertIn("AI Usage Proxy", html)
        self.assertIn("Content-Security-Policy", headers)
        self.assertIn("csrf-token", html)
        self.assertEqual(self.service.states["claude"].flow_id, "")

    def test_state_mutation_requires_token_and_scopes_flow_to_provider(self):
        payload = {"value": "", "flow_id": ""}
        status, _, _ = self.request(
            "POST",
            "/providers/claude/connect",
            payload,
            {"Content-Type": "application/json"},
        )
        self.assertEqual(status, 403)
        status, body, _ = self.request(
            "POST",
            "/providers/claude/connect",
            payload,
            {
                "Content-Type": "application/json",
                "X-CSRF-Token": self.server.csrf_token,
            },
        )
        self.assertEqual(status, 202)
        self.assertTrue(json.loads(body)["flow_id"])
        status, _, _ = self.request(
            "POST",
            "/providers/claude/credentials",
            {"value": "secret"},
            {
                "Content-Type": "application/json",
                "X-CSRF-Token": self.server.csrf_token,
            },
        )
        self.assertEqual(status, 400)

    def test_status_excludes_private_auth_flow_and_arbitrary_files_are_inaccessible(
        self,
    ):
        self.service.action("claude", "connect")
        self.service.tick("claude")
        code, body, _ = self.request("GET", "/api/status")
        self.assertEqual(code, 200)
        self.assertNotIn("example.com/authorize", body)
        self.assertEqual(self.request("GET", "/assets/../../storage.py")[0], 404)

    def test_only_ingress_gateway_can_connect(self):
        self.server.allowed_clients = ("172.30.32.2",)
        with self.assertRaises((ConnectionError, OSError)):
            self.request("GET", "/")


if __name__ == "__main__":
    unittest.main()
