"""MCP tool surface: thin wrappers over the store.

Registered onto the shared FastMCP instance via ``register(mcp)`` from
app.main. Tool names are short; through the LiteLLM gateway they appear
prefixed with the server alias (slopclanker_hello, ...).
"""

import os
from collections.abc import Iterator
from contextlib import contextmanager

from fastmcp import FastMCP

from app import store
from app.db import connect


@contextmanager
def _db() -> Iterator:
    conn = connect(os.environ.get("SLOPCLANKER_DB", "/data/slopclanker.db"))
    try:
        yield conn
    finally:
        conn.close()


def _heartbeat_timeout() -> int:
    return int(os.environ.get("SLOPCLANKER_HEARTBEAT_TIMEOUT", "900"))


def register(mcp: FastMCP) -> None:

    @mcp.tool
    def hello(
        name: str,
        session_id: str | None = None,
        note: str | None = None,
    ) -> dict:
        """Announce yourself and refresh your heartbeat. Call at session start
        and again whenever you want the full awareness snapshot: active
        clankers, their file claims, threads awaiting your input, and your
        todos. ``session_id`` should be your opencode session id so others can
        read your conversation via OpenChamber."""
        with _db() as conn:
            return store.hello(
                conn,
                name,
                session_id=session_id,
                note=note,
                heartbeat_timeout=_heartbeat_timeout(),
            )

    @mcp.tool
    def post(
        author: str,
        body: str,
        title: str | None = None,
        kind: str = "info",
        audience: str = "all",
        thread_id: int | None = None,
    ) -> dict:
        """Post to the townhall. Without ``thread_id`` this starts a new thread
        (``title`` required, kind one of info|question|proposal|handover);
        with ``thread_id`` it replies to that thread. ``audience`` is 'all' or
        a comma-separated list of clanker names - only they (and everyone for
        'all') will see it in their snapshot/check."""
        with _db() as conn:
            if thread_id is not None:
                mid = store.add_message(conn, thread_id, author, body)
                return {"id": mid, "thread_id": thread_id}
            if not title:
                raise ValueError("title is required when starting a new thread")
            tid = store.create_thread(
                conn, title, body, created_by=author, kind=kind, audience=audience
            )
            return {"id": tid, "thread_id": tid}

    @mcp.tool
    def check(name: str, since: float = 0.0) -> dict:
        """Poll what's new for you since epoch ``since`` (use server_time from
        your last hello/check as the next ``since``). Returns new threads,
        replies in threads visible to you, and new todos for you."""
        with _db() as conn:
            return store.check(conn, name, since=since)

    @mcp.tool
    def close(thread_id: int, outcome: str) -> dict:
        """Close a thread, recording the decision (e.g. 'clanker-b merges').
        The outcome is the record other clankers will read - state it clearly."""
        with _db() as conn:
            store.close_thread(conn, thread_id, outcome)
            return {"ok": True}

    @mcp.tool
    def todos_add(
        body: str,
        author: str,
        scope: str = "shared",
        assignee: str | None = None,
    ) -> dict:
        """Add a todo. scope 'shared' = team backlog everyone sees; 'session' =
        your own handover-to-self list (keyed to your name)."""
        with _db() as conn:
            return {
                "id": store.add_todo(
                    conn, body, created_by=author, scope=scope, assignee=assignee
                )
            }

    @mcp.tool
    def todos_list(name: str | None = None, include_done: bool = False) -> dict:
        """List todos. With ``name``: shared plus that clanker's session todos."""
        with _db() as conn:
            return {
                "todos": store.list_todos(conn, name=name, include_done=include_done)
            }

    @mcp.tool
    def todos_done(todo_id: int) -> dict:
        """Mark a todo done (idempotent)."""
        with _db() as conn:
            store.done_todo(conn, todo_id)
            return {"ok": True}

    @mcp.tool
    def claims_set(agent: str, paths: list[str], note: str | None = None) -> dict:
        """Claim the file/directory paths you are about to work on, with a
        short note why. Others check claims before editing the same paths.
        Re-claiming refreshes; claims go stale when your heartbeat stops."""
        with _db() as conn:
            return {"claims": store.set_claims(conn, agent, paths, note=note)}

    @mcp.tool
    def claims_check(path: str, agent: str | None = None) -> dict:
        """Check who else has claimed ``path`` or a parent/child of it (your
        own claims excluded when you pass ``agent``). Stale claims are marked;
        coordinate via a thread before touching contested paths."""
        with _db() as conn:
            return {
                "claims": store.check_claims(
                    conn, path, agent=agent, heartbeat_timeout=_heartbeat_timeout()
                )
            }

    @mcp.tool
    def claims_release(agent: str, paths: list[str]) -> dict:
        """Release your claims on paths when you are done with them."""
        with _db() as conn:
            store.release_claims(conn, agent, paths)
            return {"ok": True}
