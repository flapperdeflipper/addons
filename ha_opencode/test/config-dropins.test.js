// The drop-in merger assembles /data/.config/opencode/config.json from the
// opencode_config option plus /homeassistant/opencode.d/*.json. A broken
// drop-in must never fail the init oneshot or discard the previous config,
// so those guarantees are exercised here against a sandbox rather than
// trusted to review.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { describe, it, before, after } = require("node:test");

const ADDON_DIR = path.join(__dirname, "..");
const CHANNEL = path.basename(ADDON_DIR);
const MERGER = path.join(ADDON_DIR, "rootfs", "usr", "local", "lib", "opencode", "merge-config-dropins");
const INIT_RUN = path.join(ADDON_DIR, "rootfs", "etc", "s6-overlay", "s6-rc.d", "init-opencode", "run");

function hasTool(name) {
  try {
    execFileSync(name, ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const write = (file, contents) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, contents);
};

describe(`${CHANNEL} config drop-ins`, () => {
  let sandbox;

  before(function () {
    if (!hasTool("jq")) {
      this.skip();
    }
    sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "config-dropins-"));
  });

  after(() => {
    if (sandbox) fs.rmSync(sandbox, { recursive: true, force: true });
  });

  /** Run the merger against sandbox paths; returns { output, target }. */
  function run({ base = null, files = {}, existingTarget = null } = {}) {
    const target = path.join(sandbox, `target-${Math.random().toString(36).slice(2)}.json`);
    const dropinDir = path.join(sandbox, `dropins-${Math.random().toString(36).slice(2)}`);
    for (const [name, contents] of Object.entries(files)) {
      write(path.join(dropinDir, name), contents);
    }
    if (existingTarget !== null) write(target, existingTarget);

    const args = [MERGER, target, dropinDir];
    if (base !== null) args.push(base);
    const output = execFileSync("bash", args, { encoding: "utf8" });
    const readTarget = () => (fs.existsSync(target) ? JSON.parse(fs.readFileSync(target, "utf8")) : null);
    return { output, target, readTarget };
  }

  it("merges drop-ins in alphabetical order, deep, later file winning", () => {
    const { output, readTarget } = run({
      files: {
        "b-second.json": JSON.stringify({ provider: { litellm: { timeout: 30 } }, only: { b: 1 } }),
        "a-first.json": JSON.stringify({ provider: { litellm: { timeout: 99 } } }),
      },
    });
    assert.match(output, /MERGED: 2 file\(s\)/);
    assert.deepEqual(readTarget(), {
      provider: { litellm: { timeout: 30 } },
      only: { b: 1 },
    });
  });

  it("deep-merges over the option's config, drop-in winning", () => {
    const base = path.join(sandbox, "base-option.json");
    write(base, JSON.stringify({ model: "litellm/glm-5.3", small_model: "zai-coding-plan/glm-5.3-flash" }));
    const { output, readTarget } = run({
      base,
      files: { "00-small.json": JSON.stringify({ small_model: "litellm/glm-5.3" }) },
    });
    assert.match(output, /MERGED: 2 file\(s\)/);
    assert.deepEqual(readTarget(), { model: "litellm/glm-5.3", small_model: "litellm/glm-5.3" });
  });

  it("skips an unparseable file with a named error, the rest still applies", () => {
    const { output, readTarget } = run({
      files: {
        "00-broken.json": '{ "small_model": "oops', // no closing brace
        "01-good.json": JSON.stringify({ small_model: "litellm/glm-5.3" }),
      },
    });
    assert.match(output, /ERROR: .*00-broken\.json/);
    assert.match(output, /MERGED: 1 file\(s\)/);
    assert.deepEqual(readTarget(), { small_model: "litellm/glm-5.3" });
  });

  it("skips valid JSON that is not an object", () => {
    const { output, readTarget } = run({
      files: { "00-array.json": "[1, 2]", "01-obj.json": JSON.stringify({ ok: true }) },
    });
    assert.match(output, /ERROR: .*00-array\.json/);
    assert.deepEqual(readTarget(), { ok: true });
  });

  it("leaves an existing target untouched when nothing usable merges", () => {
    const { output, readTarget } = run({
      existingTarget: JSON.stringify({ previous: true }),
      files: { "00-broken.json": "not json" },
    });
    assert.match(output, /ERROR: .*00-broken\.json/);
    assert.deepEqual(readTarget(), { previous: true });
  });

  it("writes nothing and stays silent without drop-ins", () => {
    const { output, readTarget } = run({ existingTarget: JSON.stringify({ option: true }) });
    assert.equal(output.trim(), "");
    assert.deepEqual(readTarget(), { option: true });
  });

  it("is wired into the init service so a drop-in cannot be silently ignored", () => {
    const runScript = fs.readFileSync(INIT_RUN, "utf8");
    assert.match(runScript, /merge-config-dropins/);
    assert.match(runScript, /OPENCODE_DROPIN_DIR="\/config"/);
    // The merger exits 0 by contract; the init must not swallow its errors.
    assert.match(runScript, /ERROR:\*\).*bashio::log\.error/);
  });

  it("requests the standardized add-on config folder the drop-ins live in", () => {
    const manifest = fs.readFileSync(path.join(ADDON_DIR, "config.yaml"), "utf8");
    assert.match(manifest, /^  - type: addon_config\n    read_only: false\n/m);
  });
});
