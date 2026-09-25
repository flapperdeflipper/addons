// Behavioral tests for the memory module: tool contract, REST client
// wiring, and scoring parity with the Python litellm_mcp package (keep the
// two implementations in sync - the same cases exist in the litellm add-on's
// test/test_package.py).

const assert = require("node:assert/strict");
const path = require("node:path");
const { describe, it } = require("node:test");

const SERVER_SRC = path.join(__dirname, "..", "rootfs", "opt", "mcp-hub", "src");
const indexPromise = import(path.join(SERVER_SRC, "servers", "memory", "index.js"));
const clientPromise = import(path.join(SERVER_SRC, "servers", "memory", "client.js"));

function jsonResponse(payload, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: "status",
    text: async () => JSON.stringify(payload),
  };
}

function mockFetch(calls, responder) {
  return async (url, init) => {
    calls.push({ url: String(url), init });
    return typeof responder === "function" ? responder(String(url), init) : jsonResponse({});
  };
}

const STORE = {
  memories: [
    { key: "opencode:global:redis-cache", value: "cache_params bootstrap needs the YAML block", metadata: { tags: ["litellm", "redis"] }, updated_at: "t1" },
    { key: "opencode:global:infra-map", value: "which repo holds what", metadata: { tags: ["infra"] }, updated_at: "t2" },
    { key: "opencode:global:unrelated", value: "garden watering schedule", metadata: null, updated_at: "t3" },
    { key: "opencode:global:cache-note", value: "cache lives in redis", metadata: null, updated_at: "t4" },
  ],
  total: 4,
};

function listResponder() {
  return (url) => jsonResponse(url.includes("key_prefix=") ? { memories: [], total: 0 } : STORE);
}

describe("memory tool contract", async () => {
  const { TOOLS } = await indexPromise;

  it("exposes the six tools with python-parity names", () => {
    assert.deepEqual(
      TOOLS.map((t) => t.name).sort(),
      ["memory_delete", "memory_get", "memory_list", "memory_search", "memory_set", "memory_tags"]
    );
  });

  it("requires key for get/set/delete and key+value for set", () => {
    const required = Object.fromEntries(TOOLS.map((t) => [t.name, t.inputSchema.required || []]));
    assert.deepEqual(required.memory_get, ["key"]);
    assert.deepEqual(required.memory_set, ["key", "value"]);
    assert.deepEqual(required.memory_delete, ["key"]);
  });
});

describe("memory client", async () => {
  const { createMemoryClient } = await clientPromise;

  it("authenticates with the bearer key and builds list/get/put/delete paths", async () => {
    const calls = [];
    const client = createMemoryClient({
      baseUrl: "http://10.60.0.3:4000/",
      apiKey: "sk-memory",
      fetchImpl: mockFetch(calls, listResponder()),
    });
    await client.list();
    await client.list("opencode:");
    await client.get("opencode:global:x");
    await client.set("opencode:global:x", "v", { tags: ["a"] });
    await client.delete("opencode:global:x");
    assert.equal(calls[0].url, "http://10.60.0.3:4000/v1/memory");
    assert.equal(calls[1].url, "http://10.60.0.3:4000/v1/memory?key_prefix=opencode%3A");
    assert.equal(calls[2].url, "http://10.60.0.3:4000/v1/memory/opencode%3Aglobal%3Ax");
    assert.equal(calls[4].url, "http://10.60.0.3:4000/v1/memory/opencode%3Aglobal%3Ax");
    for (const call of calls) {
      assert.equal(call.init.headers.Authorization, "Bearer sk-memory");
    }
    assert.deepEqual(JSON.parse(calls[3].init.body), { value: "v", metadata: { tags: ["a"] } });
  });

  it("omits metadata when no tags and attaches status to errors", async () => {
    const calls = [];
    const client = createMemoryClient({
      baseUrl: "http://x:4000",
      apiKey: "k",
      fetchImpl: mockFetch(calls, (url, init) => {
        if (init.method === "PUT") return jsonResponse({}, 200);
        return jsonResponse({ error: "nope" }, 404);
      }),
    });
    await client.set("k", "v");
    assert.deepEqual(JSON.parse(calls[0].init.body), { value: "v" }, "no metadata key without tags");
    await assert.rejects(() => client.get("k"), (error) => error.status === 404 && /HTTP 404/.test(error.message));
  });

  it("refuses to construct without url or key", () => {
    assert.throws(() => createMemoryClient({ apiKey: "k" }), /memory_proxy_url/);
    assert.throws(() => createMemoryClient({ baseUrl: "http://x" }), /memory_api_key/);
  });
});

