"""Small adapter contract; authentication stays provider-owned."""

from abc import ABC, abstractmethod
from dataclasses import dataclass
from typing import Any

from models import UsageSnapshot
from storage import CredentialStore


class ProviderError(Exception):
    """Safe user-visible error; never include an upstream response or credential."""

    def __init__(
        self, message: str, status: str = "error", retry_after: float = 0
    ) -> None:
        super().__init__(message)
        self.status = status
        self.retry_after = retry_after


@dataclass(frozen=True)
class AuthView:
    kind: str
    url: str = ""
    code: str = ""
    expires_at: int | None = None

    def public(self) -> dict[str, Any]:
        return {
            "kind": self.kind,
            "url": self.url,
            "code": self.code,
            "expires_at": self.expires_at,
        }


class Provider(ABC):
    id: str
    name: str
    auth_kind: str

    def __init__(self, store: CredentialStore) -> None:
        self.store = store

    @abstractmethod
    def fetch_usage(self) -> UsageSnapshot:
        """Fetch authoritative usage with used_percent semantics."""

    @abstractmethod
    def connected(self) -> bool:
        """Whether established credentials exist (not necessarily still valid)."""

    def start_auth(self) -> AuthView:
        return AuthView(self.auth_kind)

    def complete_auth(self, value: str) -> None:
        raise ProviderError("This connection does not accept an authorization code")

    def save_key(self, value: str) -> None:
        raise ProviderError("This connection does not use an API key")

    def check_auth(self) -> bool:
        """Check a pending device login without blocking. True means complete."""
        return False

    def cancel_auth(self) -> None:
        pass

    def disconnect(self) -> None:
        self.cancel_auth()
        self.store.clear()

    def close(self) -> None:
        pass
