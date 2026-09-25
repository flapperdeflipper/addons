"""LiteLLM memory API (/v1/memory) tools.

Durable cross-session key-value memory, scoped by the API key's user/team.
Key conventions: 'opencode:global:*' shared, 'opencode:<project>:*' per
project, 'user:<topic>' personal preferences. Entries carry optional tags
(stored in metadata) for topic filtering; memory_search ranks by keyword and
tag relevance so recall does not depend on knowing exact keys.
"""

import re

from ..litellm_client import LIST_ENTRY_LIMIT, LIST_VALUE_LIMIT, VALUE_LIMIT, compact, truncate

NAME = "memory"
DESCRIPTION = "LiteLLM proxy memory: durable key-value entries across sessions"

_WORD_SPLIT = re.compile(r"[^a-z0-9]+")
_KEY_SPLIT = re.compile(r"[:/_\-]+")
_SNIPPET_RADIUS = 70
SNIPPET_LIMIT = 160
SEARCH_LIMIT_MAX = 25


def _check_key(key):
    key = (key or "").strip()
    if not key:
        raise ValueError("key must not be empty")
    return key


def _tags_of(entry):
    """Normalized tags from an entry's metadata (list, or csv/space string)."""
    meta = entry.get("metadata") if isinstance(entry, dict) else None
    raw = meta.get("tags") if isinstance(meta, dict) else None
    if isinstance(raw, str):
        raw = re.split(r"[,\s]+", raw)
    if not isinstance(raw, list):
        return []
    return [t.strip().lower() for t in raw if isinstance(t, str) and t.strip()]


def _parse_tags(tags):
    """Comma/space-separated string (or iterable) -> normalized tag list."""
    if not tags:
        return []
    if isinstance(tags, str):
        parts = re.split(r"[,\s]+", tags.strip().lower())
    else:
        parts = [str(t).strip().lower() for t in tags]
    return [p for p in parts if p]


def _terms(query):
    return [t for t in _WORD_SPLIT.split((query or "").lower()) if len(t) >= 2]


def _score(entry, terms):
    """Relevance score: key segment (exact) > tag > value substring.

    Key matching is exact-segment only: substring key matches produce noise
    ("not" inside "note") without adding recall that segments don't cover.
    """
    key = entry.get("key", "").lower()
    value = str(entry.get("value", "")).lower()
    segments = set(s for s in _KEY_SPLIT.split(key) if s)
    score = 0
    for term in terms:
        if term in segments:
            score += 6
        for tag in _tags_of(entry):
            if term == tag:
                score += 5
            elif term in tag:
                score += 2
        if term in value:
            score += 2
    return score


def _snippet(value, terms, limit=SNIPPET_LIMIT):
    """Collapsed-whitespace window around the first term hit in the value."""
    text = " ".join(str(value or "").split())
    low = text.lower()
    pos = -1
    for term in terms:
        i = low.find(term)
        if i >= 0 and (pos < 0 or i < pos):
            pos = i
    if pos < 0:
        return truncate(text, limit)
    start = max(0, pos - _SNIPPET_RADIUS)
    end = min(len(text), start + limit)
    prefix = "…" if start > 0 else ""
    suffix = "…" if end < len(text) else ""
    return prefix + text[start:end] + suffix


def _fetch_all(client):
    """One list call -> (entries, error_string). Metadata comes along."""
    status, body = client.request("GET", client.list_path(""))
    if status != 200:
        return None, client.error(status, body)
    return body.get("memories", []), None


