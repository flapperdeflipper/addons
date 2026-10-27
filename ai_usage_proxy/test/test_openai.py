"""OpenAI quota normalization and provider-scoped device login."""

import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "rootfs/app"))


class FakeClient:
    def __init__(self, usage=None):
        self.usage = usage or {}
        self.events = []
        self.calls = []

    def request(self, method, params=None):
        self.calls.append((method, params))
        if method == "account/read":
            return {
                "account": {
                    "type": "chatgpt",
                    "email": "test@example.invalid",
                    "planType": "plus",
                }
            }
        if method == "account/rateLimits/read":
            return self.usage
        if method == "account/login/start":
            return {
                "type": "chatgptDeviceCode",
                "loginId": "flow-one",
                "verificationUrl": "https://auth.openai.com/codex/device",
                "userCode": "ABCD-1234",
            }
        return {}

    def pop_notifications(self):
        events, self.events = self.events, []
        return events

    def close(self):
        pass


class OpenAITests(unittest.TestCase):
    def setUp(self):
        from storage import CredentialStore

        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.store = CredentialStore(Path(self.tmp.name), "openai")

    def test_multiple_buckets_preferred_and_remaining_allowance_becomes_used(self):
        from providers.openai import OpenAIProvider

        usage = {
            "rateLimits": {"primary": {"usedPercent": 99}},
            "rateLimitsByLimitId": {
                "codex": {
                    "planType": "plus",
                    "primary": {
                        "usedPercent": 22,
                        "windowDurationMins": 300,
                        "resetsAt": 2000,
                    },
                    "secondary": {
                        "usedPercent": 35,
                        "windowDurationMins": 10080,
                        "resetsAt": None,
                    },
                    "individualLimit": {"remainingPercent": 78, "resetsAt": 2500},
                },
                "other": {"primary": {"usedPercent": 60, "windowDurationMins": 60}},
            },
        }
        provider = OpenAIProvider(
            self.store, client=FakeClient(usage), clock=lambda: 1000
        )
        snapshot = provider.fetch_usage()
        windows = {window.id: window for window in snapshot.windows}
        self.assertEqual(windows["codex_primary"].used_percent, 22)
        self.assertEqual(windows["codex_primary"].role, "session")
        self.assertEqual(windows["codex_secondary"].role, "week")
        self.assertIsNone(windows["codex_secondary"].resets_at)
        self.assertEqual(windows["codex_individual"].used_percent, 22)
        self.assertEqual(windows["other_primary"].role, "other")
        self.assertEqual(len(windows), 4)

    def test_single_bucket_fallback_and_unknown_duration(self):
        from providers.openai import OpenAIProvider

        client = FakeClient(
            {
                "rateLimitsByLimitId": {},
                "rateLimits": {
                    "primary": {"usedPercent": 0, "windowDurationMins": None},
                    "secondary": None,
                },
            }
        )
        snapshot = OpenAIProvider(
            self.store, client=client, clock=lambda: 1000
        ).fetch_usage()
        self.assertEqual(snapshot.windows[0].used_percent, 0)
        self.assertIsNone(snapshot.windows[0].duration_seconds)
        self.assertEqual(snapshot.windows[0].role, "other")

    def test_device_completion_matches_current_login_and_cancel_clears_it(self):
        from providers.openai import OpenAIProvider

        client = FakeClient()
        provider = OpenAIProvider(self.store, client=client, clock=lambda: 1000)
        auth = provider.start_auth()
        self.assertEqual(auth.kind, "device_code")
        self.assertEqual(auth.code, "ABCD-1234")
        client.events = [
            {
                "method": "account/login/completed",
                "params": {"loginId": "old-flow", "success": True},
            }
        ]
        self.assertFalse(provider.check_auth())
        client.events = [
            {
                "method": "account/login/completed",
                "params": {"loginId": "flow-one", "success": True},
            }
        ]
        self.assertTrue(provider.check_auth())
        self.assertTrue(provider.connected())
        provider.start_auth()
        provider.cancel_auth()
        self.assertIn(("account/login/cancel", {"loginId": "flow-one"}), client.calls)
        self.assertFalse(provider.check_auth())

    def test_authentication_errors_and_expired_device_codes(self):
        from providers.base import ProviderError
        from providers.openai import OpenAIProvider

        now = [1000]
        provider = OpenAIProvider(self.store, client=FakeClient(), clock=lambda: now[0])
        provider.start_auth()
        now[0] = 2000
        with self.assertRaisesRegex(ProviderError, "expired"):
            provider.check_auth()
        client = FakeClient()
        client.request = lambda *args, **kwargs: {"account": None}
        with self.assertRaises(ProviderError) as error:
            OpenAIProvider(self.store, client=client).fetch_usage()
        self.assertEqual(error.exception.status, "auth_required")

    def test_disconnect_removes_private_auth_cache(self):
        from providers.openai import OpenAIProvider

        provider = OpenAIProvider(self.store, client=FakeClient())
        cache = self.store.directory / "codex" / "auth.json"
        cache.write_text('{"tokens":{"access_token":"private"}}')
        self.assertTrue(provider.connected())
        provider.disconnect()
        self.assertFalse(cache.exists())
        self.assertFalse(provider.connected())

    def test_disconnect_still_clears_credentials_when_cancel_cannot_reach_child(self):
        from providers.base import ProviderError
        from providers.openai import OpenAIProvider

        client = FakeClient()
        provider = OpenAIProvider(self.store, client=client)
        cache = self.store.directory / "codex" / "auth.json"
        cache.write_text('{"tokens":{}}')
        provider.start_auth()

        def failed_request(*args, **kwargs):
            raise ProviderError("Child unavailable")

        client.request = failed_request
        provider.disconnect()
        self.assertFalse(cache.exists())
        self.assertFalse(provider.connected())

    def test_device_login_reports_child_exit_without_waiting_for_code_expiry(self):
        from providers.base import ProviderError
        from providers.codex_client import CodexClient
        from providers.openai import OpenAIProvider

        script = Path(self.tmp.name) / "exit_during_login.py"
        script.write_text("""
import json, sys
for line in sys.stdin:
    message = json.loads(line)
    if message['method'] == 'initialized':
        continue
    result = {}
    if message['method'] == 'account/login/start':
        result = {'loginId': 'pending', 'verificationUrl': 'https://auth.openai.com/codex/device',
                  'userCode': 'ABCD-1234'}
    print(json.dumps({'id': message['id'], 'result': result}), flush=True)
    if message['method'] == 'account/login/start':
        sys.exit(0)
""")
        client = CodexClient(
            self.store.directory / "codex", command=[sys.executable, str(script)]
        )
        self.addCleanup(client.close)
        provider = OpenAIProvider(self.store, client=client, clock=lambda: 1000)
        provider.start_auth()
        client.process.wait(timeout=1)
        with self.assertRaisesRegex(ProviderError, "stopped"):
            provider.check_auth()
        self.assertEqual(provider.login_id, "")


if __name__ == "__main__":
    unittest.main()
