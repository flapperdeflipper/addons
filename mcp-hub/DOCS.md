# MCP Hub

One shared MCP server process per tool set, served over streamable HTTP for
every agent on this host. OpenCode sessions, the LiteLLM MCP gateway and any
other MCP client reuse the same processes instead of each spawning their own
stdio servers - the per-session spawns cost ~260 MB each (playwright-mcp +
prometheus-mcp-server + ha-mcp-server), which added up to ~1.3 GB at five
concurrent sessions.

## Endpoints

Single port (`8930/tcp`), single bearer token (the `token` option; a
`!secret <key>` value works). Every enabled server lives under `/mcp/<id>`:

| Path | Server | Kind |
|------|--------|------|
| `/mcp/victoriametrics` | Prometheus-compatible queries against VictoriaMetrics (fork of the prometheus-mcp-server 1.0.1 tool set: `prom_query`, `prom_range`, `prom_discover`, `prom_metadata`, `prom_targets`) | stateless MCP |
| `/mcp/ha-native` | Home Assistant native MCP (`/api/mcp/<API ID>`, default API `assist`), forwarded through the Supervisor | JSON-RPC forwarder |
| `/mcp/homeassistant` | The full ha-mcp-server from the ha_opencode add-on (entity/state, safe config writing, supervisor tools, MQTT, todo, hab/zigporter/ESPHome companions), served by that add-on's always-on 8927 endpoint | JSON-RPC forwarder |
| `/mcp/playwright/mcp` (streamable HTTP; `/mcp/playwright/sse` legacy) | One shared @playwright/mcp 0.0.80 instance, CDP-connected to the playwright-browser add-on (per-connection browser contexts stay isolated) | supervised upstream |

`GET /healthz` (no auth) reports per-server state; `GET /` (auth) lists the
routes. The playwright child binds to loopback only - it is reachable
exclusively through the authenticated gateway because @playwright/mcp's HTTP
transport has no authentication of its own.

## Wiring consumers

OpenCode (`/data/.config/opencode/config.json`), using the stable host IP:

```json
{
  "mcp": {
    "victoriametrics": {
      "type": "remote",
      "url": "http://10.60.0.3:8930/mcp/victoriametrics",
      "enabled": true,
      "headers": { "Authorization": "Bearer {env:MCP_HUB_TOKEN}" }
    }
  }
}
```

The `homeassistant` route forwards to the ha_opencode add-on's own HTTP MCP
endpoint (set `homeassistant_url` to it, e.g.
`http://<ha-opencode-host>:8927/mcp`, and `homeassistant_token` to that
add-on's `mcp_http_token`). The server process itself stays in ha_opencode -
it execs the hab CLI and launches Chromium for screenshots, which only that
add-on's image carries. Set `homeassistant_enabled: false` to drop the route
if ha_opencode is not installed; the hub keeps serving everything else.

## Adding a server

1. Create `rootfs/opt/mcp-hub/src/servers/<id>/index.js` exporting a manifest:

```js
export default {
  id: "myserver",
  title: "My Server",
  kind: "mcp",                      // "mcp" | "forwarder" | "upstream"
  enabledOption: "myserver_enabled",
  createServer(ctx) { /* return an SDK Server with connect() */ },
};
```

2. Import it in `src/registry.js` and add it to `MODULES`.
3. Add `myserver_enabled: true` (plus any settings) to `config.yaml`
   `options:` and `schema:` - same keys, same order.

Routing, auth, health reporting and (for `upstream`) child supervision come
for free. A module that fails to construct is reported through `/healthz`
and answers 503 on its path; it never takes the hub down.

## Forks and provenance

- `src/servers/victoriametrics/` - fork of [prometheus-mcp-server](https://github.com/eagle1e6/prometheus-mcp-server) 1.0.1 (MIT): identical tool names, schemas and response shapes, axios replaced with plain fetch.
- `src/servers/ha-native/native-mcp.js` - fork of ha_opencode's `ha-mcp-server/lib/ha-native-mcp.js` (flapperdeflipper, MIT).
- `src/auth.js`, `src/stateless.js` - forked from ha_opencode's `ha-mcp-server/lib/http-transport.js` (flapperdeflipper, MIT).
- `@playwright/mcp` is used as a pinned dependency (0.0.80), not forked.

## Testing

From the add-on directory in a worktree:

```sh
cd rootfs/opt/mcp-hub && npm ci --include=dev
cd ../../.. && node --test test/
```

## Security notes

- Map `8930/tcp` on trusted networks only; the token authenticates every
  request but traffic is plain HTTP.
- The hub token never leaves the host: it is read from the add-on options
  (resolved from `secrets.yaml` via `!secret`) and compared in constant time.
- The gateway strips `Authorization` before proxying to the playwright child.
