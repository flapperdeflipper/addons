"""Optional real-browser acceptance: python test/browser_dashboard.py.

Requires playwright and its Chromium browser; uses only local fake providers.
"""

import sys
import tempfile
import threading
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "rootfs/app"))
from models import UsageSnapshot, UsageWindow
from providers.base import AuthView, ProviderError
from service import UsageService
from test_service import FakeProvider
from web import make_server


class PreviewProvider(FakeProvider):
    def fetch_usage(self):
        if self.failure:
            raise self.failure
        return UsageSnapshot(
            self.id,
            int(time.time()),
            (
                UsageWindow(
                    "short",
                    "5-hour",
                    22,
                    18000,
                    int(time.time()) + 7200,
                    role="session",
                ),
                UsageWindow(
                    "weekly",
                    "Weekly",
                    67,
                    604800,
                    int(time.time()) + 172800,
                    role="week",
                ),
            ),
            "Personal plan",
            "display@example.test",
        )

    def start_auth(self):
        return AuthView(self.auth_kind, "https://example.com/authorize", "ABCD-1234")

    def check_auth(self):
        if getattr(self, "approved", False):
            self.has_token = True
            return True
        return False

    def save_key(self, value):
        if value != "valid-test-key":
            raise ProviderError("Replacement key rejected", "auth_required")
        self.store.write({"api_key": value})
        self.has_token = True


def main():
    from playwright.sync_api import expect, sync_playwright

    with tempfile.TemporaryDirectory() as tmp:
        providers = {
            key: PreviewProvider(Path(tmp), key) for key in ("claude", "openai", "zai")
        }
        for key, name, kind in (
            ("claude", "Claude", "authorization_code"),
            ("openai", "OpenAI / Codex", "device_code"),
            ("zai", "z.ai", "api_key"),
        ):
            providers[key].name, providers[key].auth_kind = name, kind
        providers["claude"].has_token = True
        service = UsageService(providers)

        class Publisher:
            def public(self):
                return {
                    "connected": True,
                    "source": "Test broker",
                    "topic_root": "ai/usage",
                    "discovery": True,
                    "poll_interval": 60,
                }

        server = make_server(service, Publisher(), ("127.0.0.1", 0), ("127.0.0.1",))
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        service.start()
        try:
            with sync_playwright() as playwright:
                browser = playwright.chromium.launch()
                page = browser.new_page(viewport={"width": 1380, "height": 1000})
                failures = []
                page.on("pageerror", lambda error: failures.append(str(error)))
                page.goto(f"http://127.0.0.1:{server.server_port}/")
                expect(page.locator(".card")).to_have_count(3)
                claude, openai, zai = [page.locator(".card").nth(n) for n in range(3)]
                expect(claude.locator(".metric-value").first).to_contain_text("22%")
                expect(claude.locator(".metric-value").first).to_contain_text("used")
                openai.get_by_role("button", name="Connect", exact=True).click()
                expect(openai.locator(".device-code")).to_have_text("ABCD-1234")
                zai.get_by_role("button", name="Connect", exact=True).click()
                field = zai.get_by_label("Coding Plan API key")
                expect(field).to_have_attribute("type", "password")
                field.fill("partially typed key")
                page.evaluate("update()")
                expect(field).to_have_value("partially typed key")
                field.fill("wrong-key")
                zai.get_by_role("button", name="Save and test").click()
                expect(zai.locator(".form-error")).to_contain_text(
                    "Replacement key rejected"
                )
                expect(field).to_be_visible()
                field.fill("valid-test-key")
                zai.get_by_role("button", name="Save and test").click()
                expect(zai.locator(".badge")).to_have_text("Connected")
                providers["openai"].approved = True
                expect(openai.locator(".badge")).to_have_text("Connected")
                claude.get_by_role("button", name="Manage connection").click()
                claude.get_by_role("button", name="Reconnect", exact=True).click()
                code = claude.get_by_role("textbox", name="Claude authorization code")
                expect(code).to_be_visible()
                code.fill("partially-pasted")
                providers["claude"].failure = ProviderError(
                    "Authorization revoked", "auth_required"
                )
                service.action("claude", "refresh")
                expect(claude.locator(".badge")).to_have_text("Reconnect")
                page.evaluate("update()")
                expect(code).to_have_value("partially-pasted")
                providers["claude"].failure = None
                code.fill("code#state")
                claude.get_by_role("button", name="Connect Claude", exact=True).click()
                expect(claude.locator(".panel textarea")).to_have_count(0)
                page.screenshot(
                    path="/private/tmp/ai-usage-dashboard-desktop.png", full_page=True
                )
                page.set_viewport_size({"width": 390, "height": 844})
                expect(page.locator(".card")).to_have_count(3)
                assert page.evaluate(
                    "document.documentElement.scrollWidth <= innerWidth"
                )
                page.screenshot(
                    path="/private/tmp/ai-usage-dashboard-mobile.png", full_page=True
                )
                assert not failures, failures
                browser.close()
                print(
                    "Browser acceptance passed: used values, all 3 connection flows, rejected key recovery, form persistence, responsive layout, no JS errors."
                )
        finally:
            server.shutdown()
            server.server_close()
            service.close()
            thread.join(timeout=3)


if __name__ == "__main__":
    main()
