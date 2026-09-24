// Behavioral tests for the homeassistant forwarder: bearer-authenticated
// pass-through to ha_opencode's 8927 MCP endpoint, response mapping and
// error handling, plus the manifest contract the gateway relies on.

const assert = require("node:assert/strict");
const path = require("node:path");
const { describe, it } = require("node:test");

const SERVER_SRC = path.join(__dirname, "..", "rootfs", "opt", "mcp-hub", "src");
const modulePromise = import(path.join(SERVER_SRC, "servers", "homeassistant", "index.js"));

function upstreamResponse({ status = 200, body = {} } = {}) {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: "status",
    text: async () => text,
  };
}

describe("manifest", async () => {
  const manifest = (await modulePromise).default;

  it("declares the forwarder contract", () => {
    assert.equal(manifest.id, "homeassistant");
    assert.equal(manifest.kind, "forwarder");
    assert.equal(manifest.enabledOption, "homeassistant_enabled");
    assert.equal(typeof manifest.validateJsonRpcMessage, "function");
    assert.equal(typeof manifest.createForwarder, "function");
  });
});

describe("createHaMcpForwarder", async () => {
  const { createHaMcpForwarder } = await modulePromise;

  it("requires a url and token", () => {
    assert.throws(() => createHaMcpForwarder({}), /homeassistant_url/);
    assert.throws(() => createHaMcpForwarder({ url: "http://x:8927/mcp" }), /homeassistant_token/);
  });

  it("forwards with the bearer token and passes a successful reply through", async () => {
    const seen = [];
    const reply = { jsonrpc: "2.0", id: 7, result: { tools: [{ name: "get_states" }] } };
    const forwarder = createHaMcpForwarder({
      url: "http://ha:8927/mcp",
      token: "tok",
      fetchImpl: async (url, init) => {
        seen.push({ url: String(url), init });
        return upstreamResponse({ body: reply });
      },
    });
    const message = { jsonrpc: "2.0", id: 7, method: "tools/list" };
    assert.deepEqual(await forwarder.send(message), reply);
    assert.equal(seen[0].url, "http://ha:8927/mcp");
    assert.equal(seen[0].init.headers.Authorization, "Bearer tok");
    assert.equal(seen[0].init.headers["Content-Type"], "application/json");
  });

  it("normalizes a trailing slash off the endpoint url", () => {
    const forwarder = createHaMcpForwarder({
      url: "http://ha:8927/mcp/",
      token: "tok",
      fetchImpl: async () => upstreamResponse(),
    });
    assert.equal(forwarder.endpoint, "http://ha:8927/mcp");
  });

  it("maps an upstream 202 to null (nothing to return)", async () => {
    const forwarder = createHaMcpForwarder({
      url: "http://ha:8927/mcp",
      token: "tok",
      fetchImpl: async () => upstreamResponse({ status: 202, body: "" }),
    });
    assert.equal(
      await forwarder.send({ jsonrpc: "2.0", id: 1, method: "notifications/initialized" }),
      null
    );
  });

  it("returns a JSON-RPC error carrying the upstream status and body", async () => {
    const forwarder = createHaMcpForwarder({
      url: "http://ha:8927/mcp",
      token: "tok",
      fetchImpl: async () => upstreamResponse({ status: 401, body: "unauthorized" }),
    });
    const reply = await forwarder.send({ jsonrpc: "2.0", id: 3, method: "tools/list" });
    assert.equal(reply.id, 3);
    assert.match(reply.error.message, /HTTP 401/);
    assert.equal(reply.error.data.status, 401);
    assert.equal(reply.error.data.body, "unauthorized");
  });

  it("returns a JSON-RPC error when the upstream is unreachable, and swallows notification errors", async () => {
    const forwarder = createHaMcpForwarder({
      url: "http://ha:8927/mcp",
      token: "tok",
      fetchImpl: async () => {
        throw new Error("connect ECONNREFUSED");
      },
    });
    const reply = await forwarder.send({ jsonrpc: "2.0", id: 4, method: "tools/list" });
    assert.equal(reply.id, 4);
    assert.match(reply.error.data.message, /ECONNREFUSED/);
    assert.equal(
      await forwarder.send({ jsonrpc: "2.0", method: "notifications/initialized" }),
      null
    );
  });
});

describe("createForwarder (manifest wiring)", async () => {
  const manifest = (await modulePromise).default;

  it("builds the forwarder from config and logs the endpoint", async () => {
    const logs = [];
    const forwarder = manifest.createForwarder({
      config: { homeassistant_url: "http://ha:8927/mcp", homeassistant_token: "tok" },
      env: {},
      log: (level, message) => logs.push(`${level} ${message}`),
    });
    assert.equal(forwarder.endpoint, "http://ha:8927/mcp");
    assert.ok(logs.some((line) => line.includes("/mcp/homeassistant")));
  });

  it("throws on missing config so the gateway marks the route failed", () => {
    assert.throws(() => manifest.createForwarder({ config: {}, env: {}, log: () => {} }), /homeassistant_url/);
  });
});
