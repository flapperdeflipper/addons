"""Domain logic: presence, threads, todos, claims.

Every function takes an open connection; callers open one per request.
"""

import sqlite3
import time


def _audience_match(audience: str, name: str) -> bool:
    if audience.strip().lower() in ("", "all"):
        return True
    names = [part.strip() for part in audience.split(",") if part.strip()]
    return name in names


def _agents_with_active(
    conn: sqlite3.Connection, now: float, heartbeat_timeout: int
) -> tuple[list[dict], dict[str, bool]]:
    agents: list[dict] = []
    active_by_name: dict[str, bool] = {}
    for row in conn.execute("SELECT * FROM agents ORDER BY last_seen DESC"):
        active = (now - row["last_seen"]) <= heartbeat_timeout
        active_by_name[row["name"]] = active
        agents.append(
            {
                "name": row["name"],
                "session_id": row["session_id"],
                "note": row["note"],
                "started_at": row["started_at"],
                "last_seen": row["last_seen"],
                "active": active,
            }
        )
    return agents, active_by_name


def _claims_with_stale(
    conn: sqlite3.Connection, active_by_name: dict[str, bool]
) -> list[dict]:
    return [
        {
            "agent": row["agent"],
            "path": row["path"],
            "note": row["note"],
            "claimed_at": row["claimed_at"],
            "stale": not active_by_name.get(row["agent"], False),
        }
        for row in conn.execute("SELECT * FROM claims ORDER BY claimed_at DESC")
    ]


def overview(conn: sqlite3.Connection, heartbeat_timeout: int = 900) -> dict:
    """Everything the web UI shows: agents, claims, open threads and todos."""
    now = time.time()
    agents, active_by_name = _agents_with_active(conn, now, heartbeat_timeout)
    return {
        "server_time": now,
        "agents": agents,
        "claims": _claims_with_stale(conn, active_by_name),
        "open_threads": list_threads(conn, include_closed=False),
        "open_todos": [
            dict(row)
            for row in conn.execute(
                "SELECT * FROM todos WHERE done = 0 ORDER BY created_at DESC"
            )
        ],
    }


def hello(
    conn: sqlite3.Connection,
    name: str,
    session_id: str | None = None,
    note: str | None = None,
    heartbeat_timeout: int = 900,
) -> dict:
    """Register/refresh presence and return the awareness snapshot."""
    now = time.time()
    conn.execute(
        """
        INSERT INTO agents(name, session_id, note, started_at, last_seen)
        VALUES(?, ?, ?, ?, ?)
        ON CONFLICT(name) DO UPDATE SET
            session_id = COALESCE(excluded.session_id, agents.session_id),
            note = COALESCE(excluded.note, agents.note),
            last_seen = excluded.last_seen
        """,
        (name, session_id, note, now, now),
    )
    conn.commit()
    return snapshot(conn, name, heartbeat_timeout)


def snapshot(conn: sqlite3.Connection, me: str, heartbeat_timeout: int = 900) -> dict:
    """Everything an agent should see when it wakes up."""
    now = time.time()
    agents, active_by_name = _agents_with_active(conn, now, heartbeat_timeout)
    claims = _claims_with_stale(conn, active_by_name)

    threads_for_me = [
        dict(row)
        for row in conn.execute(
            "SELECT * FROM threads WHERE status = 'open' ORDER BY created_at DESC"
        )
        if _audience_match(row["audience"], me) and row["created_by"] != me
    ]

    my_todos = [
        dict(row)
        for row in conn.execute(
            """
            SELECT * FROM todos
            WHERE done = 0
              AND ((scope = 'session' AND session_key = ?) OR assignee = ?)
            ORDER BY created_at DESC
            """,
            (me, me),
        )
    ]

    return {
        "me": me,
        "server_time": now,
        "agents": agents,
        "claims": claims,
        "threads_for_me": threads_for_me,
        "my_todos": my_todos,
    }


THREAD_KINDS = {"info", "question", "proposal", "handover"}


