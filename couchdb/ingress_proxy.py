#!/usr/bin/env python3
"""Auth-injecting reverse proxy for the HA ingress panel.

CouchDB runs with require_valid_user=true, which challenges every request
(including Fauxton's static assets) with HTTP Basic auth. Browsers refuse to
show that prompt inside the HA ingress iframe, so the panel dies on load.

This proxy fronts the ingress port ONLY: HA ingress (already gated by the HA
login and panel_admin) reaches it with an X-Hassio-Key header, which no other
client has. The proxy requires that header and forwards to CouchDB with an
Authorization header injected, so Fauxton loads and its own login screen can
still be used for a non-admin session if wanted.

Stdlib only. The direct :5984 port is untouched.
"""

import base64
import os
import sys
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


def log(msg):
    print(f"[ingress-proxy] {msg}", file=sys.stderr, flush=True)


def make_handler(upstream, credentials):
    auth_header = "Basic " + base64.b64encode(credentials.encode()).decode()

    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def _proxy(self):
            # HA ingress identifies itself with X-Hass-Source: ingress and,
            # once the HA user is authenticated, X-Remote-User-Id (observed on
            # Supervisor 2026.x; the older X-Hassio-Key contract is gone).
            # Requiring both keeps the injected-admin path reachable only via
            # an authenticated HA ingress session.
            # Presence-based: only HA ingress injects X-Hass-Source together
            # with the authenticated X-Remote-User-* headers. The exact source
            # value differs across Supervisor versions, so it is not matched.
            if not (self.headers.get("X-Hass-Source") and self.headers.get("X-Remote-User-Id")):
                names = sorted(k for k in self.headers.keys() if k.lower().startswith("x-"))
                log(f"403 {self.command} {self.path}: not an authenticated ingress request; saw: {names}")
                self.send_error(403, "ingress only")
                return
            length = int(self.headers.get("Content-Length") or 0)
            body = self.rfile.read(length) if length else None
            # Fauxton derives its asset root one level above /_utils, so
            # through the ingress prefix its asset requests arrive without the
            # /_utils prefix and 404 on CouchDB. Rewrite only that namespace;
            # API paths (_all_dbs, _session, ...) are correct as-is.
            path = self.path
            if path.startswith("/dashboard.assets"):
                path = "/_utils" + path
            req = urllib.request.Request(upstream + path, method=self.command, data=body)
            req.add_header("Authorization", auth_header)
            for header in ("Content-Type", "Accept", "If-None-Match", "If-Match"):
                if self.headers.get(header):
                    req.add_header(header, self.headers[header])
            try:
                with urllib.request.urlopen(req, timeout=60) as resp:
                    payload = resp.read()
                    self.send_response(resp.status)
                    for key, value in resp.headers.items():
                        if key.lower() in ("content-type", "cache-control", "etag", "x-couch-request-id"):
                            self.send_header(key, value)
                    self.send_header("Content-Length", str(len(payload)))
                    self.end_headers()
                    if self.command != "HEAD":
                        self.wfile.write(payload)
            except urllib.error.HTTPError as exc:
                payload = exc.read()
                self.send_response(exc.code)
                if exc.headers.get("Content-Type"):
                    self.send_header("Content-Type", exc.headers["Content-Type"])
                self.send_header("Content-Length", str(len(payload)))
                self.end_headers()
                if self.command != "HEAD":
                    self.wfile.write(payload)
            except Exception as exc:  # noqa: BLE001 - never kill the panel on one bad hop
                log(f"{self.command} {self.path}: {exc}")
                self.send_error(502, "upstream unreachable")

        do_GET = do_POST = do_PUT = do_DELETE = do_HEAD = do_OPTIONS = _proxy

        def log_message(self, fmt, *args):
            return  # quiet: the add-on log belongs to couchdb + docstore

    return Handler


def main():
    upstream = os.environ.get("COUCH_URL", "http://127.0.0.1:5984").rstrip("/")
    username = os.environ.get("INGRESS_USERNAME", "")
    password = os.environ.get("INGRESS_PASSWORD", "")
    if not username or not password:
        raise SystemExit("ingress proxy needs INGRESS_USERNAME/INGRESS_PASSWORD")
    port = int(os.environ.get("INGRESS_PROXY_PORT", "5986"))
    server = ThreadingHTTPServer(("0.0.0.0", port), make_handler(upstream, f"{username}:{password}"))
    log(f"listening on :{port}, forwarding to {upstream} as '{username}'")
    server.serve_forever()


if __name__ == "__main__":
    main()
