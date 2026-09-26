#!/usr/bin/env python3
"""Docstore MCP server: stateless JSON-RPC over HTTP in front of CouchDB.

Serves the same per-request, session-less JSON-RPC contract the MCP Hub's
forwarders expect (no initialize handshake, no Mcp-Session-Id), guarded by a
bearer token. Every write goes through core.py validation, so the registry
allowlist, _id grammar, audit fields and TTL stamping are enforced here in
code, not in prose.

Stdlib only — no pip packages in the add-on image.
"""

import base64
import hmac
import json
import os
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import core

DEFAULT_PORT = 5985
DEFAULT_COUCH_URL = "http://127.0.0.1:5984"
QUERY_LIMIT_CAP = 200


def log(msg):
    print(f"[docstore] {msg}", file=sys.stderr, flush=True)


def check_token(header, expected):
    if not expected or not isinstance(header, str):
        return False
    return hmac.compare_digest(header, f"Bearer {expected}")


class ConflictError(Exception):
    pass


class CouchClient:
    def __init__(self, base_url, username, password, timeout=30):
        self.base = base_url.rstrip("/")
        creds = f"{username}:{password}".encode()
        self.auth = "Basic " + base64.b64encode(creds).decode()
        self.timeout = timeout

    def _request(self, method, path, body=None):
        req = urllib.request.Request(self.base + path, method=method)
        req.add_header("Authorization", self.auth)
        data = None
        if body is not None:
            data = json.dumps(body).encode()
            req.add_header("Content-Type", "application/json")
        try:
            with urllib.request.urlopen(req, data, timeout=self.timeout) as resp:
                raw = resp.read()
                return json.loads(raw) if raw.strip() else {}
        except urllib.error.HTTPError as exc:
            raw = exc.read().decode(errors="replace")
            if exc.code == 404:
                raise LookupError(f"not found: {path}") from None
            if exc.code == 409:
                raise ConflictError(f"conflict: {path}") from None
            raise RuntimeError(f"couchdb {method} {path} failed: HTTP {exc.code} {raw[:300]}") from None

    def get(self, db, doc_id):
        return self._request("GET", f"/{db}/{urllib.parse.quote(doc_id, safe='')}")

    def put(self, db, doc_id, doc):
        return self._request("PUT", f"/{db}/{urllib.parse.quote(doc_id, safe='')}", doc)

    def delete(self, db, doc_id, rev):
        return self._request("DELETE", f"/{db}/{urllib.parse.quote(doc_id, safe='')}?rev={urllib.parse.quote(rev)}")

    def find(self, db, mango):
        return self._request("POST", f"/{db}/_find", mango).get("docs", [])

    def ensure_indexes(self, db):
        # Mango refuses selectors on fields without an index; these three cover
        # type lookups, queue claims and the expiry sweep. Idempotent.
        for name, fields in (
            ("type", ["type"]),
            ("queue-status", ["type", "queue", "status"]),
            ("expires", ["expires"]),
        ):
            try:
                self._request("POST", f"/{db}/_index", {"name": name, "index": {"fields": fields}, "type": "json"})
            except RuntimeError as exc:
                log(f"index {name} on {db}: {exc}")



TOOLS = [
    {
        "name": "doc_get",
        "description": "Fetch one document by _id from a docstore database.",
        "inputSchema": {
            "type": "object",
            "properties": {"db": {"type": "string"}, "id": {"type": "string"}},
            "required": ["db", "id"],
        },
    },
    {
        "name": "doc_put",
        "description": "Create a document. The _id namespace prefix must be a registry type "
        "(e.g. handoff/2026-09-26-slug); type, created/updated, agent, session and TTL are stamped.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "db": {"type": "string"},
                "id": {"type": "string"},
                "doc": {"type": "object", "description": "Body; 'expires': null opts out of TTL"},
                "agent": {"type": "string", "description": "Your agent name, stamped for audit"},
                "session": {"type": "string"},
            },
            "required": ["db", "id", "doc"],
        },
    },
    {
        "name": "doc_update",
        "description": "Replace a document body at a known _rev; revalidates against the registry.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "db": {"type": "string"},
                "id": {"type": "string"},
                "doc": {"type": "object"},
                "rev": {"type": "string"},
                "agent": {"type": "string"},
                "session": {"type": "string"},
            },
            "required": ["db", "id", "doc", "rev"],
        },
    },
    {
        "name": "doc_delete",
        "description": "Delete one document by _id and _rev.",
        "inputSchema": {
            "type": "object",
            "properties": {"db": {"type": "string"}, "id": {"type": "string"}, "rev": {"type": "string"}},
            "required": ["db", "id", "rev"],
        },
    },
    {
        "name": "doc_query",
        "description": "Mango selector query, capped at 200 docs. Only registry databases.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "db": {"type": "string"},
                "selector": {"type": "object"},
                "limit": {"type": "integer"},
                "fields": {"type": "array", "items": {"type": "string"}},
            },
            "required": ["db", "selector"],
        },
    },
    {
        "name": "task_claim",
        "description": "Atomically claim the next todo task in a work-queue (status todo -> in_progress).",
        "inputSchema": {
            "type": "object",
            "properties": {"queue": {"type": "string"}, "agent": {"type": "string"}},
            "required": ["queue"],
        },
    },
    {
        "name": "task_complete",
        "description": "Mark a task done; stamps the done-timestamp and expiry TTL.",
        "inputSchema": {
            "type": "object",
            "properties": {"db": {"type": "string"}, "id": {"type": "string"}, "agent": {"type": "string"}},
            "required": ["db", "id"],
        },
    },
]


