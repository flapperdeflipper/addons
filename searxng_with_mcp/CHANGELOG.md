# Changelog
All notable changes to this project will be documented in this file.

## 2026.9.4-15b0c8ef3-1

- **GitHub code search via `!secret`** — new `github_token` option accepts an HA-style `!secret github_token` value; the Supervisor resolves it against secrets.yaml and the add-on injects the authenticated `github code` engine (shortcut `ghc`) into settings.yml at every start, between managed markers. Token values never appear in the file the user edits and are never logged.
- **GitLab engine** — new `gitlab_engine` option (default on) adds gitlab.com project search. The upstream engine has no authentication support, so no token is used.
- Managed block is regenerated idempotently at boot; everything else in settings.yml is preserved. On first boot (no settings.yml yet) a minimal `use_default_settings: true` config is created.
