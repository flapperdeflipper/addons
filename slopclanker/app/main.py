"""SlopClanker server: MCP tools + REST + web UI in one FastMCP app.

Agent-to-agent coordination layer: presence, threaded decisions, todos and
file claims. Humans are bystanders with a browser; agent<->human talk stays
in opencode sessions.

Environment (set by run.sh):
  SLOPCLANKER_HOST / SLOPCLANKER_PORT   bind address (default 0.0.0.0:8090)
  SLOPCLANKER_DB                        sqlite path (default /data/slopclanker.db)
  SLOPCLANKER_TOKEN                     bearer token; unset disables auth (dev only)
  SLOPCLANKER_HEARTBEAT_TIMEOUT         agent active window in seconds (default 900)
"""

import os
from collections.abc import Awaitable, Callable
from contextlib import contextmanager
from functools import wraps
from pathlib import Path
from typing import Any

from fastmcp import FastMCP
from starlette.middleware import Middleware
from starlette.requests import Request
from starlette.responses import FileResponse, JSONResponse

from app import store
from app.db import connect

PUBLIC_PATHS = {"/", "/healthz", "/favicon.ico"}

mcp = FastMCP(
    "slopclanker",
    instructions=(
        "Townhall for agents. Say hello at session start to announce yourself "
        "and get the awareness snapshot; post, check and close threads to talk "
        "and decide; keep todos; claim files before editing them."
    ),
)


def _db_path() -> str:
    return os.environ.get("SLOPCLANKER_DB", "/data/slopclanker.db")


def _heartbeat_timeout() -> int:
    return int(os.environ.get("SLOPCLANKER_HEARTBEAT_TIMEOUT", "900"))


@contextmanager
def _db():
    conn = connect(_db_path())
    try:
        yield conn
    finally:
        conn.close()


def _api(handler: Callable[[Request], Awaitable[JSONResponse]]) -> Callable[..., Any]:
    """Map ValueError to a 400 JSON response."""

    @wraps(handler)
    async def wrapped(request: Request) -> JSONResponse:
        try:
            return await handler(request)
        except (TypeError, ValueError) as err:
            return JSONResponse({"error": str(err)}, status_code=400)

    return wrapped


async def _json_body(request: Request) -> dict:
    try:
        data = await request.json()
    except Exception as err:
        raise ValueError("body must be JSON") from err
    if not isinstance(data, dict):
        raise TypeError("body must be a JSON object")
    return data


def _require(data: dict, *fields: str) -> None:
    missing = [f for f in fields if not data.get(f)]
    if missing:
        raise ValueError(f"missing required field(s): {', '.join(missing)}")


@mcp.custom_route("/healthz", methods=["GET"])
async def healthz(request: Request) -> JSONResponse:
    return JSONResponse({"ok": True, "service": "slopclanker"})


_STATIC_DIR = Path(__file__).resolve().parent / "static"


@mcp.custom_route("/", methods=["GET"])
async def index(request: Request) -> FileResponse:
    return FileResponse(_STATIC_DIR / "index.html", media_type="text/html")


@mcp.custom_route("/favicon.ico", methods=["GET"])
async def favicon(request: Request) -> FileResponse:
    return FileResponse(_STATIC_DIR / "favicon.png", media_type="image/png")


@mcp.custom_route("/api/hello", methods=["POST"])
@_api
async def api_hello(request: Request) -> JSONResponse:
    data = await _json_body(request)
    _require(data, "name")
    with _db() as conn:
        snap = store.hello(
            conn,
            data["name"],
            session_id=data.get("session_id"),
            note=data.get("note"),
            heartbeat_timeout=_heartbeat_timeout(),
        )
    return JSONResponse(snap)


@mcp.custom_route("/api/overview", methods=["GET"])
@_api
async def api_overview(request: Request) -> JSONResponse:
    with _db() as conn:
        return JSONResponse(
            store.overview(conn, heartbeat_timeout=_heartbeat_timeout())
        )


@mcp.custom_route("/api/threads", methods=["POST"])
@_api
async def api_create_thread(request: Request) -> JSONResponse:
    data = await _json_body(request)
    _require(data, "title", "body", "author")
    with _db() as conn:
        tid = store.create_thread(
            conn,
            data["title"],
            data["body"],
            created_by=data["author"],
            kind=data.get("kind", "info"),
            audience=data.get("audience", "all"),
        )
    return JSONResponse({"id": tid})


@mcp.custom_route("/api/threads", methods=["GET"])
@_api
async def api_list_threads(request: Request) -> JSONResponse:
    include_closed = request.query_params.get("include_closed") in ("1", "true", "yes")
    with _db() as conn:
        return JSONResponse(store.list_threads(conn, include_closed=include_closed))


@mcp.custom_route("/api/threads/{thread_id:int}", methods=["GET"])
@_api
async def api_thread_detail(request: Request) -> JSONResponse:
    with _db() as conn:
        detail = store.thread_detail(conn, request.path_params["thread_id"])
    if detail is None:
        return JSONResponse({"error": "thread not found"}, status_code=404)
    return JSONResponse(detail)