def register(server, client):

    @server.tool()
    def memory_get(key: str) -> str:
        """Read one memory entry by its exact key (e.g. 'opencode:global:preferences').

        Returns key, value, tags, metadata and updated_at. Use memory_search
        to discover keys when the exact key is unknown.
        """
        key = _check_key(key)
        status, body = client.request("GET", client.entry_path(key))
        if status == 404:
            return "not found: " + key
        if status != 200:
            return client.error(status, body)
        return compact({
            "key": body.get("key", key),
            "value": truncate(str(body.get("value", "")), VALUE_LIMIT),
            "tags": _tags_of(body),
            "metadata": body.get("metadata"),
            "updated_at": body.get("updated_at"),
        })

    @server.tool()
    def memory_set(key: str, value: str, tags: str = "") -> str:
        """Create or update (upsert) a memory entry. Overwrites the value.

        Prefer namespaced keys: 'opencode:global:*' shared, 'opencode:<project>:*'
        per project, 'user:<topic>' for personal preferences — one fact per key,
        the key name should name the fact. tags: comma/space-separated labels
        (e.g. 'esphome, mqtt') stored as metadata for memory_search/memory_tags.
        Omitting tags on an update keeps the existing ones.
        """
        key = _check_key(key)
        body = {"value": value}
        parsed = _parse_tags(tags)
        if parsed:
            body["metadata"] = {"tags": parsed}
        status, resp = client.request("PUT", client.entry_path(key), body)
        if status != 200:
            return client.error(status, resp)
        return compact({"ok": True, "key": key, "tags": parsed, "updated_at": resp.get("updated_at")})

    @server.tool()
    def memory_search(query: str = "", tag: str = "", limit: int = 10) -> str:
        """Search memories by keywords and/or tag; returns ranked matches.

        Scoring favors key matches, then tag matches, then value matches.
        Each match carries a snippet, not the full value — memory_get(key) for
        the whole entry. Use this before starting substantial tasks instead of
        guessing exact keys; memory_tags() lists the tag vocabulary first.
        """
        want_tag = (tag or "").strip().lower()
        if not query and not want_tag:
            return "provide a query and/or tag"
        entries, err = _fetch_all(client)
        if err:
            return err
        terms = _terms(query)
        matches = []
        for entry in entries:
            tags = _tags_of(entry)
            if want_tag and want_tag not in tags:
                continue
            score = _score(entry, terms)
            if terms and score <= 0:
                continue
            matches.append((score, entry, tags))
        matches.sort(key=lambda m: (-m[0], m[1].get("key", "")))
        try:
            shown_max = max(1, min(int(limit), SEARCH_LIMIT_MAX))
        except (TypeError, ValueError):
            shown_max = 10
        shown = []
        for score, entry, tags in matches[:shown_max]:
            hit = {"key": entry.get("key", ""), "tags": tags, "updated_at": entry.get("updated_at")}
            if terms:
                hit["score"] = score
            hit["snippet"] = _snippet(entry.get("value", ""), terms)
            shown.append(hit)
        return compact({
            "query": query or None,
            "tag": want_tag or None,
            "matches": shown,
            "shown": len(shown),
            "candidates": len(matches),
            "scanned": len(entries),
        })

    @server.tool()
    def memory_tags() -> str:
        """List the tag vocabulary in use: every tag with count + sample keys.

        Cheap topic digest of the whole store — call this first when unsure
        what to memory_search for. Entries without tags are counted too.
        """
        entries, err = _fetch_all(client)
        if err:
            return err
        by_tag = {}
        untagged = 0
        for entry in entries:
            tags = _tags_of(entry)
            if not tags:
                untagged += 1
            for t in tags:
                info = by_tag.setdefault(t, {"count": 0, "keys": []})
                info["count"] += 1
                if len(info["keys"]) < 3:
                    info["keys"].append(entry.get("key", ""))
        tags_out = [
            {"tag": t, "count": info["count"], "keys": info["keys"]}
            for t, info in sorted(by_tag.items(), key=lambda kv: (-kv[1]["count"], kv[0]))
        ]
        return compact({
            "tags": tags_out,
            "tag_kinds": len(tags_out),
            "entries": len(entries),
            "untagged": untagged,
        })

    @server.tool()
    def memory_list(key_prefix: str = "") -> str:
        """List memory entries, optionally filtered by key prefix (e.g. 'opencode:').

        Values are truncated; use memory_get for full content.
        """
        status, body = client.request("GET", client.list_path(key_prefix))
        if status != 200:
            return client.error(status, body)
        entries = body.get("memories", [])
        total = body.get("total", len(entries))
        shown = [
            {
                "key": e.get("key", ""),
                "value": truncate(str(e.get("value", "")), LIST_VALUE_LIMIT),
                "tags": _tags_of(e),
                "updated_at": e.get("updated_at"),
            }
            for e in entries[:LIST_ENTRY_LIMIT]
        ]
        result = compact({"entries": shown, "shown": len(shown), "total": total})
        if len(entries) > LIST_ENTRY_LIMIT:
            result += " [truncated at %d entries]" % LIST_ENTRY_LIMIT
        return result

    @server.tool()
    def memory_delete(key: str) -> str:
        """Delete one memory entry by its exact key. Irreversible."""
        key = _check_key(key)
        status, body = client.request("DELETE", client.entry_path(key))
        if status == 404:
            return "not found: " + key
        if status != 200:
            return client.error(status, body)
        return "deleted: " + key
