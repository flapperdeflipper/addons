import { describe, expect, it, vi, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import {
  MQTT_LISTEN_MAX_EVENTS,
  clearMqttRetained,
  formatClearResult,
  formatListenResult,
  listenMqttTopic,
  normalizeListenDuration,
  normalizeTopicList,
  publishMqttMessage,
} from "../lib/mqtt.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("normalizeListenDuration", () => {
  it("defaults to 5 and clamps to 1..60", () => {
    expect(normalizeListenDuration(undefined)).toBe(5);
    expect(normalizeListenDuration(null)).toBe(5);
    expect(normalizeListenDuration("nope")).toBe(5);
    expect(normalizeListenDuration(0)).toBe(1);
    expect(normalizeListenDuration(-4)).toBe(1);
    expect(normalizeListenDuration(70)).toBe(60);
    expect(normalizeListenDuration(2.9)).toBe(2);
  });
});

describe("normalizeTopicList", () => {
  it("accepts one string or a list and drops invalid entries", () => {
    expect(normalizeTopicList("a/b")).toEqual({ topics: ["a/b"], invalid: [] });
    expect(normalizeTopicList(["a/b", " c/d ", " ", 7, undefined])).toEqual({
      topics: ["a/b", "c/d"],
      invalid: [" ", 7, undefined],
    });
  });
});

describe("publishMqttMessage", () => {
  it("publishes through the injected callHA and reports byte size", async () => {
    const callHA = vi.fn().mockResolvedValue(undefined);
    const result = await publishMqttMessage({ callHA, topic: " home/x ", payload: "hi", retain: true, qos: 1 });
    expect(result).toEqual({ topic: "home/x", bytes: 2, retained: true });
    expect(callHA).toHaveBeenCalledWith("/services/mqtt/publish", "POST", {
      topic: "home/x",
      payload: "hi",
      retain: true,
      qos: 1,
    });
  });

  it("defaults retain to false and rejects unknown qos values", async () => {
    const callHA = vi.fn().mockResolvedValue(undefined);
    await publishMqttMessage({ callHA, topic: "t", payload: "" });
    expect(callHA.mock.calls[0][2]).toEqual({ topic: "t", payload: "", retain: false, qos: 0 });
    await publishMqttMessage({ callHA, topic: "t", payload: "", qos: 9 });
    expect(callHA.mock.calls[1][2].qos).toBe(0);
  });

  it("rejects an empty topic without touching the API", async () => {
    const callHA = vi.fn();
    await expect(publishMqttMessage({ callHA, topic: "  ", payload: "x" })).rejects.toThrow(/topic/);
    expect(callHA).not.toHaveBeenCalled();
  });
});

describe("clearMqttRetained", () => {
  it("clears each exact topic and collects failures", async () => {
    const callHA = vi.fn(({ }) => Promise.resolve())
      .mockImplementationOnce(() => Promise.resolve())
      .mockImplementationOnce(() => Promise.reject(new Error("boom")))
      .mockImplementationOnce(() => Promise.resolve());
    const result = await clearMqttRetained({ callHA, topics: ["a/1", "a/2", "a/3"] });
    expect(result).toEqual({
      cleared: 2,
      failed: [{ topic: "a/2", error: "boom" }],
      total: 3,
    });
    for (const call of callHA.mock.calls) {
      expect(call[0]).toBe("/services/mqtt/publish");
      expect(call[2]).toMatchObject({ payload: "", retain: true, qos: 0 });
    }
  });

  it("reports invalid entries as failures instead of throwing", async () => {
    const callHA = vi.fn().mockResolvedValue(undefined);
    const result = await clearMqttRetained({ callHA, topics: ["ok/1", " "] });
    expect(result.cleared).toBe(1);
    expect(result.failed).toEqual([{ topic: " ", error: "invalid topic" }]);
    expect(result.total).toBe(2);
  });
});

describe("formatting", () => {
  it("renders an empty listen window", () => {
    expect(formatListenResult({ topic: "t/#", durationSeconds: 4, reason: "timeout", events: [] }))
      .toBe("no messages on t/# in 4s (timeout)");
  });

  it("renders events with retained markers and the event-limit note", () => {
    const text = formatListenResult({
      topic: "t",
      durationSeconds: 2,
      reason: "event_limit",
      events: [{ topic: "a", payload: "1", retain: true }, { topic: "b", payload: "2" }],
    });
    expect(text).toContain("2 message(s) in 2s (event_limit)");
    expect(text).toContain("a | 1 | retained");
    expect(text).toContain("b | 2");
    expect(text).toContain("event limit reached");
  });

  it("renders clear results including failures", () => {
    expect(formatClearResult({ cleared: 2, failed: [], total: 2 })).toBe("cleared retained on 2/2 topic(s)");
    const text = formatClearResult({ cleared: 0, failed: [{ topic: "x", error: "nope" }], total: 1 });
    expect(text).toContain("cleared retained on 0/1 topic(s)");
    expect(text).toContain("x: nope");
  });
});