class DocstoreServer:
    def __init__(self, registry, couch):
        self.registry = registry
        self.couch = couch
        self.last_query_limit = None

    # -- JSON-RPC ----------------------------------------------------------
    def handle(self, message):
        method = message.get("method")
        msg_id = message.get("id")
        if method == "tools/list":
            return {"jsonrpc": "2.0", "id": msg_id, "result": {"tools": TOOLS}}
        if method == "tools/call":
            params = message.get("params") or {}
            return self._call_tool(msg_id, params.get("name"), params.get("arguments") or {})
        if msg_id is not None:
            return {"jsonrpc": "2.0", "id": msg_id, "error": {"code": -32601, "message": f"unknown method {method!r}"}}
        return None

    def _ok(self, msg_id, payload):
        return {"jsonrpc": "2.0", "id": msg_id, "result": {"content": [{"type": "text", "text": payload}]}}

    def _err(self, msg_id, message):
        return {"jsonrpc": "2.0", "id": msg_id, "result": {"isError": True, "content": [{"type": "text", "text": message}]}}

    def _call_tool(self, msg_id, name, args):
        try:
            handler = getattr(self, f"_tool_{name}")
        except AttributeError:
            return self._err(msg_id, f"unknown tool {name!r}")
        try:
            return self._ok(msg_id, handler(args))
        except core.DocstoreError as exc:
            return self._err(msg_id, str(exc))
        except LookupError as exc:
            return self._err(msg_id, f"not found: {exc}")
        except (ConflictError, RuntimeError, ValueError) as exc:
            return self._err(msg_id, str(exc))

    # -- tools -------------------------------------------------------------
    def _tool_doc_get(self, args):
        doc = self.couch.get(args["db"], args["id"])
        return _dumps(doc)

    def _tool_doc_put(self, args):
        db, doc_id = args["db"], args["id"]
        now = core.utc_now_iso()
        prepared = core.prepare_create(
            self.registry, db, doc_id, args["doc"],
            now=now, agent=args.get("agent", "unknown"), session=args.get("session", "unknown"),
        )
        stored = self.couch.put(db, doc_id, prepared)
        return _dumps({"ok": True, "id": doc_id, "rev": stored.get("_rev"), "expires": prepared.get("expires")})

    def _tool_doc_update(self, args):
        db, doc_id, rev = args["db"], args["id"], args["rev"]
        existing = self.couch.get(db, doc_id)
        now = core.utc_now_iso()
        prepared = core.prepare_update(
            self.registry, db, doc_id, args["doc"], existing,
            now=now, agent=args.get("agent", "unknown"), session=args.get("session", "unknown"),
        )
        prepared["_rev"] = rev
        stored = self.couch.put(db, doc_id, prepared)
        return _dumps({"ok": True, "id": doc_id, "rev": stored.get("_rev")})

    def _tool_doc_delete(self, args):
        self.couch.delete(args["db"], args["id"], args["rev"])
        return _dumps({"ok": True, "deleted": args["id"]})

    def _tool_doc_query(self, args):
        db, selector = args["db"], args["selector"]
        if not self.registry.allows_db(db):
            raise core.DocstoreError(f"database {db!r} is not in the docstore registry")
        if not isinstance(selector, dict):
            raise core.DocstoreError("selector must be an object")
        limit = min(int(args.get("limit", 50)), QUERY_LIMIT_CAP)
        self.last_query_limit = limit
        mango = {"selector": selector, "limit": limit}
        if isinstance(args.get("fields"), list):
            mango["fields"] = args["fields"]
        docs = self.couch.find(db, mango)
        return _dumps({"count": len(docs), "docs": docs})

    def _tool_task_claim(self, args):
        queue = args["queue"]
        agent = args.get("agent", "unknown")
        now = core.utc_now_iso()
        mango = core.claim_filter(queue, limit=10)
        mango.pop("fields", None)
        for candidate in self.couch.find("agent_tasks", mango):
            if candidate.get("status") != "todo":
                continue
            claimed = dict(candidate, status="in_progress", claimed_by=agent, claimed_at=now, updated=now)
            try:
                stored = self.couch.put("agent_tasks", candidate["_id"], claimed)
            except ConflictError:
                continue
            return _dumps({"claimed": candidate["_id"], "rev": stored.get("_rev"), "doc": stored})
        raise core.DocstoreError(f"queue {queue!r} is empty")

    def _tool_task_complete(self, args):
        db, doc_id = args["db"], args["id"]
        existing = self.couch.get(db, doc_id)
        prepared = core.prepare_complete(self.registry, db, doc_id, existing, now=core.utc_now_iso())
        if args.get("agent"):
            prepared["agent"] = args["agent"]
        stored = self.couch.put(db, doc_id, prepared)
        return _dumps({"ok": True, "id": doc_id, "rev": stored.get("_rev"), "expires": prepared.get("expires")})


