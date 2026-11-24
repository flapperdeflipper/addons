import { describe, it, expect, afterEach } from "vitest";
import { createServer } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createMcpHttpListener, createStatelessMcpHandler, tokenMatches } from "../lib/http-transport.js";

// Drive the listener through a real socket so tests exercise header
// parsing the way litellm and other HTTP clients will.
const TOKEN = "test-bearer-token";
const servers = [];

async function serve(listener) {
  const httpServer = createServer(listener);
  await new Promise((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  servers.push(httpServer);
  const { port } = httpServer.address();
  return `http://127.0.0.1:${port}`;
}

function fakeTransport() {
  const calls = [];
  return {
    calls,
    handleRequest(req, res) {
      calls.push({ method: req.method, url: req.url, headers: req.headers });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    },
  };
}

afterEach(() => {
  while (servers.length) servers.pop().close();
});

describe("tokenMatches", () => {
  it("accepts the exact token", () => {
    expect(tokenMatches("abc", "abc")).toBe(true);
  });
  it("rejects wrong or empty values", () => {
    expect(tokenMatches("abc", "abd")).toBe(false);
    expect(tokenMatches("", "abc")).toBe(false);
    expect(tokenMatches(undefined, "abc")).toBe(false);
  });
  it("rejects length-mismatched values without throwing", () => {
    expect(tokenMatches("a", "abcd")).toBe(false);
    expect(tokenMatches("abcd", "ab")).toBe(false);
  });
});

describe("createMcpHttpListener", () => {
  it("returns 401 without a bearer header", async () => {
    const transport = fakeTransport();
    const base = await serve(createMcpHttpListener({ token: TOKEN, handle: transport.handleRequest.bind(transport) }));
    const res = await fetch(`${base}/mcp`, { method: "POST" });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain("Bearer");
    expect(transport.calls.length).toBe(0);
  });

  it("returns 401 for a wrong token", async () => {
    const transport = fakeTransport();
    const base = await serve(createMcpHttpListener({ token: TOKEN, handle: transport.handleRequest.bind(transport) }));
    const res = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { authorization: "Bearer wrong-token" },
    });
    expect(res.status).toBe(401);
    expect(transport.calls.length).toBe(0);
  });

  it("passes authorized /mcp requests to the transport", async () => {
    const transport = fakeTransport();
    const base = await serve(createMcpHttpListener({ token: TOKEN, handle: transport.handleRequest.bind(transport) }));
    const res = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
    });
    expect(res.status).toBe(200);
    expect(transport.calls.length).toBe(1);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("serves GET /health without auth", async () => {
    const transport = fakeTransport();
    const base = await serve(createMcpHttpListener({ token: TOKEN, handle: transport.handleRequest.bind(transport) }));
    const res = await fetch(`${base}/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
  });

  it("returns 404 for other paths even with a valid token", async () => {
    const transport = fakeTransport();
    const base = await serve(createMcpHttpListener({ token: TOKEN, handle: transport.handleRequest.bind(transport) }));
    const res = await fetch(`${base}/elsewhere`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(404);
    expect(transport.calls.length).toBe(0);
  });

  it("reports unauthorized attempts via onUnauthorized", async () => {
    const transport = fakeTransport();
    const seen = [];
    const base = await serve(
      createMcpHttpListener({
        token: TOKEN,
        handle: transport.handleRequest.bind(transport),
        onUnauthorized: (req) => seen.push(req.url),
      })
    );
    await fetch(`${base}/mcp`, { method: "POST" });
    expect(seen).toEqual(["/mcp"]);
  });

  it("throws when constructed without a token or transport", () => {
    expect(() => createMcpHttpListener({})).toThrow(/token/);
    expect(() => createMcpHttpListener({ token: "x" })).toThrow(/handle/);
  });
});

describe("createStatelessMcpHandler", () => {
  // Gateways (LiteLLM, MCP Hub) fan out tool calls. Before the fix the next
  // request connected a fresh transport before the previous one had closed,
  // so the SDK threw "Already connected to a transport" and the listener
  // answered HTTP 500.
  it("serves overlapping requests without returning HTTP 500", async () => {
    const mcp = new McpServer({ name: "transport-race-test", version: "1.0.0" });
    mcp.tool("slow_ping", "Delays briefly so requests overlap.", {}, async () => {
      await new Promise((resolve) => setTimeout(resolve, 100));
      return { content: [{ type: "text", text: "pong" }] };
    });
    const base = await serve(createMcpHttpListener({ token: TOKEN, handle: createStatelessMcpHandler(mcp) }));
    const body = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "slow_ping", arguments: {} },
    });
    const call = () =>
      fetch(`${base}/mcp`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${TOKEN}`,
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body,
      });

    const responses = await Promise.all(Array.from({ length: 6 }, call));
    const statuses = responses.map((response) => response.status);
    await Promise.all(responses.map((response) => response.text()));
    await mcp.close();

    expect(statuses).toEqual([200, 200, 200, 200, 200, 200]);
  });
});
