// Regression coverage: the hub MCP mode of the generated opencode.json.
// The generator's jq program is extracted from the init service and executed
// against the real template, so these tests fail on any syntax error, not
// just on shape changes.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { describe, it } = require("node:test");

const ADDON_ROOT = path.join(__dirname, "..");
const RUN = path.join(ADDON_ROOT, "rootfs", "etc", "s6-overlay", "s6-rc.d", "init-opencode", "run");
const TEMPLATE = path.join(ADDON_ROOT, "rootfs", "opt", "ha-mcp-server", "opencode-ha.json");

// The generator jq spans from the line starting with "jq --arg mcp_hub_url"
// (ending in an opening quote) to the closing quote line before the template
// redirect; both anchors are stable.
const lines = fs.readFileSync(RUN, "utf8").split("\n");
const openIdx = lines.findIndex((line) => line.startsWith("jq --arg mcp_hub_url") && line.endsWith("'"));
const closeIdx = lines.findIndex((line, i) => i > openIdx && line === "' /opt/ha-mcp-server/opencode-ha.json > /data/.config/opencode/opencode.json");
assert.ok(openIdx !== -1 && closeIdx !== -1, "generator jq not found in init service");
const program = lines.slice(openIdx + 1, closeIdx).join("\n");

function generate({ hubUrl = "", litellmUrl = "", keyEnv = "LITELLM_HASS_KEY" } = {}) {
  const out = execFileSync("jq", [
    "--arg", "mcp_hub_url", hubUrl,
    "--arg", "mcp_litellm_url", litellmUrl,
    "--arg", "mcp_litellm_key_env", keyEnv,
    "--arg", "profile_instruction", "/x",
    "--arg", "channel_agents", "",
    program,
    TEMPLATE,
  ]);
  return JSON.parse(out.toString("utf8"));
}

describe("hub MCP mode (3.0.0)", () => {
  it("emits remote entries with env-ref headers and no stdio remnants", () => {
    const cfg = generate({ hubUrl: "http://10.20.0.3:8930" });
    const h = cfg.mcp.homeassistant;
    assert.equal(h.type, "remote");
    assert.equal(h.url, "http://10.20.0.3:8930/mcp/homeassistant");
    assert.equal(h.headers.Authorization, "Bearer {env:MCP_HUB_TOKEN}");
    assert.equal(h.enabled, true);
    assert.ok(!("command" in h) && !("environment" in h), "remote entry must not carry stdio keys");

    const n = cfg.mcp.homeassistant_native;
    assert.equal(n.type, "remote");
    assert.equal(n.url, "http://10.20.0.3:8930/mcp/ha-native");
    assert.equal(n.headers.Authorization, "Bearer {env:MCP_HUB_TOKEN}");
    assert.ok(!("command" in n));
  });

  it("tolerates a trailing slash in the hub URL", () => {
    const cfg = generate({ hubUrl: "http://10.20.0.3:8930/" });
    assert.equal(cfg.mcp.homeassistant.url, "http://10.20.0.3:8930/mcp/homeassistant");
  });

  it("keeps local stdio generation when no hub is configured", () => {
    const cfg = generate({ hubUrl: "" });
    const h = cfg.mcp.homeassistant;
    assert.notEqual(h.type, "remote");
    assert.deepEqual(h.command.slice(0, 2), ["node", "/opt/ha-mcp-server/index.js"]);
    assert.equal(h.environment.OPENCODE_MCP_TOOL_PROFILE, "full");
    assert.equal(cfg.mcp.homeassistant_native.enabled, true);
    assert.ok(cfg.mcp.homeassistant_native.command[1].endsWith("ha-native-mcp-proxy.js"));
  });

  it("always applies the fixed instructions and read restrictions", () => {
    for (const hubUrl of ["", "http://10.20.0.3:8930"]) {
      const cfg = generate({ hubUrl });
      assert.equal(cfg.permission.read["*secrets.yaml"], "deny");
      assert.equal(cfg.permission.read["*.pem"], "deny");
      for (const instruction of [
        "/opt/ha-mcp-server/FOCUS_MODE.md",
        "/x",
        "/data/context/home-briefing.md",
        "/opt/ha-mcp-server/USER_HOOKS.md",
        "/homeassistant/AGENTS.local.md",
      ]) {
        assert.ok(cfg.instructions.includes(instruction), `${instruction} missing (hub=${hubUrl})`);
      }
      assert.equal(cfg.lsp["ha-yaml"].disabled, undefined);
    }
  });
});

