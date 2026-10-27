"""Private Codex app-server JSONL transport, with bounded requests and child cleanup."""

import json
import os
import queue
import select
import subprocess
import threading
import time
from collections import deque
from pathlib import Path
from typing import Any

from storage import private_directory

from providers.base import ProviderError

MAX_MESSAGE_BYTES = 2 * 1024 * 1024


class CodexClient:
    def __init__(
        self, state_dir: Path, *, command: list[str] | None = None, timeout: float = 30
    ) -> None:
        self.state_dir = private_directory(state_dir)
        self.command = command or [
            "codex",
            "-c",
            'cli_auth_credentials_store="file"',
            "app-server",
            "--listen",
            "stdio://",
        ]
        self.timeout = timeout
        self.environment = {
            key: value
            for key, value in os.environ.items()
            if key
            in {
                "PATH",
                "TMPDIR",
                "SSL_CERT_FILE",
                "SSL_CERT_DIR",
                "CODEX_CA_CERTIFICATE",
                "HTTPS_PROXY",
                "HTTP_PROXY",
                "NO_PROXY",
                "https_proxy",
                "http_proxy",
                "no_proxy",
            }
        }
        self.environment.update(
            {"CODEX_HOME": str(self.state_dir), "HOME": str(self.state_dir)}
        )
        self.process: subprocess.Popen[bytes] | None = None
        self._reader: threading.Thread | None = None
        self._start_lock = threading.RLock()
        self._lock = threading.Lock()
        self._write_lock = threading.Lock()
        self._pending: dict[int, queue.Queue[Any]] = {}
        self._notifications: deque[dict[str, Any]] = deque(maxlen=256)
        self._next_id = 0

    def _start(self) -> None:
        with self._start_lock:
            if self.process is not None and self.process.poll() is None:
                return
            self.close()
            try:
                process = subprocess.Popen(
                    self.command,
                    stdin=subprocess.PIPE,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.DEVNULL,
                    cwd=self.state_dir,
                    env=self.environment,
                )
            except OSError:
                raise ProviderError(
                    "Codex account service could not start; check the add-on image"
                ) from None
            self.process = process
            assert process.stdin is not None
            os.set_blocking(process.stdin.fileno(), False)
            self._reader = threading.Thread(
                target=self._read_loop,
                args=(process,),
                daemon=True,
                name="codex-account-reader",
            )
            self._reader.start()
            try:
                self._request(
                    "initialize",
                    {
                        "clientInfo": {
                            "name": "ai_usage_proxy",
                            "title": "AI Usage Proxy",
                            "version": "2.0.0",
                        }
                    },
                )
                self._write({"method": "initialized", "params": {}})
            except ProviderError:
                self.close()
                raise

    def _write(self, value: dict[str, Any], deadline: float | None = None) -> None:
        deadline = deadline if deadline is not None else time.monotonic() + self.timeout
        encoded = json.dumps(value, separators=(",", ":")).encode() + b"\n"
        if len(encoded) > MAX_MESSAGE_BYTES:
            raise ProviderError("Codex request is too large")
        if not self._write_lock.acquire(timeout=max(0, deadline - time.monotonic())):
            raise ProviderError(
                "Codex account request timed out; retrying automatically"
            )
        try:
            process = self.process
            if process is None or process.stdin is None or process.poll() is not None:
                raise ProviderError(
                    "Codex account service stopped; retrying automatically"
                )
            try:
                descriptor = process.stdin.fileno()
                offset = 0
                while offset < len(encoded):
                    remaining = deadline - time.monotonic()
                    if remaining <= 0:
                        raise ProviderError(
                            "Codex account request timed out; retrying automatically"
                        )
                    _, writable, _ = select.select([], [descriptor], [], remaining)
                    if not writable:
                        raise ProviderError(
                            "Codex account request timed out; retrying automatically"
                        )
                    try:
                        offset += os.write(descriptor, encoded[offset:])
                    except BlockingIOError:
                        continue
            except (OSError, ValueError):
                raise ProviderError(
                    "Codex account service stopped; retrying automatically"
                ) from None
        finally:
            self._write_lock.release()

    def _read_loop(self, process: subprocess.Popen[bytes]) -> None:
        assert process.stdout is not None
        try:
            while True:
                line = process.stdout.readline(MAX_MESSAGE_BYTES + 1)
                if not line:
                    break
                if len(line) > MAX_MESSAGE_BYTES:
                    break
                try:
                    value = json.loads(line)
                except (json.JSONDecodeError, UnicodeDecodeError):
                    break
                if not isinstance(value, dict):
                    break
                with self._lock:
                    if "id" in value:
                        response_id = value["id"]
                        if isinstance(response_id, int):
                            waiter = self._pending.pop(response_id, None)
                            if waiter:
                                waiter.put(value)
                    elif isinstance(value.get("method"), str):
                        self._notifications.append(value)
        except (OSError, ValueError):
            pass
        finally:
            with self._lock:
                if self.process is process:
                    for waiter in self._pending.values():
                        waiter.put(
                            ProviderError(
                                "Codex account service stopped; retrying automatically"
                            )
                        )
                    self._pending.clear()
            # A malformed child must not remain alive waiting for another request.
            if process.poll() is None:
                try:
                    process.terminate()
                except OSError:
                    pass

    def _request(self, method: str, params: dict[str, Any] | None) -> dict[str, Any]:
        deadline = time.monotonic() + self.timeout
        waiter: queue.Queue[Any] = queue.Queue(maxsize=1)
        with self._lock:
            self._next_id += 1
            request_id = self._next_id
            self._pending[request_id] = waiter
        try:
            try:
                self._write(
                    {"method": method, "id": request_id, "params": params or {}},
                    deadline,
                )
            except ProviderError:
                self.close()
                raise
            try:
                response = waiter.get(timeout=max(0, deadline - time.monotonic()))
            except queue.Empty:
                self.close()
                raise ProviderError(
                    "Codex account request timed out; retrying automatically"
                ) from None
            if isinstance(response, ProviderError):
                self.close()
                raise response
            if "error" in response:
                error = response["error"]
                code = error.get("code") if isinstance(error, dict) else None
                message = (
                    str(error.get("message", "")).lower()
                    if isinstance(error, dict)
                    else ""
                )
                if code in (401, 403) or any(
                    word in message
                    for word in ("unauthorized", "not logged in", "not authenticated")
                ):
                    raise ProviderError(
                        "OpenAI authorization required; reconnect", "auth_required"
                    )
                if code == -32001:
                    raise ProviderError(
                        "Codex account service is busy; retrying", "rate_limited", 30
                    )
                raise ProviderError(
                    "Codex could not complete the account request; retry or reconnect"
                )
            result = response.get("result")
            if not isinstance(result, dict):
                raise ProviderError(
                    "Codex returned an unsupported account response", "unsupported"
                )
            return result
        finally:
            with self._lock:
                self._pending.pop(request_id, None)

    def request(
        self, method: str, params: dict[str, Any] | None = None
    ) -> dict[str, Any]:
        self._start()
        return self._request(method, params)

    def notify(self, method: str, params: dict[str, Any] | None = None) -> None:
        self._start()
        self._write({"method": method, "params": params or {}})

    def pop_notifications(self) -> list[dict[str, Any]]:
        with self._lock:
            values = list(self._notifications)
            self._notifications.clear()
        return values

    def is_running(self) -> bool:
        """Whether the child and its response reader can complete a pending login."""
        process = self.process
        reader = self._reader
        return (
            process is not None
            and process.poll() is None
            and reader is not None
            and reader.is_alive()
        )

    def close(self) -> None:
        """Terminate the private child and unblock any outstanding requests."""
        with self._start_lock:
            process, self.process = self.process, None
            if process is not None:
                if process.poll() is None:
                    process.terminate()
                    try:
                        process.wait(timeout=2)
                    except subprocess.TimeoutExpired:
                        process.kill()
                        process.wait(timeout=2)
                if process.stdin:
                    process.stdin.close()
                if process.stdout:
                    process.stdout.close()
            reader, self._reader = self._reader, None
            if reader is not None and reader is not threading.current_thread():
                reader.join(timeout=2)
            with self._lock:
                for waiter in self._pending.values():
                    waiter.put(ProviderError("Codex account service closed"))
                self._pending.clear()
                self._notifications.clear()
