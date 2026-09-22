// Stateless streamable-HTTP MCP handling for the MCP Hub.
//
// Forked from ha_opencode's ha-mcp-server lib/http-transport.js (MIT,
// flapperdeflipper). STATELESS on purpose: clients POST methods such as
// tools/list directly, without initialize or an Mcp-Session-Id (Home
// Assistant's own native MCP endpoint behaves the same way). Each request
// gets a fresh StreamableHTTPServerTransport connected to the module's
// server; the SDK allows one connected transport at a time, so requests are
// serialized through a promise chain instead of racing.
//
// The `server` can be any SDK server with connect() - both the high-level
// McpServer and the low-level Server used by the bundled modules qualify.

import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

/**
 * Per-request stateless handler around a single server instance.
 * Serialized through a promise chain because the SDK allows one connected
 * transport at a time; requests queue rather than race.
 */
export function createStatelessMcpHandler(mcpServer) {
  if (!mcpServer || typeof mcpServer.connect !== "function") {
    throw new Error("mcpServer with connect() is required");
  }
  let chain = Promise.resolve();
  return function handle(req, res) {
    chain = chain
      .then(async () => {
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: undefined,
          enableJsonResponse: true,
        });
        res.on("close", () => transport.close().catch(() => {}));
        await mcpServer.connect(transport);
        await transport.handleRequest(req, res);
      })
      .catch((error) => {
        if (!res.headersSent) {
          res.writeHead(500, { "content-type": "application/json" });
          res.end(
            JSON.stringify({
              jsonrpc: "2.0",
              error: { code: -32603, message: "internal error" },
              id: null,
            })
          );
        }
      });
  };
}
