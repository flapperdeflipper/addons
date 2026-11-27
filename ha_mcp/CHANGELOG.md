# Changelog

## 1.2.2

- **Changed** — automated dependency update (Renovate).

## 1.2.1

- **Changed** — automated dependency update (Renovate).

## 1.2.0

- **Changed:** built on Home Assistant's Debian base with only what the server
  runs (Node 24.21.0, hab, zigporter, Chromium) instead of the shared
  agent-base image, which goes away. No change to the tools.

## 1.1.0

- **Added:** `mqtt_publish` accepts `verify: true` — the server subscribes to
  the exact topic on Home Assistant's own MQTT connection, waits for the
  broker to confirm the subscription, publishes, and checks the window for
  the echo, reporting `verified` in the result. This is the reliable way to
  test the MQTT publish path from an agent session: the obvious alternative
  (separate `mqtt_listen` + `mqtt_publish` tool calls) cannot observe its own
  publish, because tool requests serialize and the listen window always
  finishes before the publish fires — three false "routing is broken"
  conclusions during the mosquitto 2.1.4 upgrade verification were caused by
  exactly this.
- **Changed:** `mqtt_listen` gained an internal `onSubscribed` hook (fires
  when the broker confirms the subscription); `mqtt_publish`'s tool
  description documents the verify option and the loopback gotcha.

## 1.0.2

- **Changed** — automated dependency update (Renovate).

## 1.0.1

- The self-update guard's fallback (used when Supervisor doesn't report this
  add-on's slug) matches `ha_mcp` instead of the removed OpenCode add-on's
  slug, so `update_component` refuses to update this add-on mid-request.
- Comments describe MCP clients on other hosts instead of sibling add-ons.

## 1.0.0

- The Home Assistant MCP server from the OpenCode add-on as its own add-on:
  streamable HTTP on 8927 with a bearer token, tool profile `deployed` (every
  tool except configuration writes), configuration directory read-only. For
  agents that run outside Home Assistant.
