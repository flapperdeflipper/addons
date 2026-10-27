"""Ingress dashboard and bounded provider-scoped connection actions."""

import html
import json
import re
import secrets
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urlparse

from providers.base import ProviderError
from service import UsageService

ASSETS = Path(__file__).parent / "assets"
# Supervisor's Ingress gateway; other containers on the hassio network must not
# reach the dashboard, its CSRF token or the credential endpoints.
INGRESS_CLIENTS = ("172.30.32.2",)


class WebServer(ThreadingHTTPServer):
    daemon_threads = True
    service: UsageService
    publisher: Any
    csrf_token: str
    allowed_clients: tuple[str, ...]

    def verify_request(self, request: Any, client_address: Any) -> bool:
        return client_address[0] in self.allowed_clients


class Handler(BaseHTTPRequestHandler):
    server: WebServer

    def _send(self, code: int, body: bytes, mime: str = "application/json") -> None:
        self.send_response(code)
        self.send_header("Content-Type", mime)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header(
            "Content-Security-Policy",
            "default-src 'self'; script-src 'self'; style-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'",
        )
        self.end_headers()
        self.wfile.write(body)

    def _json(self, code: int, value: Any) -> None:
        self._send(code, json.dumps(value, allow_nan=False).encode())

    def do_GET(self) -> None:
        request = urlparse(self.path)
        if request.path == "/":
            base = self.headers.get("X-Ingress-Path", "").rstrip("/")
            if base and (
                not base.startswith("/")
                or base.startswith("//")
                or any(c in base for c in ("\r", "\n", "?", "#", "<", ">", '"', "'"))
            ):
                self._json(400, {"error": "Invalid Ingress path"})
                return
            page = (ASSETS / "index.html").read_text()
            page = page.replace("__BASE__", html.escape(base, quote=True))
            page = page.replace("__CSRF__", self.server.csrf_token)
            self._send(200, page.encode(), "text/html; charset=utf-8")
        elif request.path in ("/assets/dashboard.js", "/assets/dashboard.css"):
            asset = ASSETS / request.path.rsplit("/", 1)[1]
            mime = "text/javascript" if asset.suffix == ".js" else "text/css"
            self._send(200, asset.read_bytes(), f"{mime}; charset=utf-8")
        elif request.path == "/api/status":
            self._json(
                200,
                {
                    "providers": self.server.service.views(),
                    "mqtt": self.server.publisher.public(),
                },
            )
        elif match := re.fullmatch(r"/providers/([a-z][a-z0-9_]*)/flow", request.path):
            try:
                flow_id = parse_qs(request.query).get("flow_id", [""])[0]
                self._json(200, self.server.service.flow_view(match[1], flow_id))
            except ProviderError as error:
                self._json(400, {"error": str(error)})
        else:
            self._json(404, {"error": "Not found"})

    def do_POST(self) -> None:
        token = self.headers.get("X-CSRF-Token", "")
        if not secrets.compare_digest(token, self.server.csrf_token):
            self._json(403, {"error": "Reload this page before submitting the form"})
            return
        if self.headers.get("Content-Type", "").split(";")[0] != "application/json":
            self._json(415, {"error": "Expected a JSON form"})
            return
        match = re.fullmatch(
            r"/providers/([a-z][a-z0-9_]*)/(connect|complete|credentials|cancel|disconnect|refresh)",
            urlparse(self.path).path,
        )
        if not match:
            self._json(404, {"error": "Not found"})
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if length < 0 or length > 16384:
                self._json(413, {"error": "Form is too large"})
                return
            payload = json.loads(self.rfile.read(length))
            if not isinstance(payload, dict):
                raise TypeError
            value, flow_id = payload.get("value", ""), payload.get("flow_id", "")
            if not isinstance(value, str) or not isinstance(flow_id, str):
                raise TypeError
            result = self.server.service.action(match[1], match[2], value, flow_id)
            self._json(202, result)
        except ProviderError as error:
            self._json(400, {"error": str(error), "status": error.status})
        except (ValueError, TypeError, UnicodeDecodeError):
            self._json(400, {"error": "Invalid form"})

    def log_message(self, format: str, *args: Any) -> None:
        # Do not log OAuth flow handles or credentials submitted to this page.
        pass


def make_server(
    service: UsageService,
    publisher: Any,
    address: tuple[str, int] = ("0.0.0.0", 8237),
    allowed_clients: tuple[str, ...] = INGRESS_CLIENTS,
) -> WebServer:
    server = WebServer(address, Handler)
    server.service = service
    server.publisher = publisher
    server.csrf_token = secrets.token_urlsafe(32)
    server.allowed_clients = allowed_clients
    return server
