"""Store domain logic: presence and the awareness snapshot."""

import time

import pytest

from app import store
from app.db import connect


@pytest.fixture
def conn(tmp_path):
    return connect(tmp_path / "sc.db")


def test_hello_registers_agent(conn):
    snap = store.hello(conn, "clanker-a", heartbeat_timeout=900)
    agents = {a["name"]: a for a in snap["agents"]}
    assert "clanker-a" in agents
    assert agents["clanker-a"]["active"] is True
    assert snap["server_time"] > 0


def test_second_agent_sees_first(conn):
    store.hello(conn, "clanker-a", heartbeat_timeout=900)
    snap = store.hello(conn, "clanker-b", heartbeat_timeout=900)
    names = {a["name"] for a in snap["agents"]}
    assert names == {"clanker-a", "clanker-b"}


def test_inactive_agent_flagged(conn):
    store.hello(conn, "clanker-a", heartbeat_timeout=900)
    stale = time.time() - 3600
    conn.execute("UPDATE agents SET last_seen = ? WHERE name = 'clanker-a'", (stale,))
    snap = store.hello(conn, "clanker-b", heartbeat_timeout=900)
    agents = {a["name"]: a for a in snap["agents"]}
    assert agents["clanker-a"]["active"] is False
    assert agents["clanker-b"]["active"] is True


def test_hello_updates_note_and_session_but_keeps_started_at(conn):
    snap1 = store.hello(
        conn, "clanker-a", session_id="sess-1", note="first", heartbeat_timeout=900
    )
    snap2 = store.hello(
        conn, "clanker-a", session_id="sess-2", note="second", heartbeat_timeout=900
    )
    a1 = {a["name"]: a for a in snap1["agents"]}["clanker-a"]
    a2 = {a["name"]: a for a in snap2["agents"]}["clanker-a"]
    assert a2["note"] == "second"
    assert a2["session_id"] == "sess-2"
    assert a2["started_at"] == a1["started_at"]
    assert a2["last_seen"] >= a1["last_seen"]


# --- threads -----------------------------------------------------------


def test_create_thread_adds_first_message(conn):
    tid = store.create_thread(
        conn,
        "Who merges?",
        "I can do it.",
        created_by="clanker-a",
        kind="proposal",
        audience="clanker-b",
    )
    detail = store.thread_detail(conn, tid)
    assert detail["title"] == "Who merges?"
    assert detail["kind"] == "proposal"
    assert detail["status"] == "open"
    assert len(detail["messages"]) == 1
    assert detail["messages"][0]["author"] == "clanker-a"


def test_add_message_appends(conn):
    tid = store.create_thread(conn, "t", "b", created_by="clanker-a")
    store.add_message(conn, tid, "clanker-b", "reply")
    detail = store.thread_detail(conn, tid)
    assert [m["body"] for m in detail["messages"]] == ["b", "reply"]


def test_add_message_unknown_thread_raises(conn):
    with pytest.raises(ValueError):
        store.add_message(conn, 999, "clanker-a", "hi")


def test_close_blocks_replies_and_records_outcome(conn):
    tid = store.create_thread(conn, "t", "b", created_by="clanker-a")
    store.close_thread(conn, tid, outcome="clanker-b merges")
    with pytest.raises(ValueError):
        store.add_message(conn, tid, "clanker-a", "too late")
    detail = store.thread_detail(conn, tid)
    assert detail["status"] == "closed"
    assert detail["outcome"] == "clanker-b merges"
    assert detail["closed_at"] is not None


def test_close_unknown_thread_raises(conn):
    with pytest.raises(ValueError):
        store.close_thread(conn, 999, outcome="x")


def test_create_thread_rejects_unknown_kind(conn):
    with pytest.raises(ValueError):
        store.create_thread(conn, "t", "b", created_by="clanker-a", kind="rant")


def test_snapshot_threads_for_me_audience(conn):
    store.hello(conn, "clanker-a", heartbeat_timeout=900)
    store.hello(conn, "clanker-b", heartbeat_timeout=900)
    store.hello(conn, "clanker-c", heartbeat_timeout=900)
    store.create_thread(
        conn, "for b", "b please weigh in", created_by="clanker-a", audience="clanker-b"
    )
    store.create_thread(conn, "for all", "fyi", created_by="clanker-a")

    snap_b = store.snapshot(conn, "clanker-b")
    titles_b = {t["title"] for t in snap_b["threads_for_me"]}
    snap_c = store.snapshot(conn, "clanker-c")
    titles_c = {t["title"] for t in snap_c["threads_for_me"]}
    snap_a = store.snapshot(conn, "clanker-a")

    assert titles_b == {"for b", "for all"}
    assert titles_c == {"for all"}
    assert snap_a["threads_for_me"] == []


# --- check -------------------------------------------------------------


def test_check_returns_new_threads_and_nothing_after(conn):
    store.hello(conn, "clanker-a", heartbeat_timeout=900)
    store.hello(conn, "clanker-b", heartbeat_timeout=900)
    t0 = time.time()
    store.create_thread(conn, "fresh", "news", created_by="clanker-a")
    result = store.check(conn, "clanker-b", since=t0)
    assert [t["title"] for t in result["threads"]] == ["fresh"]
    t1 = time.time()
    result = store.check(conn, "clanker-b", since=t1)
    assert result["threads"] == [] and result["messages"] == []


