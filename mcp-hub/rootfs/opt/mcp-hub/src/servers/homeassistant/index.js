// Home Assistant MCP server (ha-mcp-server) forwarder module. One forwarder
// instance serves every hub client: each POST is validated and forwarded to
// the ha_opencode add-on's always-on HTTP endpoint on 8927/tcp, which serves
// the exact same tool set the sessions used to spawn per-session over stdio.
//
// The server itself stays hosted in ha_opencode because it execs the hab CLI
// and launches Chromium for screenshots - dependencies of that add-on's
// image. This module only makes it reachable at the hub's single entrypoint,
// with the hub's token, for every harness on the host.
//
// Both ends are stateless (per-request StreamableHTTPServerTransport, no
// initialize handshake, no Mcp-Session-Id), so a plain per-request
// JSON-RPC pass-through is the whole job.

import { validateJsonRpcMessage } from "../ha-native/native-mcp.js";
import { createStatelessForwarder } from "../../lib/stateless-forwarder.js";

export function createHaMcpForwarder(opts = {}) {
  return createStatelessForwarder({
    ...opts,
    label: "ha-mcp-server",
    urlError: "homeassistant_url is required (the ha_opencode add-on's 8927 MCP endpoint)",
    tokenError: "homeassistant_token is required (the ha_opencode add-on's mcp_http_token)",
  });
}

export default {
  id: "homeassistant",
  title: "Home Assistant MCP server (ha-mcp-server)",
  kind: "forwarder",
  enabledOption: "homeassistant_enabled",
  validateJsonRpcMessage,

  createForwarder(ctx) {
    const { config, log } = ctx;
    const forwarder = createHaMcpForwarder({
      url: config.homeassistant_url,
      token: config.homeassistant_token,
    });
    log("info", `forwarding /mcp/homeassistant to ${forwarder.endpoint}`);
    return forwarder;
  },
};
