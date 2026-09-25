# Changelog

## 1.1.1

- **Fix**: `/mcp/homeassistant` answered every request with `HTTP 406 Not Acceptable` - the forwarder sent `Accept: application/json`, but ha-mcp-server's streamable HTTP transport (per the MCP spec) requires clients to accept both `application/json` and `text/event-stream`. The forwarder now sends the combined Accept header; ha-mcp-server replies with plain JSON, which the existing parsing already handles.

## 1.1.0

- **Add**: `/mcp/homeassistant` - a forwarder route to the full ha-mcp-server (entity/state, safe config writing, supervisor tools, MQTT, todo, hab/zigporter/ESPHome companions) hosted by the ha_opencode add-on's always-on 8927 HTTP endpoint. The server process stays in ha_opencode (it execs the hab CLI and launches Chromium for screenshots); the hub only makes it reachable at the single entrypoint with the single hub token. New options `homeassistant_enabled` (default on), `homeassistant_url` and `homeassistant_token` (the ha_opencode `mcp_http_token`); with the URL unset the route reports `failed` in `/healthz` and answers 503 while the rest of the hub keeps working.

## 1.0.2

- **Fix**: playwright answered proxied requests with `Access is only allowed at localhost:7101` - @playwright/mcp validates the Host header (anti-DNS-rebinding) and rejects the hub's rewritten `127.0.0.1:7101`. The proxy now sends `Host: localhost:<port>` so both the streamable `/mcp` and legacy `/sse` endpoints work through the gateway.
## 1.0.1

- **Fix**: ha-native answered every request with `internal error` - the gateway calls `validateJsonRpcMessage` on the module manifest, but ha-native exported it as a module named export instead of a manifest property. The validator now lives on the manifest, and forwarder modules missing it fail at startup (state `failed` in `/healthz`, 503 on their path) instead of 500ing per request.
- **Fix**: playwright answered 404 on its own sub-paths - @playwright/mcp serves streamable HTTP at its `/mcp` and legacy SSE at its `/sse`, but gateway routing was exact-match. `upstream` modules now pass sub-paths and query strings through (`/mcp/playwright/mcp`, `/mcp/playwright/sse`); stateless `mcp`/`forwarder` kinds still reject sub-paths with 404.
## 1.0.0

- **Add**: initial release - shared MCP gateway add-on serving one process per tool set over streamable HTTP behind a single bearer token (`/mcp/<id>`, port 8930). Bundled servers: **VictoriaMetrics** (fork of the prometheus-mcp-server 1.0.1 tool set, exact tool contract, plain-fetch client), **Home Assistant native MCP forwarder** (fork of ha_opencode's ha-native-mcp bridge with keyed-endpoint negotiation and 404 fallback) and **Playwright** (one shared @playwright/mcp 0.0.80 instance over CDP to the playwright-browser add-on, loopback-bound behind the gateway).
- **Add**: extensible server registry (`src/servers/<id>/` manifests with `mcp`, `forwarder` and `upstream` kinds) so future MCP servers drop in without touching the gateway.
- **Performance**: replaces per-agent-session stdio spawns that cost ~260 MB each (playwright-mcp + prometheus-mcp-server + ha-mcp-server) with shared processes; ~1.3 GB at the current five concurrent OpenCode sessions.
