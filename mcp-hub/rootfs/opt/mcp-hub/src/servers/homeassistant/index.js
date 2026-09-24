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

import {
  createJsonRpcError,
  validateJsonRpcMessage,
} from "../ha-native/native-mcp.js";

// The client timeout for the homeassistant entry is 65s (mqtt_listen alone
// can run 60s), so the forwarder must outlast the client, never cut it short.
const DEFAULT_TIMEOUT_MS = 120000;

export function createHaMcpForwarder({
  fetchImpl = fetch,
  url,
  token,
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  const endpoint = String(url ?? "").trim().replace(/\/+$/, "");
  if (!endpoint) {
    throw new Error("homeassistant_url is required (the ha_opencode add-on's 8927 MCP endpoint)");
  }
  if (!token) {
    throw new Error("homeassistant_token is required (the ha_opencode add-on's mcp_http_token)");
  }

  async function send(message) {
    const id = message?.id;
    try {
      const response = await fetchImpl(endpoint, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify(message),
        signal: AbortSignal.timeout(timeoutMs),
      });
      const text = await response.text();
      let json = null;
      if (text.trim()) {
        try {
          json = JSON.parse(text);
        } catch {
          // Keep the raw text for diagnostics below.
        }
      }
      if (response.status === 202) return null;
      if (response.ok && json) return json;
      if (id === undefined) return null;
      return createJsonRpcError(id, -32000, `ha-mcp-server request failed with HTTP ${response.status}`, {
        endpoint,
        status: response.status,
        body: text.slice(0, 1000) || response.statusText,
      });
    } catch (error) {
      if (id === undefined) return null;
      return createJsonRpcError(id, -32000, "ha-mcp-server request failed", {
        message: error?.message || String(error),
      });
    }
  }

  return { endpoint, send };
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
