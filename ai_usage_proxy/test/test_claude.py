"""Claude OAuth and usage behavior with an injected upstream boundary."""

import sys
import tempfile
import unittest
from pathlib import Path
from urllib.parse import parse_qs, urlparse

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "rootfs/app"))


class ClaudeTests(unittest.TestCase):
    def setUp(self):
        from storage import CredentialStore

        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.store = CredentialStore(Path(self.tmp.name), "claude")

    def test_auth_binds_state_to_verifier_and_expires(self):
        from providers.base import ProviderError
        from providers.claude import ClaudeProvider

        now = [1000]
        provider = ClaudeProvider(self.store, clock=lambda: now[0])
        view = provider.start_auth()
        params = parse_qs(urlparse(view.url).query)
        self.assertEqual(view.kind, "authorization_code")
        self.assertEqual(params["state"][0], provider.pending_verifier)
        with self.assertRaises(ProviderError):
            provider.complete_auth("code#wrong-state")
        now[0] += 901
        with self.assertRaisesRegex(ProviderError, "expired"):
            provider.complete_auth("code#" + params["state"][0])

    def test_bare_code_uses_pending_verifier_as_state(self):
        from providers.claude import ClaudeProvider
        from providers.http_client import HttpResponse

        sent = []

        class Upstream:
            def request(self, url, method="GET", body=None, headers=None):
                sent.append(body)
                return HttpResponse(200, {"access_token": "a", "refresh_token": "r"})

        provider = ClaudeProvider(self.store, http=Upstream(), clock=lambda: 1000)
        provider.start_auth()
        verifier = provider.pending_verifier
        provider.complete_auth("code")
        self.assertEqual(sent[0]["state"], verifier)
        self.assertEqual(self.store.read()["refresh_token"], "r")

    def test_rotated_tokens_saved_before_usage_and_missing_is_unknown(self):
        from providers.claude import ClaudeProvider
        from providers.http_client import HttpResponse

        self.store.write(
            {"refresh_token": "old", "access_token": "expired", "expires_at": 0}
        )
        store = self.store

        class Upstream:
            def request(self, url, method="GET", body=None, headers=None):
                if "oauth/token" in url:
                    return HttpResponse(
                        200,
                        {
                            "access_token": "fresh",
                            "refresh_token": "rotated",
                            "expires_in": 3600,
                        },
                    )
                self.assert_saved = store.read()["refresh_token"]
                return HttpResponse(
                    200,
                    {
                        "five_hour": {"utilization": 22, "resets_at": None},
                        "seven_day": {"utilization": None},
                    },
                )

        http = Upstream()
        provider = ClaudeProvider(self.store, http=http, clock=lambda: 1000)
        snapshot = provider.fetch_usage()
        self.assertEqual(http.assert_saved, "rotated")
        self.assertEqual(snapshot.windows[0].used_percent, 22)
        self.assertEqual(snapshot.windows[0].role, "session")
        self.assertIsNone(snapshot.windows[1].used_percent)
        self.assertIsNone(snapshot.windows[0].resets_at)

    def test_network_refresh_is_not_classified_as_revoked(self):
        from providers.base import ProviderError
        from providers.claude import ClaudeProvider
        from providers.http_client import HttpResponse

        self.store.write({"refresh_token": "old"})

        class Upstream:
            def request(self, *args, **kwargs):
                return HttpResponse(503, {})

        provider = ClaudeProvider(self.store, http=Upstream())
        with self.assertRaises(ProviderError) as error:
            provider.fetch_usage()
        self.assertEqual(error.exception.status, "error")
        self.assertTrue(provider.connected())

    def test_unauthorized_usage_refreshes_and_retries_once(self):
        from providers.claude import ClaudeProvider
        from providers.http_client import HttpResponse

        self.store.write(
            {"refresh_token": "old", "access_token": "old", "expires_at": 99999}
        )

        class Upstream:
            calls = 0

            def request(self, url, method="GET", body=None, headers=None):
                if "oauth/token" in url:
                    return HttpResponse(
                        200,
                        {
                            "access_token": "fresh",
                            "refresh_token": "new",
                            "expires_in": 3600,
                        },
                    )
                self.calls += 1
                return (
                    HttpResponse(401, {})
                    if self.calls == 1
                    else HttpResponse(200, {"five_hour": {"utilization": 0}})
                )

        http = Upstream()
        self.assertEqual(
            ClaudeProvider(self.store, http=http, clock=lambda: 1000)
            .fetch_usage()
            .windows[0]
            .used_percent,
            0,
        )
        self.assertEqual(http.calls, 2)

    def test_invalid_token_lifetime_still_persists_rotated_refresh_token(self):
        from providers.claude import ClaudeProvider
        from providers.http_client import HttpResponse

        self.store.write({"refresh_token": "old"})

        class Upstream:
            def request(self, url, *args, **kwargs):
                if "oauth/token" not in url:
                    return HttpResponse(200, {"five_hour": {"utilization": 22}})
                return HttpResponse(
                    200,
                    {
                        "access_token": "new",
                        "refresh_token": "new",
                        "expires_in": float("nan"),
                    },
                )

        ClaudeProvider(self.store, http=Upstream(), clock=lambda: 1000).fetch_usage()
        self.assertEqual(self.store.read()["refresh_token"], "new")
        self.assertEqual(self.store.read()["expires_at"], 1000)


if __name__ == "__main__":
    unittest.main()
