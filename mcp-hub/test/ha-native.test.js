// Behavioral tests for the forked native MCP forwarder: JSON-RPC validation,
// endpoint negotiation (404 fallback, unknown-API-ID reporting) and error
// mapping. Mirrors the semantics of ha_opencode's ha-native-mcp.js.

const assert = require("node:assert/strict");
const path = require("node:path");
const { describe, it } = require("node:test");

const SERVER_SRC = path.join(__dirname, "..", "rootfs", "opt", "mcp-hub", "src");
const nativePromise = import(path.join(SERVER_SRC, "servers", "ha-native", "native-mcp.js"));

function nativeResponse({ status = 200, body = {} } = {}) {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: "status",
    endpoint: "http://supervisor/core/api/mcp/assist",
    text: async () => text,
    json: (() => {
      try {
        return JSON.parse(text);
      } catch {
        return null;
      }
    })(),
  };
}

describe("validateJsonRpcMessage", async () => {
  const { validateJsonRpcMessage } = await nativePromise;

  it("accepts requests, notifications and responses", () => {
    assert.equal(validateJsonRpcMessage({ jsonrpc: "2.0", id: 1, method: "tools/list" }).valid, true);
    assert.equal(validateJsonRpcMessage({ jsonrpc: "2.0", method: "notify" }).valid, true);
    assert.equal(validateJsonRpcMessage({ jsonrpc: "2.0", id: 1, result: {} }).valid, true);
  });

  it("rejects batches, wrong versions and malformed messages", () => {
    assert.equal(validateJsonRpcMessage([{ jsonrpc: "2.0" }]).valid, false);
    assert.equal(validateJsonRpcMessage({ jsonrpc: "1.0", id: 1, method: "x" }).valid, false);
    assert.equal(validateJsonRpcMessage({ id: 1, method: "x" }).valid, false);
    assert.equal(validateJsonRpcMessage({ jsonrpc: "2.0", id: 1, method: "" }).valid, false);
  });
});

describe("createNativeMcpForwarder", async () => {
  const { createNativeMcpForwarder } = await nativePromise;

  it("passes a successful response through unchanged", async () => {
    const reply = { jsonrpc: "2.0", id: 7, result: { tools: [] } };
    const forwarder = createNativeMcpForwarder({
      supervisorToken: "tok",
      fetchImpl: async () => nativeResponse({ body: reply }),
    });
    assert.deepEqual(await forwarder.send({ jsonrpc: "2.0", id: 7, method: "tools/list" }), reply);
  });

  it("maps an upstream 202 to null (nothing to return)", async () => {
    const forwarder = createNativeMcpForwarder({
      supervisorToken: "tok",
      fetchImpl: async () => nativeResponse({ status: 202, body: "" }),
    });
    assert.equal(
      await forwarder.send({ jsonrpc: "2.0", id: 1, method: "notifications/initialized" }),
      null
    );
  });

  it("falls back from a missing keyed endpoint but reports an unknown API ID", async () => {
    const calls = [];
    const forwarder = createNativeMcpForwarder({
      supervisorToken: "tok",
      fetchImpl: async (url) => {
        calls.push(String(url));
        if (calls.length === 1) {
          return nativeResponse({ status: 404, body: { error: "not found" } });
        }
        return nativeResponse({ body: { jsonrpc: "2.0", id: 1, result: { via: "base" } } });
      },
      fallbackRetryMs: 0,
    });
    const message = { jsonrpc: "2.0", id: 1, method: "tools/list" };
    const reply = await forwarder.send(message);
    assert.equal(reply.result.via, "base");
    assert.equal(calls[0].endsWith("/mcp/assist"), true);
    assert.equal(calls[1].endsWith("/mcp"), true);

    // Unknown LLM API: reported, never fallen back from.
    const strict = createNativeMcpForwarder({
      supervisorToken: "tok",
      fetchImpl: async () =>
        nativeResponse({ status: 404, body: { error: "Unknown LLM API nope" } }),
    });
    const strictReply = await strict.send(message);
    assert.match(strictReply.error.message, /does not know the LLM API ID/);
  });

  it("returns a JSON-RPC error when the request itself fails", async () => {
    const forwarder = createNativeMcpForwarder({
      supervisorToken: "tok",
      fetchImpl: async () => {
        throw new Error("boom");
      },
    });
    const reply = await forwarder.send({ jsonrpc: "2.0", id: 3, method: "tools/list" });
    assert.equal(reply.id, 3);
    assert.match(reply.error.message, /failed/);
  });

  it("surfaces a missing supervisor token as a request error", async () => {
    const forwarder = createNativeMcpForwarder({});
    const reply = await forwarder.send({ jsonrpc: "2.0", id: 4, method: "tools/list" });
    assert.equal(reply.id, 4);
    assert.match(reply.error.data.message, /SUPERVISOR_TOKEN/);
  });
});
