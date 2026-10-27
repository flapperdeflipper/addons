"""z.ai key acceptance and conservative quota normalization."""

import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "rootfs/app"))


class ZaiTests(unittest.TestCase):
    def setUp(self):
        from storage import CredentialStore

        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.store = CredentialStore(Path(self.tmp.name), "zai")

    def test_first_party_legacy_used_percentages_and_raw_authorization(self):
        from providers.http_client import HttpResponse
        from providers.zai import ZaiProvider

        self.store.write({"api_key": "my-key"})

        class Upstream:
            def request(self, url, method="GET", body=None, headers=None):
                self.header = headers["Authorization"]
                return HttpResponse(
                    200,
                    {
                        "success": True,
                        "data": {
                            "limits": [
                                {"type": "TIME_LIMIT", "percentage": 78},
                                {"type": "TOKENS_LIMIT", "percentage": 22},
                            ]
                        },
                    },
                )

        http = Upstream()
        snapshot = ZaiProvider(self.store, http=http, clock=lambda: 1000).fetch_usage()
        self.assertEqual(http.header, "my-key")
        by_id = {window.id: window for window in snapshot.windows}
        self.assertEqual(by_id["tokens"].used_percent, 22)
        self.assertEqual(by_id["mcp"].used_percent, 78)
        self.assertIsNone(by_id["tokens"].resets_at)

    def test_rejected_replacement_preserves_current_key(self):
        from providers.base import ProviderError
        from providers.http_client import HttpResponse
        from providers.zai import ZaiProvider

        self.store.write({"api_key": "current"})

        class Upstream:
            def request(self, *args, **kwargs):
                return HttpResponse(401, {"error": "secret"})

        with self.assertRaises(ProviderError):
            ZaiProvider(self.store, http=Upstream()).save_key("invalid")
        self.assertEqual(self.store.read()["api_key"], "current")

    def test_valid_key_with_unknown_credit_schema_is_saved_and_flagged(self):
        from providers.base import ProviderError
        from providers.http_client import HttpResponse
        from providers.zai import ZaiProvider

        class Upstream:
            def request(self, *args, **kwargs):
                return HttpResponse(
                    200,
                    {
                        "success": True,
                        "data": {
                            "limits": [
                                {"type": "CREDIT_LIMIT", "percentage": 22, "unit": 77}
                            ]
                        },
                    },
                )

        provider = ZaiProvider(self.store, http=Upstream())
        with self.assertRaises(ProviderError) as error:
            provider.save_key("valid-key")
        self.assertEqual(error.exception.status, "unsupported")
        self.assertTrue(provider.connected())
        self.assertEqual(self.store.read()["api_key"], "valid-key")

    def test_application_error_200_is_not_a_successful_connection(self):
        from providers.base import ProviderError
        from providers.http_client import HttpResponse
        from providers.zai import ZaiProvider

        class Upstream:
            def request(self, *args, **kwargs):
                return HttpResponse(
                    200, {"success": False, "code": 401, "msg": "secret"}
                )

        with self.assertRaises(ProviderError) as error:
            ZaiProvider(self.store, http=Upstream()).save_key("invalid")
        self.assertEqual(error.exception.status, "auth_required")
        self.assertEqual(self.store.read(), {})
        self.assertNotIn("secret", str(error.exception))

    def test_malformed_or_error_envelope_preserves_current_key(self):
        from providers.base import ProviderError
        from providers.http_client import HttpResponse
        from providers.zai import ZaiProvider

        payloads = (
            {},
            {"error": "invalid key"},
            {"data": {"limits": "not-a-quota-list"}},
            {"limits": ["not-a-quota"]},
            {"limits": [{"other": "unknown"}]},
            {"success": True, "error": "invalid key"},
        )
        for payload in payloads:
            with self.subTest(payload=payload):
                self.store.write({"api_key": "current"})

                class Upstream:
                    response_payload = payload

                    def request(self, *args, **kwargs):
                        return HttpResponse(200, self.response_payload)

                with self.assertRaises(ProviderError):
                    ZaiProvider(self.store, http=Upstream()).save_key("unproven")
                self.assertEqual(self.store.read()["api_key"], "current")

    def test_recognizable_direct_quota_payload_can_accept_replacement(self):
        from providers.http_client import HttpResponse
        from providers.zai import ZaiProvider

        self.store.write({"api_key": "current"})

        class Upstream:
            def request(self, *args, **kwargs):
                return HttpResponse(
                    200, {"limits": [{"type": "TOKENS_LIMIT", "percentage": 22}]}
                )

        ZaiProvider(self.store, http=Upstream()).save_key("replacement")
        self.assertEqual(self.store.read()["api_key"], "replacement")


if __name__ == "__main__":
    unittest.main()
