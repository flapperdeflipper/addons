// Manifest sanity: config.yaml declares the keys the Supervisor store
// pipeline depends on, and the version stays plain semver (repo rule: no
// prerelease/-N suffixes). Text+regex like the other suites here — no YAML
// dependency.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { describe, it } = require("node:test");

const ADDON_DIR = path.join(__dirname, "..");
const config = fs.readFileSync(path.join(ADDON_DIR, "config.yaml"), "utf8");

describe("add-on manifest", () => {
  it("declares a name", () => {
    assert.match(config, /^name:\s*"?[^"\s]/m);
  });

  it("declares a plain-semver version", () => {
    assert.match(config, /^version:\s*"?\d+\.\d+\.\d+"?\s*$/m);
  });

  it("declares a slug matching the add-on directory", () => {
    const slug = path.basename(ADDON_DIR);
    assert.match(config, new RegExp(`^slug:\\s*"?${slug}"?\\s*$`, "m"));
  });
});
