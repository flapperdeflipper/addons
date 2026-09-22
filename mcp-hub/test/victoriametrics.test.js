// Behavioral tests for the forked VictoriaMetrics client and the MCP tool
// contract. Tool names and required-argument arrays are asserted against the
// upstream prometheus-mcp-server 1.0.1 contract so sessions can switch from
// the per-session npx spawn to the hub without noticing.

const assert = require("node:assert/strict");
const path = require("node:path");
const { describe, it } = require("node:test");

const SERVER_SRC = path.join(__dirname, "..", "rootfs", "opt", "mcp-hub", "src");
const indexPromise = import(path.join(SERVER_SRC, "servers", "victoriametrics", "index.js"));
const clientPromise = import(path.join(SERVER_SRC, "servers", "victoriametrics", "client.js"));

function jsonResponse(payload) {
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    text: async () => JSON.stringify(payload),
  };
}

function mockFetch(calls) {
  return async (url, init) => {
    calls.push({ url: String(url), init });
    return jsonResponse({ status: "success", data: { result: [] } });
  };
}

describe("victoriametrics tool contract", async () => {
  const { TOOLS } = await indexPromise;

  it("keeps the upstream tool names in order", () => {
    assert.deepEqual(
      TOOLS.map((tool) => tool.name),
      ["prom_query", "prom_range", "prom_discover", "prom_metadata", "prom_targets"]
    );
  });

  it("keeps upstream required-argument arrays", () => {
    const required = Object.fromEntries(TOOLS.map((t) => [t.name, t.inputSchema.required || []]));
    assert.deepEqual(required.prom_query, ["query"]);
    assert.deepEqual(required.prom_range, ["query", "start", "end", "step"]);
    assert.deepEqual(required.prom_discover, []);
    assert.deepEqual(required.prom_metadata, []);
    assert.deepEqual(required.prom_targets, []);
  });
});

describe("victoriametrics client", async () => {
  const { createVictoriaMetricsClient } = await clientPromise;

  it("queries the instant endpoint with the query and time params", async () => {
    const calls = [];
    const client = createVictoriaMetricsClient({
      baseUrl: "http://vm:8428/",
      fetchImpl: mockFetch(calls),
    });
    await client.query("up", "2026-09-20T00:00:00Z");
    assert.equal(calls.length, 1);
    assert.ok(calls[0].url.startsWith("http://vm:8428/api/v1/query?"));
    assert.ok(calls[0].url.includes("query=up"));
    assert.ok(calls[0].url.includes("time=2026-09-20T00%3A00%3A00Z"));
  });

  it("sends basic auth when username and password are set, and omits it otherwise", async () => {
    const withAuth = [];
    const client = createVictoriaMetricsClient({
      baseUrl: "http://vm:8428",
      username: "homeassistant",
      password: "secret",
      fetchImpl: mockFetch(withAuth),
    });
    await client.discover();
    assert.match(withAuth[0].init.headers.Authorization, /^Basic /);

    const withoutAuth = [];
    const anon = createVictoriaMetricsClient({
      baseUrl: "http://vm:8428",
      fetchImpl: mockFetch(withoutAuth),
    });
    await anon.discover();
    assert.equal(withoutAuth[0].init.headers.Authorization, undefined);
  });

  it("maps state=any to no state param on the targets endpoint", async () => {
    const calls = [];
    const client = createVictoriaMetricsClient({
      baseUrl: "http://vm:8428",
      fetchImpl: mockFetch(calls),
    });
    await client.targets("any");
    assert.equal(calls[0].url.includes("state="), false);
  });

  it("surfaces non-2xx responses as errors", async () => {
    const client = createVictoriaMetricsClient({
      baseUrl: "http://vm:8428",
      fetchImpl: async () => ({
        ok: false,
        status: 401,
        statusText: "Unauthorized",
        text: async () => "unauthorized",
      }),
    });
    await assert.rejects(() => client.discover(), /HTTP 401/);
  });

  it("filters metric labels while preserving __name__ (upstream fork behavior)", async () => {
    const payload = {
      status: "success",
      data: {
        result: [
          { metric: { __name__: "x", job: "j", instance: "i", drop: "d" }, value: [1, "2"] },
        ],
      },
    };
    const client = createVictoriaMetricsClient({
      baseUrl: "http://vm:8428",
      fetchImpl: async () => jsonResponse(payload),
    });
    const out = await client.query("x", undefined, ["job"]);
    assert.deepEqual(out.data.result[0].metric, { __name__: "x", job: "j" });
  });
});
