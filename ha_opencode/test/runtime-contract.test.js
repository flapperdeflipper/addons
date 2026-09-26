// The add-on runs exactly one OpenCode build — the certified one baked into
// its agent-base base image — and inherits its whole toolchain from that
// image. That is a property of several files at once (the AGENT_BASE pin in
// the Dockerfile, the CI-read pin in build.yaml, the build-time assertions)
// so it is asserted here rather than trusted to review.
//
// Scoped to the add-on folder this test file ships in, so the copy promoted to
// stable checks stable and the beta copy checks beta.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { describe, it } = require("node:test");

const ADDON_DIR = path.join(__dirname, "..");
const CHANNEL = path.basename(ADDON_DIR);
const ROOTFS = path.join(ADDON_DIR, "rootfs");

const read = (...parts) => fs.readFileSync(path.join(...parts), "utf8");

/** Every shipped shell script and s6 run file, as [relative path, contents]. */
function shellSources() {
  const roots = [
    path.join(ROOTFS, "usr", "local", "bin"),
    path.join(ROOTFS, "usr", "local", "lib", "opencode"),
    path.join(ROOTFS, "etc", "s6-overlay", "s6-rc.d"),
  ];
  const files = [];
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    for (const entry of fs.readdirSync(root, { recursive: true, withFileTypes: true })) {
      const parent = entry.parentPath ?? entry.path ?? root;
      const full = path.join(parent, entry.name);
      if (!entry.isFile()) continue;
      const contents = fs.readFileSync(full);
      // Skip anything that is not text (none today, but the tree grows).
      if (contents.includes(0)) continue;
      files.push([path.relative(ADDON_DIR, full), contents.toString("utf8")]);
    }
  }
  return files;
}

describe(`${CHANNEL} runtime pin`, () => {
  const dockerfile = read(ADDON_DIR, "Dockerfile");
  const buildYaml = read(ADDON_DIR, "build.yaml");

  const basePin = /^ARG AGENT_BASE=(.+)$/m.exec(dockerfile)?.[1]?.trim();
  const buildYamlBasePin = /^\s*AGENT_BASE:\s*"([^"]*)"/m.exec(buildYaml)?.[1];

  it("pins an exact agent-base image in the Dockerfile", () => {
    assert.ok(basePin, "Dockerfile has no ARG AGENT_BASE");
    assert.match(
      basePin,
      /^ghcr\.io\/flapperdeflipper\/agent-base:\d+\.\d+\.\d+$/,
      `AGENT_BASE must be an exact ghcr pin, got '${basePin}'`,
    );
  });

  it("pins the same image in build.yaml, which is what CI reads", () => {
    assert.ok(buildYamlBasePin, "build.yaml has no AGENT_BASE");
    assert.equal(buildYamlBasePin, basePin);
  });

  it("builds from that pin and nothing else", () => {
    assert.match(dockerfile, /^FROM \$\{AGENT_BASE\}$/m);
    // The toolchain must come from the base image, not be reinstalled here:
    // divergence between the add-ons is exactly what agent-base exists to
    // prevent. The single exception is chromium: only this add-on launches a
    // browser (screenshot tool), so it owns that layer since agent-base 1.1.0.
    const aptInstalls = dockerfile.match(/apt-get install[^\n]*/g) ?? [];
    assert.deepEqual(
      aptInstalls.map((l) => /--no-install-recommends\s+(\S+)/.exec(l)?.[1]),
      ["chromium"],
      "only the chromium layer may apt-install; everything else comes from agent-base",
    );
    assert.doesNotMatch(dockerfile, /npm install -g/);
    assert.doesNotMatch(dockerfile, /FROM node:/);
  });

  it("fails closed on architecture selection", () => {
    assert.match(dockerfile, /Unsupported BUILD_ARCH: \$\{BUILD_ARCH:-unset\}/);
  });

  it("fails the build when the inherited runtime is not the certified one", () => {
    assert.match(dockerfile, /test "\$\(opencode --version\)" = "\$\(cat \/usr\/local\/share\/opencode-certified-version\)"/);
  });

  it("carries no OpenChamber pin or bundle since the 2.13.0 split", () => {
    assert.doesNotMatch(dockerfile, /OPENCHAMBER/);
    assert.doesNotMatch(buildYaml, /OPENCHAMBER/);
    assert.equal(
      fs.existsSync(path.join(ROOTFS, "opt", "openchamber")),
      false,
      "rootfs/opt/openchamber should be gone",
    );
    assert.equal(
      fs.existsSync(path.join(ROOTFS, "usr", "local", "bin", "openchamber-ingress-proxy.js")),
      false,
      "the ingress proxy moved to the ha_openchamber add-on",
    );
  });

  it("no longer ships the toolchain layers that moved to agent-base", () => {
    // The ttyd ingress page is built into the base image and only referenced
    // at runtime; the profile.d helpers are inherited.
    assert.equal(fs.existsSync(path.join(ROOTFS, "opt", "ttyd")), false);
    assert.equal(fs.existsSync(path.join(ROOTFS, "etc", "profile.d")), false);
  });

  it("records the certified version for runtime code to read", () => {
    assert.match(
      read(ROOTFS, "usr", "local", "lib", "opencode", "runtime.sh"),
      /opencode_certified_version\(\)/,
    );
  });

  it("uses current Supervisor map types for local app development", () => {
    const config = read(ADDON_DIR, "config.yaml");

    assert.match(config, /^  - type: local_apps$/m);
    assert.match(config, /^  - type: all_app_configs$/m);
    assert.match(config, /^  - type: app_config$/m);
    assert.doesNotMatch(config, /^  - type: (addons|all_addon_configs|addon_config)$/m);
  });
});

