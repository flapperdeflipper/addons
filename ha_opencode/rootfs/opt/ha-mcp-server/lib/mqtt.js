/**
 * MQTT broker access through Home Assistant's own MQTT connection
 * (Supervisor core API + core websocket), so no broker credentials are
 * ever handled. Ported from the standalone mcp-mqtt stdio server so the
 * tools ride every transport ha-mcp-server speaks (stdio for opencode,
 * streamable HTTP for sibling add-ons such as the LiteLLM MCP gateway).
 */
import WebSocket from "ws";

export const MQTT_LISTEN_DEFAULT_SECONDS = 5;
export const MQTT_LISTEN_MAX_SECONDS = 60;
export const MQTT_LISTEN_MAX_EVENTS = 500;

const CORE_WS_URL = process.env.HA_CORE_WS_URL || "ws://supervisor/core/api/websocket";

/**
 * Clamp a requested listen window to 1..60 seconds (default 5).
 */
export function normalizeListenDuration(value) {
  if (value === null || value === undefined || value === "") return MQTT_LISTEN_DEFAULT_SECONDS;
  const n = Number(value);
  if (!Number.isFinite(n)) return MQTT_LISTEN_DEFAULT_SECONDS;
  return Math.min(MQTT_LISTEN_MAX_SECONDS, Math.max(1, Math.trunc(n)));
}

/**
 * Normalize a `topics` argument (one string or a list) into
 * { topics: [trimmed, non-empty], invalid: [originals] }.
 */
export function normalizeTopicList(topics) {
  const raw = Array.isArray(topics) ? topics : [topics];
  const list = [];
  const invalid = [];
  for (const t of raw) {
    if (typeof t === "string" && t.trim() !== "") {
      list.push(t.trim());
    } else {
      invalid.push(t);
    }
  }
  return { topics: list, invalid };
}

/**
 * One websocket per listen call: connect, auth, mqtt/subscribe, collect,
 * close. `openSocket(url)` is injectable for tests; defaults to the `ws`
 * client against the Supervisor core websocket proxy.
 */
export function listenMqttTopic({
  topic,
  durationSeconds = MQTT_LISTEN_DEFAULT_SECONDS,
  maxEvents = MQTT_LISTEN_MAX_EVENTS,
  url = CORE_WS_URL,
  token = process.env.SUPERVISOR_TOKEN || "",
  openSocket = (u) => new WebSocket(u),
} = {}) {
  if (typeof topic !== "string" || topic.trim() === "") {
    return Promise.reject(new TypeError("topic must be a non-empty string"));
  }
  const wantedTopic = topic.trim();
  return new Promise((resolve, reject) => {
    const events = [];
    let subId = null;
    let done = false;

    const ws = openSocket(url);
    const timer = setTimeout(() => finish("timeout"), durationSeconds * 1000);

    function finish(reason) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { ws.close(); } catch { /* already closed */ }
      resolve({ reason, events, topic: wantedTopic, truncatedAtLimit: events.length >= maxEvents });
    }

    ws.on("message", (data) => {
      let m;
      try {
        m = JSON.parse(data.toString());
      } catch {
        return; // ignore unparseable frames
      }
      if (m.type === "auth_required") {
        ws.send(JSON.stringify({ type: "auth", access_token: token }));
      } else if (m.type === "auth_invalid") {
        const err = new Error("core websocket auth rejected the supervisor token");
        done = true;
        clearTimeout(timer);
        try { ws.close(); } catch { /* already closed */ }
        reject(err);
      } else if (m.type === "auth_ok") {
        subId = 1;
        ws.send(JSON.stringify({ id: subId, type: "mqtt/subscribe", topic: wantedTopic }));
      } else if (m.type === "result" && m.id === subId && m.success === false) {
        const err = new Error(`mqtt/subscribe failed: ${JSON.stringify(m.error || {})}`);
        done = true;
        clearTimeout(timer);
        try { ws.close(); } catch { /* already closed */ }
        reject(err);
      } else if (m.type === "event" && m.event && m.event.topic !== undefined) {
        events.push(m.event);
        if (events.length >= maxEvents) finish("event_limit");
      }
    });

    ws.on("error", (error) => {
      if (!done) {
        done = true;
        clearTimeout(timer);
        reject(new Error(`websocket error: ${error?.message || error}`));
      }
      finish("error");
    });
  });
}

/**
 * Publish through Home Assistant's mqtt/publish service. `callHA` is
 * injected (index.js owns REST auth, redaction and timeouts).
 */
export async function publishMqttMessage({ callHA, topic, payload, retain = false, qos = 0 }) {
  if (typeof topic !== "string" || topic.trim() === "") {
    throw new TypeError("topic must be a non-empty string");
  }
  const text = String(payload ?? "");
  await callHA("/services/mqtt/publish", "POST", {
    topic: topic.trim(),
    payload: text,
    retain: retain === true,
    qos: [0, 1, 2].includes(qos) ? qos : 0,
  });
  return { topic: topic.trim(), bytes: Buffer.byteLength(text, "utf8"), retained: retain === true };
}

/**
 * Clear retained messages by publishing an empty retained payload to each
 * exact topic. Enumerate topics with mqtt_listen first; wildcards are not
 * expanded — each entry must be an exact topic by design.
 */
export async function clearMqttRetained({ callHA, topics }) {
  const { topics: list, invalid } = normalizeTopicList(topics);
  const failed = invalid.map((t) => ({ topic: String(t), error: "invalid topic" }));
  let cleared = 0;
  for (const t of list) {
    try {
      await publishMqttMessage({ callHA, topic: t, payload: "", retain: true, qos: 0 });
      cleared++;
    } catch (error) {
      failed.push({ topic: t, error: error?.message || String(error) });
    }
  }
  const total = list.length + invalid.length;
  return { cleared, failed, total };
}

/**
 * Human-readable mqtt_listen result text, bounded by the event cap.
 */
export function formatListenResult({ topic, durationSeconds, reason, events }) {
  if (!events || events.length === 0) {
    return `no messages on ${topic} in ${durationSeconds}s (${reason})`;
  }
  const lines = events.map((e) => `${e.topic} | ${e.payload}${e.retain ? " | retained" : ""}`);
  const suffix = reason === "event_limit" ? " (event limit reached — listen again or narrow the filter)" : "";
  return `${lines.length} message(s) in ${durationSeconds}s (${reason})${suffix}:\n${lines.join("\n")}`;
}

/**
 * Human-readable mqtt_clear_retained result text.
 */
export function formatClearResult({ cleared, failed, total }) {
  const failedLines = (failed || []).map((f) => `${f.topic}: ${f.error}`);
  return `cleared retained on ${cleared}/${total} topic(s)${failedLines.length ? `\nfailed:\n${failedLines.join("\n")}` : ""}`;
}
