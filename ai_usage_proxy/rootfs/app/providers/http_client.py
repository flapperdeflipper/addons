"""Bounded JSON HTTP with credential-safe errors and no cross-host redirects."""

import json
import math
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from datetime import UTC, datetime
from email.utils import parsedate_to_datetime
from typing import Any

from providers.base import ProviderError


@dataclass(frozen=True)
class HttpResponse:
    status: int
    data: Any
    retry_after: float = 0


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(
        self, req: Any, fp: Any, code: int, msg: str, headers: Any, newurl: str
    ) -> None:
        return None


def retry_seconds(value: str | None) -> float:
    if not value:
        return 0
    try:
        seconds = float(value)
    except ValueError:
        try:
            seconds = parsedate_to_datetime(value).timestamp() - time.time()
        except (TypeError, ValueError, OverflowError):
            return 0
    return max(0, min(seconds, 86400)) if math.isfinite(seconds) else 0


class HttpClient:
    def __init__(self, timeout: float = 30, max_bytes: int = 2 * 1024 * 1024) -> None:
        self.timeout = timeout
        self.max_bytes = max_bytes
        self.opener = urllib.request.build_opener(NoRedirect())

    def request(
        self,
        url: str,
        method: str = "GET",
        body: Any = None,
        headers: dict[str, str] | None = None,
    ) -> HttpResponse:
        data = json.dumps(body).encode() if body is not None else None
        h = {"User-Agent": "ai-usage-proxy/2.0", "Accept": "application/json"}
        if body is not None:
            h["Content-Type"] = "application/json"
        h.update(headers or {})
        request = urllib.request.Request(url, data=data, headers=h, method=method)
        try:
            response = self.opener.open(request, timeout=self.timeout)
        except urllib.error.HTTPError as error:
            response = error
        except (OSError, ValueError, urllib.error.URLError):
            raise ProviderError(
                "Cannot reach the provider; retrying automatically"
            ) from None
        with response:
            payload = response.read(self.max_bytes + 1)
            if len(payload) > self.max_bytes:
                raise ProviderError("Provider response is too large", "unsupported")
            try:
                parsed = json.loads(payload or b"{}")
            except (json.JSONDecodeError, UnicodeDecodeError):
                if response.code >= 400:
                    parsed = {}
                else:
                    raise ProviderError(
                        "Provider returned invalid JSON", "unsupported"
                    ) from None
            return HttpResponse(
                response.code,
                parsed,
                retry_seconds(response.headers.get("Retry-After")),
            )


def require_success(response: HttpResponse, label: str) -> dict[str, Any]:
    if response.status in (401, 403):
        raise ProviderError(
            f"{label} authorization rejected; reconnect", "auth_required"
        )
    if response.status == 429:
        raise ProviderError(
            f"{label} updates paused by rate limiting",
            "rate_limited",
            response.retry_after or 300,
        )
    if response.status < 200 or response.status >= 300:
        raise ProviderError(
            f"{label} request failed (HTTP {response.status}); retrying"
        )
    if not isinstance(response.data, dict):
        raise ProviderError(f"{label} returned an unsupported response", "unsupported")
    return response.data


def epoch_seconds(value: Any) -> int | None:
    """Accept documented epoch seconds or timezone-qualified ISO timestamps only."""
    if value is None or value == "":
        return None
    if isinstance(value, bool):
        raise TypeError("Invalid reset timestamp")
    if isinstance(value, (int, float)):
        if not math.isfinite(value) or value <= 0 or value > 100_000_000_000:
            raise ValueError("Invalid reset timestamp")
        return int(value)
    if isinstance(value, str):
        stamp = datetime.fromisoformat(value)
        if stamp.tzinfo is None:
            raise ValueError("Reset timestamp requires timezone")
        return int(stamp.astimezone(UTC).timestamp())
    raise ValueError("Invalid reset timestamp")