describe(`${CHANNEL} bundled runtime precedence`, () => {
  const sources = shellSources();

  it("never installs a rolling OpenCode at runtime", () => {
    for (const [file, contents] of sources) {
      assert.ok(
        !/opencode-ai@latest/.test(contents),
        `${file} still installs opencode-ai@latest`,
      );
      assert.ok(
        !/npm install -g opencode-ai/.test(contents),
        `${file} still installs opencode-ai from npm at runtime`,
      );
    }
  });

  it("ships no background updater", () => {
    assert.equal(
      fs.existsSync(path.join(ROOTFS, "usr", "local", "bin", "opencode-update.sh")),
      false,
    );
  });

  it("never puts the persistent npm prefix ahead of the image binary on PATH", () => {
    for (const [file, contents] of sources) {
      for (const line of contents.split("\n")) {
        if (!/^\s*(export\s+)?PATH=/.test(line) && !/printf 'export PATH=/.test(line)) continue;
        assert.ok(
          !/npm-global/.test(line) && !/NPM_CONFIG_PREFIX\}?\/bin/.test(line),
          `${file} puts the persistent npm prefix on PATH: ${line.trim()}`,
        );
      }
    }
  });

  it("disables OpenCode's own auto-update everywhere a session can start", () => {
    const mustDisable = [
      path.join("rootfs", "etc", "s6-overlay", "s6-rc.d", "init-opencode", "run"),
      path.join("rootfs", "etc", "s6-overlay", "s6-rc.d", "ha-opencode", "run"),
      path.join("rootfs", "etc", "s6-overlay", "s6-rc.d", "ha-opencode-server", "run"),
      path.join("rootfs", "usr", "local", "bin", "opencode-session.sh"),
      path.join("rootfs", "usr", "local", "bin", "ha-readonly"),
    ];
    for (const relative of mustDisable) {
      assert.match(
        read(ADDON_DIR, relative),
        /OPENCODE_DISABLE_AUTOUPDATE=true/,
        `${relative} does not disable OpenCode auto-update`,
      );
    }
  });

  it("carries no update-policy option or plumbing", () => {
    assert.ok(!/opencode_update_policy/.test(read(ADDON_DIR, "config.yaml")));
    assert.ok(!/opencode_update_policy/.test(read(ADDON_DIR, "translations", "en.yaml")));
    for (const [file, contents] of sources) {
      assert.ok(
        !/OPENCODE_UPDATE_POLICY/.test(contents),
        `${file} still branches on the removed update policy`,
      );
    }
    // The legacy marker file of pre-3.0.0 versions is not read either; nothing
    // migrates it anymore.
    const init = read(ROOTFS, "etc", "s6-overlay", "s6-rc.d", "init-opencode", "run");
    assert.ok(!/\.opencode_update_policy/.test(init), "init service still reads the legacy update-policy marker");
  });
});

describe(`${CHANNEL} generated OpenCode configuration contract`, () => {
  const template = JSON.parse(read(ROOTFS, "opt", "ha-mcp-server", "opencode-ha.json"));

  it("runs the bundled MCP server and language server", () => {
    assert.deepEqual(template.mcp.homeassistant.command, ["node", "/opt/ha-mcp-server/index.js"]);
    assert.deepEqual(template.mcp.homeassistant_native.command, [
      "node",
      "/opt/ha-mcp-server/ha-native-mcp-proxy.js",
      "assist",
    ]);
    assert.deepEqual(template.lsp["ha-yaml"].command, [
      "node",
      "/opt/ha-lsp-server/server.js",
      "--stdio",
    ]);
    assert.deepEqual(template.formatter.prettier.command, ["prettier", "--write", "$FILE"]);
  });

  it("keeps the native MCP bridge on (fixed in this fork)", () => {
    assert.equal(template.mcp.homeassistant_native.enabled, true);
    assert.equal(
      template.mcp.homeassistant.environment.OPENCODE_NATIVE_HA_MCP_ENABLED,
      "true",
    );
  });

  it("loads the core MCP instructions", () => {
    assert.ok(template.instructions.includes("/opt/ha-mcp-server/MCP_CORE_INSTRUCTIONS.md"));
  });

  it("asks before edits and before mutating shell commands", () => {
    assert.equal(template.permission.edit, "ask");
    for (const pattern of ["yq -i*", "sed -i*", "tee *", "rm *", "mv *"]) {
      assert.equal(
        template.permission.bash[pattern],
        "ask",
        `permission.bash['${pattern}'] should stay 'ask'`,
      );
    }
  });

  it("references the profile instruction files that are actually selected", () => {
    // The init service fixes the profile to full (the hub server is shared
    // full-profile); only ha-readonly swaps in the compact text.
    const init = read(ROOTFS, "etc", "s6-overlay", "s6-rc.d", "init-opencode", "run");
    assert.match(init, /MCP_PROFILE_FULL\.md/);
    const readonly = read(ROOTFS, "usr", "local", "bin", "ha-readonly");
    assert.match(readonly, /MCP_PROFILE_COMPACT\.md/);
    for (const profile of ["COMPACT", "CONFIGURATION", "FULL"]) {
      assert.ok(
        fs.existsSync(path.join(ROOTFS, "opt", "ha-mcp-server", `MCP_PROFILE_${profile}.md`)),
        `MCP_PROFILE_${profile}.md is missing`,
      );
    }
  });
});
