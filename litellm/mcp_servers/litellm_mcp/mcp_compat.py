"""Support both the older and newer official MCP Python SDK layouts.

The SDK moved transport options (host/port) from the FastMCP constructor
(older) to Server.run() (newer, FastMCP renamed MCPServer). The import is
deliberately lazy so ``--help``, the registry and tests work without the
``mcp`` package installed.

Standalone streamable-http serving can enforce bearer-token client auth by
wrapping the SDK server's ASGI app (see BearerAuthMiddleware). The gateway
stdio path never authenticates - the proxy supervises it directly.
"""

import hmac
import json


class BearerAuthMiddleware:
    """ASGI middleware rejecting HTTP requests without the exact bearer token.

    Everything that is not an HTTP scope (lifespan, websocket) is passed
    through untouched. The comparison is constant-time. Tested without the
    MCP SDK installed (plain ASGI callables).
    """

    def __init__(self, app, token):
        self.app = app
        self.token = token

    async def __call__(self, scope, receive, send):
        if scope.get("type") != "http":
            await self.app(scope, receive, send)
            return

        # ASGI header names are lowercase bytes; normalize defensively anyway.
        headers = {bytes(key).lower(): value for key, value in scope.get("headers") or []}
        supplied = headers.get(b"authorization", b"").decode("latin-1")
        expected = "Bearer " + self.token
        if not hmac.compare_digest(supplied.encode("utf-8"), expected.encode("utf-8")):
            body = json.dumps({"error": "unauthorized"}).encode("utf-8")
            await send(
                {
                    "type": "http.response.start",
                    "status": 401,
                    "headers": [
                        (b"content-type", b"application/json"),
                        (b"content-length", str(len(body)).encode("ascii")),
                        (b"www-authenticate", b"Bearer"),
                    ],
                }
            )
            await send({"type": "http.response.body", "body": body})
            return

        await self.app(scope, receive, send)


def asgi_app(server):
    """Return the SDK server's streamable-HTTP ASGI app, or None.

    Tries the streamable-http accessor first; the older SSE name is the
    fallback for SDK builds that only expose that transport app.
    """
    for attr in ("streamable_http_app", "sse_app"):
        factory = getattr(server, attr, None)
        if callable(factory):
            return factory()
    return None


class ServerRunner:
    """Builds the MCP server now, serves it when run() is called."""

    def __init__(self, name, host, port):
        self.host = host
        self.port = port
        try:  # newer SDK
            from mcp.server.mcpserver import MCPServer

            self._server = MCPServer(name)
            self._new_sdk = True
        except ImportError:  # older SDK
            from mcp.server.fastmcp import FastMCP

            self._server = FastMCP(name, host=host, port=port)
            self._new_sdk = False

    @property
    def server(self):
        return self._server

    def run(self, transport="streamable-http", auth_token=None):
        if transport != "streamable-http" or not auth_token:
            # Gateway stdio child, or no token configured: serve exactly the
            # way the SDK would.
            if self._new_sdk:
                self._server.run(transport=transport, host=self.host, port=self.port)
            else:
                self._server.run(transport=transport)
            return

        # Authenticated standalone serving: wrap the SDK's own ASGI app so
        # every route (messages, SSE stream, session) sits behind the check.
        app = asgi_app(self._server)
        if app is None:
            raise RuntimeError(
                "this MCP SDK build exposes no streamable-http ASGI app; "
                "cannot enforce bearer auth, refusing to serve unauthenticated"
            )
        import uvicorn

        uvicorn.run(BearerAuthMiddleware(app, auth_token), host=self.host, port=self.port)
