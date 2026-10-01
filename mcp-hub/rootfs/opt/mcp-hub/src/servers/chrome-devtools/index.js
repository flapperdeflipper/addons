// Chrome DevTools MCP module. Hosts chrome-devtools-mcp (pinned in
// package.json) in-process and serves it through the hub's stateless
// streamable-HTTP handler, like the bundled "mcp" kind servers.
//
// The browser lives inside this container: chrome-devtools-mcp launches the
// image's Debian chromium lazily on the first tool call and drives it over a
// pipe (puppeteer `pipe: true`), so no CDP port exists on any network. The
// only way in is /mcp/chrome-devtools behind the hub's bearer token - this
// replaced the playwright-browser add-on, whose CDP port had no auth at all.
//
// One server, one browser, shared by every agent session. chrome-devtools-mcp
// serializes tool calls itself and its page-ID routing (default on) makes
// page-scoped tools take an explicit pageId, so concurrent sessions do not
// fight over a "selected" page. new_page accepts an isolatedContext name for
// sessions that need their own cookies/storage.

import { createMcpServer } from "chrome-devtools-mcp";
import { parseArguments } from "chrome-devtools-mcp/build/src/config/mcp-options.js";
import { VERSION } from "chrome-devtools-mcp/build/src/version.js";

export const CHROMIUM_PATH = "/usr/bin/chromium";

export function buildArgs() {
  return [
    "--headless",
    // Throwaway profile per browser launch, cleaned up on close.
    "--isolated",
    `--executable-path=${CHROMIUM_PATH}`,
    // Add-on containers run as root; Chrome refuses to start as root with
    // its sandbox enabled (crbug.com/638180).
    "--chrome-arg=--no-sandbox",
    "--chrome-arg=--disable-dev-shm-usage",
    // No usage statistics to Google, no trace URLs to the CrUX API.
    "--no-usage-statistics",
    "--no-performance-crux",
  ];
}

export function parseServerArgs(args = buildArgs()) {
  // parseArguments() expects a full process.argv (node + script first).
  return parseArguments(VERSION, [process.execPath, "chrome-devtools-mcp", ...args], {});
}

export default {
  id: "chrome-devtools",
  title: "Chrome DevTools (in-container headless Chromium)",
  kind: "mcp",
  enabledOption: "chrome_devtools_enabled",

  createServer(ctx) {
    // createMcpServer() is async (tool registration); the stateless handler
    // only needs connect(), so hand it a facade that waits for the server.
    const ready = createMcpServer(parseServerArgs(), {}).then(({ server }) => server);
    ready.catch((error) => {
      ctx.log("error", "chrome-devtools server failed to initialize", { error: error?.message || String(error) });
    });
    return {
      async connect(transport) {
        return (await ready).connect(transport);
      },
    };
  },
};
