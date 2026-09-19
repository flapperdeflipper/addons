// Structural contract for the MQTT tools inside ha-mcp-server (ported from
// the retired standalone mcp-mqtt stdio server so the tools also reach
// sibling add-ons via the HTTP MCP endpoint on 8927). The live protocol
// behaviour (publish/listen/clear against the broker) needs a Supervisor
// token and is exercised manually; unit tests for the module logic live in
// rootfs/opt/ha-mcp-server/test/mqtt.test.js. Here we pin everything that
// can drift silently between releases.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { describe, it } = require("node:test");

const ADDON_DIR = path.join(__dirname, "..");
const MCP_DIR = path.join(ADDON_DIR, "rootfs", "opt", "ha-mcp-server");
const INDEX = path.join(MCP_DIR, "index.js");
const MODULE = path.join(MCP_DIR, "lib", "mqtt.js");
const UNIT_TESTS = path.join(MCP_DIR, "test", "mqtt.test.js");
const OPENCODE_HA = path.join(MCP_DIR, "opencode-ha.json");
const OPENCODE_READONLY = path.join(MCP_DIR, "opencode-readonly.json");
const TOOL_PROFILES = path.join(MCP_DIR, "lib", "tool-profiles.js");
const INIT_RUN = path.join(ADDON_DIR, "rootfs", "etc", "s6-overlay", "s6-rc.d", "init-opencode", "run");
const RETIRED_SCRIPT = path.join(ADDON_DIR, "rootfs", "usr", "local", "bin", "mcp-mqtt");

const read = (p) => fs.readFileSync(p, "utf8");
const MQTT_TOOLS = ["mqtt_clear_retained", "mqtt_listen", "mqtt_publish"];

describe("mqtt tools in ha-mcp-server", () => {
  const moduleSource = read(MODULE);
  const indexSource = read(INDEX);

  it("ships the module and its unit tests", () => {
    assert.ok(fs.existsSync(MODULE), "lib/mqtt.js must exist");
    assert.ok(fs.existsSync(UNIT_TESTS), "test/mqtt.test.js must exist");
    assert.match(moduleSource, /export function listenMqttTopic/);
    assert.match(moduleSource, /export async function publishMqttMessage/);
    assert.match(moduleSource, /export async function clearMqttRetained/);
  });

  it("defines and dispatches exactly the three documented tools", () => {
    for (const tool of MQTT_TOOLS) {
      const defs = indexSource.match(new RegExp(`name: "${tool}"`, "g")) || [];
      assert.equal(defs.length, 1, `${tool} must be defined exactly once in TOOLS`);
      const defStart = indexSource.indexOf(`name: "${tool}"`);
      const block = indexSource.slice(defStart, defStart + 2500);
      assert.match(block, /inputSchema/, `${tool} needs an input schema`);
      assert.match(block, /description:/, `${tool} must be described`);
      assert.match(indexSource, new RegExp(`case "${tool}": \\{`), `${tool} must have a dispatch case`);
    }
  });

  it("talks only to the Supervisor core API, never an external host", () => {
    const urls = [...moduleSource.matchAll(/[a-z]+:\/\/[a-z0-9.:{}/_-]+/gi)].map((m) => m[0]);
    assert.ok(urls.length > 0, "expected at least the core websocket default");
    for (const url of urls) {
      assert.match(url, /^wss?:\/\/supervisor\//, `unexpected endpoint: ${url}`);
    }
  });

  it("carries no credential-shaped literals", () => {
    assert.doesNotMatch(moduleSource, /(sk-[A-Za-z0-9_-]{16,}|Bearer\s+[A-Za-z0-9._-]{16,})/);
  });

  it("bounds the listen window and event collection", () => {
    assert.match(moduleSource, /MQTT_LISTEN_MAX_SECONDS = 60/);
    assert.match(moduleSource, /MQTT_LISTEN_MAX_EVENTS = 500/);
  });

  it("rides the homeassistant server with a timeout that covers a 60s listen", () => {
    const cfg = JSON.parse(read(OPENCODE_HA));
    assert.equal(cfg.mcp?.mqtt, undefined, "no standalone mqtt server entry may exist");
    assert.ok((cfg.mcp?.homeassistant?.timeout ?? 0) >= 65000, "homeassistant timeout must cover a 60s mqtt_listen");
    assert.deepEqual(cfg.mcp?.homeassistant?.command, ["node", "/opt/ha-mcp-server/index.js"]);
  });

  it("retired the standalone mcp-mqtt script and its wiring", () => {
    assert.ok(!fs.existsSync(RETIRED_SCRIPT), "the standalone script must be gone");
    const run = read(INIT_RUN);
    assert.doesNotMatch(run, /\.mcp\.mqtt/, "the init script must not gate a mqtt server entry");
  });

  it("keeps the tools out of the read-only session", () => {
    const ro = JSON.parse(read(OPENCODE_READONLY));
    assert.equal(ro.mcp?.mqtt, undefined, "no mqtt overlay entry may exist");
    assert.equal(ro.mcp?.homeassistant?.environment?.OPENCODE_MCP_TOOL_PROFILE, "compact");
    const profiles = read(TOOL_PROFILES);
    const compactBlock = profiles.slice(profiles.indexOf("COMPACT_TOOL_NAMES"), profiles.indexOf("CONFIGURATION_TOOL_NAMES"));
    for (const tool of MQTT_TOOLS) {
      assert.ok(!compactBlock.includes(`"${tool}"`), `${tool} must stay out of the compact profile`);
    }
  });
});
