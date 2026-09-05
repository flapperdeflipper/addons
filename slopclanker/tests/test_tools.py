"""MCP tools over the in-memory fastmcp Client."""

import pytest
from fastmcp import Client

from app.main import mcp


@pytest.fixture
def anyio_backend() -> str:
    return "asyncio"


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("SLOPCLANKER_DB", str(tmp_path / "tools.db"))
    monkeypatch.delenv("SLOPCLANKER_TOKEN", raising=False)
    return Client(mcp)


@pytest.mark.anyio
async def test_hello_snapshot_via_tool(client):
    async with client:
        result = await client.call_tool(
            "hello", {"name": "clanker-a", "note": "working on x"}
        )
        snap = result.data
        assert snap["me"] == "clanker-a"
        assert any(a["name"] == "clanker-a" and a["active"] for a in snap["agents"])


@pytest.mark.anyio
async def test_post_thread_reply_close_and_check(client):
    async with client:
        await client.call_tool("hello", {"name": "clanker-a"})
        await client.call_tool("hello", {"name": "clanker-b"})
        r = await client.call_tool(
            "post",
            {
                "title": "who merges?",
                "body": "I can do it",
                "author": "clanker-a",
                "kind": "proposal",
                "audience": "clanker-b",
            },
        )
        tid = r.data["id"]
        r = await client.call_tool(
            "post", {"thread_id": tid, "author": "clanker-b", "body": "ok"}
        )
        assert r.data["id"] > 0
        r = await client.call_tool("check", {"name": "clanker-b", "since": 0})
        assert any(t["title"] == "who merges?" for t in r.data["threads"])
        r = await client.call_tool("close", {"thread_id": tid, "outcome": "b merges"})
        assert r.data["ok"] is True
        r = await client.call_tool("check", {"name": "clanker-b", "since": 0})
        assert all(t["title"] != "who merges?" for t in r.data["threads"])


@pytest.mark.anyio
async def test_todos_tools(client):
    async with client:
        r = await client.call_tool(
            "todos_add", {"body": "bump version", "author": "clanker-a"}
        )
        tid = r.data["id"]
        r = await client.call_tool("todos_list", {"name": "clanker-a"})
        assert [t["body"] for t in r.data["todos"]] == ["bump version"]
        await client.call_tool("todos_done", {"todo_id": tid})
        r = await client.call_tool("todos_list", {"name": "clanker-a"})
        assert r.data["todos"] == []


@pytest.mark.anyio
async def test_claims_tools(client):
    async with client:
        await client.call_tool("hello", {"name": "clanker-a"})
        await client.call_tool(
            "claims_set",
            {"agent": "clanker-a", "paths": ["/repo/app"], "note": "refactor"},
        )
        r = await client.call_tool("claims_check", {"path": "/repo/app/main.py"})
        assert [c["agent"] for c in r.data["claims"]] == ["clanker-a"]
        r = await client.call_tool(
            "claims_check", {"path": "/repo/app/main.py", "agent": "clanker-a"}
        )
        assert r.data["claims"] == []
        await client.call_tool(
            "claims_release", {"agent": "clanker-a", "paths": ["/repo/app"]}
        )
        r = await client.call_tool("claims_check", {"path": "/repo/app/main.py"})
        assert r.data["claims"] == []
