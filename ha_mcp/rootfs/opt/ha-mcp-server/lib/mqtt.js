/**
 * MQTT broker access through Home Assistant's own MQTT connection
 * (Supervisor core API + core websocket), so no broker credentials are
 * ever handled. Ported from the standalone mcp-mqtt stdio server so the
 * tools ride every transport ha-mcp-server speaks (stdio, and streamable
 * HTTP for MCP clients such as a LiteLLM MCP gateway).
 */
import WebSocket from "ws";

export const MQTT_LISTEN_DEFAULT_SECONDS = 5;
export const MQTT_LISTEN_MAX_SECONDS = 60;
export const MQTT_LISTEN_MAX_EVENTS = 500;
export const MQTT_VERIFY_DEFAULT_SECONDS = 4;

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
 * client against the Supervisor core websocket proxy. `onSubscribed`,
 * when given, fires once the broker confirmed the subscription — callers
 * that must not publish before the subscription exists await it.
 */
export function listenMqttTopic({
  topic,
  durationSeconds = MQTT_LISTEN_DEFAULT_SECONDS,
  maxEvents = MQTT_LISTEN_MAX_EVENTS,
  url = CORE_WS_URL,
  token = process.env.SUPERVISOR_TOKEN || "",
  openSocket = (u) => new WebSocket(u),
  onSubscribed = null,
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
      } else if (m.type === "result" && m.id === subId && m.success === true) {
        if (typeof onSubscribed === "function") onSubscribed();
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
 * Publish with a server-side delivery check: subscribe to the exact topic on
 * Home Assistant's connection, wait for the broker to confirm the
 * subscription, publish, then watch the window for the echo. Everything
 * happens inside this one call, so it stays correct even when the calling
 * agent's tool requests are serialized (a separate mqtt_listen call from the
 * same session always runs after the publish and cannot observe it).
 *
 * Verification matches topic AND payload. Note the corner case: for a
 * retained publish whose payload equals the retained value already on the
 * broker, the subscribe-time replay matches before the echo does — which
 * still confirms the broker holds that value, only not that THIS publish
 * routed anywhere.
 */
export async function publishMqttMessageVerified({
  callHA,
  topic,
  payload,
  retain = false,
  qos = 0,
  windowSeconds = MQTT_VERIFY_DEFAULT_SECONDS,
  url = CORE_WS_URL,
  token = process.env.SUPERVISOR_TOKEN || "",
  openSocket = (u) => new WebSocket(u),
} = {}) {
  if (typeof topic !== "string" || topic.trim() === "") {
    throw new TypeError("topic must be a non-empty string");
  }
  const wantedTopic = topic.trim();
  const durationSeconds = normalizeListenDuration(windowSeconds);

  let subscribedDone = false;
  let notifySubscribed;
  const subscribed = new Promise((resolve) => { notifySubscribed = resolve; });
  const listenPromise = listenMqttTopic({
    topic: wantedTopic,
    durationSeconds,
    url,
    token,
    openSocket,
    onSubscribed: () => { subscribedDone = true; notifySubscribed(); },
  });
  // Fail fast when the window closes without a confirmed subscription —
  // otherwise the publish step would wait on `subscribed` forever.
  const guard = listenPromise.then((listen) => {
    if (!subscribedDone) {
      throw new Error(`no echo check possible: subscription not confirmed within ${durationSeconds}s (${listen.reason})`);
    }
    return listen;
  });
  const publishStep = (async () => {
    await subscribed;
    return publishMqttMessage({ callHA, topic: wantedTopic, payload, retain, qos });
  })();

  let published;
  let listen;
  try {
    [published, listen] = await Promise.all([publishStep, guard]);
  } catch (error) {
    listenPromise.catch(() => {}); // a late websocket failure must not surface as unhandled
    throw error;
  }
  const wantedPayload = String(payload ?? "");
  const echoCount = listen.events.filter((e) => e.topic === wantedTopic && e.payload === wantedPayload).length;
  return {
    ...published,
    verified: echoCount > 0,
    verifyWindowSeconds: durationSeconds,
    listenReason: listen.reason,
  };
}

/**
 * Human-readable result for a verified publish.
 */
export function formatPublishVerifyResult({ topic, bytes, retained, verified, verifyWindowSeconds, listenReason }) {
  const base = `published ${bytes} byte(s) to ${topic}${retained ? " (retained)" : ""}`;
  if (verified) {
    return `${base} — verified: the broker echoed the message back within ${verifyWindowSeconds}s`;
  }
  return `${base} — NOT verified: no echo on the topic within ${verifyWindowSeconds}s (${listenReason}). The publish may still have been accepted; re-check with mqtt_listen on the exact topic.`;
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