// A minimal stand-in for the `ws` client: captures sent frames and lets the
// test push incoming frames through emit("message", Buffer).
function fakeSocket() {
  const sock = new EventEmitter();
  sock.sent = [];
  sock.send = (raw) => sock.sent.push(JSON.parse(raw));
  sock.close = () => sock.emit("close");
  return sock;
}

function frame(obj) {
  return Buffer.from(JSON.stringify(obj));
}

describe("listenMqttTopic", () => {
  it("authenticates, subscribes and collects events", async () => {
    vi.useFakeTimers();
    const sock = fakeSocket();
    const pending = listenMqttTopic({ topic: "home/#", durationSeconds: 5, token: "test-token", openSocket: () => sock });
    sock.emit("message", frame({ type: "auth_required" }));
    sock.emit("message", frame({ type: "auth_ok" }));
    expect(sock.sent[0]).toEqual({ type: "auth", access_token: "test-token" });
    expect(sock.sent[1]).toEqual({ id: 1, type: "mqtt/subscribe", topic: "home/#" });
    sock.emit("message", frame({ type: "result", id: 1, success: true }));
    sock.emit("message", frame({ type: "event", event: { topic: "home/x", payload: "{\"a\":1}" } }));
    sock.emit("message", frame({ type: "event", event: { topic: "home/y", payload: "z", retain: true } }));
    const settled = pending.then((r) => r);
    await vi.advanceTimersByTimeAsync(5000);
    const { reason, events } = await settled;
    expect(reason).toBe("timeout");
    expect(events).toHaveLength(2);
    expect(events[1]).toEqual({ topic: "home/y", payload: "z", retain: true });
  });

  it("resolves early at the event cap", async () => {
    const sock = fakeSocket();
    const pending = listenMqttTopic({ topic: "t", durationSeconds: 30, maxEvents: 2, openSocket: () => sock });
    sock.emit("message", frame({ type: "auth_required" }));
    sock.emit("message", frame({ type: "auth_ok" }));
    sock.emit("message", frame({ type: "event", event: { topic: "t", payload: "1" } }));
    sock.emit("message", frame({ type: "event", event: { topic: "t", payload: "2" } }));
    const { reason, events } = await pending;
    expect(reason).toBe("event_limit");
    expect(events).toHaveLength(2);
  });

  it("rejects on auth_invalid", async () => {
    const sock = fakeSocket();
    const pending = listenMqttTopic({ topic: "t", durationSeconds: 1, openSocket: () => sock });
    sock.emit("message", frame({ type: "auth_required" }));
    sock.emit("message", frame({ type: "auth_invalid" }));
    await expect(pending).rejects.toThrow(/auth rejected/);
  });

  it("rejects when the subscribe command fails", async () => {
    const sock = fakeSocket();
    const pending = listenMqttTopic({ topic: "bad/#", durationSeconds: 1, openSocket: () => sock });
    sock.emit("message", frame({ type: "auth_required" }));
    sock.emit("message", frame({ type: "auth_ok" }));
    sock.emit("message", frame({ type: "result", id: 1, success: false, error: { code: 404, message: "nope" } }));
    await expect(pending).rejects.toThrow(/mqtt\/subscribe failed/);
  });

  it("rejects on socket errors", async () => {
    const sock = fakeSocket();
    const pending = listenMqttTopic({ topic: "t", durationSeconds: 5, openSocket: () => sock });
    sock.emit("error", new Error("ECONNREFUSED"));
    await expect(pending).rejects.toThrow(/websocket error/);
  });

  it("rejects an empty topic before opening a socket", async () => {
    const openSocket = vi.fn();
    await expect(listenMqttTopic({ topic: "  ", openSocket })).rejects.toThrow(/topic/);
    expect(openSocket).not.toHaveBeenCalled();
  });

  it("caps collection at MQTT_LISTEN_MAX_EVENTS by default", () => {
    expect(MQTT_LISTEN_MAX_EVENTS).toBe(500);
  });
});
