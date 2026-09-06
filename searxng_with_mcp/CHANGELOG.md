# Changelog
All notable changes to this project will be documented in this file.

## 2026.9.9

- **Fixed 403 on every MCP search** — SearXNG allows only the `html` output format by default, so the bundled MCP server's `format=json` queries all failed with `403 Forbidden`. New `search_formats.py` runs at boot (after the engines patch) and idempotently adds `json` to `search.formats` in settings.yml, touching only that line and preserving the rest of the file byte-for-byte. Unrecognized layouts are logged and left unchanged so SearXNG still starts.

## 2026.9.8

- **Python dependency refresh** — fastmcp >=4.0.1<5, beautifulsoup4 >=4.15.0<5, trafilatura >=2.2.0<3, pymupdf4llm >=1.28.2, python-dateutil >=2.9.0.post0<3. fastmcp 4, trafilatura 2 and pymupdf4llm 1.x are major version jumps.

## 2026.9.7

- **Modern map type** — rename the legacy `addon_config` map to `app_config` (same volume, new Supervisor naming); clears the store validation warning.

## 2026.9.6

- **Rebuild for cosign signing** — no functional changes; rebuilt from master after keyless cosign image signing landed in CI, so this tag publishes with a signature.

## 2026.9.5

- **Version scheme change** — local versions are now plain semver (`2026.9.5`), bumped past the upstream base tag (noted in a `config.yaml` comment). The old `<upstream>-<patch>` suffix scheme confused Supervisor version handling.
- **Fixed ingress CSS** — `run.sh` parsed `set_base_url_for_ingress` with `grep | cut`, which silently fails on the Supervisor's single-line `options.json`, so `SEARXNG_BASE_URL` was never set and the ingress UI lost its stylesheet. Option parsing now uses python/json.

## 2026.9.4-15b0c8ef3-1

- **GitHub code search via `!secret`** — new `github_token` option accepts an HA-style `!secret github_token` value; the Supervisor resolves it against secrets.yaml and the add-on injects the authenticated `github code` engine (shortcut `ghc`) into settings.yml at every start, between managed markers. Token values never appear in the file the user edits and are never logged.
- **GitLab engine** — new `gitlab_engine` option (default on) adds gitlab.com project search. The upstream engine has no authentication support, so no token is used.
- Managed block is regenerated idempotently at boot; everything else in settings.yml is preserved. On first boot (no settings.yml yet) a minimal `use_default_settings: true` config is created.
