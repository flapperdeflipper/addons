# Changelog
All notable changes to this project will be documented in this file.

## 2026.9.1

- **Add-on icon and logo** — branding images added, shown in the add-on store.

## 2026.9.0

- **Initial release** — vendored from [`hemm-ems/hactl-companion`](https://github.com/hemm-ems/hactl-companion) at upstream 2026.7.13 (upstream publishes no LICENSE file; vendored with attribution at the operator's discretion). Bridge add-on for the hactl CLI: authenticated Ingress API for reading/writing HA YAML config, Supervisor queries, log tailing and reload/restart commands, with optional WireGuard tunnel management.
- **Layout restructured for the add-on builder** — Dockerfile, run.sh, pyproject.toml and `src/` moved from the repo root into the add-on folder; image published as `flapperdeflipper/addon-hactl-companion`. Dev files (tests, CI workflows, compose files, dev docs) stay upstream-only.
- **DOCS.md install section** now points at this repository; upstream links kept for reference.
