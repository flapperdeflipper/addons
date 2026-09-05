// HTTP (streamable) transport for the ha-mcp-server.
//
// Serves the exact same tool set as the stdio server on a plain HTTP
// listener so sibling add-ons (e.g. the LiteLLM MCP gateway) and LAN
// clients can use it without a local process spawn. Every request must
// carry `Authorization: Bearer <MCP_HTTP_TOKEN>`; anything else is
// rejected before it reaches the MCP transport.
//
// STATELESS on purpose: gateway clients POST methods such as tools/list
// directly, without initialize or an Mcp-Session-Id (Home Assistant's own
// native MCP endpoint behaves the same way). Each request gets a fresh
// StreamableHTTPServerTransport; the single module-level McpServer is
// connected to it and disconnected again once the response closes, so
// concurrent requests never fight over one transport.

import { createServer } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

/** Constant-time bearer comparison; length leak is acceptable for a LAN token. */
export function tokenMatches(presented, expected) {
  if (typeof presented !== "string" || presented.length === 0) return false;
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function bearerFrom(headers) {
  const value = headers.authorization || "";
  const match = /^Bearer\s+(.+)$/i.exec(value);
  return match ? match[1].trim() : "";
}

/**
 * Per-request stateless handler around a single McpServer instance.
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

/**
 * Build the request listener used by the HTTP server. `handle` receives
 * authorized /mcp requests (a transport-like object or any function).
 */
export function createMcpHttpListener({ token, handle, onUnauthorized } = {}) {
  if (!token) throw new Error("token is required");
  const dispatch =
    typeof handle === "function"
      ? handle
      : handle && typeof handle.handleRequest === "function"
        ? (req, res) => handle.handleRequest(req, res)
        : null;
  if (!dispatch) throw new Error("handle function or transport with handleRequest is required");
  return function listener(req, res) {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (req.method === "GET" && url.pathname === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: "ok" }));
      return;
    }
    if (url.pathname !== "/mcp") {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not found" }));
      return;
    }
    if (!tokenMatches(bearerFrom(req.headers), token)) {
      if (onUnauthorized) onUnauthorized(req);
      res.writeHead(401, {
        "content-type": "application/json",
        "www-authenticate": 'Bearer realm="ha-mcp-server"',
      });
      res.end(
        JSON.stringify({
          jsonrpc: "2.0",
          error: { code: -32001, message: "unauthorized" },
          id: null,
        })
      );
      return;
    }
    dispatch(req, res);
  };
}

/**
 * Serve `mcpServer` statelessly (per-request transports) on `port`.
 * Returns the node:http server (call .close() to stop).
 */
export async function startHttpMcpServer(mcpServer, { port, token, host = "0.0.0.0", log = () => {} } = {}) {
  const httpServer = createServer(
    createMcpHttpListener({
      token,
      handle: createStatelessMcpHandler(mcpServer),
      onUnauthorized: (req) => log("warn", `unauthorized MCP http request from ${req.socket.remoteAddress}`),
    })
  );
  await new Promise((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(port, host, resolve);
  });
  return httpServer;
}
