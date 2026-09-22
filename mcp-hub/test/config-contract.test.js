// Contract tests for config.yaml - the Supervisor gotchas that have bitten
// sibling add-ons: options/schema key order, the version/CHANGELOG pair, the
// image namespace, and the modules' enabledOption keys.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { createRequire } = require("node:module");
const { describe, it } = require("node:test");

const ADDON_ROOT = path.join(__dirname, "..");
const SERVER_PACKAGE = path.join(ADDON_ROOT, "rootfs", "opt", "mcp-hub", "package.json");

// js-yaml is a devDependency of the server package; resolve it from there
// so the tests work in a fresh worktree after `npm ci --include=dev`.
const requireFromServer = createRequire(SERVER_PACKAGE);
const yaml = requireFromServer("js-yaml");

const config = yaml.load(fs.readFileSync(path.join(ADDON_ROOT, "config.yaml"), "utf8"));

const changelog = fs.readFileSync(path.join(ADDON_ROOT, "CHANGELOG.md"), "utf8");
const changelogVersion = /^## (.+)$/m.exec(changelog)?.[1];

describe("config contract", () => {
  it("options and schema declare the same keys in the same order", () => {
    assert.deepEqual(
      Object.keys(config.options),
      Object.keys(config.schema),
      "options and schema keys must match exactly and in order, or an option silently reads back as \"null\""
    );
  });

  it("version matches the newest CHANGELOG entry", () => {
    assert.ok(changelogVersion, "CHANGELOG.md must have a ## <version> heading");
    assert.equal(config.version, changelogVersion);
  });

  it("image is published under the flapperdeflipper addon- namespace", () => {
    assert.equal(config.image, "flapperdeflipper/addon-mcp-hub");
  });

  it("every exposed port has a description", () => {
    for (const port of Object.keys(config.ports)) {
      assert.ok(config.ports_description?.[port], `port ${port} needs a ports_description entry`);
    }
  });

  it("the hub token is a password-typed option", () => {
    assert.equal(config.schema.token, "password");
    assert.equal(config.options.token, "");
  });

  it("every registry module's enabledOption exists in options", async () => {
    const registryPath = path.join(
      ADDON_ROOT, "rootfs", "opt", "mcp-hub", "src", "registry.js"
    );
    const serversDir = path.join(ADDON_ROOT, "rootfs", "opt", "mcp-hub", "src", "servers");
    const registry = fs.readFileSync(registryPath, "utf8");
    const moduleDirs = fs.readdirSync(serversDir).filter((entry) =>
      fs.statSync(path.join(serversDir, entry)).isDirectory()
    );
    assert.ok(moduleDirs.length >= 3, "expected at least the three bundled servers");
    for (const dir of moduleDirs) {
      assert.match(
        registry,
        new RegExp(`from "./servers/${dir}/index.js"`),
        `server '${dir}' exists but is not imported in registry.js`
      );
      const manifest = await import(
        path.join(serversDir, dir, "index.js")
      );
      assert.ok(manifest.default?.id, `server '${dir}' must default-export a manifest with an id`);
      assert.ok(
        manifest.default.enabledOption in config.options,
        `server '${dir}' references option '${manifest.default.enabledOption}' missing from config.yaml`
      );
    }
  });
});