def test_check_includes_replies_to_my_threads_but_not_my_own_posts(conn):
    store.hello(conn, "clanker-a", heartbeat_timeout=900)
    tid = store.create_thread(conn, "mine", "question", created_by="clanker-a")
    t0 = time.time()
    store.add_message(conn, tid, "clanker-b", "answer")
    store.add_message(conn, tid, "clanker-a", "thanks")
    result = store.check(conn, "clanker-a", since=t0)
    assert [m["body"] for m in result["messages"]] == ["answer"]


def test_check_excludes_threads_not_addressed_to_me(conn):
    store.hello(conn, "clanker-a", heartbeat_timeout=900)
    store.create_thread(
        conn, "private", "b only", created_by="clanker-a", audience="clanker-b"
    )
    t0 = time.time()
    result = store.check(conn, "clanker-c", since=t0)
    assert result["threads"] == []


# --- todos -------------------------------------------------------------


def test_add_shared_todo_and_list(conn):
    tid = store.add_todo(conn, "bump litellm version", created_by="clanker-a")
    todos = store.list_todos(conn)
    assert [t["body"] for t in todos] == ["bump litellm version"]
    assert todos[0]["scope"] == "shared"
    assert todos[0]["done"] == 0
    assert tid == todos[0]["id"]


def test_session_todo_defaults_to_creator_key(conn):
    store.add_todo(conn, "self reminder", created_by="clanker-a", scope="session")
    mine = store.list_todos(conn, name="clanker-a")
    other = store.list_todos(conn, name="clanker-b")
    assert [t["body"] for t in mine] == ["self reminder"]
    assert other == []


def test_list_todos_name_includes_shared_and_own_session(conn):
    store.add_todo(conn, "shared one", created_by="clanker-a")
    store.add_todo(conn, "private one", created_by="clanker-a", scope="session")
    store.add_todo(conn, "private two", created_by="clanker-b", scope="session")
    got = store.list_todos(conn, name="clanker-a")
    assert {t["body"] for t in got} == {"shared one", "private one"}


def test_done_todo_marks_idempotent_and_unknown_raises(conn):
    tid = store.add_todo(conn, "task", created_by="clanker-a")
    store.done_todo(conn, tid)
    store.done_todo(conn, tid)  # idempotent
    todos = store.list_todos(conn, include_done=True)
    assert todos[0]["done"] == 1
    assert todos[0]["done_at"] is not None
    with pytest.raises(ValueError):
        store.done_todo(conn, 999)


def test_add_todo_rejects_bad_scope(conn):
    with pytest.raises(ValueError):
        store.add_todo(conn, "x", created_by="clanker-a", scope="global")


# --- claims ------------------------------------------------------------


def test_set_and_check_claims_exact_and_prefix(conn):
    store.hello(conn, "clanker-a", heartbeat_timeout=900)
    store.set_claims(
        conn, "clanker-a", ["/homeassistant/addons/litellm"], note="version bump"
    )
    exact = store.check_claims(conn, "/homeassistant/addons/litellm/run.sh")
    parent = store.check_claims(conn, "/homeassistant/addons/litellm")
    child_scope = store.check_claims(conn, "/homeassistant/addons")
    unrelated = store.check_claims(conn, "/homeassistant/configuration.yaml")
    assert [c["agent"] for c in exact] == ["clanker-a"]
    assert [c["agent"] for c in parent] == ["clanker-a"]
    assert [c["agent"] for c in child_scope] == ["clanker-a"]
    assert unrelated == []


def test_check_excludes_own_claims(conn):
    store.hello(conn, "clanker-a", heartbeat_timeout=900)
    store.set_claims(conn, "clanker-a", ["/p/x"])
    assert store.check_claims(conn, "/p/x", agent="clanker-a") == []
    assert len(store.check_claims(conn, "/p/x")) == 1


def test_claims_flagged_stale_when_agent_inactive(conn):
    store.hello(conn, "clanker-a", heartbeat_timeout=900)
    store.set_claims(conn, "clanker-a", ["/p/x"])
    stale = time.time() - 3600
    conn.execute("UPDATE agents SET last_seen = ? WHERE name = 'clanker-a'", (stale,))
    got = store.check_claims(conn, "/p/x", agent="clanker-b")
    assert got[0]["stale"] is True


def test_release_claims(conn):
    store.hello(conn, "clanker-a", heartbeat_timeout=900)
    store.set_claims(conn, "clanker-a", ["/p/x", "/p/y"])
    store.release_claims(conn, "clanker-a", ["/p/x", "/p/never-claimed"])
    snap = store.snapshot(conn, "clanker-b")
    assert [c["path"] for c in snap["claims"]] == ["/p/y"]


def test_snapshot_includes_claims_with_staleness(conn):
    store.hello(conn, "clanker-a", heartbeat_timeout=900)
    store.hello(conn, "clanker-b", heartbeat_timeout=900)
    store.set_claims(conn, "clanker-a", ["/p/a"])
    store.set_claims(conn, "clanker-b", ["/p/b"])
    conn.execute(
        "UPDATE agents SET last_seen = ? WHERE name = 'clanker-b'",
        (time.time() - 9999,),
    )
    snap = store.snapshot(conn, "clanker-b")
    flags = {c["path"]: c["stale"] for c in snap["claims"]}
    assert flags == {"/p/a": False, "/p/b": True}
