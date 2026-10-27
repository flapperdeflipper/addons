"""Exercise the actual JSONL client with a deterministic child process."""

import sys
import tempfile
import threading
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "rootfs/app"))

FAKE = r"""
import json, sys, time
for line in sys.stdin:
    req = json.loads(line)
    method = req['method']
    if method == 'initialized':
        continue
    if method == 'timeout':
        time.sleep(3)
        continue
    if method == 'malformed':
        print('not-json', flush=True)
        continue
    if method == 'exit':
        sys.exit(1)
    if method == 'echo':
        print(json.dumps({'method': 'account/updated', 'params': {'authMode': 'chatgpt'}}), flush=True)
    print(json.dumps({'id': req['id'], 'result': {'method': method, 'params': req.get('params')}}), flush=True)
    if method == 'stop-reading':
        time.sleep(10)
"""


class CodexClientTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.script = Path(self.tmp.name) / "fake.py"
        self.script.write_text(FAKE)

    def client(self, timeout=1):
        from providers.codex_client import CodexClient

        client = CodexClient(
            Path(self.tmp.name) / "state",
            command=[sys.executable, str(self.script)],
            timeout=timeout,
        )
        self.addCleanup(client.close)
        return client

    def test_initialization_then_interleaved_notification_and_response(self):
        client = self.client()
        result = client.request("echo", {"number": 22})
        self.assertEqual(result["params"], {"number": 22})
        self.assertEqual(client.pop_notifications()[0]["method"], "account/updated")
        self.assertEqual(client.pop_notifications(), [])
        self.assertNotIn("OPENAI_API_KEY", client.environment)
        self.assertEqual(
            client.environment["CODEX_HOME"], str(Path(self.tmp.name) / "state")
        )

    def test_timeout_kills_child_and_next_request_restarts(self):
        from providers.base import ProviderError

        client = self.client(timeout=0.1)
        with self.assertRaisesRegex(ProviderError, "timed out"):
            client.request("timeout")
        self.assertEqual(client.request("echo")["method"], "echo")

    def test_exit_and_malformed_output_are_safe_failures(self):
        from providers.base import ProviderError

        client = self.client()
        for method in ("exit", "malformed"):
            with self.subTest(method=method), self.assertRaises(ProviderError):
                client.request(method)
            self.assertEqual(client.request("echo")["method"], "echo")

    def test_close_terminates_process(self):
        client = self.client()
        client.request("echo")
        process = client.process
        client.close()
        self.assertIsNotNone(process.poll())
        self.assertIsNone(client.process)

    def test_request_deadline_includes_writing_to_a_nonreading_child(self):
        from providers.base import ProviderError

        client = self.client(timeout=0.1)
        client.request("stop-reading")
        errors = []

        def request_large_message():
            try:
                client.request("echo", {"value": "x" * 1_000_000})
            except ProviderError as error:
                errors.append(error)

        writer = threading.Thread(target=request_large_message, daemon=True)
        writer.start()
        try:
            writer.join(timeout=1)
            self.assertFalse(
                writer.is_alive(), "A blocked write exceeded the request deadline"
            )
            self.assertEqual(len(errors), 1)
            self.assertIn("timed out", str(errors[0]))
        finally:
            client.close()
            writer.join(timeout=1)
        self.assertEqual(client.request("echo")["method"], "echo")


if __name__ == "__main__":
    unittest.main()
