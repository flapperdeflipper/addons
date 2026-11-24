// The service and session scripts: the client attaches with --server and the
// password from the environment (never a command-line argument), and the
// add-on asks for no Home Assistant access. Text+regex like the other suites.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { describe, it } = require("node:test");

const ADDON_DIR = path.join(__dirname, "..");
const read = (p) => fs.readFileSync(path.join(ADDON_DIR, p), "utf8");
const run = read("rootfs/etc/s6-overlay/s6-rc.d/opencode-tui/run");
const session = read("rootfs/usr/local/bin/opencode-tui-session");
const config = read("config.yaml");

describe("opencode_tui scripts", () => {
  it("attaches the client to the configured server and directory", () => {
    assert.match(session, /opencode --server "\$\{OPENCODE_TUI_SERVER\}" "\$\{directory\}"/);
  });

  it("creates the start directory locally before the client changes into it", () => {
    assert.match(session, /mkdir -p "\$\{directory\}"[\s\S]*opencode --server/);
  });

  it("passes the password through the environment only", () => {
    assert.match(run, /export OPENCODE_PASSWORD="\$\{SERVER_PASSWORD\}"/);
    assert.doesNotMatch(session, /--password/);
    assert.doesNotMatch(run, /tmux[^\n]*PASSWORD/);
  });

  it("refuses to start without an address or password", () => {
    assert.match(run, /bashio::var\.has_value "\$\{SERVER_URL\}"/);
    assert.match(run, /exec sleep infinity/);
  });

  it("keeps the session in tmux on the Ingress port", () => {
    assert.match(run, /-p 8099/);
    assert.match(run, /tmux new-session -A -s opencode/);
    assert.match(config, /^ingress_port: 8099$/m);
  });
});

describe("opencode_tui manifest", () => {
  it("asks for no Home Assistant or Supervisor API and maps no folder", () => {
    assert.match(config, /^hassio_api: false$/m);
    assert.match(config, /^homeassistant_api: false$/m);
    assert.doesNotMatch(config, /^map:/m);
  });

  it("ships without a server address (set per installation)", () => {
    assert.match(config, /^  server_url: null$/m);
  });
});
