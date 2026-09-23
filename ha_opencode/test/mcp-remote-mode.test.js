// 2.21.2 regression coverage: the remote MCP mode of the generated
// opencode.json. The generator's jq program is extracted from the init
// service and executed against the real template, so these tests fail on any
// syntax error, not just on shape changes.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { describe, it } = require("node:test");

const ADDON_ROOT = path.join(__dirname, "..");
const RUN = path.join(ADDON_ROOT, "rootfs", "etc", "s6-overlay", "s6-rc.d", "init-opencode", "run");
const TEMPLATE = path.join(ADDON_ROOT, "rootfs", "opt", "ha-mcp-server", "opencode-ha.json");

// The generator jq spans from the line ending in an opening quote to the
// closing quote line before the template redirect; both anchors are stable.
const lines = fs.readFileSync(RUN, "utf8").split("\n");
const openIdx = lines.findIndex((line) => line.startsWith("jq --arg native_ha_mcp_api_id") && line.endsWith("'"));
const closeIdx = lines.findIndex((line, i) => i > openIdx && line === "' /opt/ha-mcp-server/opencode-ha.json > /data/.config/opencode/opencode.json");
assert.ok(openIdx !== -1 && closeIdx !== -1, "generator jq not found in init service");
const program = lines.slice(openIdx + 1, closeIdx).join("\n");

function generate({ mcpRemote, homeassistantUrl, nativeUrl }) {
  const out = execFileSync("jq", [
    "--arg", "mcp_remote_homeassistant_url", homeassistantUrl,
    "--arg", "mcp_remote_native_url", nativeUrl,
    "--arg", "native_ha_mcp_api_id", "assist",
    "--arg", "mcp_tool_profile", "full",
    "--arg", "profile_instruction", "/x",
    "--arg", "channel_agents", "",
    "--argjson", "mcp", "true",
    "--argjson", "mcp_remote", mcpRemote,
    "--argjson", "native_ha_mcp", "true",
    "--argjson", "lsp_disabled", "false",
    "--argjson", "ppq", "false",
    "--argjson", "restrict", "false",
    "--argjson", "focus", "false",
    "--argjson", "briefing", "false",
    "--argjson", "notes", "false",
    "--argjson", "hooks", "false",
    program,
    TEMPLATE,
  ]);
  return JSON.parse(out.toString("utf8"));
}

describe("remote MCP mode (2.21.2)", () => {
  it("emits remote entries with env-ref headers and no stdio remnants", () => {
    const cfg = generate({
      mcpRemote: "true",
      homeassistantUrl: "http://10.60.0.3:8927/mcp",
      nativeUrl: "http://10.60.0.3:8930/mcp/ha-native",
    });
    const h = cfg.mcp.homeassistant;
    assert.equal(h.type, "remote");
    assert.equal(h.url, "http://10.60.0.3:8927/mcp");
    assert.equal(h.headers.Authorization, "Bearer {env:MCP_HTTP_TOKEN}");
    assert.equal(h.enabled, true);
    assert.ok(!("command" in h) && !("environment" in h), "remote entry must not carry stdio keys");

    const n = cfg.mcp.homeassistant_native;
    assert.equal(n.type, "remote");
    assert.equal(n.url, "http://10.60.0.3:8930/mcp/ha-native");
    assert.equal(n.headers.Authorization, "Bearer {env:MCP_HUB_TOKEN}");
    assert.ok(!("command" in n));
  });

  it("keeps local stdio generation unchanged when disabled", () => {
    const cfg = generate({ mcpRemote: "false", homeassistantUrl: "", nativeUrl: "" });
    const h = cfg.mcp.homeassistant;
    assert.notEqual(h.type, "remote");
    assert.deepEqual(h.command.slice(0, 2), ["node", "/opt/ha-mcp-server/index.js"]);
    assert.ok("OPENCODE_MCP_TOOL_PROFILE" in h.environment);
    assert.ok(cfg.mcp.homeassistant_native.command[1].endsWith("ha-native-mcp-proxy.js"));
  });

  it("falls back to stdio when remote is enabled but a URL is empty", () => {
    const cfg = generate({ mcpRemote: "true", homeassistantUrl: "", nativeUrl: "" });
    assert.notEqual(cfg.mcp.homeassistant.type, "remote");
    assert.notEqual(cfg.mcp.homeassistant_native.type, "remote");
  });
});

describe("remote MCP mode option contract (2.21.2)", () => {
  const config = fs.readFileSync(path.join(ADDON_ROOT, "config.yaml"), "utf8");
  it("declares the three options in options and schema", () => {
    const optionMatches = config.match(/mcp_remote_enabled|mcp_remote_homeassistant_url|mcp_remote_native_url/g) || [];
    assert.equal(optionMatches.length, 6, "each option must appear once in options and once in schema");
  });

  it("does not reserve the MCP token env names", () => {
    const init = fs.readFileSync(RUN, "utf8");
    const reserved = init.match(/ENV_VARS_RESERVED='([^']*)'/)?.[1] || "";
    for (const name of ["MCP_HTTP_TOKEN", "MCP_HUB_TOKEN"]) {
      assert.ok(!reserved.includes(`\"${name}\"`), `${name} must stay injectable via env_vars`);
    }
  });
});
