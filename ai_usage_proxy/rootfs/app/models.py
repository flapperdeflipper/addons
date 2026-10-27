"""Values shared by provider adapters, the dashboard, and MQTT."""

import math
from dataclasses import asdict, dataclass
from typing import Any


def percentage_used(value: Any, *, remaining: bool = False) -> float | None:
    """Normalize a provider percentage to USED; preserve unknown and over-quota values."""
    if value is None:
        return None
    if isinstance(value, bool):
        raise ValueError("Invalid percentage")  # noqa: TRY004 - one invalid-value contract
    number = float(value)
    if not math.isfinite(number) or number < 0 or (remaining and number > 100):
        raise ValueError("Invalid percentage")
    return 100 - number if remaining else number


@dataclass(frozen=True)
class UsageWindow:
    id: str
    label: str
    used_percent: float | None
    duration_seconds: int | None = None
    resets_at: int | None = None
    bucket_id: str = "default"
    role: str = "other"


@dataclass(frozen=True)
class UsageSnapshot:
    provider_id: str
    fetched_at: int
    windows: tuple[UsageWindow, ...]
    plan: str | None = None
    account: str | None = None

    def public(self) -> dict[str, Any]:
        """Return only normalized account/usage information, never provider responses."""
        return asdict(self)
