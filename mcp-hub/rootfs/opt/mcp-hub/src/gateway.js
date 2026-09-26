// MCP Hub gateway - the single entrypoint of the add-on.
//
// One HTTP listener (default 8930/tcp) serves every bundled MCP server under
// /mcp/<id> behind one shared bearer token. This replaces the per-agent-
// session stdio spawns (each opencode session used to pay ~260 MB for its
// own playwright-mcp + prometheus-mcp-server + ha-mcp-server processes).
//
// Kinds served (see registry.js):
//   mcp       -> stateless streamable-HTTP through a shared SDK server
//   forwarder -> validated JSON-RPC pass-through to an upstream MCP endpoint
//   upstream  -> streaming reverse proxy to a supervised child process
//
// A failing module never takes the gateway down: it is reported through
// /healthz and its path answers 503, and everything else keeps working.

import { createServer, request as httpRequest } from "node:http";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { bearerFrom, tokenMatches } from "./auth.js";
import { createStatelessMcpHandler } from "./stateless.js";
import { MODULES } from "./registry.js";

const DEFAULT_PORT = 8930;
const MAX_FORWARDER_BODY_BYTES = 2 * 1024 * 1024;
const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "host",
  // The child needs no credentials; the hub token must not leak downstream.
  "authorization",
]);

export function createLogger(stream = process.stdout) {
  return function log(level, message, extra = {}) {
    stream.write(
      JSON.stringify({
        level,
        logger: "mcp-hub",
        message,
        ...extra,
        timestamp: new Date().toISOString(),
      }) + "\n"
    );
  };
}

