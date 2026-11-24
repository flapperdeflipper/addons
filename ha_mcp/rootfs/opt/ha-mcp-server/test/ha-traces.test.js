import { describe, it, expect } from "vitest";

import {
  normalizeTraceSummaries,
  summarizeTraceDetail,
  parseTraceEntityId,
  pickLatestRunId,
} from "../lib/ha-traces.js";
import { condenseLogLines, formatErrorLogResult } from "../lib/ha-error-log.js";

const summaryFixture = (overrides = {}) => ({
  last_step: "action/0",
  run_id: "run-1",
  state: "stopped",
  script_execution: "finished",
  timestamp: { start: "2026-09-09T21:26:21.171189+00:00", finish: "2026-09-09T21:26:21.288746+00:00" },
  domain: "automation",
  item_id: "my_automation",
  trigger: { description: "State of sensor.foo became on" },
  ...overrides,
});

describe("normalizeTraceSummaries", () => {
  it("maps short-dict traces to compact rows keyed by entity id", () => {
    const rows = normalizeTraceSummaries([summaryFixture()]);
    expect(rows).toHaveLength(1);
    expect(rows[0].entity_id).toBe("automation.my_automation");
    expect(rows[0].trigger).toBe("State of sensor.foo became on");
    expect(rows[0].error).toBeUndefined();
  });

  it("sorts newest first and filters to errored runs on request", () => {
    const raw = [
      summaryFixture({ run_id: "old", timestamp: { start: "2026-09-01T00:00:00+00:00" } }),
      summaryFixture({ run_id: "new", timestamp: { start: "2026-09-09T00:00:00+00:00" } }),
      summaryFixture({
        run_id: "boom",
        script_execution: "error",
        error: "TypeError: cannot render template",
        timestamp: { start: "2026-09-05T00:00:00+00:00" },
      }),
    ];
    const all = normalizeTraceSummaries(raw);
    expect(all.map((r) => r.run_id)).toEqual(["new", "boom", "old"]);

    const errored = normalizeTraceSummaries(raw, { erroredOnly: true });
    expect(errored.map((r) => r.run_id)).toEqual(["boom"]);
    expect(errored[0].error).toContain("TypeError");
  });

  it("ignores non-object entries", () => {
    expect(normalizeTraceSummaries([null, 5, "x"])).toEqual([]);
  });
});

describe("summarizeTraceDetail", () => {
  const detailFixture = () => ({
    ...summaryFixture({ run_id: "run-9" }),
    trace: {
      "trigger/1": [{ path: "trigger/1", timestamp: "2026-09-09T21:26:21.171247+00:00", changed_variables: { this: { entity_id: "automation.my_automation", attributes: { friendly_name: "x" } } } }],
      "action/0": [
        { path: "action/0", timestamp: "2026-09-09T21:26:21.2Z", result: { service: "light.turn_on" }, changed_variables: { count: 1 } },
        { path: "action/0", timestamp: "2026-09-09T21:26:21.9Z", error: "RepeatError: Something went wrong" },
      ],
    },
    config: { mode: "single" },
    context: { parent_id: "abc123" },
  });

  it("flattens trace nodes into a bounded timeline with retries as separate records", () => {
    const { detail, meta } = summarizeTraceDetail(detailFixture());
    expect(detail.entity_id).toBe("automation.my_automation");
    expect(detail.context_parent_id).toBe("abc123");
    expect(detail.timeline).toHaveLength(3);
    expect(detail.timeline.map((n) => n.path)).toEqual(["trigger/1", "action/0", "action/0"]);
    expect(detail.timeline[2].error).toContain("RepeatError");
    expect(detail.timeline[0].changed_variables.this).toContain("automation.my_automation");
    expect(detail.config).toBeUndefined();
    expect(meta.truncated).toBe(false);
  });

  it("clips large values and caps the timeline at maxNodes", () => {
    const fixture = detailFixture();
    const nodes = {};
    for (let i = 0; i < 30; i += 1) {
      nodes[`action/${i}`] = [{ path: `action/${i}`, result: "x".repeat(5000) }];
    }
    fixture.trace = nodes;
    const { detail, meta } = summarizeTraceDetail(fixture, { maxNodes: 10, maxChars: 100 });
    expect(detail.timeline).toHaveLength(10);
    expect(meta).toEqual({ timeline_nodes: 30, returned_nodes: 10, truncated: true });
    expect(detail.timeline[0].result.length).toBeLessThan(115);
    expect(detail.timeline[0].result).toContain("chars]");
  });

  it("includes a clipped config only when requested", () => {
    const { detail } = summarizeTraceDetail(detailFixture(), { includeConfig: true });
    expect(detail.config).toContain('"mode":"single"');
  });
});

describe("parseTraceEntityId / pickLatestRunId", () => {
  it("accepts automation and script entity ids, rejects everything else", () => {
    expect(parseTraceEntityId("automation.my_auto")).toEqual({ domain: "automation", item_id: "my_auto" });
    expect(parseTraceEntityId("script.my_script")).toEqual({ domain: "script", item_id: "my_script" });
    expect(parseTraceEntityId("light.my_light")).toBeNull();
    expect(parseTraceEntityId("garbage")).toBeNull();
  });

  it("picks the newest run that has a start timestamp", () => {
    const rows = [
      { run_id: "a", started: "2026-09-01T00:00:00+00:00" },
      { run_id: "b", started: "2026-09-09T00:00:00+00:00" },
      { run_id: "c" },
    ];
    expect(pickLatestRunId(rows)).toBe("b");
    expect(pickLatestRunId([])).toBeNull();
  });
});

describe("condenseLogLines", () => {
  it("collapses timestamp-insensitive duplicates with counts, preserving first-seen order", () => {
    const lines = [
      "2026-09-09 21:26:21.171 ERROR Something broke",
      "2026-09-09 21:26:22.000 INFO fine",
      "2026-09-09 21:27:01.990 ERROR Something broke",
      "",
    ];
    expect(condenseLogLines(lines)).toEqual([
      "2026-09-09 21:26:21.171 ERROR Something broke  [×2]",
      "2026-09-09 21:26:22.000 INFO fine",
    ]);
  });

  it("feeds the unique flag through formatErrorLogResult", () => {
    const text = [
      "2026-09-09 21:26:21.171 ERROR Duplicate me",
      "2026-09-09 21:27:01.990 ERROR Duplicate me",
      "2026-09-09 21:28:00.000 WARNING Once",
    ].join("\n");
    const result = formatErrorLogResult({ text, source: "error_log", requestedLines: 100, lines: 100, unique: true });
    expect(result.meta.unique).toBe(true);
    expect(result.meta.duplicates_collapsed).toBe(1);
    expect(result.data.log).toContain("[×2]");
  });
});
