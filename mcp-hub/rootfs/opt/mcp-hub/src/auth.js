// Bearer-token helpers for the MCP Hub gateway.
//
// Forked from ha_opencode's ha-mcp-server lib/http-transport.js (MIT,
// flapperdeflipper) so the hub keeps the same token semantics: constant-time
// comparison, case-insensitive Bearer scheme, no length-leak paranoia beyond
// the early return (acceptable for a LAN token).

import { timingSafeEqual } from "node:crypto";

/** Constant-time bearer comparison; length leak is acceptable for a LAN token. */
export function tokenMatches(presented, expected) {
  if (typeof presented !== "string" || presented.length === 0) return false;
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function bearerFrom(headers) {
  const value = headers.authorization || "";
  const match = /^Bearer\s+(.+)$/i.exec(value);
  return match ? match[1].trim() : "";
}