export function loadConfig({ optionsPath = process.env.HUB_OPTIONS_PATH || "/data/options.json" } = {}) {
  let fileConfig = {};
  try {
    fileConfig = JSON.parse(readFileSync(optionsPath, "utf8"));
  } catch {
    // Tests and local runs inject config through HUB_* env instead.
  }
  // An option that is still a literal "!secret ..." means the key was missing
  // from secrets.yaml when the Supervisor wrote options.json. Serving with a
  // reference string as a credential would be silent auth theater - refuse.
  const unresolved = Object.entries(fileConfig)
    .filter(([, v]) => typeof v === "string" && v.startsWith("!secret "))
    .map(([k]) => k);
  if (unresolved.length > 0) {
    throw new Error(
      'unresolved !secret reference in option(s): ' + unresolved.join(', ') +
      ' (key missing in secrets.yaml) - refusing to start',
    );
  }
  return {
    ...fileConfig,
    token: process.env.HUB_TOKEN || fileConfig.token || "",
    port: Number(process.env.HUB_PORT || DEFAULT_PORT),
  };
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error("request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function sendJson(res, status, payload, extraHeaders = {}) {
  res.writeHead(status, { "content-type": "application/json", ...extraHeaders });
  res.end(JSON.stringify(payload));
}

function sendJsonRpcError(res, status, code, message, extraHeaders = {}) {
  sendJson(res, status, { jsonrpc: "2.0", error: { code, message }, id: null }, extraHeaders);
}

/**
 * Supervise an "upstream" module child: spawn it, restart it with capped
 * backoff when it exits, and tear it down on stop(). State changes are
 * reported through onState so /healthz always reflects reality.
 */
export function createUpstreamSupervisor({ spec, log, onState = () => {} }) {
  let child = null;
  let stopped = false;
  let restartDelayMs = 1000;
  let restartTimer = null;
  let state = "starting";

  function setState(next) {
    state = next;
    onState(next);
  }

  function start() {
    if (stopped) return;
    setState("starting");
    log("info", `spawning upstream ${spec.command} ${spec.args.join(" ")}`);
    child = spawn(spec.command, spec.args, { stdio: ["ignore", "inherit", "inherit"] });

    child.on("exit", (code, signal) => {
      child = null;
      if (stopped) return;
      setState("restarting");
      log("warn", `upstream exited (code=${code} signal=${signal}); restarting in ${restartDelayMs}ms`);
      restartTimer = setTimeout(() => {
        restartDelayMs = Math.min(restartDelayMs * 2, 30000);
        start();
      }, restartDelayMs);
    });

    // The child is considered up once it accepts connections; the proxy
    // answers 503 until then, so no readiness probe is needed here.
    setState("running");
  }

  return {
    start,
    get state() {
      return state;
    },
    async stop() {
      stopped = true;
      if (restartTimer) clearTimeout(restartTimer);
      if (child) {
        await new Promise((resolve) => {
          child.once("exit", resolve);
          child.kill("SIGTERM");
          setTimeout(() => child && child.kill("SIGKILL"), 5000).unref();
        });
      }
    },
  };
}

/**
 * Build the gateway. `modules` and `config` are injectable for tests.
 */
export function createGateway({ config, modules = MODULES, env = process.env, log = createLogger() } = {}) {
  if (!config.token) {
    throw new Error("A bearer token is required (set the token option)");
  }

  const ctx = { config, env, log };
  const routes = new Map(); // id -> { module, state, handler | forwarder | supervisor }

  for (const module of modules) {
    const enabled = config[module.enabledOption] !== false;
    if (!enabled) {
      routes.set(module.id, { module, state: "disabled" });
      continue;
    }
    try {
      if (module.kind === "mcp") {
        const server = module.createServer(ctx);
        routes.set(module.id, {
          module,
          state: "running",
          handler: createStatelessMcpHandler(server),
        });
      } else if (module.kind === "forwarder") {
        if (typeof module.validateJsonRpcMessage !== "function") {
          throw new Error("forwarder modules must expose validateJsonRpcMessage(message)");
        }
        routes.set(module.id, {
          module,
          state: "running",
          forwarder: module.createForwarder(ctx),
        });
      } else if (module.kind === "upstream") {
        const spec = module.spawn(ctx);
        const entry = { module, state: "disabled", supervisor: null, spec };
        entry.supervisor = createUpstreamSupervisor({
          spec,
          log,
          onState: (state) => {
            entry.state = state;
          },
        });
        entry.state = "starting";
        routes.set(module.id, entry);
      } else {
        throw new Error(`unknown module kind: ${module.kind}`);
      }
      log("info", `enabled ${module.kind} server '${module.id}' at /mcp/${module.id}`);
    } catch (error) {
      // One broken module must never take the hub down.
      routes.set(module.id, { module, state: "failed", error: error?.message || String(error) });
      log("error", `failed to enable server '${module.id}'`, { error: error?.message || String(error) });
    }
  }

  function healthPayload() {
    const servers = {};
    for (const [id, entry] of routes) {
      servers[id] = entry.state;
    }
    return { status: "ok", servers };
  }

  async function handleForwarder(req, res, entry) {
    if (req.method !== "POST") {
      sendJsonRpcError(res, 405, -32600, "POST required for this server", { allow: "POST" });
      return;
    }
    const body = await readBody(req, MAX_FORWARDER_BODY_BYTES);
    let message;
    try {
      message = JSON.parse(body.toString("utf8"));
    } catch {
      sendJsonRpcError(res, 400, -32700, "Parse error");
      return;
    }
    const validate = entry.module.validateJsonRpcMessage;
    const validation = validate(message);
    if (!validation.valid) {
      sendJson(res, 400, {
        jsonrpc: "2.0",
        error: { code: -32600, message: validation.reason },
        id: validation.id,
      });
      return;
    }
    const reply = await entry.forwarder.send(message);
    if (reply === null || reply === undefined) {
      // Notification accepted, or an upstream 202: nothing to return.
      res.writeHead(202);
      res.end();
      return;
    }
    sendJson(res, 200, reply);
  }

  function proxyToUpstream(req, res, entry, childPath) {
    if (!entry.supervisor || entry.state !== "running") {
      sendJsonRpcError(res, 503, -32003, `upstream '${entry.module.id}' is ${entry.state}`);
      return;
    }
    const headers = { ...req.headers };
    for (const header of HOP_BY_HOP_HEADERS) delete headers[header];
    // @playwright/mcp validates the Host header against its bind address
    // (anti-DNS-rebinding) and only accepts localhost - 127.0.0.1 is
    // rejected. Speak the child's own name, not the hub's, not the IP.
    headers.host = `localhost:${entry.spec.port}`;
    const upstream = httpRequest({
      host: "127.0.0.1",
      port: entry.spec.port,
      method: req.method,
      path: childPath,
      headers,
    });
    upstream.on("response", (upRes) => {
      res.writeHead(upRes.statusCode || 502, upRes.headers);
      upRes.pipe(res);
    });
    upstream.on("error", (error) => {
      if (!res.headersSent) {
        sendJsonRpcError(res, 502, -32003, `upstream '${entry.module.id}' unreachable: ${error.message}`);
      } else {
        res.destroy();
      }
    });
    req.pipe(upstream);
  }

  const listener = async function listener(req, res) {
    const url = new URL(req.url ?? "/", "http://localhost");
    const pathname = url.pathname.replace(/\/+$/, "") || "/";

    if (req.method === "GET" && pathname === "/healthz") {
      sendJson(res, 200, healthPayload());
      return;
    }

    if (!tokenMatches(bearerFrom(req.headers), config.token)) {
      log("warn", `unauthorized request from ${req.socket.remoteAddress} for ${pathname}`);
      sendJsonRpcError(res, 401, -32001, "unauthorized", {
        "www-authenticate": 'Bearer realm="mcp-hub"',
      });
      return;
    }

    if (req.method === "GET" && (pathname === "/" || pathname === "")) {
      const servers = [...routes.entries()].map(([id, entry]) => ({
        id,
        title: entry.module.title,
        kind: entry.module.kind,
        state: entry.state,
        path: `/mcp/${id}`,
      }));
      sendJson(res, 200, { servers });
      return;
    }

    const match = /^\/mcp\/([a-z0-9_-]+)(\/.*)?$/.exec(pathname);
    if (!match) {
      sendJson(res, 404, { error: "not found" });
      return;
    }
    const subPath = match[2] || "";
    const entry = routes.get(match[1]);
    if (!entry) {
      sendJson(res, 404, { error: `unknown MCP server '${match[1]}'` });
      return;
    }
    if (entry.state === "disabled" || entry.state === "failed") {
      sendJsonRpcError(res, 503, -32003, `server '${match[1]}' is ${entry.state}`);
      return;
    }

    try {
      if (entry.module.kind === "mcp") {
        if (subPath) {
          sendJson(res, 404, { error: "sub-paths are not supported for this server" });
          return;
        }
        if (req.method !== "POST") {
          sendJsonRpcError(res, 405, -32600, "POST required for this server", { allow: "POST" });
          return;
        }
        entry.handler(req, res);
        return;
      }
      if (entry.module.kind === "forwarder") {
        if (subPath) {
          sendJson(res, 404, { error: "sub-paths are not supported for this server" });
          return;
        }
        await handleForwarder(req, res, entry);
        return;
      }
      // Upstream children own their own sub-paths (e.g. playwright-mcp serves
      // streamable HTTP at /mcp and legacy SSE at /sse).
      proxyToUpstream(req, res, entry, (subPath || "/") + url.search);
    } catch (error) {
      log("error", `error serving /mcp/${match[1]}`, { error: error?.message || String(error) });
      if (!res.headersSent) {
        sendJsonRpcError(res, 500, -32603, "internal error");
      }
    }
  };

  const httpServer = createServer(listener);

  return {
    httpServer,
    routes,
    async start({ port = config.port, host = "0.0.0.0" } = {}) {
      for (const entry of routes.values()) {
        if (entry.supervisor) entry.supervisor.start();
      }
      await new Promise((resolve, reject) => {
        httpServer.once("error", reject);
        httpServer.listen(port, host, resolve);
      });
      log("info", `MCP Hub listening on ${host}:${port} (bearer authenticated)`);
      return httpServer;
    },
    async stop() {
      for (const entry of routes.values()) {
        if (entry.supervisor) await entry.supervisor.stop();
      }
      await new Promise((resolve) => httpServer.close(resolve));
    },
  };
}

export async function main() {
  const log = createLogger();
  const config = loadConfig();
  if (!config.token) {
    log("error", "no token configured - set the token option (a !secret <key> value works) and restart");
    process.exit(1);
  }
  const gateway = createGateway({ config, log });

  let shuttingDown = false;
  async function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    log("info", `received ${signal}, shutting down`);
    await gateway.stop();
    process.exit(0);
  }
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  try {
    await gateway.start();
  } catch (error) {
    log("error", "gateway failed to start", { error: error?.message || String(error) });
    process.exit(1);
  }
}

// Run only when executed directly (tests import createGateway instead).
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main();
}
