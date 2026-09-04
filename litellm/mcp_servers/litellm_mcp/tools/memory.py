"""LiteLLM memory API (/v1/memory) tools.

Durable cross-session key-value memory, scoped by the API key's user/team.
Key conventions: 'opencode:global:*' shared, 'opencode:<project>:*' per
project, 'user:<topic>' personal preferences.
"""

from ..litellm_client import LIST_ENTRY_LIMIT, LIST_VALUE_LIMIT, VALUE_LIMIT, compact, truncate

NAME = "memory"
DESCRIPTION = "LiteLLM proxy memory: durable key-value entries across sessions"


def _check_key(key):
    key = (key or "").strip()
    if not key:
        raise ValueError("key must not be empty")
    return key


def register(server, client):

    @server.tool()
    def memory_get(key: str) -> str:
        """Read one memory entry by its exact key (e.g. 'opencode:global:preferences').

        Returns key, value, metadata and updated_at. Use memory_list to discover keys.
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
            "metadata": body.get("metadata"),
            "updated_at": body.get("updated_at"),
        })

    @server.tool()
    def memory_set(key: str, value: str) -> str:
        """Create or update (upsert) a memory entry. Overwrites the previous value.

        Prefer namespaced keys: 'opencode:global:*' shared, 'opencode:<project>:*'
        per project, 'user:<topic>' for personal preferences.
        """
        key = _check_key(key)
        status, body = client.request("PUT", client.entry_path(key), {"value": value})
        if status != 200:
            return client.error(status, body)
        return compact({"ok": True, "key": key, "updated_at": body.get("updated_at")})

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