def create_thread(
    conn: sqlite3.Connection,
    title: str,
    body: str,
    created_by: str,
    kind: str = "info",
    audience: str = "all",
) -> int:
    """Create a thread with its first message. Returns the thread id."""
    if kind not in THREAD_KINDS:
        raise ValueError(f"kind must be one of {sorted(THREAD_KINDS)}, got {kind!r}")
    now = time.time()
    cur = conn.execute(
        """
        INSERT INTO threads(title, kind, audience, status, created_by, created_at)
        VALUES(?, ?, ?, 'open', ?, ?)
        """,
        (title.strip(), kind, audience.strip() or "all", created_by, now),
    )
    tid = int(cur.lastrowid)
    conn.execute(
        "INSERT INTO messages(thread_id, author, body, created_at) VALUES(?, ?, ?, ?)",
        (tid, created_by, body, now),
    )
    conn.commit()
    return tid


def add_message(
    conn: sqlite3.Connection, thread_id: int, author: str, body: str
) -> int:
    """Append a reply. Raises ValueError for unknown or closed threads."""
    row = conn.execute(
        "SELECT status FROM threads WHERE id = ?", (thread_id,)
    ).fetchone()
    if row is None:
        raise ValueError(f"thread {thread_id} does not exist")
    if row["status"] != "open":
        raise ValueError(f"thread {thread_id} is closed")
    cur = conn.execute(
        "INSERT INTO messages(thread_id, author, body, created_at) VALUES(?, ?, ?, ?)",
        (thread_id, author, body, time.time()),
    )
    conn.commit()
    return int(cur.lastrowid)


def close_thread(conn: sqlite3.Connection, thread_id: int, outcome: str) -> None:
    """Close a thread, recording the decision. Raises ValueError if unknown/closed."""
    row = conn.execute(
        "SELECT status FROM threads WHERE id = ?", (thread_id,)
    ).fetchone()
    if row is None:
        raise ValueError(f"thread {thread_id} does not exist")
    if row["status"] != "open":
        raise ValueError(f"thread {thread_id} is already closed")
    conn.execute(
        "UPDATE threads SET status = 'closed', outcome = ?, closed_at = ? WHERE id = ?",
        (outcome, time.time(), thread_id),
    )
    conn.commit()


def thread_detail(conn: sqlite3.Connection, thread_id: int) -> dict | None:
    """Thread row plus its messages, or None."""
    row = conn.execute("SELECT * FROM threads WHERE id = ?", (thread_id,)).fetchone()
    if row is None:
        return None
    detail = dict(row)
    detail["messages"] = [
        dict(m)
        for m in conn.execute(
            "SELECT * FROM messages WHERE thread_id = ? ORDER BY created_at, id",
            (thread_id,),
        )
    ]
    return detail


def list_threads(conn: sqlite3.Connection, include_closed: bool = False) -> list[dict]:
    """Threads newest first, with message counts."""
    where = "" if include_closed else "WHERE status = 'open'"
    return [
        dict(row)
        for row in conn.execute(
            f"""
            SELECT t.*, COUNT(m.id) AS message_count
            FROM threads t LEFT JOIN messages m ON m.thread_id = t.id
            {where}
            GROUP BY t.id
            ORDER BY t.created_at DESC
            """
        )
    ]


def check(conn: sqlite3.Connection, me: str, since: float) -> dict:
    """Everything new for ``me`` since epoch ``since`` (strictly greater)."""
    now = time.time()
    open_threads = [
        dict(row)
        for row in conn.execute(
            "SELECT * FROM threads WHERE status = 'open' ORDER BY created_at"
        )
    ]
    visible_ids = {t["id"] for t in open_threads if _audience_match(t["audience"], me)}
    new_threads = [
        t
        for t in open_threads
        if t["created_at"] > since and t["created_by"] != me and t["id"] in visible_ids
    ]

    new_messages = [
        dict(row)
        for row in conn.execute(
            """
            SELECT m.* FROM messages m JOIN threads t ON t.id = m.thread_id
            WHERE m.created_at > ? AND t.status = 'open' AND m.author != ?
            ORDER BY m.created_at
            """,
            (since, me),
        )
        if row["thread_id"] in visible_ids
    ]

    new_todos = [
        dict(row)
        for row in conn.execute(
            """
            SELECT * FROM todos
            WHERE done = 0 AND created_at > ?
              AND ((scope = 'session' AND session_key = ?) OR assignee = ?)
            ORDER BY created_at
            """,
            (since, me, me),
        )
    ]

    return {
        "me": me,
        "server_time": now,
        "threads": new_threads,
        "messages": new_messages,
        "todos": new_todos,
    }


