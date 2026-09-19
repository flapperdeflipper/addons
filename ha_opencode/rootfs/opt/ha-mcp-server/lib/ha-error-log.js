/**
 * Read the Home Assistant error log, falling back to the Core journal only
 * when Supervisor reports that the file-backed error-log endpoint is absent.
 */
import { redactSensitiveText } from "./supervisor-operations.js";

export async function readErrorLogWithFallback({
  readErrorLog,
  readCoreLogs,
  lines = 100,
} = {}) {
  if (typeof readErrorLog !== "function" || typeof readCoreLogs !== "function") {
    throw new TypeError("readErrorLog and readCoreLogs functions are required");
  }

  try {
    return {
      text: await readErrorLog(),
      source: "error_log",
    };
  } catch (error) {
    if (error?.status !== 404) throw error;

    return {
      text: await readCoreLogs(lines),
      source: "core_journal",
    };
  }
}

/**
 * Build a transparent MCP payload for either the error-log file or the
 * Supervisor-backed Core journal fallback.
 */
export function formatErrorLogResult({ text, source, requestedLines, lines, unique = false }) {
  const allLines = String(text ?? "").split("\n");
  if (allLines.at(-1) === "") allLines.pop();
  const logLines = allLines.slice(-lines);
  const usingCoreJournal = source === "core_journal";
  const uniqueLines = unique ? condenseLogLines(logLines) : logLines;
  const duplicatesCollapsed = logLines.length - uniqueLines.length;
  const { text: redactedLog, redactions } = redactSensitiveText(uniqueLines.join("\n"));

  return {
    summary: `Returned ${uniqueLines.length} Home Assistant ${usingCoreJournal ? "Core journal" : "error log"} ${unique ? "unique lines" : "lines"}${usingCoreJournal ? " (error log unavailable)" : ""}${unique && duplicatesCollapsed > 0 ? `, ${duplicatesCollapsed} duplicate line(s) collapsed` : ""}${redactions > 0 ? `, ${redactions} redaction(s) applied` : ""}`,
    data: { log: redactedLog },
    meta: {
      requested_lines: requestedLines,
      returned_lines: uniqueLines.length,
      ...(unique ? { unique, duplicates_collapsed: duplicatesCollapsed } : {}),
      source,
      fallback_used: usingCoreJournal,
      total_lines: usingCoreJournal ? null : allLines.length,
      truncated: usingCoreJournal ? null : allLines.length > logLines.length,
      server_limited: usingCoreJournal,
    },
  };
}

/**
 * Collapse repeated log lines into one line with an occurrence count, keyed by
 * the line with its leading timestamp removed. Order of first occurrence is
 * preserved. Empty lines are dropped.
 */
const LOG_TIMESTAMP_PREFIX = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:[.,]\d+)? /;

export function condenseLogLines(logLines) {
  const seen = new Map();
  const order = [];
  for (const line of logLines) {
    const key = String(line ?? "").replace(LOG_TIMESTAMP_PREFIX, "").trim();
    if (key === "") continue;
    const existing = seen.get(key);
    if (existing) {
      existing.count += 1;
    } else {
      const record = { line: String(line ?? ""), count: 1 };
      seen.set(key, record);
      order.push(record);
    }
  }
  return order.map((record) => (record.count > 1 ? `${record.line}  [×${record.count}]` : record.line));
}
