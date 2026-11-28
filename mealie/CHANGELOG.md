# Changelog
All notable changes to this project will be documented in this file.

## 1.1.0

- **Added** — `postgres` options: Mealie can use a Postgres database instead of the SQLite file (TLS required, password as a file only the Mealie user can read). Off by default; existing installs keep SQLite until it is enabled. DOCS: how to move the data with a Mealie backup and restore.

## 1.0.1

- **Changed** — Dockerfile comment no longer refers to the removed LiteLLM add-on. No functional change.

## 1.0.0

- **Added** — first release: Mealie v3.31.0 from the official image, data under `/data/mealie` (SQLite) with cold Home Assistant backups, OIDC login options, trusted-proxy list that refuses `*`, and the web UI on port 9925.
