// The s6 services and the manifest: the server runs the `deployed` profile
// on 8927 with a bearer token, refuses to start without one, and the
// configuration directory is mapped read-only. Text+regex like the other
// suites.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { describe, it } = require("node:test");

const ADDON_DIR = path.join(__dirname, "..");
const read = (p) => fs.readFileSync(path.join(ADDON_DIR, p), "utf8");
const init = read("rootfs/etc/s6-overlay/s6-rc.d/init-ha-mcp/run");
const http = read("rootfs/etc/s6-overlay/s6-rc.d/ha-mcp-http/run");
const config = read("config.yaml");

describe("ha_mcp services", () => {
  it("selects the deployed tool profile", () => {
    assert.match(init, /export OPENCODE_MCP_TOOL_PROFILE=deployed/);
  });

  it("serves HTTP on 8927 and refuses to start without a token", () => {
    assert.match(http, /index\.js --transport http --port 8927/);
    assert.match(http, /bashio::var\.has_value "\$\{MCP_HTTP_TOKEN\}"/);
    assert.match(http, /exec sleep infinity/);
  });

  it("starts the HTTP service after the init oneshot", () => {
    assert.ok(fs.existsSync(path.join(ADDON_DIR, "rootfs/etc/s6-overlay/s6-rc.d/ha-mcp-http/dependencies.d/init-ha-mcp")));
    assert.equal(read("rootfs/etc/s6-overlay/s6-rc.d/init-ha-mcp/type").trim(), "oneshot");
    assert.equal(read("rootfs/etc/s6-overlay/s6-rc.d/ha-mcp-http/type").trim(), "longrun");
  });

  it("keeps the Supervisor token out of the env file", () => {
    assert.doesNotMatch(init, /SUPERVISOR_TOKEN/);
  });
});

describe("ha_mcp manifest", () => {
  it("maps the configuration directory read-only", () => {
    assert.match(config, /- type: homeassistant_config\n\s+read_only: true/);
  });

  it("publishes the MCP port", () => {
    assert.match(config, /^  8927\/tcp: 8927$/m);
  });
});

describe("ha_mcp server tree", () => {
  it("ships no OpenCode-only files", () => {
    const server = path.join(ADDON_DIR, "rootfs/opt/ha-mcp-server");
    for (const name of ["opencode-ha.json", "headless-permissions.mjs", "skills", "agents", "startup-hooks", "evaluate-agent.mjs"]) {
      assert.equal(fs.existsSync(path.join(server, name)), false, `${name} belongs to the OpenCode add-on`);
    }
  });
});
