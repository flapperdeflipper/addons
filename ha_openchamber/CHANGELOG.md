# Changelog
All notable changes to this project will be documented in this file.

## 1.0.0

- **First release — OpenChamber as its own add-on** — the OpenChamber browser UI for OpenCode conversations, split out of the OpenCode add-on (ha_opencode 2.14.0 removes its bundled copy). Runs the pinned `@openchamber/web` 1.24.1 in a dedicated slim image (base-debian + Node 24.21.0, Ingress-patched bundle, first-party ingress proxy) with no OpenCode runtime, terminal, MCP server, or Home Assistant config access of its own.
- **Attaches to the OpenCode add-on's LAN server instead of spawning OpenCode** — upstream's external-server mode (`OPENCODE_HOST` + `OPENCODE_SKIP_START`): the add-on auto-discovers the Docker host gateway (explicit `opencode_host` override supported), waits up to two minutes for the server, and authenticates every API call with the shared basic-auth credentials. Sessions shown are exactly the OpenCode add-on's; OpenChamber keeps none of its own.
- **Basic authentication on the LAN web UI** — the mappable 4097/tcp proxy instance now requires HTTP Basic auth (constant-time comparison, 401 + `WWW-Authenticate` on plain requests and WebSocket upgrades alike) using the same `opencode_username`/`opencode_password` options. The Home Assistant Ingress listener keeps its strict remote allowlist and stays authentication-free — Home Assistant's login covers it. This is the pattern the OpenCode add-on's LAN server adopts in the same release, so one credential pair protects both exposed ports.
