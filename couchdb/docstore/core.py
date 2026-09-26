"""Pure docstore logic: registry parsing, doc validation, TTL stamping.

Stdlib only on purpose: this module runs unchanged in CI (plain python3,
no pip installs) and inside the add-on image. The HTTP/MCP layer lives in
server.py and stays a thin adapter over these functions.

All timestamps are UTC ISO-8601 with a trailing "Z" so Mango string
comparison ($lte on expires) matches chronological order.
"""

import re
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone

DB_NAME_RE = re.compile(r"^[a-z][a-z0-9_$()+/-]*$")
ISO_FORMAT = "%Y-%m-%dT%H:%M:%SZ"


class DocstoreError(Exception):
    """Refusal raised before anything is sent to CouchDB."""


@dataclass(frozen=True)
class TypeSpec:
    db: str
    id_pattern: re.Pattern
    ttl_days: int | None
    ttl_from: str  # "created" | "done"


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).strftime(ISO_FORMAT)


def _parse_timestamp(value, field):
    if not isinstance(value, str):
        raise DocstoreError(f"{field} must be an ISO-8601 string, got {type(value).__name__}")
    text = value.strip()
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    try:
        parsed = datetime.fromisoformat(text)
    except ValueError as exc:
        raise DocstoreError(f"{field} is not a valid ISO-8601 timestamp: {value!r}") from exc
    if parsed.tzinfo is None:
        raise DocstoreError(f"{field} must carry a timezone offset: {value!r}")
    return parsed.astimezone(timezone.utc)


def normalize_timestamp(value, field) -> str:
    return _parse_timestamp(value, field).strftime(ISO_FORMAT)


def _add_days(iso: str, days: int) -> str:
    parsed = _parse_timestamp(iso, "now")
    return (parsed + timedelta(days=days)).strftime(ISO_FORMAT)


class Registry:
    """Allowlist of databases plus the per-type rules enforced on every write."""

    def __init__(self, databases, types):
        self.databases = frozenset(databases)
        self.types = types

    @classmethod
    def parse(cls, raw) -> "Registry":
        if not isinstance(raw, dict):
            raise DocstoreError("registry must be a JSON object")

        databases = raw.get("databases")
        if not isinstance(databases, list) or not databases:
            raise DocstoreError("registry.databases must be a non-empty list")
        for name in databases:
            if not isinstance(name, str) or not DB_NAME_RE.match(name):
                raise DocstoreError(f"invalid database name in registry: {name!r}")

        raw_types = raw.get("types", {})
        if not isinstance(raw_types, dict):
            raise DocstoreError("registry.types must be an object")

        types = {}
        for type_name, spec in raw_types.items():
            if not isinstance(spec, dict):
                raise DocstoreError(f"type {type_name!r} spec must be an object")
            db = spec.get("db")
            if db not in databases:
                raise DocstoreError(f"type {type_name!r} binds to undeclared database {db!r}")
            pattern = spec.get("id_pattern")
            try:
                compiled = re.compile(pattern) if isinstance(pattern, str) else None
            except re.error as exc:
                raise DocstoreError(f"type {type_name!r} has an invalid id_pattern: {exc}") from exc
            if compiled is None:
                raise DocstoreError(f"type {type_name!r} is missing id_pattern")
            ttl_days = spec.get("ttl_days")
            if ttl_days is not None and (not isinstance(ttl_days, int) or ttl_days <= 0):
                raise DocstoreError(f"type {type_name!r} ttl_days must be a positive integer or null")
            ttl_from = spec.get("ttl_from", "created")
            if ttl_from not in ("created", "done"):
                raise DocstoreError(f"type {type_name!r} ttl_from must be 'created' or 'done'")
            types[type_name] = TypeSpec(db=db, id_pattern=compiled, ttl_days=ttl_days, ttl_from=ttl_from)

        return cls(databases, types)

    def spec(self, type_name) -> TypeSpec:
        try:
            return self.types[type_name]
        except KeyError:
            raise DocstoreError(f"unknown type {type_name!r} (registry types: {sorted(self.types)})") from None

    def allows_db(self, db) -> bool:
        return db in self.databases