describe("litellm MCP mode (3.1.0)", () => {
  it("replaces the whole mcp section with a single litellm entry", () => {
    const cfg = generate({ litellmUrl: "http://10.60.0.3:4000" });
    assert.deepEqual(Object.keys(cfg.mcp), ["litellm"]);
    const l = cfg.mcp.litellm;
    assert.equal(l.type, "remote");
    assert.equal(l.url, "http://10.60.0.3:4000/mcp");
    assert.equal(l.enabled, true);
    assert.equal(l.timeout, 120000);
    assert.equal(l.headers.Authorization, "Bearer {env:LITELLM_HASS_KEY}");
  });

  it("takes precedence over the hub mode", () => {
    const cfg = generate({ litellmUrl: "http://10.60.0.3:4000", hubUrl: "http://10.60.0.3:8930" });
    assert.deepEqual(Object.keys(cfg.mcp), ["litellm"]);
  });

  it("honors a custom key env name and trims a trailing slash", () => {
    const cfg = generate({ litellmUrl: "http://h:4000/", keyEnv: "LITELLM_REMOTE_KEY" });
    assert.equal(cfg.mcp.litellm.url, "http://h:4000/mcp");
    assert.equal(cfg.mcp.litellm.headers.Authorization, "Bearer {env:LITELLM_REMOTE_KEY}");
  });

  it("wires the litellm provider, discovery plugin and default model pair", () => {
    const cfg = generate({ litellmUrl: "http://10.60.0.3:4000", keyEnv: "LITELLM_HASS_KEY" });
    assert.deepEqual(cfg.plugin, ["opencode-plugin-litellm@1.3.0"]);
    assert.equal(cfg.model, "litellm/glm-5.3");
    assert.equal(cfg.small_model, "litellm/glm-5.3-flash-small");
    const p = cfg.provider.litellm;
    assert.equal(p.npm, "@ai-sdk/openai-compatible");
    assert.equal(p.options.baseURL, "http://10.60.0.3:4000/v1");
    assert.equal(p.options.apiKey, "{env:LITELLM_HASS_KEY}");
    assert.equal(p.options.timeout, 600000);
  });

  it("keeps provider wiring consistent with a custom key env name", () => {
    const cfg = generate({ litellmUrl: "http://h:4000", keyEnv: "LITELLM_REMOTE_KEY" });
    assert.equal(cfg.provider.litellm.options.apiKey, "{env:LITELLM_REMOTE_KEY}");
    assert.equal(cfg.mcp.litellm.headers.Authorization, "Bearer {env:LITELLM_REMOTE_KEY}");
  });

  it("leaves provider, plugin and model untouched without a gateway", () => {
    const cfg = generate({ hubUrl: "http://10.20.0.3:8930" });
    assert.equal(cfg.plugin, undefined);
    assert.equal(cfg.model, undefined);
    assert.equal(cfg.provider, undefined);
  });

  it("keeps the fixed instructions and read restrictions in litellm mode too", () => {
    const cfg = generate({ litellmUrl: "http://10.60.0.3:4000" });
    assert.equal(cfg.permission.read["*secrets.yaml"], "deny");
    assert.ok(cfg.instructions.includes("/homeassistant/AGENTS.local.md"));
  });
});

describe("hub MCP option contract (3.0.0)", () => {
  const config = fs.readFileSync(path.join(ADDON_ROOT, "config.yaml"), "utf8");
  const init = fs.readFileSync(RUN, "utf8");

  it("declares mcp_hub_url in options and schema", () => {
    assert.equal((config.match(/^  mcp_hub_url:/gm) || []).length, 2);
  });

  it("declares the litellm gateway options in options and schema", () => {
    assert.equal((config.match(/^  mcp_litellm_url:/gm) || []).length, 2);
    assert.equal((config.match(/^  mcp_litellm_key_env:/gm) || []).length, 2);
  });

  it("does not reserve the MCP token env names", () => {
    const reserved = init.match(/ENV_VARS_RESERVED='([^']*)'/)?.[1] || "";
    for (const name of ["MCP_HTTP_TOKEN", "MCP_HUB_TOKEN"]) {
      assert.ok(!reserved.includes(`\"${name}\"`), `${name} must stay injectable via env_vars`);
    }
  });

  it("no removed option is still read from the configuration", () => {
    for (const gone of [
      "mcp_enabled", "mcp_tool_profile", "lsp_enabled", "screenshot_enabled",
      "native_ha_mcp_enabled", "native_ha_mcp_api_id", "home_briefing_enabled",
      "decision_notes_enabled", "restrict_sensitive_files", "addon_access_enabled",
      "cpu_mode", "enable_server", "server_username", "mcp_http_enabled",
      "mcp_remote_enabled", "ppq_private_enabled", "ppq_api_key",
      "serial_devices", "user_hooks_enabled", "terminal_theme", "font_size",
      "cursor_style", "cursor_blink", "focus_mode",
    ]) {
      assert.ok(!init.includes(`'${gone}'`), `init service still reads option '${gone}'`);
      assert.ok(!config.includes(`${gone}:`), `config.yaml still declares '${gone}'`);
    }
  });
});
