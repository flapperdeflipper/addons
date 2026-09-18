// hactl ships as a pinned GitHub release and is wired into sessions by three
// files at once: the Dockerfile install, the init service that writes
// /data/hactl/.env from the access_token option, and the profile.d wrapper
// that turns unconfigured use into setup instructions. Those properties are
// asserted here rather than trusted to review, mirroring runtime-contract.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { describe, it } = require("node:test");

const ADDON_DIR = path.join(__dirname, "..");
const ROOTFS = path.join(ADDON_DIR, "rootfs");

const read = (...parts) => fs.readFileSync(path.join(...parts), "utf8");

describe("hactl image install", () => {
  const dockerfile = read(ADDON_DIR, "Dockerfile");

  const versionPin = /^ARG HACTL_VERSION=(.+)$/m.exec(dockerfile)?.[1]?.trim();

  it("pins an exact hactl release", () => {
    assert.ok(versionPin, "Dockerfile has no ARG HACTL_VERSION");
    assert.match(
      versionPin,
      /^\d{4}\.\d+\.\d+$/,
      `HACTL_VERSION must be an exact calendar version, got '${versionPin}'`,
    );
  });

  it("downloads the pinned release, handling the v-prefixed tag", () => {
    assert.match(
      dockerfile,
      new RegExp(
        `releases/download/v\\$\\{HACTL_VERSION\\}/hactl_\\$\\{HACTL_VERSION\\}_linux_\\$\\{ARCH\\}\\.tar\\.gz`,
      ),
    );
    // Debian arch (amd64/arm64) in the asset name, like yq/cosign.
    assert.match(dockerfile, /echo "arm64" \|\| echo "amd64"/);
  });

  it("extracts only the binary and fails the build on a wrong version", () => {
    assert.match(dockerfile, /tar -xzf \/tmp\/hactl\.tar\.gz -C \/tmp hactl/);
    assert.match(dockerfile, /install -m 0755 \/tmp\/hactl \/usr\/local\/bin\/hactl/);
    assert.match(dockerfile, /hactl version 2>\/dev\/null \| grep -q "hactl \$\{HACTL_VERSION\}"/);
  });

  it("marks the profile.d wrapper executable", () => {
    assert.match(dockerfile, /chmod \+x \/etc\/profile\.d\/hactl\.sh/);
  });
});

describe("hactl instance wiring", () => {
  const init = read(ROOTFS, "etc", "s6-overlay", "s6-rc.d", "init-opencode", "run");

  it("writes the .env from the access token option, tightly scoped", () => {
    assert.match(init, /printf 'HA_URL=http:\/\/supervisor\/core\\nHA_TOKEN=%s\\n' "\$\{ACCESS_TOKEN\}" > \/data\/hactl\/\.env/);
    assert.match(init, /chmod 700 \/data\/hactl/);
    assert.match(init, /chmod 600 \/data\/hactl\/\.env/);
    // Written under umask 077 so no other mode can leak in.
    assert.match(init, /umask 077/);
  });

  it("removes a stale .env when no token is configured", () => {
    assert.match(init, /rm -f \/data\/hactl\/\.env/);
  });

  it("points every session at the instance directory", () => {
    assert.match(init, /printf 'export HACTL_DIR=\/data\/hactl\\n' >> "\$\{ENV_VARS_FILE\}"/);
  });
});

describe("hactl profile.d wrapper", () => {
  const wrapper = read(ROOTFS, "etc", "profile.d", "hactl.sh");

  it("blocks API commands with setup instructions when unconfigured", () => {
    assert.match(wrapper, /\[ ! -f \/data\/hactl\/\.env \]/);
    assert.match(wrapper, /Long-lived Access Tokens/);
    assert.match(wrapper, /access.token/);
    assert.match(wrapper, /return 1/);
  });

  it("keeps offline commands available without configuration", () => {
    for (const sub of ["rtfm", "version", "help", "--help"]) {
      assert.ok(wrapper.includes(sub), `wrapper should keep '${sub}' available`);
    }
    assert.match(wrapper, /command hactl "\$@"/);
  });
});
