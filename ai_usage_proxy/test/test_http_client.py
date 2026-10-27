"""Real HTTP boundary behavior against a local fixture server."""

import json
import sys
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "rootfs/app"))


class HttpTests(unittest.TestCase):
    def test_json_limit_and_retry_delay(self):
        from providers.base import ProviderError
        from providers.http_client import HttpClient

        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):
                if self.path == "/rate":
                    self.send_response(429)
                    self.send_header("Retry-After", "120")
                    self.end_headers()
                    self.wfile.write(b'{"error":"secret"}')
                elif self.path == "/large":
                    self.send_response(200)
                    self.end_headers()
                    self.wfile.write(b"x" * 200)
                else:
                    self.send_response(200)
                    self.end_headers()
                    self.wfile.write(json.dumps({"ok": True}).encode())

            def log_message(self, *args):
                pass

        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            client = HttpClient(max_bytes=100)
            url = f"http://127.0.0.1:{server.server_port}"
            self.assertEqual(client.request(url).data, {"ok": True})
            response = client.request(url + "/rate")
            self.assertEqual(response.status, 429)
            self.assertEqual(response.retry_after, 120)
            with self.assertRaises(ProviderError):
                client.request(url + "/large")
        finally:
            server.shutdown()
            server.server_close()
            thread.join()


if __name__ == "__main__":
    unittest.main()
