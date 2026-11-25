# Changelog

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
