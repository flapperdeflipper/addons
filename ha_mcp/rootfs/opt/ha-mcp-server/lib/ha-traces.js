/**
 * Pure helpers for the Home Assistant trace WebSocket API
 * (`trace/list`, `trace/get`). Every value that can grow without bound —
 * step results, changed variables, error payloads, configs — is clipped or
 * reduced to a preview before it enters an MCP response.
 */

const DEFAULT_MAX_NODES = 120;
const DEFAULT_MAX_CHARS = 200;
const ERROR_MAX_CHARS = 300;
const CONFIG_MAX_CHARS = 4000;

function clip(value, maxChars) {
  const text = String(value ?? "");
  return text.length > maxChars ? `${text.slice(0, maxChars)}… [${text.length} chars]` : text;
}

function preview(value, maxChars = 80) {
  if (value === null || value === undefined) return null;
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "string") return clip(value, maxChars);
  if (Array.isArray(value)) return clip(JSON.stringify(value), maxChars);
  return clip(JSON.stringify(value), maxChars);
}

function compactTrigger(trigger) {
  if (trigger === null || trigger === undefined) return null;
  if (typeof trigger === "string") return clip(trigger, 120);
  if (typeof trigger === "object") {
    if (typeof trigger.description === "string") return clip(trigger.description, 120);
    return clip(JSON.stringify(trigger), 120);
  }
  return clip(String(trigger), 120);
}

function isErroredRow(row) {
  return row.script_execution === "error" || Boolean(row.error);
}

export function normalizeTraceSummaries(rawList, { erroredOnly = false } = {}) {
  const rows = [];
  for (const raw of Array.isArray(rawList) ? rawList : []) {
    if (!raw || typeof raw !== "object") continue;
    const row = {
      entity_id: `${raw.domain}.${raw.item_id}`,
      run_id: raw.run_id ?? null,
      state: raw.state ?? null,
      script_execution: raw.script_execution ?? null,
      last_step: raw.last_step ?? null,
      trigger: compactTrigger(raw.trigger),
      error: raw.error !== undefined && raw.error !== null ? clip(
        typeof raw.error === "object" ? JSON.stringify(raw.error) : String(raw.error),
        ERROR_MAX_CHARS
      ) : undefined,
      started: raw.timestamp?.start ?? null,
      finished: raw.timestamp?.finish ?? null,
    };
    if (erroredOnly && !isErroredRow(row)) continue;
    rows.push(row);
  }
  rows.sort((a, b) => String(b.started ?? "").localeCompare(String(a.started ?? "")));
  return rows;
}

function previewVariables(changedVariables) {
  if (!changedVariables || typeof changedVariables !== "object") return undefined;
  const entries = Object.entries(changedVariables);
  if (entries.length === 0) return undefined;
  const out = {};
  for (const [key, value] of entries) {
    out[key] = preview(value);
  }
  return out;
}

const TRACE_NODE_COLLATOR = new Intl.Collator(undefined, { numeric: true });

export function summarizeTraceDetail(
  raw,
  {
    maxNodes = DEFAULT_MAX_NODES,
    maxChars = DEFAULT_MAX_CHARS,
    includeConfig = false,
  } = {}
) {
  const trace = raw && typeof raw.trace === "object" && raw.trace !== null ? raw.trace : {};
  const paths = Object.keys(trace)
    .filter((key) => trace[key] !== null && typeof trace[key] === "object")
    .sort((a, b) => TRACE_NODE_COLLATOR.compare(a, b));

  const timeline = [];
  for (const path of paths) {
    const steps = Array.isArray(trace[path]) ? trace[path] : [trace[path]];
    for (const step of steps) {
      if (!step || typeof step !== "object") continue;
      const node = {
        path,
        timestamp: step.timestamp ?? null,
      };
      if (step.error !== undefined && step.error !== null) {
        node.error = clip(
          typeof step.error === "object" ? JSON.stringify(step.error) : String(step.error),
          ERROR_MAX_CHARS
        );
      }
      if (step.result !== undefined) node.result = preview(step.result, maxChars);
      const variables = previewVariables(step.changed_variables);
      if (variables !== undefined) node.changed_variables = variables;
      timeline.push(node);
    }
  }

  // The trace is executed chronologically (trigger fires, then actions run);
  // presenting it path-alphabetically puts actions before their trigger.
  const executedAt = (node) => {
    const parsed = node.timestamp ? Date.parse(node.timestamp) : NaN;
    return Number.isNaN(parsed) ? Infinity : parsed;
  };
  timeline.sort((a, b) => executedAt(a) - executedAt(b));

  const truncated = timeline.length > maxNodes;
  const summary = {
    entity_id: `${raw?.domain}.${raw?.item_id}`,
    run_id: raw?.run_id ?? null,
    state: raw?.state ?? null,
    script_execution: raw?.script_execution ?? null,
    last_step: raw?.last_step ?? null,
    trigger: compactTrigger(raw?.trigger),
    error: raw?.error !== undefined && raw?.error !== null ? clip(
      typeof raw.error === "object" ? JSON.stringify(raw.error) : String(raw.error),
      ERROR_MAX_CHARS
    ) : undefined,
    started: raw?.timestamp?.start ?? null,
    finished: raw?.timestamp?.finish ?? null,
    context_parent_id: raw?.context?.parent_id ?? null,
  };

  const detail = { ...summary, timeline: truncated ? timeline.slice(0, maxNodes) : timeline };
  if (includeConfig && raw?.config !== undefined && raw?.config !== null) {
    detail.config = clip(JSON.stringify(raw.config), CONFIG_MAX_CHARS);
  }

  return {
    detail,
    meta: {
      timeline_nodes: timeline.length,
      returned_nodes: detail.timeline.length,
      truncated,
    },
  };
}

export function parseTraceEntityId(entityId) {
  const match = /^([a-z_][a-z0-9_]*)\.([a-z0-9_]+)$/.exec(String(entityId ?? "").trim());
  if (!match) return null;
  const [, domain, itemId] = match;
  if (domain !== "automation" && domain !== "script") return null;
  return { domain, item_id: itemId };
}

export function pickLatestRunId(summaries) {
  let best = null;
  for (const row of Array.isArray(summaries) ? summaries : []) {
    if (!row || typeof row !== "object") continue;
    if (row.run_id === undefined || row.run_id === null) continue;
    if (row.started === undefined || row.started === null) continue;
    if (!best || String(row.started).localeCompare(String(best.started)) > 0) best = row;
  }
  return best ? best.run_id : null;
}
