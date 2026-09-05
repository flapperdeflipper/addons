// HTTP (streamable) transport for the ha-mcp-server.
//
// Serves the exact same tool set as the stdio server on a plain HTTP
// listener so sibling add-ons (e.g. the LiteLLM MCP gateway) and LAN
// clients can use it without a local process spawn. Every request must
// carry `Authorization: Bearer <MCP_HTTP_TOKEN>`; anything else is
// rejected before it reaches the MCP transport.
//
// The transport is stateful (session ids are issued on initialize and
// required afterwards), which lets the single module-level McpServer
// instance stay connected once instead of being rebuilt per request.

import { createServer } from "node:http";
import { randomUUID, timingSafeEqual } from "node:crypto";
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
 * Build the request listener used by the HTTP server. Split out from
 * startHttpMcpServer so tests can drive it with a fake transport.
 */
export function createMcpHttpListener({ token, transport, onUnauthorized } = {}) {
  if (!token) throw new Error("token is required");
  if (!transport || typeof transport.handleRequest !== "function") {
    throw new Error("transport with handleRequest is required");
  }
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
    transport.handleRequest(req, res);
  };
}

/**
 * Connect `mcpServer` to a stateful StreamableHTTPServerTransport and serve
 * it on `port`. Returns the node:http server (call .close() to stop).
 */
export async function startHttpMcpServer(mcpServer, { port, token, host = "0.0.0.0", log = () => {} } = {}) {
  if (!mcpServer || typeof mcpServer.connect !== "function") {
    throw new Error("mcpServer with connect() is required");
  }
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
  });
  await mcpServer.connect(transport);

  const httpServer = createServer(
    createMcpHttpListener({
      token,
      transport,
      onUnauthorized: (req) => log("warn", `unauthorized MCP http request from ${req.socket.remoteAddress}`),
    })
  );
  await new Promise((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(port, host, resolve);
  });
  return httpServer;
}
