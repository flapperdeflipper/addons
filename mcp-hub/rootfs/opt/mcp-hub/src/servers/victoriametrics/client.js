// VictoriaMetrics (Prometheus-compatible API) client for the MCP Hub.
//
// Fork of prometheus-mcp-server 1.0.1's PrometheusClient (MIT,
// eagle1e6/prometheus-mcp-server) with axios replaced by plain fetch and the
// same response semantics: the Prometheus envelope is returned as-is, and
// query/range results can be filtered to selected metric labels while always
// preserving __name__.

function filterQueryResult(result, includes) {
  if (!includes || includes.length === 0) {
    return result;
  }
  const filteredResult = result.result.map((data) => {
    if (!data.metric) {
      return data;
    }
    const filteredMetric = {};
    // Always preserve __name__ if it exists
    if ("__name__" in data.metric) {
      filteredMetric["__name__"] = data.metric["__name__"];
    }
    // Add other requested properties
    for (const key of includes) {
      if (key in data.metric && key !== "__name__") {
        filteredMetric[key] = data.metric[key];
      }
    }
    return {
      ...data,
      metric: filteredMetric,
    };
  });
  return {
    ...result,
    result: filteredResult,
  };
}

export function createVictoriaMetricsClient({
  baseUrl,
  username,
  password,
  timeoutMs = 10000,
  fetchImpl = fetch,
} = {}) {
  if (!baseUrl) {
    throw new Error("victoriametrics_url is required");
  }

  const base = String(baseUrl).replace(/\/+$/, "");
  const headers = { Accept: "application/json" };
  if (username && password) {
    headers.Authorization = `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
  }

  async function get(path, params = {}) {
    const url = new URL(base + path);
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null && value !== "") {
        url.searchParams.set(key, String(value));
      }
    }
    const response = await fetchImpl(url, {
      headers,
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`VictoriaMetrics ${path} failed with HTTP ${response.status}: ${text.slice(0, 200)}`);
    }
    try {
      return JSON.parse(text);
    } catch {
      throw new Error(`VictoriaMetrics ${path} returned a non-JSON response: ${text.slice(0, 200)}`);
    }
  }

  return {
    async query(query, time, includes) {
      const params = { query };
      if (time) params.time = time;
      const data = await get("/api/v1/query", params);
      if (data.data && includes) {
        data.data = filterQueryResult(data.data, includes);
      }
      return data;
    },

    async range(query, start, end, step, includes) {
      const params = { query, start, end, step };
      const data = await get("/api/v1/query_range", params);
      if (data.data && includes) {
        data.data = filterQueryResult(data.data, includes);
      }
      return data;
    },

    async discover() {
      return get("/api/v1/label/__name__/values");
    },

    async metadata(metric) {
      const params = {};
      if (metric) params.metric = metric;
      return get("/api/v1/metadata", params);
    },

    async targets(state) {
      const params = {};
      if (state && state !== "any") params.state = state;
      return get("/api/v1/targets", params);
    },
  };
}
