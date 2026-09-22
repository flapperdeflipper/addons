// Playwright MCP module. Runs ONE @playwright/mcp instance (pinned in
// package.json) on a loopback port inside the hub container, connected over
// CDP to the shared headless Chromium in the playwright-browser add-on.
// The gateway streams-proxies /mcp/playwright to it; playwright-mcp keeps
// per-connection browser contexts itself, so concurrent agent sessions are
// isolated while the process - and the browser - stay shared.
//
// The @playwright/mcp HTTP transport has no authentication, which is why it
// binds to 127.0.0.1 only and is reachable from outside exclusively through
// the hub's bearer-authenticated gateway.

import { createRequire } from "node:module";
import { dirname, isAbsolute, join } from "node:path";
import { readFileSync } from "node:fs";

const require = createRequire(import.meta.url);

export const PLAYWRIGHT_MCP_INTERNAL_PORT = 7101;

export function resolvePlaywrightMcpCli() {
  // The package exports map only exposes the library entry; the CLI lives at
  // the bin path from its manifest. Resolving package.json (explicitly
  // exported) and joining keeps this correct across reinstalls.
  const manifestPath = require.resolve("@playwright/mcp/package.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const bin = typeof manifest.bin === "string" ? manifest.bin : manifest.bin?.["playwright-mcp"];
  if (!bin) {
    throw new Error("@playwright/mcp does not declare a CLI bin");
  }
  return isAbsolute(bin) ? bin : join(dirname(manifestPath), bin);
}

export function buildSpawnSpec(ctx, { cliPath = resolvePlaywrightMcpCli() } = {}) {
  const cdpEndpoint = ctx.config.playwright_cdp_endpoint;
  if (!cdpEndpoint) {
    throw new Error("playwright_cdp_endpoint is required");
  }
  return {
    command: process.execPath,
    args: [
      cliPath,
      "--cdp-endpoint",
      cdpEndpoint,
      "--host",
      "127.0.0.1",
      "--port",
      String(PLAYWRIGHT_MCP_INTERNAL_PORT),
    ],
    port: PLAYWRIGHT_MCP_INTERNAL_PORT,
  };
}

export default {
  id: "playwright",
  title: "Playwright (shared browser via CDP)",
  kind: "upstream",
  enabledOption: "playwright_enabled",

  spawn(ctx) {
    return buildSpawnSpec(ctx);
  },
};
