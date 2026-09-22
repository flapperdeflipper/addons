// Home Assistant native MCP bridge, forked from ha_opencode's ha-mcp-server
// lib/ha-native-mcp.js (MIT, flapperdeflipper). Only the pieces the hub needs
// are vendored: URL building, JSON-RPC validation, the per-request forward
// and the endpoint-mode negotiation with its 404 fallback. The upstream
// probe helper is not used by the hub.
//
// Endpoint semantics (from upstream, kept verbatim where possible):
//   - `auto`: prefer the keyed /api/mcp/<API ID> endpoint and fall back to
//     the configured /api/mcp endpoint when the keyed one does not exist
//     (keyed endpoints exist from Home Assistant 2026.8). A 404 that names
//     an unknown API ID is reported, not fallen back from.
//   - `keyed` / `configured`: pin one of the two endpoints.

export const NATIVE_MCP_ASSIST_API_ID = "assist";
export const NATIVE_MCP_PROTOCOL_VERSION = "2025-11-25";

const DEFAULT_SUPERVISOR_API = "http://supervisor/core/api";

export const NATIVE_MCP_ENDPOINT_MODES = ["auto", "keyed", "configured"];
export const DEFAULT_NATIVE_MCP_ENDPOINT_MODE = "auto";

export function normalizeNativeMcpEndpointMode(mode = DEFAULT_NATIVE_MCP_ENDPOINT_MODE) {
  const normalized = String(mode ?? "").trim().toLowerCase();
  return NATIVE_MCP_ENDPOINT_MODES.includes(normalized)
    ? normalized
    : DEFAULT_NATIVE_MCP_ENDPOINT_MODE;
}

export function normalizeNativeMcpApiId(apiId = NATIVE_MCP_ASSIST_API_ID, { allowBaseEndpoint = false } = {}) {
  const normalized = String(apiId ?? "").trim();
  if (!normalized && allowBaseEndpoint) return null;
  return normalized || NATIVE_MCP_ASSIST_API_ID;
}

export function buildNativeMcpUrl({
  baseUrl = DEFAULT_SUPERVISOR_API,
  apiId,
} = {}) {
  const normalizedBase = String(baseUrl).replace(/\/+$/, "");
  if (!apiId) return `${normalizedBase}/mcp`;
  return `${normalizedBase}/mcp/${encodeURIComponent(apiId)}`;
}

export function createJsonRpcError(id, code, message, data = undefined) {
  const error = { code, message };
  if (data !== undefined) error.data = data;
  return {
    jsonrpc: "2.0",
    id: id ?? null,
    error,
  };
}

