// Shared stateless JSON-RPC pass-through for MCP endpoints that answer
// per-request (StreamableHTTPServerTransport without sessions, no
// initialize handshake, no Mcp-Session-Id). Used by the homeassistant and
// docstore forwarders; each POST is validated and forwarded verbatim with a
// bearer token, and the reply passes straight back through.

import { createJsonRpcError } from "../servers/ha-native/native-mcp.js";

// The client timeout for the homeassistant entry is 65s (mqtt_listen alone
// can run 60s), so a forwarder must outlast the client, never cut it short.
const DEFAULT_TIMEOUT_MS = 120000;

export function createStatelessForwarder({
  fetchImpl = fetch,
  url,
  token,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  label = "upstream",
  urlError = "url is required",
  tokenError = "token is required",
} = {}) {
  const endpoint = String(url ?? "").trim().replace(/\/+$/, "");
  if (!endpoint) {
    throw new Error(urlError);
  }
  if (!token) {
    throw new Error(tokenError);
  }

  async function send(message) {
    const id = message?.id;
    try {
      const response = await fetchImpl(endpoint, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/json, text/event-stream",
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
      return createJsonRpcError(id, -32000, `${label} request failed with HTTP ${response.status}`, {
        endpoint,
        status: response.status,
        body: text.slice(0, 1000) || response.statusText,
      });
    } catch (error) {
      if (id === undefined) return null;
      return createJsonRpcError(id, -32000, `${label} request failed`, {
        message: error?.message || String(error),
      });
    }
  }

  return { endpoint, send };
}
