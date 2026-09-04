"""Support both the older and newer official MCP Python SDK layouts.

The SDK moved transport options (host/port) from the FastMCP constructor
(older) to Server.run() (newer, FastMCP renamed MCPServer). The import is
deliberately lazy so ``--help``, the registry and tests work without the
``mcp`` package installed.
"""


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

    def run(self, transport="streamable-http"):
        if self._new_sdk:
            self._server.run(transport=transport, host=self.host, port=self.port)
        else:
            self._server.run(transport=transport)