def _dumps(obj):
    return json.dumps(obj, separators=(",", ":"), sort_keys=True)


# ---------------------------------------------------------------------------
# HTTP plumbing + sweeper + entrypoint
# ---------------------------------------------------------------------------

def sweeper_loop(registry, couch, interval_seconds):
    while True:
        total = 0
        for db, selector in core.sweep_plan(registry, core.utc_now_iso()):
            try:
                expired = couch.find(db, selector)
            except (RuntimeError, LookupError) as exc:
                log(f"sweep {db} failed: {exc}")
                continue
            for row in expired:
                try:
                    couch.delete(db, row["_id"], row["_rev"])
                    total += 1
                except (ConflictError, LookupError, RuntimeError) as exc:
                    log(f"sweep delete {db}/{row.get('_id')}: {exc}")
        if total:
            log(f"sweeper purged {total} expired document(s)")
        time.sleep(interval_seconds)


def make_handler(server, token):
    class Handler(BaseHTTPRequestHandler):
        def do_POST(self):
            length = int(self.headers.get("Content-Length") or 0)
            try:
                body = json.loads(self.rfile.read(length) or b"{}")
            except ValueError:
                self._reply(400, {"error": "invalid JSON"})
                return
            if not check_token(self.headers.get("Authorization"), token):
                self._reply(401, {"error": "unauthorized"})
                return
            response = server.handle(body)
            if response is None:
                self._reply(202, "")
                return
            self._reply(200, response)

        def do_GET(self):
            self._reply(405, {"error": "POST only"})

        def _reply(self, code, payload):
            data = json.dumps(payload).encode() if payload != "" else b""
            self.send_response(code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            if data:
                self.wfile.write(data)

        def log_message(self, fmt, *args):
            log(f"http {self.address_string()} {fmt % args}")

    return Handler


def load_registry(path, default_path):
    for candidate in (path, default_path):
        if candidate and os.path.isfile(candidate):
            with open(candidate) as fh:
                registry = core.Registry.parse(json.load(fh))
            if candidate == path:
                return registry
            log(f"registry missing at {path}; using bundled default")
            return registry
    raise SystemExit("no registry found")



def resolve_credentials(options, env):
    """The CouchDB login the MCP tools use.

    run.sh resolves blank option passwords into generated files and hands the
    result here via DOCSTORE_PASSWORD/DOCSTORE_USERNAME — options.json alone
    only ever holds blanks for generated accounts.
    """
    docstore = options.get("docstore") or {}
    username = env.get("DOCSTORE_USERNAME") or docstore.get("username") or "agent"
    password = env.get("DOCSTORE_PASSWORD") or ""
    if not password:
        for login in options.get("logins") or []:
            if login.get("username") == username:
                password = login.get("password") or ""
    if not password:
        raise SystemExit(f"login {username!r} (docstore.username) has no password")
    return username, password


def main():
    options_path = os.environ.get("OPTIONS_JSON", "/data/options.json")
    with open(options_path) as fh:
        options = json.load(fh)
    docstore = options.get("docstore") or {}

    username, password = resolve_credentials(options, os.environ)
    token = docstore.get("token") or os.environ.get("DOCSTORE_TOKEN") or ""
    if not token:
        raise SystemExit("docstore token is empty; run.sh must generate or configure one")
    if not password:
        raise SystemExit(f"login {username!r} (docstore.username) not found or has no password")

    registry = load_registry(
        os.environ.get("DOCSTORE_REGISTRY", "/config/couchdb/docstore/registry.json"),
        os.environ.get("DOCSTORE_REGISTRY_DEFAULT", "/docstore/registry.default.json"),
    )
    couch = CouchClient(os.environ.get("COUCH_URL", DEFAULT_COUCH_URL), username, password)

    for db in sorted(registry.databases):
        try:
            couch.ensure_indexes(db)
        except Exception as exc:  # noqa: BLE001 - index creation must never block boot
            log(f"index setup for {db} deferred: {exc}")

    sweep_seconds = int(os.environ.get("DOCSTORE_SWEEP_SECONDS", "3600"))
    threading.Thread(
        target=sweeper_loop, args=(registry, couch, sweep_seconds), daemon=True, name="docstore-sweeper"
    ).start()

    port = int(os.environ.get("DOCSTORE_PORT", str(DEFAULT_PORT)))
    httpd = ThreadingHTTPServer(("0.0.0.0", port), make_handler(DocstoreServer(registry, couch), token))
    log(f"MCP endpoint listening on :{port} (db allowlist: {sorted(registry.databases)})")
    httpd.serve_forever()


if __name__ == "__main__":
    main()
