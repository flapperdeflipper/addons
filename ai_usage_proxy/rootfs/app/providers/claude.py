"""Claude subscription usage and the existing code-plus-state OAuth flow."""

import base64
import hashlib
import math
import secrets
import time
from collections.abc import Callable
from typing import Any
from urllib.parse import urlencode

from models import UsageSnapshot, UsageWindow, percentage_used
from storage import CredentialStore

from providers.base import AuthView, Provider, ProviderError
from providers.http_client import (
    HttpClient,
    HttpResponse,
    epoch_seconds,
    require_success,
)

CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e"
AUTHORIZE_URL = "https://claude.ai/oauth/authorize"
TOKEN_URLS = (
    "https://platform.claude.com/v1/oauth/token",
    "https://console.anthropic.com/v1/oauth/token",
)
REDIRECT_URI = "https://console.anthropic.com/oauth/code/callback"
USAGE_URL = "https://api.anthropic.com/api/oauth/usage"
PKCE_MAX_AGE = 900


class ClaudeProvider(Provider):
    id = "claude"
    name = "Claude"
    auth_kind = "authorization_code"

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
        self.pending_verifier = ""
        self.pending_created = 0.0
        store.migrate_claude()

    def connected(self) -> bool:
        return bool(self.store.read().get("refresh_token"))

    def start_auth(self) -> AuthView:
        now = self.clock()
        if not self.pending_verifier or now - self.pending_created >= PKCE_MAX_AGE:
            self.pending_verifier = (
                base64.urlsafe_b64encode(secrets.token_bytes(32)).rstrip(b"=").decode()
            )
            self.pending_created = now
        verifier = self.pending_verifier
        challenge = (
            base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest())
            .rstrip(b"=")
            .decode()
        )
        params = {
            "code": "true",
            "client_id": CLIENT_ID,
            "response_type": "code",
            "redirect_uri": REDIRECT_URI,
            "scope": "org:create_api_key user:profile user:inference",
            "code_challenge": challenge,
            "code_challenge_method": "S256",
            "state": verifier,
        }
        return AuthView(
            self.auth_kind,
            AUTHORIZE_URL + "?" + urlencode(params),
            expires_at=int(self.pending_created + PKCE_MAX_AGE),
        )

    def _token_request(self, body: dict[str, Any]) -> dict[str, Any]:
        last_error: ProviderError | None = None
        for url in TOKEN_URLS:
            try:
                response = self.http.request(url, "POST", body=body)
            except ProviderError as error:
                last_error = error
                continue
            # HTTP fallback only when the first endpoint is unavailable, not on revoked tokens.
            if response.status in (404, 502, 503, 504) and url != TOKEN_URLS[-1]:
                continue
            if response.status == 400:
                raise ProviderError(
                    "Claude authorization expired or rejected; reconnect",
                    "auth_required",
                )
            return require_success(response, "Claude")
        raise last_error or ProviderError("Claude token service is unavailable")

    def _save_tokens(
        self, data: dict[str, Any], previous: dict[str, Any]
    ) -> dict[str, Any]:
        access = data.get("access_token")
        refresh = data.get("refresh_token", previous.get("refresh_token"))
        if (
            not isinstance(access, str)
            or not access
            or not isinstance(refresh, str)
            or not refresh
        ):
            raise ProviderError(
                "Claude returned an incomplete authorization", "unsupported"
            )
        try:
            expires_in = float(data.get("expires_in", 28800))
            if (
                not math.isfinite(expires_in)
                or expires_in <= 0
                or expires_in > 31_536_000
            ):
                raise ValueError()
        except (TypeError, ValueError):
            # Issuance may have invalidated the old refresh token already. Keep the new
            # lineage even if optional lifetime metadata is bad, and renew conservatively.
            expires_in = 0
        credentials = {
            "access_token": access,
            "refresh_token": refresh,
            "expires_at": self.clock() + expires_in,
        }
        self.store.write(credentials)
        return credentials

    def complete_auth(self, value: str) -> None:
        if not self.pending_verifier:
            raise ProviderError("Start a new Claude connection first")
        if self.clock() - self.pending_created >= PKCE_MAX_AGE:
            self.cancel_auth()
            raise ProviderError("Claude authorization link expired; start again")
        code, _, state = value.strip().partition("#")
        # The state is the verifier; a bare code (fragment lost on copy) is accepted.
        if not code or (
            state and not secrets.compare_digest(state, self.pending_verifier)
        ):
            raise ProviderError(
                "Claude code or state did not match; copy the full code#state"
            )
        state = state or self.pending_verifier
        data = self._token_request(
            {
                "grant_type": "authorization_code",
                "code": code,
                "state": state,
                "redirect_uri": REDIRECT_URI,
                "client_id": CLIENT_ID,
                "code_verifier": self.pending_verifier,
            }
        )
        self._save_tokens(data, {})
        self.cancel_auth()

    def cancel_auth(self) -> None:
        self.pending_verifier = ""
        self.pending_created = 0

    def _refresh(self, credentials: dict[str, Any]) -> dict[str, Any]:
        refresh = credentials.get("refresh_token")
        if not refresh:
            raise ProviderError("Connect Claude to start monitoring", "auth_required")
        data = self._token_request(
            {
                "grant_type": "refresh_token",
                "refresh_token": refresh,
                "client_id": CLIENT_ID,
            }
        )
        return self._save_tokens(data, credentials)

    def fetch_usage(self) -> UsageSnapshot:
        credentials = self.store.read()
        try:
            expires_at = float(credentials.get("expires_at", 0))
        except (TypeError, ValueError):
            expires_at = 0
        if not credentials.get("access_token") or self.clock() >= expires_at - 300:
            credentials = self._refresh(credentials)
        response: HttpResponse | None = None
        for attempt in range(2):
            response = self.http.request(
                USAGE_URL,
                headers={
                    "Authorization": "Bearer " + credentials["access_token"],
                    "anthropic-beta": "oauth-2025-04-20",
                },
            )
            if response.status != 401 or attempt == 1:
                break
            credentials = self._refresh(credentials)
        assert response is not None
        data = require_success(response, "Claude")
        windows = []
        descriptions = {
            "five_hour": ("5-hour", 18000, "session"),
            "seven_day": ("Weekly", 604800, "week"),
        }
        try:
            for key, (label, duration, role) in descriptions.items():
                item = data.get(key)
                if item is None:
                    continue
                if not isinstance(item, dict):
                    raise TypeError()
                windows.append(
                    UsageWindow(
                        key,
                        label,
                        percentage_used(item.get("utilization")),
                        duration,
                        epoch_seconds(item.get("resets_at")),
                        "default",
                        role,
                    )
                )
        except (TypeError, ValueError):
            raise ProviderError(
                "Claude returned unsupported usage values", "unsupported"
            ) from None
        if not windows:
            raise ProviderError(
                "Claude did not return subscription usage windows", "unsupported"
            )
        return UsageSnapshot(self.id, int(self.clock()), tuple(windows))
