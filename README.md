# addons

My personal home-assistant addons

[AI Usage Proxy](ai_usage_proxy/README.md) publishes Claude, OpenAI/Codex, and z.ai subscription usage to MQTT displays and provides account management through Home Assistant Ingress.

[HA MCP](ha_mcp/DOCS.md) serves the Home Assistant MCP server over HTTP for agents elsewhere on the network, without the tools that write configuration.

[IMAP Backup](imap_backup/README.md) is a small Dovecot IMAP server to copy mail into from Apple Mail, stored as Maildir under `/share`.

[Mealie](mealie/DOCS.md) is a recipe manager and meal planner with a phone-friendly web app, OIDC login and AI recipe import.

[Terminal](terminal/DOCS.md) is a personal bash and vim environment with your dotfiles and toolset, Claude Code, and OpenCode's terminal interface for an OpenCode server elsewhere on your network.

## Install

[![Add repository to My Home Assistant](https://my.home-assistant.io/badges/supervisor_add_addon_repository.svg)](https://my.home-assistant.io/redirect/supervisor_add_addon_repository/?repository_url=https://github.com/flapperdeflipper/addons)

Or manually: go to Supervisor -> Add-on store -> Add new repository by url and fill in `https://github.com/flapperdeflipper/addons`.


## Verifying images

Images pushed from `main` are signed with [cosign](https://github.com/sigstore/cosign) keyless, via the build workflow's GitHub OIDC identity. Verify any published tag with:

```console
cosign verify \
  --certificate-identity-regexp '^https://github\.com/flapperdeflipper/addons/\.github/workflows/builder\.yml@refs/heads/main$' \
  --certificate-oidc-issuer-regexp '^https://token\.actions\.githubusercontent\.com$' \
  flapperdeflipper/addon-ha-mcp:1.0.0
```

Swap the image reference for any `flapperdeflipper/addon-*` repository and tag.

**Note:** tags published before cosign was enabled are unsigned; only tags built after the signing workflow landed verify successfully.


## Running the tests locally

`scripts/test-addon.sh` runs an add-on's test suites the same way CI does: node:test and vitest suites through npm, Python suites through [uv](https://docs.astral.sh/uv/) on Python 3.15 with the packages from `<addon>/test/test-requirements.txt`. Needs Node 26 and uv.

```console
scripts/test-addon.sh ai_usage_proxy ha_mcp       # selected add-ons
scripts/test-addon.sh                              # all add-ons + base image pin check
```


## Disclaimer

Most of these addons are either for personal use and as a result not thoroughly tested, others are a direct fork from the community or core addons. You are recommended not to use any of those addons but instead use the original.
