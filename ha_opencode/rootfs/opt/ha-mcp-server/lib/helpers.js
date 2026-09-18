/**
 * MCP Content Helpers
 *
 * Pure utility functions for building MCP content objects.
 */

/**
 * Build an MCP text content object with optional annotations.
 */
export function createTextContent(text, options = {}) {
  const content = { type: "text", text };
  if (options.audience || options.priority !== undefined) {
    content.annotations = {};
    if (options.audience) content.annotations.audience = options.audience;
    if (options.priority !== undefined) content.annotations.priority = options.priority;
  }
  return content;
}

/**
 * Build an MCP text content object containing JSON that older clients can read.
 */
export function createJsonTextContent(payload, options = {}) {
  const { pretty = false, ...contentOptions } = options;
  return createTextContent(JSON.stringify(payload, null, pretty ? 2 : 0), contentOptions);
}

/**
 * Build a stable summary/data/meta payload for clients without structuredContent.
 */
export function createCompactPayload(summary, data, meta = {}) {
  return { summary, data, meta };
}

/**
 * Truncate long text while preserving the beginning and end.
 */
export function truncateText(text, options = {}) {
  const value = String(text ?? "");
  const maxChars = options.maxChars ?? 20000;
  if (value.length <= maxChars) {
    return {
      text: value,
      truncated: false,
      original_chars: value.length,
      returned_chars: value.length,
      omitted_chars: 0,
    };
  }

  let headChars = Math.min(options.headChars ?? Math.ceil(maxChars * 0.35), maxChars);
  let tailChars = Math.max(0, maxChars - headChars);
  let omittedChars = Math.max(0, value.length - headChars - tailChars);
  let omission = `\n\n... ${omittedChars} chars omitted ...\n\n`;
  const available = Math.max(0, maxChars - omission.length);
  headChars = Math.min(headChars, available);
  tailChars = Math.max(0, available - headChars);
  omittedChars = Math.max(0, value.length - headChars - tailChars);
  omission = `\n\n... ${omittedChars} chars omitted ...\n\n`;

  return {
    text: `${value.slice(0, headChars)}${omission}${value.slice(value.length - tailChars)}`,
    truncated: true,
    original_chars: value.length,
    returned_chars: Math.min(maxChars, headChars + omission.length + tailChars),
    omitted_chars: omittedChars,
  };
}

/**
 * Truncate arrays of log/output lines with a head/tail split.
 */
export function truncateLines(lines, options = {}) {
  const values = Array.isArray(lines) ? lines : String(lines ?? "").split("\n");
  const maxLines = options.maxLines ?? 200;
  if (values.length <= maxLines) {
    return {
      lines: values,
      truncated: false,
      original_lines: values.length,
      returned_lines: values.length,
      omitted_lines: 0,
    };
  }

  const headLines = Math.min(options.headLines ?? Math.ceil(maxLines * 0.25), maxLines);
  const tailLines = Math.max(0, maxLines - headLines);
  const omittedLines = Math.max(0, values.length - headLines - tailLines);
  const marker = `... ${omittedLines} lines omitted ...`;
  const truncatedLines = [
    ...values.slice(0, headLines),
    marker,
    ...values.slice(values.length - tailLines),
  ];

  return {
    lines: truncatedLines,
    truncated: true,
    original_lines: values.length,
    returned_lines: truncatedLines.length,
    omitted_lines: omittedLines,
  };
}

/**
 * Build an MCP image content object with optional annotations.
 */
export function createImageContent(base64Data, mimeType, options = {}) {
  const content = { type: "image", data: base64Data, mimeType };
  if (options.audience || options.priority !== undefined) {
    content.annotations = {};
    if (options.audience) content.annotations.audience = options.audience;
    if (options.priority !== undefined) content.annotations.priority = options.priority;
  }
  return content;
}

/**
 * Build an MCP resource link object with optional annotations.
 */
export function createResourceLink(uri, name, description, options = {}) {
  const link = {
    type: "resource_link",
    uri,
    name,
    description,
  };
  if (options.mimeType) link.mimeType = options.mimeType;
  if (options.audience || options.priority !== undefined) {
    link.annotations = {};
    if (options.audience) link.annotations.audience = options.audience;
    if (options.priority !== undefined) link.annotations.priority = options.priority;
  }
  return link;
}

/**
 * Redact bulky or credential-bearing tool arguments before they are written
 * to the add-on log. Mirrors the ESPHome arg redactor's field treatment:
 * large text payloads become char counts, secret-shaped fields become flags.
 */
const SENSITIVE_ARG_FIELDS = new Set([
  "password", "token", "api_key", "access_token", "refresh_token",
  "client_secret", "secret", "psk", "key",
]);

export function redactToolArgsForLog(args) {
  const redact = (value) => {
    if (Array.isArray(value)) {
      return { array_length: value.length };
    }
    if (!value || typeof value !== "object") return value;
    const safe = {};
    for (const [field, fieldValue] of Object.entries(value)) {
      if (field === "content" || field === "file_content" || field === "yaml_config" || field === "config") {
        safe[`${field}_chars`] = typeof fieldValue === "string" ? fieldValue.length : null;
      } else if (field === "lines") {
        safe.lines_count = Array.isArray(fieldValue) ? fieldValue.length : null;
      } else if (SENSITIVE_ARG_FIELDS.has(field)) {
        safe[`has_${field}`] = fieldValue !== undefined && fieldValue !== null && fieldValue !== "";
      } else {
        safe[field] = redact(fieldValue);
      }
    }
    return safe;
  };
  if (!args || typeof args !== "object") return args;
  return redact(args);
}
