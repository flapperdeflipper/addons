// Tests for the chrome-devtools module: the pinned chrome-devtools-mcp
// accepts the hub's flags (parsed through its own yargs schema, so a renamed
// flag in a bump fails here instead of at runtime), the browser is launched
// in-container over a pipe rather than reached over the network, and the
// server registers its tools without starting Chromium.

const assert = require("node:assert/strict");
const path = require("node:path");
const { createRequire } = require("node:module");
const { describe, it } = require("node:test");

const SERVER_SRC = path.join(__dirname, "..", "rootfs", "opt", "mcp-hub", "src");
const SERVER_PACKAGE = path.join(__dirname, "..", "rootfs", "opt", "mcp-hub", "package.json");
const requireFromServer = createRequire(SERVER_PACKAGE);
const modulePromise = import(path.join(SERVER_SRC, "servers", "chrome-devtools", "index.js"));

describe("chrome-devtools module", async () => {
  const mod = await modulePromise;

  it("is an mcp-kind module gated by chrome_devtools_enabled", () => {
    assert.equal(mod.default.id, "chrome-devtools");
    assert.equal(mod.default.kind, "mcp");
    assert.equal(mod.default.enabledOption, "chrome_devtools_enabled");
  });

  it("launches the image's chromium headless, sandbox-less and telemetry-free", () => {
    const args = mod.parseServerArgs();
    assert.equal(args.headless, true);
    assert.equal(args.isolated, true);
    assert.equal(args.executablePath, mod.CHROMIUM_PATH);
    assert.ok(args.chromeArg.includes("--no-sandbox"));
    assert.equal(args.usageStatistics, false);
    assert.equal(args.performanceCrux, false);
    assert.equal(args.pageIdRouting, true);
  });

  it("never connects to a remote browser", () => {
    const args = mod.parseServerArgs();
    assert.equal(args.browserUrl, undefined);
    assert.equal(args.wsEndpoint, undefined);
    assert.equal(args.autoConnect, undefined);
  });

  it("serves tools/list without launching a browser", async () => {
    const { Client } = requireFromServer("@modelcontextprotocol/sdk/client/index.js");
    const { InMemoryTransport } = requireFromServer("@modelcontextprotocol/sdk/inMemory.js");
    const logs = [];
    const server = mod.default.createServer({ log: (...entry) => logs.push(entry) });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: "test", version: "0.0.0" });
    await client.connect(clientTransport);
    const { tools } = await client.listTools();
    const names = tools.map((tool) => tool.name);
    for (const expected of ["navigate_page", "take_snapshot", "click", "fill", "take_screenshot", "new_page"]) {
      assert.ok(names.includes(expected), `missing tool ${expected}`);
    }
    await client.close();
    assert.deepEqual(logs, []);
  });
});
