// Static graph regression coverage for the OpenChamber add-on's s6 services,
// ported from ha_opencode (issue #95 lineage). The devcontainer acceptance
// harness separately exercises these definitions under real s6 and Supervisor.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { describe, it } = require("node:test");

// This add-on's directory is the root of its tree (no channel siblings).
const ADDON_ROOT = path.join(__dirname, "..");

function read(filePath) {
  return fs.readFileSync(filePath, "utf8");
}

function servicePath(...parts) {
  return path.join(
    ADDON_ROOT,
    "rootfs",
    "etc",
    "s6-overlay",
    "s6-rc.d",
    ...parts,
  );
}

describe("OpenChamber s6 service ownership", () => {
  {
    it(`ha_openchamber directly supervises all four services`, () => {
      const server = read(servicePath("ha-openchamber", "run"));
      const ingress = read(servicePath("ha-openchamber-ingress", "run"));
      const lan = read(servicePath("ha-openchamber-lan", "run"));
      const mcp = read(servicePath("ha-openchamber-mcp", "run"));
      const dockerfile = read(path.join(ADDON_ROOT, "Dockerfile"));

      for (const service of ["ha-openchamber", "ha-openchamber-ingress", "ha-openchamber-lan", "ha-openchamber-mcp"]) {
        assert.equal(read(servicePath(service, "type")), "longrun\n");
        assert.equal(
          fs.existsSync(servicePath("user", "contents.d", service)),
          true,
          `${service} must be in the user bundle`,
        );
      }

      assert.equal(
        fs.existsSync(servicePath("ha-openchamber-ingress", "dependencies.d", "ha-openchamber")),
        true,
      );
      assert.equal(
        fs.existsSync(servicePath("ha-openchamber-lan", "dependencies.d", "ha-openchamber")),
        true,
      );

      assert.match(server, /^exec "\$\{OPENCHAMBER_BIN\}" serve/m);
      assert.doesNotMatch(server, /OPENCHAMBER_PID|wait -n|trap cleanup/);
      assert.doesNotMatch(server, /^.*\s&\s*(?:#.*)?$/m);

      assert.match(ingress, /exec node \/usr\/local\/bin\/openchamber-ingress-proxy\.js/);
      assert.doesNotMatch(ingress, /^.*\s&\s*(?:#.*)?$/m);
      assert.match(ingress, /http:\/\/127\.0\.0\.1:\$\{OPENCHAMBER_INTERNAL_PORT\}\/health/);
      assert.match(ingress, /\/command\/s6-svc -r \/run\/service\/ha-openchamber/);
      assert.match(ingress, /export OPENCHAMBER_ALLOW_ANY_REMOTE="false"/);
      assert.doesNotMatch(ingress, /OPENCHAMBER_BASIC_USER|OPENCHAMBER_BASIC_PASSWORD/);

      assert.match(lan, /exec node \/usr\/local\/bin\/openchamber-ingress-proxy\.js/);
      assert.match(lan, /export OPENCHAMBER_ALLOWED_REMOTES=/);
      assert.match(lan, /export OPENCHAMBER_REDIRECT_URL=/);
      assert.doesNotMatch(lan, /OPENCHAMBER_BASIC_USER|OPENCHAMBER_BASIC_PASSWORD/);
      assert.doesNotMatch(lan, /OPENCHAMBER_ALLOW_ANY_REMOTE/);

      // The agent MCP service idles when disabled, refuses to serve without
      // a token, proxies only the loopback REST API, and never fails the
      // container.
      assert.match(mcp, /exec node \/opt\/openchamber-mcp\/server\.mjs/);
      assert.match(mcp, /bashio::config 'mcp_enabled'/);
      assert.match(mcp, /bashio::config 'mcp_token'/);
      assert.match(mcp, /export OPENCHAMBER_URL="http:\/\/127\.0\.0\.1:3010"/);
      assert.match(mcp, /export MCP_PORT=4100/);
      assert.doesNotMatch(mcp, /^.*\s&\s*(?:#.*)?$/m);

      assert.equal(
        fs.existsSync(servicePath("ha-openchamber-mcp", "dependencies.d", "ha-openchamber")),
        true,
      );

      assert.match(
        dockerfile,
        /chmod \+x \/etc\/s6-overlay\/s6-rc\.d\/ha-openchamber-ingress\/run/,
      );
      assert.match(
        dockerfile,
        /npm install --prefix \/opt\/openchamber-mcp/,
      );
    });

    it(`ha_openchamber attaches to an external OpenCode server and never spawns one`, () => {
      const server = read(servicePath("ha-openchamber", "run"));

      assert.match(server, /export OPENCODE_HOST="\$\{OPENCODE_ORIGIN\}:\$\{OPENCODE_PORT\}"/);
      assert.match(server, /export OPENCODE_SKIP_START="true"/);
      assert.match(server, /export OPENCODE_SERVER_PASSWORD=/);
      assert.doesNotMatch(server, /opencode serve/);
    });
  }
});
