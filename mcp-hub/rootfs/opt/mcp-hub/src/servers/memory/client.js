// Minimal REST client for the LiteLLM proxy's /v1/memory API (Memory
// Management, LiteLLM v1.83.10+, PostgreSQL-backed). Bearer-authenticated
// with the same memory key the litellm add-on uses - pass it as a
// !secret <key> option value; the Supervisor resolves it before start.
//
// The API is intentionally small: list (optional key_prefix filter), get,
// upsert (PUT; metadata is only replaced when the body carries it - verified
// against the live proxy 2026-09-25) and delete. Search scoring lives in
// index.js and needs nothing beyond list().

export function createMemoryClient({
  baseUrl,
  apiKey,
  timeoutMs = 30000,
  fetchImpl = fetch,
} = {}) {
  const base = String(baseUrl ?? "").trim().replace(/\/+$/, "");
  if (!base) {
    throw new Error("memory_proxy_url is required (the LiteLLM proxy base URL)");
  }
  if (!apiKey) {
    throw new Error("memory_api_key is required (set a !secret litellm_memory_key-style option)");
  }

  async function call(method, path, body) {
    const init = {
      method,
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(timeoutMs),
    };
    if (body !== undefined) {
      init.headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(body);
    }
    const response = await fetchImpl(base + path, init);
    const text = await response.text();
    if (!response.ok) {
      const error = new Error(
        `LiteLLM memory API ${method} ${path} failed with HTTP ${response.status}` +
          (text ? `: ${text.slice(0, 300)}` : `: ${response.statusText}`)
      );
      error.status = response.status;
      throw error;
    }
    return text ? JSON.parse(text) : {};
  }

  return {
    list: (keyPrefix = "") =>
      call("GET", "/v1/memory" + (keyPrefix ? `?key_prefix=${encodeURIComponent(keyPrefix)}` : "")),
    get: (key) => call("GET", `/v1/memory/${encodeURIComponent(key)}`),
    set: (key, value, metadata) =>
      call("PUT", `/v1/memory/${encodeURIComponent(key)}`, metadata ? { value, metadata } : { value }),
    delete: (key) => call("DELETE", `/v1/memory/${encodeURIComponent(key)}`),
  };
}
