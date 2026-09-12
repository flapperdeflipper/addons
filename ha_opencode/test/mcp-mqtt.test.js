// Structural contract for the bundled mcp-mqtt server: the script, its base
// config wiring, the init-script gate and the read-only overlay must agree.
// The live protocol behaviour (publish/listen/clear against the broker) needs
// a Supervisor token and is exercised manually in the add-on terminal; here
// we pin everything that can drift silently between releases.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { describe, it } = require("node:test");

const ADDON_DIR = path.join(__dirname, "..");
const SCRIPT = path.join(ADDON_DIR, "rootfs", "usr", "local", "bin", "mcp-mqtt");
const OPENCODE_HA = path.join(ADDON_DIR, "rootfs", "opt", "ha-mcp-server", "opencode-ha.json");
const OPENCODE_READONLY = path.join(ADDON_DIR, "rootfs", "opt", "ha-mcp-server", "opencode-readonly.json");
const INIT_RUN = path.join(ADDON_DIR, "rootfs", "etc", "s6-overlay", "s6-rc.d", "init-opencode", "run");

const read = (p) => fs.readFileSync(p, "utf8");

describe("mcp-mqtt server", () => {
  const script = read(SCRIPT);

  it("ships as an executable node script", () => {
    assert.ok(fs.statSync(SCRIPT).mode & 0o111, "mcp-mqtt must carry the exec bit");
    assert.match(script, /^#!\/usr\/bin\/env node/);
  });

  it("exposes exactly the three documented tools over the protocol", async () => {
    // Behavioral, not textual: ask the actual server for its tool list.
    // tools/list touches no network, so a dummy token is enough.
    const { spawn } = require("node:child_process");
    const proc = spawn("node", [SCRIPT], { env: { ...process.env, SUPERVISOR_TOKEN: "dummy" } });
    let out = "";
    proc.stdout.on("data", (d) => (out += d));
    proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }) + "\n");
    proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
    proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }) + "\n");
    await new Promise((r) => setTimeout(r, 800));
    proc.kill();
    const lines = out.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
    const list = lines.find((m) => m.id === 2);
    assert.ok(list?.result?.tools, "tools/list answered");
    const names = list.result.tools.map((t) => t.name).sort();
    assert.deepEqual(names, ["mqtt_clear_retained", "mqtt_listen", "mqtt_publish"]);
    for (const tool of list.result.tools) {
      assert.ok(tool.description.length >= 40, `${tool.name} must be described`);
      assert.ok(tool.inputSchema?.properties, `${tool.name} needs an input schema`);
    }
  });

  it("authenticates via SUPERVISOR_TOKEN only and fails fast without it", () => {
    assert.match(script, /const TOKEN = process\.env\.SUPERVISOR_TOKEN \|\| ""/);
    assert.match(script, /SUPERVISOR_TOKEN is not set/);
  });

  it("talks only to the Supervisor core API, never an external host", () => {
    const urls = [...script.matchAll(/https?:\/\/[a-z0-9.:{}/_-]+/gi)].map((m) => m[0]);
    for (const url of urls) {
      assert.match(url, /^https?:\/\/supervisor\//, `unexpected endpoint: ${url}`);
    }
  });

  it("carries no credential-shaped literals", () => {
    assert.doesNotMatch(script, /(sk-[A-Za-z0-9_-]{16,}|Bearer\s+[A-Za-z0-9._-]{16,})/);
  });

  it("is wired into the base config with an explicit token environment", () => {
    const cfg = JSON.parse(read(OPENCODE_HA));
    const mqtt = cfg.mcp?.mqtt;
    assert.equal(mqtt?.type, "local");
    assert.deepEqual(mqtt?.command, ["node", "/usr/local/bin/mcp-mqtt"]);
    assert.equal(mqtt?.environment?.SUPERVISOR_TOKEN, "{env:SUPERVISOR_TOKEN}");
    assert.ok((mqtt?.timeout ?? 0) >= 65000, "timeout must cover a 60s mqtt_listen");
  });

  it("follows the mcp_enabled option gate like the homeassistant server", () => {
    const run = read(INIT_RUN);
    assert.match(run, /\.mcp\.mqtt\.enabled = \$mcp/);
    // The jq program and the JSON template must agree the server exists.
    assert.ok(JSON.parse(read(OPENCODE_HA)).mcp.mqtt, "template entry");
  });

  it("stays disabled in the read-only session config", () => {
    const ro = JSON.parse(read(OPENCODE_READONLY));
    assert.equal(ro.mcp?.mqtt?.enabled, false, "publishing is not a read-only action");
  });
});
