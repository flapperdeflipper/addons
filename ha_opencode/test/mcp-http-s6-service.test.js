// Regression coverage for 2.8.1: the MCP-over-HTTP service must export
// MCP_HTTP_TOKEN before exec'ing node, which reads process.env.MCP_HTTP_TOKEN.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { describe, it } = require("node:test");

const ADDON_ROOT = path.join(__dirname, "..");
const RUN = path.join(
  ADDON_ROOT,
  "rootfs",
  "etc",
  "s6-overlay",
  "s6-rc.d",
  "ha-opencode-mcp-http",
  "run",
);
const SERVER = path.join(ADDON_ROOT, "rootfs", "opt", "ha-mcp-server", "index.js");

describe("MCP over HTTP s6 service", () => {
  it("exports MCP_HTTP_TOKEN before exec'ing the HTTP transport", () => {
    const run = fs.readFileSync(RUN, "utf8");
    assert.match(run, /^export MCP_HTTP_TOKEN$/m);
    const exportIndex = run.indexOf("export MCP_HTTP_TOKEN");
    const execIndex = run.indexOf(
      "exec node /opt/ha-mcp-server/index.js --transport http",
    );
    assert.ok(
      exportIndex !== -1 && execIndex !== -1 && exportIndex < execIndex,
      "MCP_HTTP_TOKEN must be exported before the exec'd node process starts",
    );
  });

  it("node entry point consumes process.env.MCP_HTTP_TOKEN for --transport http", () => {
    const server = fs.readFileSync(SERVER, "utf8");
    assert.match(server, /process\.env\.MCP_HTTP_TOKEN/);
  });
});

describe("MCP over HTTP stateless transport (2.9.1)", () => {
  const transport = fs.readFileSync(
    path.join(ADDON_ROOT, "rootfs", "opt", "ha-mcp-server", "lib", "http-transport.js"),
    "utf8",
  );

  it("serves each request through a fresh stateless transport", () => {
    assert.match(transport, /sessionIdGenerator:\s*undefined/);
    assert.match(transport, /enableJsonResponse:\s*true/);
    assert.match(transport, /export function createStatelessMcpHandler/);
    assert.match(transport, /handle:\s*createStatelessMcpHandler\(mcpServer\)/);
  });

  it("does not issue stateful session ids (single-session lockout regression)", () => {
    assert.doesNotMatch(transport, /sessionIdGenerator:\s*\(\)\s*=>/);
  });
});