describe("memory tool behavior", async () => {
  const { createHandleToolCall } = await indexPromise;
  const { createMemoryClient } = await clientPromise;

  function handler(storeResponder = listResponder()) {
    const client = createMemoryClient({ baseUrl: "http://x:4000", apiKey: "k", fetchImpl: mockFetch([], storeResponder) });
    return createHandleToolCall(client);
  }

  const parse = (result) => JSON.parse(result.content[0].text);

  it("search ranks segment matches first, excludes non-matches, bounds snippets", async () => {
    const result = await handler()({ params: { name: "memory_search", arguments: { query: "redis cache" } } });
    const out = parse(result);
    assert.equal(out.matches[0].key, "opencode:global:redis-cache");
    assert.equal(out.matches[1].key, "opencode:global:cache-note");
    assert.ok(!out.matches.some((m) => m.key.includes("unrelated") || m.key.includes("infra-map")));
    assert.equal(out.scanned, 4);
    assert.ok(out.matches[0].score > out.matches[1].score);
    assert.ok(out.matches[0].snippet.length <= 165);
  });

  it("tag-only search filters without scores; no substring key matches", async () => {
    const tagged = await handler()({ params: { name: "memory_search", arguments: { tag: "redis" } } });
    const out = parse(tagged);
    assert.deepEqual(out.matches.map((m) => m.key), ["opencode:global:redis-cache"]);
    assert.ok(!("score" in out.matches[0]));

    const noise = await handler()({ params: { name: "memory_search", arguments: { query: "zzz not there" } } });
    assert.deepEqual(parse(noise).matches, [], '"not" inside "note" must not match');
  });

  it("requires query or tag, caps the limit", async () => {
    const none = await handler()({ params: { name: "memory_search", arguments: {} } });
    assert.match(none.content[0].text, /provide a query and\/or tag/);

    const many = { memories: Array.from({ length: 40 }, (_, i) => ({ key: `esphome:${i}`, value: "kitchen sensor", metadata: { tags: ["esphome"] } })), total: 40 };
    const capped = await handler((url) => jsonResponse(url.includes("key_prefix") ? { memories: [], total: 0 } : many))({
      params: { name: "memory_search", arguments: { query: "esphome kitchen", limit: 999 } },
    });
    assert.equal(parse(capped).shown, 25, "hard cap at 25");
  });

  it("memory_tags digests counts, samples and untagged", async () => {
    const out = parse(await handler()({ params: { name: "memory_tags", arguments: {} } }));
    assert.equal(out.entries, 4);
    assert.equal(out.untagged, 2);
    assert.deepEqual(out.tags.map((t) => t.tag), ["infra", "litellm", "redis"], "count desc, then tag asc");
    assert.deepEqual(out.tags.find((t) => t.tag === "redis").keys, ["opencode:global:redis-cache"]);
  });

  it("memory_set normalizes tags and maps 404 to not-found on get/delete", async () => {
    const calls = [];
    const client = createMemoryClient({
      baseUrl: "http://x:4000",
      apiKey: "k",
      fetchImpl: mockFetch(calls, (url, init) => {
        if (init.method === "PUT") return jsonResponse({ key: "opencode:ha:q", updated_at: "t" });
        return jsonResponse({ error: "not found" }, 404);
      }),
    });
    const call = createHandleToolCall(client);
    const set = parse(await call({ params: { name: "memory_set", arguments: { key: "opencode:ha:q", value: "v", tags: "esphome, ha mqtt" } } }));
    assert.deepEqual(set.tags, ["esphome", "ha", "mqtt"]);
    assert.deepEqual(JSON.parse(calls.find((c) => c.init.method === "PUT").init.body), {
      value: "v",
      metadata: { tags: ["esphome", "ha", "mqtt"] },
    });
    const got = await call({ params: { name: "memory_get", arguments: { key: "gone" } } });
    assert.equal(got.content[0].text, '"not found: gone"');
    const deleted = await call({ params: { name: "memory_delete", arguments: { key: "gone" } } });
    assert.equal(deleted.content[0].text, '"not found: gone"');
  });
});
