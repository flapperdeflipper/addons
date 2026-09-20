# Changelog

## 1.0.0

- **Add**: initial release - shared MCP gateway add-on serving one process per tool set over streamable HTTP behind a single bearer token (`/mcp/<id>`, port 8930). Bundled servers: **VictoriaMetrics** (fork of the prometheus-mcp-server 1.0.1 tool set, exact tool contract, plain-fetch client), **Home Assistant native MCP forwarder** (fork of ha_opencode's ha-native-mcp bridge with keyed-endpoint negotiation and 404 fallback) and **Playwright** (one shared @playwright/mcp 0.0.80 instance over CDP to the playwright-browser add-on, loopback-bound behind the gateway).
- **Add**: extensible server registry (`src/servers/<id>/` manifests with `mcp`, `forwarder` and `upstream` kinds) so future MCP servers drop in without touching the gateway.
- **Performance**: replaces per-agent-session stdio spawns that cost ~260 MB each (playwright-mcp + prometheus-mcp-server + ha-mcp-server) with shared processes; ~1.3 GB at the current five concurrent OpenCode sessions.
