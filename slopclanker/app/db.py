"""SQLite storage: schema + connection factory.

One connection per operation (WAL allows concurrent readers; writes queue
behind busy_timeout). All timestamps are epoch seconds (float).
"""

import sqlite3
from pathlib import Path

TABLES = {"agents", "threads", "messages", "todos", "claims"}

SCHEMA = """
CREATE TABLE IF NOT EXISTS agents(
    name       TEXT PRIMARY KEY,
    session_id TEXT,
    note       TEXT,
    started_at REAL NOT NULL,
    last_seen  REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS threads(
    id         INTEGER PRIMARY KEY,
    title      TEXT NOT NULL,
    kind       TEXT NOT NULL DEFAULT 'info',
    audience   TEXT NOT NULL DEFAULT 'all',
    status     TEXT NOT NULL DEFAULT 'open',
    outcome    TEXT,
    created_by TEXT NOT NULL,
    created_at REAL NOT NULL,
    closed_at  REAL
);

CREATE TABLE IF NOT EXISTS messages(
    id         INTEGER PRIMARY KEY,
    thread_id  INTEGER NOT NULL REFERENCES threads(id),
    author     TEXT NOT NULL,
    body       TEXT NOT NULL,
    created_at REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS todos(
    id          INTEGER PRIMARY KEY,
    body        TEXT NOT NULL,
    done        INTEGER NOT NULL DEFAULT 0,
    scope       TEXT NOT NULL DEFAULT 'shared',
    session_key TEXT,
    assignee    TEXT,
    created_by  TEXT NOT NULL,
    created_at  REAL NOT NULL,
    done_at     REAL
);

CREATE TABLE IF NOT EXISTS claims(
    agent      TEXT NOT NULL,
    path       TEXT NOT NULL,
    note       TEXT,
    claimed_at REAL NOT NULL,
    PRIMARY KEY(agent, path)
);

CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages(thread_id);
CREATE INDEX IF NOT EXISTS idx_messages_created ON messages(created_at);
CREATE INDEX IF NOT EXISTS idx_threads_created ON threads(created_at);
CREATE INDEX IF NOT EXISTS idx_todos_scope ON todos(scope);
CREATE INDEX IF NOT EXISTS idx_claims_path ON claims(path);
"""


def connect(path: str | Path) -> sqlite3.Connection:
    """Open (and migrate-create) the database at ``path``. Idempotent."""
    conn = sqlite3.connect(str(path), timeout=5.0)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    conn.executescript(SCHEMA)
    conn.commit()
    return conn