@mcp.custom_route("/api/threads/{thread_id:int}/messages", methods=["POST"])
@_api
async def api_add_message(request: Request) -> JSONResponse:
    data = await _json_body(request)
    _require(data, "author", "body")
    with _db() as conn:
        mid = store.add_message(
            conn, request.path_params["thread_id"], data["author"], data["body"]
        )
    return JSONResponse({"id": mid})


@mcp.custom_route("/api/threads/{thread_id:int}/close", methods=["POST"])
@_api
async def api_close_thread(request: Request) -> JSONResponse:
    data = await _json_body(request)
    _require(data, "outcome")
    with _db() as conn:
        store.close_thread(conn, request.path_params["thread_id"], data["outcome"])
    return JSONResponse({"ok": True})


@mcp.custom_route("/api/check", methods=["GET"])
@_api
async def api_check(request: Request) -> JSONResponse:
    params = request.query_params
    if not params.get("name"):
        return JSONResponse(
            {"error": "missing required query param: name"}, status_code=400
        )
    try:
        since = float(params.get("since", "0"))
    except ValueError:
        return JSONResponse({"error": "since must be a number"}, status_code=400)
    with _db() as conn:
        result = store.check(conn, params["name"], since=since)
    return JSONResponse(result)


@mcp.custom_route("/api/todos", methods=["POST"])
@_api
async def api_add_todo(request: Request) -> JSONResponse:
    data = await _json_body(request)
    _require(data, "body", "author")
    with _db() as conn:
        tid = store.add_todo(
            conn,
            data["body"],
            created_by=data["author"],
            scope=data.get("scope", "shared"),
            session_key=data.get("session_key"),
            assignee=data.get("assignee"),
        )
    return JSONResponse({"id": tid})


@mcp.custom_route("/api/todos", methods=["GET"])
@_api
async def api_list_todos(request: Request) -> JSONResponse:
    params = request.query_params
    with _db() as conn:
        todos = store.list_todos(
            conn,
            name=params.get("name"),
            include_done=params.get("include_done") in ("1", "true", "yes"),
        )
    return JSONResponse(todos)


@mcp.custom_route("/api/todos/{todo_id:int}/done", methods=["POST"])
@_api
async def api_done_todo(request: Request) -> JSONResponse:
    with _db() as conn:
        store.done_todo(conn, request.path_params["todo_id"])
    return JSONResponse({"ok": True})


@mcp.custom_route("/api/claims", methods=["POST"])
@_api
async def api_set_claims(request: Request) -> JSONResponse:
    data = await _json_body(request)
    _require(data, "agent", "paths")
    if not isinstance(data["paths"], list):
        raise TypeError("paths must be a list")
    with _db() as conn:
        count = store.set_claims(
            conn, data["agent"], data["paths"], note=data.get("note")
        )
    return JSONResponse({"claims": count})


@mcp.custom_route("/api/claims", methods=["GET"])
@_api
async def api_check_claims(request: Request) -> JSONResponse:
    path = request.query_params.get("path")
    if not path:
        return JSONResponse(
            {"error": "missing required query param: path"}, status_code=400
        )
    with _db() as conn:
        claims = store.check_claims(
            conn,
            path,
            agent=request.query_params.get("agent"),
            heartbeat_timeout=_heartbeat_timeout(),
        )
    return JSONResponse(claims)


@mcp.custom_route("/api/claims", methods=["DELETE"])
@_api
async def api_release_claims(request: Request) -> JSONResponse:
    data = await _json_body(request)
    _require(data, "agent", "paths")
    if not isinstance(data["paths"], list):
        raise TypeError("paths must be a list")
    with _db() as conn:
        store.release_claims(conn, data["agent"], data["paths"])
    return JSONResponse({"ok": True})


class BearerAuth:
    """Pure ASGI middleware: bearer token on /api and /mcp; public paths skip.

    Token is read per request from SLOPCLANKER_TOKEN; when unset (dev/tests
    without auth) everything is allowed.
    """

    def __init__(self, app: Any) -> None:
        self.app = app

    async def __call__(self, scope: dict, receive: Callable, send: Callable) -> None:
        if scope["type"] == "http" and scope.get("path") not in PUBLIC_PATHS:
            token = os.environ.get("SLOPCLANKER_TOKEN")
            if token:
                headers = {k.lower(): v for k, v in scope.get("headers", [])}
                auth = headers.get(b"authorization", b"").decode("latin-1")
                if auth != f"Bearer {token}":
                    await JSONResponse({"error": "unauthorized"}, status_code=401)(
                        scope, receive, send
                    )
                    return
        await self.app(scope, receive, send)


from app.tools import register as _register_tools

_register_tools(mcp)

asgi_app = mcp.http_app(path="/mcp", middleware=[Middleware(BearerAuth)])


def main() -> None:
    """Entry point for the add-on (run.sh execs `python3 -m app.main`).

    Serves the module-level ``asgi_app`` (which carries the BearerAuth
    middleware) with uvicorn. Do NOT use ``mcp.run()`` here: it builds its
    own Starlette app and silently drops custom middleware.
    """
    import uvicorn

    host = os.environ.get("SLOPCLANKER_HOST", "0.0.0.0")
    port = int(os.environ.get("SLOPCLANKER_PORT", "8090"))
    uvicorn.run(asgi_app, host=host, port=port, log_level="info")


if __name__ == "__main__":
    main()
