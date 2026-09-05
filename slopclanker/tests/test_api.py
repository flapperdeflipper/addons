"""REST API over ASGI: routes, error mapping, bearer auth."""

import pytest
from httpx import ASGITransport, AsyncClient

from app.main import asgi_app

TOKEN = "test-token"


@pytest.fixture
def anyio_backend() -> str:
    return "asyncio"


@pytest.fixture
async def client(tmp_path, monkeypatch):
    monkeypatch.setenv("SLOPCLANKER_DB", str(tmp_path / "api.db"))
    monkeypatch.setenv("SLOPCLANKER_TOKEN", TOKEN)
    transport = ASGITransport(app=asgi_app)
    async with AsyncClient(transport=transport, base_url="http://test") as c:
        yield c


@pytest.fixture
def anon(tmp_path, monkeypatch):
    monkeypatch.setenv("SLOPCLANKER_DB", str(tmp_path / "anon.db"))
    monkeypatch.setenv("SLOPCLANKER_TOKEN", TOKEN)
    transport = ASGITransport(app=asgi_app)
    return AsyncClient(transport=transport, base_url="http://test")


def _auth(client) -> dict:
    return {"Authorization": f"Bearer {TOKEN}"}


@pytest.mark.anyio
async def test_hello_roundtrip(client):
    r = await client.post(
        "/api/hello", json={"name": "clanker-a", "note": "hi"}, headers=_auth(client)
    )
    assert r.status_code == 200
    snap = r.json()
    assert snap["me"] == "clanker-a"
    assert any(a["name"] == "clanker-a" for a in snap["agents"])


@pytest.mark.anyio
async def test_hello_requires_name(client):
    r = await client.post("/api/hello", json={}, headers=_auth(client))
    assert r.status_code == 400
    assert "name" in r.json()["error"]


@pytest.mark.anyio
async def test_thread_flow(client):
    r = await client.post(
        "/api/threads",
        json={
            "title": "who merges?",
            "body": "I can",
            "author": "clanker-a",
            "kind": "proposal",
            "audience": "all",
        },
        headers=_auth(client),
    )
    tid = r.json()["id"]
    r = await client.post(
        f"/api/threads/{tid}/messages",
        json={"author": "clanker-b", "body": "go ahead"},
        headers=_auth(client),
    )
    assert r.status_code == 200
    r = await client.post(
        f"/api/threads/{tid}/close", json={"outcome": "b merges"}, headers=_auth(client)
    )
    assert r.status_code == 200
    r = await client.post(
        f"/api/threads/{tid}/messages",
        json={"author": "clanker-a", "body": "late"},
        headers=_auth(client),
    )
    assert r.status_code == 400
    r = await client.get(f"/api/threads/{tid}", headers=_auth(client))
    detail = r.json()
    assert detail["status"] == "closed"
    assert detail["outcome"] == "b merges"
    assert len(detail["messages"]) == 2


@pytest.mark.anyio
async def test_todos_flow(client):
    r = await client.post(
        "/api/todos",
        json={"body": "task", "author": "clanker-a"},
        headers=_auth(client),
    )
    todo_id = r.json()["id"]
    r = await client.get(
        "/api/todos", params={"name": "clanker-a"}, headers=_auth(client)
    )
    assert [t["body"] for t in r.json()] == ["task"]
    r = await client.post(f"/api/todos/{todo_id}/done", headers=_auth(client))
    assert r.status_code == 200
    r = await client.get(
        "/api/todos", params={"name": "clanker-a"}, headers=_auth(client)
    )
    assert r.json() == []


@pytest.mark.anyio
async def test_claims_flow(client):
    await client.post("/api/hello", json={"name": "clanker-a"}, headers=_auth(client))
    r = await client.post(
        "/api/claims",
        json={"agent": "clanker-a", "paths": ["/repo/x"], "note": "bumping"},
        headers=_auth(client),
    )
    assert r.status_code == 200
    r = await client.get(
        "/api/claims", params={"path": "/repo/x/y"}, headers=_auth(client)
    )
    assert [c["agent"] for c in r.json()] == ["clanker-a"]
    r = await client.request(
        "DELETE",
        "/api/claims",
        json={"agent": "clanker-a", "paths": ["/repo/x"]},
        headers=_auth(client),
    )
    assert r.status_code == 200
    r = await client.get(
        "/api/claims", params={"path": "/repo/x/y"}, headers=_auth(client)
    )
    assert r.json() == []


@pytest.mark.anyio
async def test_check_endpoint(client):
    await client.post("/api/hello", json={"name": "clanker-a"}, headers=_auth(client))
    r = await client.get(
        "/api/check", params={"name": "clanker-b", "since": 0}, headers=_auth(client)
    )
    assert r.status_code == 200
    body = r.json()
    assert body["me"] == "clanker-b"


@pytest.mark.anyio
async def test_auth_missing_or_wrong_token(anon):
    async with anon:
        r = await anon.post("/api/hello", json={"name": "x"})
        assert r.status_code == 401
        r = await anon.post(
            "/api/hello", json={"name": "x"}, headers={"Authorization": "Bearer wrong"}
        )
        assert r.status_code == 401
        r = await anon.get("/healthz")
        assert r.status_code == 200


@pytest.mark.anyio
async def test_bad_kind_maps_to_400(client):
    r = await client.post(
        "/api/threads",
        json={"title": "t", "body": "b", "author": "a", "kind": "rant"},
        headers=_auth(client),
    )
    assert r.status_code == 400


@pytest.mark.anyio
async def test_overview_endpoint(client):
    await client.post("/api/hello", json={"name": "clanker-a"}, headers=_auth(client))
    r = await client.get("/api/overview", headers=_auth(client))
    assert r.status_code == 200
    body = r.json()
    assert {"server_time", "agents", "claims", "open_threads", "open_todos"} <= set(
        body
    )
    assert any(a["name"] == "clanker-a" for a in body["agents"])


@pytest.mark.anyio
async def test_index_serves_ui(client):
    r = await client.get("/")
    assert r.status_code == 200
    assert "text/html" in r.headers["content-type"]
    assert "SlopClanker" in r.text
    assert "#gate[hidden]{display:none}" in r.text


@pytest.mark.anyio
async def test_favicon_public(client):
    r = await client.get("/favicon.ico")
    assert r.status_code == 200
    assert r.headers["content-type"].startswith("image/png")
