// Spawn-spec tests for the playwright module: exact CLI wiring to the shared
// playwright-browser add-on, loopback-only binding, and the missing-endpoint
// guard. The child itself is exercised end-to-end by the gateway tests.

const assert = require("node:assert/strict");
const path = require("node:path");
const { describe, it } = require("node:test");

const SERVER_SRC = path.join(__dirname, "..", "rootfs", "opt", "mcp-hub", "src");
const playwrightPromise = import(path.join(SERVER_SRC, "servers", "playwright", "index.js"));

describe("playwright module", async () => {
  const mod = await playwrightPromise;

  it("is an upstream-kind module gated by playwright_enabled", () => {
    assert.equal(mod.default.kind, "upstream");
    assert.equal(mod.default.enabledOption, "playwright_enabled");
  });

  it("builds a spawn spec pinned to the CDP endpoint and loopback", () => {
    const spec = mod.buildSpawnSpec({
      config: { playwright_cdp_endpoint: "http://4e94d283-playwright-browser:9222" },
    });
    assert.equal(spec.command, process.execPath);
    assert.ok(spec.args[0].endsWith("cli.js"), "must run the pinned @playwright/mcp cli");
    const cdp = spec.args.indexOf("--cdp-endpoint");
    assert.equal(spec.args[cdp + 1], "http://4e94d283-playwright-browser:9222");
    const host = spec.args.indexOf("--host");
    assert.equal(spec.args[host + 1], "127.0.0.1");
    assert.ok(spec.args.includes("--port"));
    assert.equal(spec.port, mod.PLAYWRIGHT_MCP_INTERNAL_PORT);
  });

  it("refuses to build a spec without a CDP endpoint", () => {
    assert.throws(() => mod.buildSpawnSpec({ config: {} }), /cdp_endpoint/);
  });
});
