"""DB layer: schema, idempotent open, WAL."""

from app.db import TABLES, connect


def test_connect_creates_all_tables(tmp_path):
    conn = connect(tmp_path / "sc.db")
    rows = conn.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall()
    names = {row["name"] for row in rows}
    assert TABLES <= names


def test_connect_is_idempotent(tmp_path):
    connect(tmp_path / "sc.db")
    conn = connect(tmp_path / "sc.db")
    assert conn.execute("SELECT COUNT(*) AS c FROM agents").fetchone()["c"] == 0


def test_wal_mode_enabled(tmp_path):
    conn = connect(tmp_path / "sc.db")
    mode = conn.execute("PRAGMA journal_mode").fetchone()[0]
    assert mode == "wal"