TODO_SCOPES = {"shared", "session"}


def add_todo(
    conn: sqlite3.Connection,
    body: str,
    created_by: str,
    scope: str = "shared",
    session_key: str | None = None,
    assignee: str | None = None,
) -> int:
    """Add a todo. Session-scoped todos default their key to the creator."""
    if scope not in TODO_SCOPES:
        raise ValueError(f"scope must be one of {sorted(TODO_SCOPES)}, got {scope!r}")
    if scope == "session" and not session_key:
        session_key = created_by
    cur = conn.execute(
        """
        INSERT INTO todos(body, scope, session_key, assignee, created_by, created_at)
        VALUES(?, ?, ?, ?, ?, ?)
        """,
        (body, scope, session_key, assignee, created_by, time.time()),
    )
    conn.commit()
    return int(cur.lastrowid)


def list_todos(
    conn: sqlite3.Connection,
    name: str | None = None,
    include_done: bool = False,
) -> list[dict]:
    """Open todos; with ``name``: shared plus that agent's session todos."""
    where, params = [], []
    if not include_done:
        where.append("done = 0")
    if name:
        where.append("(scope = 'shared' OR (scope = 'session' AND session_key = ?))")
        params.append(name)
    clause = f"WHERE {' AND '.join(where)}" if where else ""
    return [
        dict(row)
        for row in conn.execute(
            f"SELECT * FROM todos {clause} ORDER BY created_at DESC", params
        )
    ]


def done_todo(conn: sqlite3.Connection, todo_id: int) -> None:
    """Mark a todo done. Idempotent; ValueError for unknown ids."""
    row = conn.execute("SELECT done FROM todos WHERE id = ?", (todo_id,)).fetchone()
    if row is None:
        raise ValueError(f"todo {todo_id} does not exist")
    if row["done"]:
        return
    conn.execute(
        "UPDATE todos SET done = 1, done_at = ? WHERE id = ?", (time.time(), todo_id)
    )
    conn.commit()


def _paths_conflict(a: str, b: str) -> bool:
    """True when two paths are equal or one is a parent directory of the other."""
    a, b = a.rstrip("/"), b.rstrip("/")
    return a == b or a.startswith(b + "/") or b.startswith(a + "/")


def set_claims(
    conn: sqlite3.Connection, agent: str, paths: list[str], note: str | None = None
) -> int:
    """Announce the paths an agent is working on. Additive; returns claim count."""
    now = time.time()
    for path in paths:
        conn.execute(
            """
            INSERT INTO claims(agent, path, note, claimed_at) VALUES(?, ?, ?, ?)
            ON CONFLICT(agent, path) DO UPDATE SET
                note = COALESCE(excluded.note, claims.note),
                claimed_at = excluded.claimed_at
            """,
            (agent, path.rstrip("/"), note, now),
        )
    conn.commit()
    count = int(
        conn.execute(
            "SELECT COUNT(*) AS c FROM claims WHERE agent = ?", (agent,)
        ).fetchone()["c"]
    )
    return count


def check_claims(
    conn: sqlite3.Connection,
    path: str,
    agent: str | None = None,
    heartbeat_timeout: int = 900,
) -> list[dict]:
    """Active-or-stale claims conflicting with ``path``, excluding ``agent``'s own."""
    now = time.time()
    active = {
        row["name"]: (now - row["last_seen"]) <= heartbeat_timeout
        for row in conn.execute("SELECT name, last_seen FROM agents")
    }
    return [
        {
            "agent": row["agent"],
            "path": row["path"],
            "note": row["note"],
            "claimed_at": row["claimed_at"],
            "stale": not active.get(row["agent"], False),
        }
        for row in conn.execute("SELECT * FROM claims ORDER BY claimed_at DESC")
        if _paths_conflict(path, row["path"]) and row["agent"] != agent
    ]


def release_claims(conn: sqlite3.Connection, agent: str, paths: list[str]) -> None:
    """Drop an agent's claims on given paths. Unknown paths are ignored."""
    for path in paths:
        conn.execute(
            "DELETE FROM claims WHERE agent = ? AND path = ?", (agent, path.rstrip("/"))
        )
    conn.commit()