export async function requestNativeMcp({
  fetchImpl = fetch,
  supervisorToken,
  baseUrl = DEFAULT_SUPERVISOR_API,
  apiId = null,
  message,
  timeoutMs = 60000,
} = {}) {
  if (!supervisorToken) {
    throw new Error("SUPERVISOR_TOKEN is required for Home Assistant native MCP");
  }
  if (!message || typeof message !== "object") {
    throw new Error("A JSON-RPC message object is required");
  }

  const endpoint = buildNativeMcpUrl({ baseUrl, apiId });
  const response = await fetchImpl(endpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${supervisorToken}`,
      Accept: "application/json",
      "Content-Type": "application/json",
      // Required of MCP clients from protocol revision 2025-06-18 onward. The
      // Supervisor proxy forwards this header, so sending it keeps the bridge
      // correct if Core starts enforcing it.
      "MCP-Protocol-Version": NATIVE_MCP_PROTOCOL_VERSION,
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
      // Keep the raw text for diagnostics; callers decide how to handle it.
    }
  }

  return {
    endpoint,
    ok: response.ok,
    status: response.status,
    statusText: response.statusText,
    text,
    json,
  };
}

export function mapNativeMcpResponse(response, id) {
  if (response.status === 202) return null;
  if (response.ok && response.json) return response.json;

  if (id === undefined) return null;

  return createJsonRpcError(
    id,
    -32000,
    `Home Assistant native MCP request failed with HTTP ${response.status}`,
    {
      endpoint: response.endpoint,
      status: response.status,
      body: response.text?.slice(0, 1000) || response.statusText,
    }
  );
}

/**
 * Validate a client message before it is forwarded to Home Assistant.
 *
 * Home Assistant Core has crashed on malformed POSTs to /api/mcp
 * (home-assistant/core#176734), so the bridge rejects anything that is not a
 * well-formed JSON-RPC 2.0 message rather than passing it through. JSON-RPC
 * batches (arrays) are rejected too: MCP dropped batching, and Home
 * Assistant validates one message per request.
 */
export function validateJsonRpcMessage(message) {
  if (typeof message !== "object" || message === null || Array.isArray(message)) {
    return { valid: false, id: null, reason: "Message must be a JSON-RPC object" };
  }

  const id = message.id ?? null;

  if (message.jsonrpc !== "2.0") {
    return { valid: false, id, reason: "Message must set jsonrpc to \"2.0\"" };
  }

  if (typeof message.method === "string" && message.method.length > 0) {
    return { valid: true, id, reason: null };
  }

  if ("method" in message) {
    return { valid: false, id, reason: "Message method must be a non-empty string" };
  }

  const isResponse = "result" in message
    || (typeof message.error === "object" && message.error !== null);
  if (isResponse && message.id !== undefined) {
    return { valid: true, id, reason: null };
  }

  return { valid: false, id, reason: "Message must be a JSON-RPC request, notification, or response" };
}

function isUnknownLlmApiResponse(response) {
  return typeof response?.text === "string" && response.text.includes("Unknown LLM API");
}

/**
 * How long a negotiated fallback stays latched before the keyed endpoint is
 * retried, in milliseconds (upstream default: 15 minutes). Upgrading Home
 * Assistant restarts Core without restarting the hub, so the latch must
 * re-arm itself.
 */
export const NATIVE_MCP_FALLBACK_RETRY_MS = 15 * 60 * 1000;

/**
 * Create a stateful forwarder that negotiates which native MCP endpoint to
 * use. One instance serves every hub client: negotiation state is endpoint
 * selection only, never per-client session state.
 */
export function createNativeMcpForwarder({
  fetchImpl = fetch,
  supervisorToken,
  baseUrl = DEFAULT_SUPERVISOR_API,
  apiId = NATIVE_MCP_ASSIST_API_ID,
  endpointMode = DEFAULT_NATIVE_MCP_ENDPOINT_MODE,
  timeoutMs = 60000,
  onEndpointFallback = null,
  onEndpointRecovered = null,
  fallbackRetryMs = NATIVE_MCP_FALLBACK_RETRY_MS,
  now = () => Date.now(),
} = {}) {
  const mode = normalizeNativeMcpEndpointMode(endpointMode);
  const configuredApiId = normalizeNativeMcpApiId(apiId, { allowBaseEndpoint: true });
  let activeApiId = mode === "configured" ? null : configuredApiId;
  let fellBackAt = null;
  // Only state *changes* are reported, so a Home Assistant that will never
  // serve the keyed endpoint logs one fallback, not one per interval.
  let reportedFallback = false;

  async function request(message, requestApiId) {
    return requestNativeMcp({
      fetchImpl,
      supervisorToken,
      baseUrl,
      apiId: requestApiId,
      message,
      timeoutMs,
    });
  }

  // Re-arm the keyed endpoint when the latch has aged out, so the next
  // request discovers a Home Assistant that has since gained it.
  function maybeRetryKeyedEndpoint() {
    if (mode !== "auto" || fellBackAt === null || activeApiId) return;
    if (!(fallbackRetryMs > 0)) return;
    if (now() - fellBackAt < fallbackRetryMs) return;

    fellBackAt = null;
    activeApiId = configuredApiId;
  }

  return {
    get endpointMode() {
      return mode;
    },
    get activeApiId() {
      return activeApiId;
    },
    get endpoint() {
      return buildNativeMcpUrl({ baseUrl, apiId: activeApiId });
    },
    async send(message) {
      const id = message?.id;

      try {
        maybeRetryKeyedEndpoint();

        const response = await request(message, activeApiId);

        if (mode !== "auto" || !activeApiId || response.status !== 404) {
          if (activeApiId && reportedFallback) {
            reportedFallback = false;
            onEndpointRecovered?.({
              endpoint: response.endpoint,
              api_id: configuredApiId,
            });
          }
          return mapNativeMcpResponse(response, id);
        }

        // A 404 naming an unknown API ID means the keyed endpoint exists but
        // the ID is wrong; falling back would quietly serve a different LLM
        // API than the one asked for, so the misconfiguration is reported.
        if (isUnknownLlmApiResponse(response)) {
          if (id === undefined) return null;
          return createJsonRpcError(
            id,
            -32000,
            `Home Assistant does not know the LLM API ID '${configuredApiId}'`,
            {
              endpoint: response.endpoint,
              api_id: configuredApiId,
              hint: "Check the API ID against the LLM APIs registered in Home Assistant. Leave the API ID empty to use every API selected in the MCP Server integration.",
            }
          );
        }

        fellBackAt = now();
        activeApiId = null;

        if (!reportedFallback) {
          reportedFallback = true;
          onEndpointFallback?.({
            from: response.endpoint,
            to: buildNativeMcpUrl({ baseUrl, apiId: null }),
            api_id: configuredApiId,
            reason: "keyed_endpoint_unavailable",
            retry_in_ms: fallbackRetryMs > 0 ? fallbackRetryMs : null,
          });
        }

        return mapNativeMcpResponse(await request(message, activeApiId), id);
      } catch (error) {
        if (id === undefined) return null;
        return createJsonRpcError(id, -32000, "Home Assistant native MCP request failed", {
          message: error?.message || String(error),
        });
      }
    },
  };
}