def _resolve_type(registry: Registry, doc_id: str, declared) -> str:
    """The _id namespace prefix names the type; doc.type may confirm, never contradict."""
    prefix = doc_id.split("/", 1)[0] if "/" in doc_id else None
    if prefix is None or prefix not in registry.types:
        raise DocstoreError(
            f"cannot derive doc type from _id {doc_id!r}: no registry type named {prefix!r}"
        )
    if declared is not None and declared != prefix:
        raise DocstoreError(f"doc.type {declared!r} disagrees with _id namespace {prefix!r}")
    return prefix

def validate_doc_id(registry: Registry, db: str, doc_id: str, doc_type: str) -> None:
    if not registry.allows_db(db):
        raise DocstoreError(f"database {db!r} is not in the docstore registry")
    spec = registry.spec(doc_type)
    if spec.db != db:
        raise DocstoreError(f"type {doc_type!r} lives in database {spec.db!r}, not {db!r}")
    if not spec.id_pattern.match(doc_id):
        raise DocstoreError(f"_id {doc_id!r} does not match pattern {spec.id_pattern.pattern!r} for type {doc_type!r}")


def _resolve_expiry(doc, spec, *, now, default_from=None):
    """expires key of the prepared doc, per the opt-out semantics.

    - explicit null  -> no expiry (opt out)
    - explicit value -> validated, normalized to Z-form, kept
    - key absent     -> registry default (from `now` or the done-timestamp),
                        unless the type has no ttl or ttl starts at 'done'
    """
    if "expires" in doc:
        value = doc["expires"]
        if value is None:
            return None
        return normalize_timestamp(value, "expires")
    if spec.ttl_days is None:
        return None
    if spec.ttl_from == "done":
        return None
    return _add_days(now if default_from is None else default_from, spec.ttl_days)


def prepare_create(registry, db, doc_id, doc, *, now, agent, session) -> dict:
    doc_type = _resolve_type(registry, doc_id, doc.get("type"))
    validate_doc_id(registry, db, doc_id, doc_type)

    prepared = dict(doc)
    expires = _resolve_expiry(doc, registry.spec(doc_type), now=now)
    if expires is not None:
        prepared["expires"] = expires
    else:
        prepared.pop("expires", None)
    prepared.update(
        {
            "type": doc_type,
            "created": now,
            "updated": now,
            "agent": agent,
            "session": session,
        }
    )
    return prepared


def prepare_update(registry, db, doc_id, doc, existing, *, now, agent, session) -> dict:
    doc_type = _resolve_type(registry, doc_id, doc.get("type", existing.get("type")))
    if existing.get("type") not in (None, doc_type):
        raise DocstoreError("changing doc.type is not allowed; delete and recreate instead")
    validate_doc_id(registry, db, doc_id, doc_type)

    prepared = dict(doc)
    prepared["type"] = doc_type
    prepared["created"] = existing.get("created", now)
    spec = registry.spec(doc_type)
    if "expires" in doc:
        if doc["expires"] is None:
            prepared.pop("expires", None)
        else:
            prepared["expires"] = normalize_timestamp(doc["expires"], "expires")
    elif "expires" in existing:
        # absent expires carries the stored value; never re-stamps on update
        prepared["expires"] = existing["expires"]
    prepared.update({"updated": now, "agent": agent, "session": session})
    return prepared


def prepare_complete(registry, db, doc_id, existing, *, now) -> dict:
    doc_type = existing.get("type")
    if doc_type != "task":
        raise DocstoreError("completion is only defined for type 'task'")
    spec = registry.spec(doc_type)
    validate_doc_id(registry, db, doc_id, doc_type)

    prepared = dict(existing)
    prepared["status"] = "done"
    prepared["done"] = now
    expires = _resolve_expiry(existing, spec, now=now)
    if expires is None and spec.ttl_from == "done" and spec.ttl_days is not None and "expires" not in existing:
        expires = _add_days(now, spec.ttl_days)
    if expires is not None:
        prepared["expires"] = expires
    return prepared


def sweep_plan(registry, now):
    """One Mango selector per registered database: everything already expired."""
    return [
        (db, {"selector": {"expires": {"$lte": now}}, "limit": 500, "fields": ["_id", "_rev"]})
        for db in sorted(registry.databases)
    ]


def claim_filter(queue, limit=10):
    if not isinstance(queue, str) or not queue:
        raise DocstoreError("queue must be a non-empty string")
    return {"selector": {"type": "task", "queue": queue, "status": "todo"}, "limit": limit}
