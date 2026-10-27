"""z.ai monitoring using the first-party Coding Plan usage endpoint.

Only first-party-confirmed legacy quota types are mapped to named windows.
Unverified credit encodings are deliberately not guessed.
"""

import time
from collections.abc import Callable
from typing import Any

from models import UsageSnapshot, UsageWindow, percentage_used
from storage import CredentialStore

from providers.base import Provider, ProviderError
from providers.http_client import HttpClient, require_success

USAGE_URL = "https://api.z.ai/api/monitor/usage/quota/limit"


class ZaiProvider(Provider):
    id = "zai"
    name = "z.ai"
    auth_kind = "api_key"

    def __init__(
        self,
        store: CredentialStore,
        *,
        http: Any = None,
        clock: Callable[[], float] = time.time,
    ) -> None:
        super().__init__(store)
        self.http = http or HttpClient()
        self.clock = clock

    def connected(self) -> bool:
        return bool(self.store.read().get("api_key"))

    def _read(self, key: str) -> dict[str, Any]:
        response = self.http.request(
            USAGE_URL, headers={"Authorization": key, "Accept-Language": "en-US,en"}
        )
        data = require_success(response, "z.ai")
        code = data.get("code")
        if (
            data.get("success") is False
            or data.get("error")
            or isinstance(code, bool)
            or code not in (None, 0, 200, "0", "200")
        ):
            if code in (401, 403, "401", "403", 1000, "1000", 1001, "1001"):
                raise ProviderError(
                    "z.ai key rejected; replace the Coding Plan key", "auth_required"
                )
            raise ProviderError(
                "z.ai could not return subscription usage; check your Coding Plan"
            )
        payload = data.get("data", data)
        if not isinstance(payload, dict):
            raise ProviderError(
                "z.ai returned an unsupported quota response", "unsupported"
            )
        explicit_success = data.get("success") is True or code in (0, 200, "0", "200")
        if not explicit_success:
            # Envelope-free responses establish acceptance only when they follow a
            # verified quota shape. Arbitrary HTTP 200 objects cannot replace a key.
            try:
                self._normalize(payload)
            except ProviderError:
                raise ProviderError(
                    "z.ai did not confirm an authorized quota response",
                    "unsupported",
                ) from None
        return payload

    def _normalize(self, payload: dict[str, Any]) -> UsageSnapshot:
        limits = payload.get("limits")
        if not isinstance(limits, list) or not limits:
            raise ProviderError(
                "z.ai did not return active subscription quotas", "unsupported"
            )
        windows = []
        seen: set[str] = set()
        supported = {
            "TOKENS_LIMIT": ("tokens", "5-hour", 18000, "session"),
            "TIME_LIMIT": ("mcp", "Monthly MCP", None, "other"),
        }
        try:
            for item in limits:
                if not isinstance(item, dict) or item.get("type") not in supported:
                    raise ValueError()
                window_id, label, duration, role = supported[item["type"]]
                if window_id in seen:
                    # Multiple token limits may encode new windows: do not collapse or mislabel.
                    raise ValueError()
                seen.add(window_id)
                windows.append(
                    UsageWindow(
                        window_id,
                        label,
                        percentage_used(item.get("percentage")),
                        duration,
                        None,
                        "default",
                        role,
                    )
                )
        except (TypeError, ValueError):
            raise ProviderError(
                "Connected; z.ai usage format needs a verified quota mapping",
                "unsupported",
            ) from None
        return UsageSnapshot(self.id, int(self.clock()), tuple(windows))

    def save_key(self, value: str) -> None:
        key = value.strip()
        if (
            not key
            or len(key) > 8192
            or any(char in key for char in "\r\n")
            or key.startswith("!secret ")
        ):
            raise ProviderError("Enter a valid Coding Plan API key")
        payload = self._read(key)
        # A successful auth response may use a newer, as-yet-unsupported quota schema.
        # Save accepted credentials, then report that schema separately to the UI.
        self.store.write({"api_key": key})
        self._normalize(payload)

    def fetch_usage(self) -> UsageSnapshot:
        key = self.store.read().get("api_key")
        if not isinstance(key, str) or not key:
            raise ProviderError(
                "Connect a z.ai Coding Plan key to start monitoring", "auth_required"
            )
        return self._normalize(self._read(key))
