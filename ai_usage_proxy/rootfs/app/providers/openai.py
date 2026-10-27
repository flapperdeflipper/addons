"""OpenAI/Codex subscription usage with Codex-owned managed authentication."""

import time
from collections.abc import Callable
from typing import Any
from urllib.parse import quote, urlparse

from models import UsageSnapshot, UsageWindow, percentage_used
from storage import CredentialStore, private_directory

from providers.base import AuthView, Provider, ProviderError
from providers.codex_client import CodexClient
from providers.http_client import epoch_seconds

DEVICE_FLOW_MAX_AGE = 900


class OpenAIProvider(Provider):
    id = "openai"
    name = "OpenAI / Codex"
    auth_kind = "device_code"

    def __init__(
        self,
        store: CredentialStore,
        *,
        client: Any = None,
        clock: Callable[[], float] = time.time,
    ) -> None:
        super().__init__(store)
        self.state_dir = private_directory(store.directory / "codex")
        self.client = client or CodexClient(self.state_dir)
        self.clock = clock
        self.login_id = ""
        self.login_started = 0.0
        self._authenticated = False

    def connected(self) -> bool:
        return self._authenticated or (self.state_dir / "auth.json").is_file()

    def start_auth(self) -> AuthView:
        self.cancel_auth()
        result = self.client.request(
            "account/login/start", {"type": "chatgptDeviceCode"}
        )
        login_id = result.get("loginId")
        url = result.get("verificationUrl")
        code = result.get("userCode")
        if (
            not isinstance(login_id, str)
            or not login_id
            or not isinstance(url, str)
            or not isinstance(code, str)
        ):
            raise ProviderError(
                "OpenAI did not return device login details", "unsupported"
            )
        parsed = urlparse(url)
        if parsed.scheme != "https" or parsed.hostname not in (
            "auth.openai.com",
            "chatgpt.com",
        ):
            raise ProviderError(
                "OpenAI returned an unsupported verification URL", "unsupported"
            )
        self.login_id = login_id
        self.login_started = self.clock()
        return AuthView(
            self.auth_kind, url, code, int(self.login_started + DEVICE_FLOW_MAX_AGE)
        )

    def check_auth(self) -> bool:
        if not self.login_id:
            return False
        if self.clock() - self.login_started >= DEVICE_FLOW_MAX_AGE:
            self.cancel_auth()
            raise ProviderError("OpenAI device code expired; connect again")
        for notification in self.client.pop_notifications():
            params = notification.get("params")
            if not isinstance(params, dict):
                continue
            if (
                notification.get("method") != "account/login/completed"
                or params.get("loginId") != self.login_id
            ):
                continue
            self.login_id = ""
            if params.get("success") is not True:
                raise ProviderError(
                    "OpenAI sign-in was not completed; connect again", "auth_required"
                )
            self._authenticated = True
            return True
        if hasattr(self.client, "is_running") and not self.client.is_running():
            self.login_id = ""
            self.login_started = 0
            self.client.close()
            raise ProviderError("OpenAI sign-in service stopped; connect again")
        return False

    def cancel_auth(self) -> None:
        login_id, self.login_id = self.login_id, ""
        if login_id:
            self.client.request("account/login/cancel", {"loginId": login_id})
        self.login_started = 0

    def disconnect(self) -> None:
        try:
            self.cancel_auth()
            if self.connected():
                self.client.request("account/logout")
        except ProviderError:
            # Disconnection always removes local access, even when the child is unavailable.
            pass
        finally:
            self.client.close()
            (self.state_dir / "auth.json").unlink(missing_ok=True)
            self.store.clear()
            self._authenticated = False

    @staticmethod
    def _duration(value: Any) -> int | None:
        if value is None:
            return None
        if isinstance(value, bool) or not isinstance(value, int) or value <= 0:
            raise ValueError("Invalid window duration")
        return value * 60

    def fetch_usage(self) -> UsageSnapshot:
        account_result = self.client.request("account/read")
        account = account_result.get("account")
        if not isinstance(account, dict) or account.get("type") != "chatgpt":
            self._authenticated = False
            raise ProviderError(
                "Connect your OpenAI subscription to start monitoring", "auth_required"
            )
        self._authenticated = True
        result = self.client.request("account/rateLimits/read")
        buckets = result.get("rateLimitsByLimitId")
        if not isinstance(buckets, dict) or not buckets:
            bucket = result.get("rateLimits")
            if not isinstance(bucket, dict):
                raise ProviderError(
                    "OpenAI returned no subscription usage", "unsupported"
                )
            buckets = {bucket.get("limitId") or "codex": bucket}
        windows = []
        plan = account.get("planType")
        try:
            for bucket_id, bucket in buckets.items():
                if not isinstance(bucket_id, str) or not isinstance(bucket, dict):
                    raise TypeError()
                safe_id = quote(bucket_id, safe="")
                labels = bucket.get("limitName") or bucket_id
                if not isinstance(labels, str):
                    raise TypeError()
                entries = []
                for slot in ("primary", "secondary"):
                    value = bucket.get(slot)
                    if value is None:
                        continue
                    if not isinstance(value, dict) or "usedPercent" not in value:
                        raise ValueError()
                    duration = self._duration(value.get("windowDurationMins"))
                    entries.append((slot, value, duration))
                short = [
                    (duration, slot)
                    for slot, _, duration in entries
                    if duration is not None and duration < 604800
                ]
                short_slot = min(short)[1] if short else None
                for slot, value, duration in entries:
                    role = "other"
                    if bucket_id == "codex":
                        if duration == 604800:
                            role = "week"
                        elif slot == short_slot:
                            role = "session"
                    if duration == 604800:
                        label = "Weekly"
                    elif duration and duration % 3600 == 0:
                        label = f"{duration // 3600}-hour"
                    elif duration:
                        label = f"{duration // 60}-minute"
                    else:
                        label = slot.capitalize() + " window"
                    if bucket_id != "codex":
                        label = labels[:80] + " · " + label
                    windows.append(
                        UsageWindow(
                            f"{safe_id}_{slot}",
                            label,
                            percentage_used(value["usedPercent"]),
                            duration,
                            epoch_seconds(value.get("resetsAt")),
                            bucket_id,
                            role,
                        )
                    )
                individual = bucket.get("individualLimit")
                if individual is not None:
                    if (
                        not isinstance(individual, dict)
                        or "remainingPercent" not in individual
                    ):
                        raise ValueError()
                    windows.append(
                        UsageWindow(
                            f"{safe_id}_individual",
                            "Individual allowance",
                            percentage_used(
                                individual["remainingPercent"], remaining=True
                            ),
                            None,
                            epoch_seconds(individual.get("resetsAt")),
                            bucket_id,
                        )
                    )
                if bucket_id == "codex" and isinstance(bucket.get("planType"), str):
                    plan = bucket["planType"]
        except (ValueError, TypeError, OverflowError):
            raise ProviderError(
                "OpenAI returned unsupported quota values", "unsupported"
            ) from None
        if not windows:
            raise ProviderError(
                "OpenAI returned no subscription usage windows", "unsupported"
            )
        email = account.get("email")
        return UsageSnapshot(
            self.id,
            int(self.clock()),
            tuple(windows),
            plan if isinstance(plan, str) else None,
            email if isinstance(email, str) else None,
        )

    def close(self) -> None:
        self.client.close()
