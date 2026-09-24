// Server module registry - the extension point of the MCP Hub.
//
// A module is a directory under src/servers/<id>/ whose index.js default-
// exports a manifest:
//
//   {
//     id: "victoriametrics",          // path segment under /mcp/
//     title: "VictoriaMetrics",
//     kind: "mcp" | "forwarder" | "upstream",
//     enabledOption: "victoriametrics_enabled",   // config.yaml option key
//     ...
//   }
//
// Kinds:
//   - "mcp":       createServer(ctx) -> SDK Server. Served through the
//                  stateless streamable-HTTP handler (one shared process,
//                  per-request transports, no session state).
//   - "forwarder": createForwarder(ctx) -> { send(message) }. Raw JSON-RPC
//                  pass-through to an upstream MCP endpoint; POST bodies are
//                  validated and forwarded per request.
//   - "upstream":  spawn(ctx) -> { command, args, port }. The gateway runs
//                  the process on a loopback port and streams-proxyies
//                  /mcp/<id> to it (used for playwright-mcp, which needs no
//                  shared state between its own per-connection contexts).
//
// Adding a server:
//   1. create src/servers/<id>/index.js exporting a manifest,
//   2. import it below and add it to MODULES,
//   3. add the enable option (+ any settings) to config.yaml options/schema.
// The gateway picks up routing, auth and health reporting automatically.

import victoriametrics from "./servers/victoriametrics/index.js";
import haNative from "./servers/ha-native/index.js";
import playwright from "./servers/playwright/index.js";
import homeassistant from "./servers/homeassistant/index.js";

export const MODULES = [victoriametrics, haNative, playwright, homeassistant];
