"""Connection flows and independent scheduling through real service state."""

import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "rootfs/app"))
from models import UsageSnapshot, UsageWindow
from providers.base import AuthView, Provider, ProviderError
from storage import CredentialStore


class FakeProvider(Provider):
    name = "Test"
    auth_kind = "authorization_code"

    def __init__(self, root, provider_id):
        super().__init__(CredentialStore(root, provider_id))
        self.id = provider_id
        self.has_token = False
        self.reads = 0
        self.failure = None
        self.block = None

    def connected(self):
        return self.has_token

    def fetch_usage(self):
        if self.block:
            self.block.wait(2)
        self.reads += 1
        if self.failure:
            raise self.failure
        return UsageSnapshot(
            self.id,
            int(time.time()),
            (UsageWindow("short", "5-hour", 22, 18000, role="session"),),
        )

    def start_auth(self):
        return AuthView(self.auth_kind, "https://example.com/authorize")

    def complete_auth(self, value):
        if value != "code#state":
            raise ProviderError("Invalid code")
        self.has_token = True

    def disconnect(self):
        self.has_token = False


class ServiceTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.providers = {
            key: FakeProvider(Path(self.tmp.name), key) for key in ("claude", "openai")
        }
        from service import UsageService

        self.service = UsageService(self.providers, poll_interval=60)

    def tearDown(self):
        self.service.close()
        self.tmp.cleanup()

    def test_provider_flow_isolation_and_late_code_rejection(self):
        claude_flow = self.service.action("claude", "connect")["flow_id"]
        openai_flow = self.service.action("openai", "connect")["flow_id"]
        self.service.tick("claude")
        self.service.tick("openai")
        self.assertNotEqual(claude_flow, openai_flow)
        with self.assertRaises(ProviderError):
            self.service.action("openai", "complete", "code#state", claude_flow)
        self.service.action("claude", "cancel", flow_id=claude_flow)
        self.service.tick("claude")
        with self.assertRaises(ProviderError):
            self.service.action("claude", "complete", "code#state", claude_flow)
        self.assertFalse(self.providers["claude"].has_token)

    def test_authentication_then_reading_and_no_secret_in_status(self):
        flow = self.service.action("claude", "connect")["flow_id"]
        self.service.tick("claude")
        self.service.action("claude", "complete", "code#state", flow)
        self.service.tick("claude")
        state = self.service.view("claude")
        self.assertEqual(state["connection"], "connected")
        self.assertEqual(state["snapshot"]["windows"][0]["used_percent"], 22)
        self.assertNotIn("code#state", str(state))
        self.assertNotIn("https://example.com/authorize", str(state))

    def test_refresh_bypasses_interval_but_not_backoff(self):
        p = self.providers["claude"]
        p.has_token = True
        self.service.tick("claude")
        self.service.action("claude", "refresh")
        self.service.tick("claude")
        self.assertEqual(p.reads, 2)
        p.failure = ProviderError("Wait", "rate_limited", retry_after=300)
        self.service.action("claude", "refresh")
        self.service.tick("claude")
        self.service.action("claude", "refresh")
        self.service.tick("claude")
        self.assertEqual(p.reads, 3)
        state = self.service.view("claude")
        self.assertEqual(state["status"], "rate_limited")
        self.assertEqual(state["snapshot"]["windows"][0]["used_percent"], 22)

    def test_blocked_provider_does_not_delay_another(self):
        self.providers["claude"].block = threading.Event()
        for p in self.providers.values():
            p.has_token = True
        self.service.start()
        deadline = time.monotonic() + 1
        while not self.providers["openai"].reads and time.monotonic() < deadline:
            time.sleep(0.01)
        self.assertGreater(self.providers["openai"].reads, 0)
        self.providers["claude"].block.set()

    def test_failed_key_submission_keeps_form_and_existing_reading(self):
        provider = self.providers["claude"]
        provider.auth_kind = "api_key"
        provider.has_token = True
        self.service.tick("claude")
        flow = self.service.action("claude", "connect")["flow_id"]
        self.service.tick("claude")

        def reject(value):
            raise ProviderError("Replacement could not be verified", "unsupported")

        provider.save_key = reject
        self.service.action("claude", "credentials", "rejected", flow)
        self.service.tick("claude")
        state = self.service.view("claude")
        self.assertEqual(state["flow_id"], flow)
        self.assertTrue(state["flow_ready"])
        self.assertIsNotNone(state["snapshot"])

    def test_failed_login_start_can_be_retried(self):
        def reject():
            raise ProviderError("Device login unavailable")

        self.providers["openai"].start_auth = reject
        self.service.action("openai", "connect")
        self.service.tick("openai")
        self.assertEqual(self.service.view("openai")["flow_id"], "")

    def test_auth_error_remains_visible_when_existing_connection_poll_succeeds(self):
        provider = self.providers["claude"]
        provider.auth_kind = "api_key"
        provider.has_token = True
        flow = self.service.action("claude", "connect")["flow_id"]
        self.service.tick("claude")

        def reject(value):
            raise ProviderError("Replacement key rejected", "auth_required")

        provider.save_key = reject
        self.service.action("claude", "credentials", "wrong", flow)
        self.service.action("claude", "refresh")
        self.service.tick("claude")
        self.assertEqual(
            self.service.view("claude")["auth_message"], "Replacement key rejected"
        )

    def test_stale_key_form_cannot_complete_a_newer_flow(self):
        self.providers["claude"].auth_kind = "api_key"
        old_flow = self.service.action("claude", "connect")["flow_id"]
        self.service.tick("claude")
        self.service.action("claude", "cancel", flow_id=old_flow)
        self.service.tick("claude")
        new_flow = self.service.action("claude", "connect")["flow_id"]
        self.service.tick("claude")
        self.assertNotEqual(old_flow, new_flow)
        with self.assertRaises(ProviderError):
            self.service.action("claude", "credentials", "old-tab-key", old_flow)

    def test_expired_flow_ends_even_if_provider_cancel_fails(self):
        flow = self.service.action("openai", "connect")["flow_id"]
        self.service.tick("openai")
        self.service.states["openai"].flow_started -= 901

        def fail_cancel():
            raise ProviderError("Account service unavailable")

        self.providers["openai"].cancel_auth = fail_cancel
        self.service.tick("openai")
        self.assertNotEqual(self.service.view("openai")["flow_id"], flow)
        self.assertFalse(self.service.view("openai")["flow_ready"])

    def test_rejected_credentials_are_retried_without_reconnect(self):
        provider = self.providers["claude"]
        provider.has_token = True
        provider.failure = ProviderError("Token rejected", "auth_required")
        self.service.tick("claude")
        self.assertEqual(
            self.service.view("claude")["connection"], "reconnect_required"
        )
        self.service.tick("claude")
        self.assertEqual(provider.reads, 1)
        provider.failure = None
        self.service.states["claude"].retry_at = 0
        self.service.states["claude"].next_poll = 0
        self.service.tick("claude")
        self.assertEqual(provider.reads, 2)
        state = self.service.view("claude")
        self.assertEqual(state["connection"], "connected")
        self.assertEqual(state["status"], "ok")

    def test_failed_reconnect_keeps_working_connection_status(self):
        provider = self.providers["claude"]
        provider.has_token = True
        self.service.tick("claude")
        flow = self.service.action("claude", "connect")["flow_id"]
        self.service.tick("claude")

        def limited(value):
            raise ProviderError("Slow down", "rate_limited", retry_after=300)

        provider.complete_auth = limited
        self.service.action("claude", "complete", "code#wrong", flow)
        self.service.tick("claude")
        state = self.service.view("claude")
        self.assertEqual(state["status"], "ok")
        self.assertEqual(state["message"], "Connected")
        self.assertIsNone(state["retry_at"])
        self.assertEqual(state["auth_message"], "Slow down")

    def test_unexpected_login_start_failure_ends_flow(self):
        def crash():
            raise RuntimeError("boom")

        self.providers["openai"].start_auth = crash
        self.service.action("openai", "connect")
        self.service.tick("openai")
        self.assertEqual(self.service.view("openai")["flow_id"], "")

    def test_rate_limited_round_with_reading_confirms_current(self):
        provider = self.providers["claude"]
        provider.has_token = True
        self.service.tick("claude")
        provider.failure = ProviderError("Wait", "rate_limited", retry_after=300)
        self.service.action("claude", "refresh")
        self.service.tick("claude")
        state = self.service.view("claude")
        self.assertEqual(state["status"], "rate_limited")
        self.assertIsNotNone(state["snapshot"])
        self.assertIsNotNone(state["confirmed_at"])
        self.assertTrue(state["available"])

    def test_staleness_keys_on_confirmation_not_fetch(self):
        provider = self.providers["claude"]
        provider.has_token = True
        self.service.tick("claude")
        provider.failure = ProviderError("Wait", "rate_limited", retry_after=300)
        self.service.action("claude", "refresh")
        self.service.tick("claude")
        # A throttled round just confirmed the reading: not stale yet.
        self.assertFalse(self.service.view("claude")["stale"])
        # Three poll intervals without any confirmation flip it stale; a
        # non-ok status (here rate_limited) stays visible, only ok -> stale.
        self.service.states["claude"].confirmed -= 4 * self.service.poll_interval
        state = self.service.view("claude")
        self.assertEqual(state["status"], "rate_limited")
        self.assertTrue(state["stale"])
        self.assertFalse(state["available"])

    def test_failed_round_does_not_confirm_reading(self):
        provider = self.providers["claude"]
        provider.has_token = True
        self.service.tick("claude")
        confirmed_before = self.service.states["claude"].confirmed
        provider.failure = ProviderError("Cannot reach the provider; retrying")
        self.service.action("claude", "refresh")
        self.service.tick("claude")
        self.assertEqual(self.service.states["claude"].confirmed, confirmed_before)

    def test_rate_limited_backoff_capped_for_confirmed_readings(self):
        provider = self.providers["claude"]
        provider.has_token = True
        self.service.tick("claude")
        provider.failure = ProviderError("Wait", "rate_limited", retry_after=3600)
        self.service.action("claude", "refresh")
        self.service.tick("claude")
        expected = time.monotonic() + 600
        retry_at = self.service.states["claude"].retry_at
        self.assertLess(abs(retry_at - expected), 5)

    def test_disconnect_clears_snapshot(self):
        self.providers["claude"].has_token = True
        self.service.tick("claude")
        self.service.action("claude", "disconnect")
        self.service.tick("claude")
        self.assertIsNone(self.service.view("claude")["snapshot"])
        self.assertEqual(self.service.view("claude")["connection"], "disconnected")


if __name__ == "__main__":
    unittest.main()
