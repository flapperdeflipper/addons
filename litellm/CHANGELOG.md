# Changelog
All notable changes to this project will be documented in this file.

## 1.99.1-7

- **Dropped the ha-mcp-server image copy** — ha_opencode 2.8.0+ serves its full MCP server over authenticated streamable HTTP (`mcp_http_enabled` + `mcp_http_token`, port 8927/tcp), so the gateway registers it as a plain HTTP server instead of a stdio child. Removes the multi-stage `COPY --from` from the Dockerfile and, with it, the known gap where companion CLI tools (zigporter, hab) failed at call time. Switch `/homeassistant/litellm/config.yaml` from the stdio `homeassistant` entry to the HTTP URL when updating.

## 1.99.1-6

- **Full Home Assistant MCP server in the gateway** — the `ha-mcp-server` from the published ha_opencode add-on image (multi-stage `COPY --from=flapperdeflipper/addon-ha-opencode:2.7.0`, pure-JS deps so the Debian node_modules survive the Alpine base) is available at `/mcp_servers/ha-mcp-server` for stdio registration. Register it in `/homeassistant/litellm/config.yaml` with `SUPERVISOR_TOKEN` passed through the env map (stdio children get a scrubbed environment). Companion CLIs (zigporter, hab) are absent in this image — their tools list but fail at call time.

## 1.99.1-4

- **`litellm_mcp` package: LiteLLM memory over MCP** — the proxy's `/v1/memory` API served as MCP tools (`memory_get/set/list/delete` + `registry_list` discovery) by a proper Python package (`python -m litellm_mcp`): explicit tool registry, injected REST client, lazy SDK import for both older/newer `mcp` layouts, `--transport streamable-http|stdio`, and tests (`test/test_package.py`) that run without the MCP SDK. Served **through the LiteLLM MCP gateway** as a stdio server (registered in `/homeassistant/litellm/config.yaml`, proxy-supervised — no dedicated port or shell launcher). Additional tools = a module + one registry line.
- **Tool discovery** — a built-in `registry_list` MCP tool reports every available module with its description and enabled state (so agents can see what else exists and ask for it to be enabled), and `python -m litellm_mcp --list` prints the same catalog from the shell without the MCP SDK.
- **Corrected the secrets-policy docs** — add-on options *do* support HA-style `!secret <key>` values (the Supervisor resolves them before writing `/data/options.json`); the run.sh/DOCS claim that they cannot was wrong. The add-on's key-name convention is unchanged.
