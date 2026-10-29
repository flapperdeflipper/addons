"""Independent account connection and usage workers."""

import logging
import secrets
import threading
import time
from collections import deque
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any

from models import UsageSnapshot
from providers.base import AuthView, Provider, ProviderError

LOG = logging.getLogger(__name__)

# Rejected credentials are rechecked this often until reconnected (legacy DEAD_TOKEN_RETRY).
AUTH_RETRY = 600


@dataclass
class ProviderState:
    lock: Any = field(default_factory=threading.RLock)
    wake: threading.Event = field(default_factory=threading.Event)
    commands: deque = field(default_factory=deque)
    snapshot: UsageSnapshot | None = None
    status: str = "starting"
    message: str = "Checking connection"
    auth_message: str = ""
    connection: str = "disconnected"
    flow_id: str = ""
    flow: AuthView | None = None
    flow_started: float = 0
    busy: bool = False
    force: bool = True
    retry_at: float = 0
    next_poll: float = 0
    failures: int = 0
    confirmed: float = 0


class UsageService:
    """Serialize each provider's credentials while other providers remain independent."""

    def __init__(self, providers: dict[str, Provider], poll_interval: int = 60) -> None:
        self.providers = providers
        self.poll_interval = poll_interval
        self.states = {key: ProviderState() for key in providers}
        self.stop = threading.Event()
        self.threads: list[threading.Thread] = []
        self.listeners: list[Callable[[str], None]] = []

    def _state(self, provider_id: str) -> ProviderState:
        if provider_id not in self.states:
            raise ProviderError("Unknown provider")
        return self.states[provider_id]

    def _notify(self, provider_id: str) -> None:
        for listener in self.listeners:
            try:
                listener(provider_id)
            except Exception:  # noqa: BLE001 - isolate worker and publisher failures
                LOG.error("Could not publish %s state", provider_id)

    def view(self, provider_id: str) -> dict[str, Any]:
        state = self._state(provider_id)
        provider = self.providers[provider_id]
        with state.lock:
            stale = bool(
                state.snapshot
                and time.monotonic() - state.confirmed >= self.poll_interval * 3
            )
            status = "stale" if stale and state.status == "ok" else state.status
            confirmed_at = (
                int(time.time() - (time.monotonic() - state.confirmed))
                if state.snapshot
                else None
            )
            return {
                "id": provider_id,
                "name": provider.name,
                "auth_kind": provider.auth_kind,
                "connection": state.connection,
                "status": status,
                "message": state.message,
                "auth_message": state.auth_message,
                "snapshot": state.snapshot.public() if state.snapshot else None,
                "confirmed_at": confirmed_at,
                "available": bool(
                    state.snapshot and not stale and state.connection == "connected"
                ),
                "stale": stale,
                "busy": state.busy,
                "retry_at": int(time.time() + max(0, state.retry_at - time.monotonic()))
                if state.retry_at > time.monotonic()
                else None,
                "flow_id": state.flow_id,
                "flow_ready": state.flow is not None,
            }

    def views(self) -> list[dict[str, Any]]:
        return [self.view(key) for key in self.providers]

    def flow_view(self, provider_id: str, flow_id: str) -> dict[str, Any]:
        state = self._state(provider_id)
        with state.lock:
            if not flow_id or not secrets.compare_digest(state.flow_id, flow_id):
                raise ProviderError("This connection attempt has ended. Start again.")
            return {
                "flow_id": flow_id,
                **(state.flow.public() if state.flow else {"kind": "waiting"}),
            }

    def action(
        self, provider_id: str, action: str, value: str = "", flow_id: str = ""
    ) -> dict[str, Any]:
        state = self._state(provider_id)
        provider = self.providers[provider_id]
        allowed = {
            "connect",
            "complete",
            "credentials",
            "cancel",
            "disconnect",
            "refresh",
        }
        if action not in allowed:
            raise ProviderError("Unknown action")
        if action == "complete" and provider.auth_kind != "authorization_code":
            raise ProviderError("This provider does not accept an authorization code")
        if action == "credentials" and provider.auth_kind != "api_key":
            raise ProviderError("This provider does not accept an API key")
        with state.lock:
            if action == "refresh":
                if state.connection == "reconnect_required":
                    raise ProviderError(
                        "Reconnect this provider first", "auth_required"
                    )
                state.force = True
            elif action == "connect" and state.flow_id:
                return {"flow_id": state.flow_id}
            else:
                state.auth_message = ""
                if action in ("complete", "cancel", "credentials") and (
                    not flow_id or flow_id != state.flow_id
                ):
                    raise ProviderError(
                        "This connection attempt has ended. Start again."
                    )
                if state.busy and action not in ("cancel", "disconnect"):
                    raise ProviderError("A connection action is already in progress")
                if action in ("cancel", "disconnect"):
                    state.flow_id = ""
                    state.flow = None
                    state.commands.clear()
                elif action == "connect" or (
                    action == "credentials" and not state.flow_id
                ):
                    state.flow_id = secrets.token_urlsafe(24)
                    state.flow_started = time.monotonic()
                    state.flow = (
                        AuthView("api_key") if action == "credentials" else None
                    )
                state.commands.append((action, value, state.flow_id))
                state.busy = True
            result = {"flow_id": state.flow_id}
            state.wake.set()
        return result

    def _command(self, key: str, command: tuple[str, str, str]) -> None:
        state, provider = self.states[key], self.providers[key]
        action, value, flow_id = command
        success = False
        before = provider.store.path.stat() if provider.store.path.exists() else None
        try:
            if action == "connect":
                flow = provider.start_auth()
                with state.lock:
                    if state.flow_id == flow_id:
                        state.flow = flow
            elif action in ("complete", "credentials"):
                if action == "complete":
                    provider.complete_auth(value)
                else:
                    provider.save_key(value)
                success = True
            elif action == "cancel":
                provider.cancel_auth()
            elif action == "disconnect":
                provider.disconnect()
                with state.lock:
                    state.snapshot = None
                    state.connection = "disconnected"
                    state.status = "disconnected"
                    state.message = "Connect to see subscription usage"
                    state.retry_at = 0
                    state.force = False
        except ProviderError as error:
            with state.lock:
                # Keep polling status intact; a failed form must not mark a working
                # connection as broken on MQTT or pause its polling.
                state.auth_message = str(error)
                # A valid new key can be stored even when its quota schema is unsupported.
                if action == "credentials" and error.status == "unsupported":
                    after = (
                        provider.store.path.stat()
                        if provider.store.path.exists()
                        else None
                    )
                    success = after is not None and (
                        before is None
                        or (before.st_ino, before.st_mtime_ns)
                        != (after.st_ino, after.st_mtime_ns)
                    )
                if action == "connect" and state.flow_id == flow_id:
                    state.flow_id = ""
                    state.flow = None
        except Exception:  # noqa: BLE001 - isolate worker and publisher failures
            LOG.error("%s connection action failed", key)
            with state.lock:
                state.auth_message = "Connection action failed. Please retry."
                if action == "connect" and state.flow_id == flow_id:
                    state.flow_id = ""
                    state.flow = None
        finally:
            with state.lock:
                if success and state.flow_id == flow_id:
                    state.auth_message = ""
                    state.flow_id = ""
                    state.flow = None
                    state.snapshot = None
                    state.connection = "connected"
                    state.force = True
                    state.retry_at = 0
                state.busy = bool(state.commands)

    def _poll(self, key: str) -> None:
        state, provider = self.states[key], self.providers[key]
        try:
            snapshot = provider.fetch_usage()
            with state.lock:
                state.snapshot = snapshot
                state.confirmed = time.monotonic()
                state.connection = "connected"
                state.status = "ok"
                state.message = "Connected"
                state.failures = 0
                state.retry_at = 0
        except ProviderError as error:
            with state.lock:
                state.failures += 1
                state.status = error.status
                state.message = str(error)
                state.connection = (
                    "reconnect_required"
                    if error.status == "auth_required"
                    else "connected"
                )
                if error.status == "auth_required":
                    delay = max(error.retry_after, AUTH_RETRY)
                elif error.status == "rate_limited":
                    # Anthropic's usage endpoint answers 429 while nothing
                    # changed; a throttled round with a held reading counts
                    # as "still current", so displays only flag readings
                    # that stopped being confirmed.
                    if state.snapshot is not None:
                        state.confirmed = time.monotonic()
                    # Honour Retry-After only up to the confirmation window.
                    delay = min(error.retry_after or 300, 600)
                else:
                    delay = error.retry_after or min(300, 5 * 2 ** min(state.failures, 6))
                state.retry_at = time.monotonic() + delay
        except Exception:  # noqa: BLE001 - isolate worker and publisher failures
            LOG.error("%s usage update failed", key)
            with state.lock:
                state.status = "error"
                state.message = "Could not update usage. Retrying shortly."
                state.retry_at = time.monotonic() + 30
        finally:
            with state.lock:
                state.force = False
                state.next_poll = time.monotonic() + self.poll_interval

    def tick(self, key: str) -> None:
        """Advance one provider; called only by that provider's worker."""
        state, provider = self.states[key], self.providers[key]
        with state.lock:
            command = state.commands.popleft() if state.commands else None
        if command:
            self._command(key, command)
        with state.lock:
            pending = state.flow is not None
            expired = bool(
                state.flow_id
                and (
                    time.monotonic() - state.flow_started >= 900
                    or (
                        state.flow
                        and state.flow.expires_at
                        and time.time() >= state.flow.expires_at
                    )
                )
            )
        if expired:
            try:
                provider.cancel_auth()
            except ProviderError:
                pass
            finally:
                with state.lock:
                    state.flow_id = ""
                    state.flow = None
                    state.auth_message = (
                        "Connection attempt expired. Please start again."
                    )
        elif pending and provider.auth_kind == "device_code":
            try:
                completed = provider.check_auth()
                if completed:
                    with state.lock:
                        state.flow_id = ""
                        state.flow = None
                        state.snapshot = None
                        state.connection = "connected"
                        state.force = True
                        state.retry_at = 0
            except ProviderError as error:
                with state.lock:
                    state.flow_id = ""
                    state.flow = None
                    state.auth_message = str(error)
        with state.lock:
            connected = provider.connected()
            if not connected and state.status == "starting":
                state.status = "disconnected"
                state.message = "Connect to see subscription usage"
            if connected and state.connection == "disconnected":
                state.connection = "checking"
            ready = (
                connected
                and time.monotonic() >= state.retry_at
                and (state.force or time.monotonic() >= state.next_poll)
            )
        if ready:
            self._poll(key)
        self._notify(key)

    def _run(self, key: str) -> None:
        state = self.states[key]
        while not self.stop.is_set():
            try:
                self.tick(key)
            except Exception:  # noqa: BLE001 - isolate worker and publisher failures
                LOG.error("%s worker failed; retrying", key)
            state.wake.wait(1)
            state.wake.clear()

    def start(self) -> None:
        for key in self.providers:
            thread = threading.Thread(
                target=self._run, args=(key,), daemon=True, name=f"usage-{key}"
            )
            self.threads.append(thread)
            thread.start()

    def close(self) -> None:
        self.stop.set()
        for state in self.states.values():
            state.wake.set()
        # Close subprocess clients first to release blocked RPC requests.
        for provider in self.providers.values():
            provider.close()
        for thread in self.threads:
            thread.join(timeout=3)
