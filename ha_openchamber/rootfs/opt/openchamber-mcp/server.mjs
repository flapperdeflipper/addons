// openchamber-mcp-server — Agent MCP server for OpenChamber's Project Notes.
//
// Serves OpenChamber's notes, todos and plans (the Project Notes panel of the
// web UI) to MCP clients such as the OpenCode add-on, over streamable HTTP
// with a bearer token. Every call proxies the loopback-only OpenChamber REST
// API (/api/project-context/:projectId) owned by the ha-openchamber service —
// the JSON files under /data stay owned by that server alone, so the web UI
// and agent sessions can never drift apart.
//
// Transport mirrors the OpenCode add-on's ha-mcp-server HTTP mode (issue
// #95 lineage): stateless per-request StreamableHTTPServerTransport around a
// single Server instance, bearer auth in front. Projects are addressed by
// directory and converted with OpenChamber's own id rule: path_<base64url of
// the path>, hashed to path_sha256_<sha256hex(id)> past 200 characters
// (projectConfigFileStemOf — keep in sync with packages/web/server/lib/
// projects/project-id.js).
//
// The MCP SDK import is deliberately dynamic and only reached in start(): the
// unit tests import this file without the SDK installed (repo tests run with
// no node_modules, like the other openchamber tests).

import { createServer } from "node:http";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";

const MAX_PROJECT_ID_LENGTH = 200; // matches OpenChamber projectConfigFileStemOf
const CALL_TIMEOUT_MS = 10000;

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

/** OpenChamber project id for a checkout directory. */
export function projectIdFor(directory) {
  const normalized = String(directory || "").replace(/\\/g, "/").replace(/\/+$/g, "") || String(directory || "");
  const id = `path_${Buffer.from(normalized.trim(), "utf8").toString("base64url")}`;
  if (id.length <= MAX_PROJECT_ID_LENGTH) return id;
  return `path_sha256_${createHash("sha256").update(id, "utf8").digest("hex")}`;
}

function _fmtNote(n) {
  const pinned = n.pinned ? " (pinned)" : "";
  const source = n.source ? ` (${n.source})` : "";
  const body = String(n.body ?? "").replace(/\s+/g, " ").slice(0, 300);
  return `- [${n.id}]${pinned}${source} ${body}`;
}

function _fmtTodo(t) {
  return `- [${t.id}] ${t.completed ? "[x]" : "[ ]"} ${t.text}`;
}

export function formatContext(c) {
  if (!c || typeof c !== "object") return "no context returned";
  const notes = (c.notes || []).map(_fmtNote);
  const todos = (c.todos || []).map(_fmtTodo);
  const plans = (c.plans || []).map((p) => `- [${p.id}]${p.pinned ? " (pinned)" : ""} ${p.title || p.file || ""}`);
  return [
    `notes (${notes.length}):`, ...(notes.length ? notes : ["  (none)"]),
    `todos (${todos.length}):`, ...(todos.length ? todos : ["  (none)"]),
    `plans (${plans.length}):`, ...(plans.length ? plans : ["  (none)"]),
  ].join("\n");
}

export class OpenChamberError extends Error {}

/**
 * REST client for OpenChamber's project-context API. Todo writes use the
 * whole-array PUT, so read-modify-write calls are serialized through a
 * promise chain and never interleave.
 */
export function createClient(baseUrl) {
  const base = String(baseUrl || "").replace(/\/+$/, "");
  let chain = Promise.resolve();

  async function call(projectId, route, method = "GET", body) {
    const res = await fetch(`${base}/api/project-context/${encodeURIComponent(projectId)}${route}`, {
      method,
      headers: body ? { "Content-Type": "application/json" } : {},
      body: body ? JSON.stringify(body) : undefined,
      redirect: "manual", // loopback never redirects; surface one instead of following it
      signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
    });
    const text = await res.text();
    let payload = null;
    try { payload = JSON.parse(text); } catch {}
    if (!res.ok) {
      const detail = (payload && payload.error) || text.slice(0, 200);
      throw new OpenChamberError(`OpenChamber ${res.status}: ${detail}`);
    }
    if (payload === null || typeof payload !== "object") {
      throw new OpenChamberError(`OpenChamber returned non-JSON (status ${res.status})`);
    }
    return payload;
  }

  return {
    async call(projectId, route, method, body) {
      const run = () => call(projectId, route, method, body);
      const result = chain.then(run, run);
      chain = result.catch(() => {});
      return result;
    },
    readContext(projectId) {
      return this.call(projectId, "");
    },
  };
}

/** Tool table. Handlers receive (args, ctx) with ctx = { client, defaultDir }. */
export function toolHandlers(ctx) {
  const pid = (directory) => projectIdFor(directory || ctx.defaultDir);

  return {
    async openchamber_context(args) {
      return formatContext(await ctx.client.readContext(pid(args.directory)));
    },

    async openchamber_note_add(args) {
      const result = await ctx.client.call(pid(args.directory), "/notes", "POST", {
        body: String(args.body ?? ""),
        source: "agent",
      });
      const note = result.note || {};
      return `note saved as [${note.id}]:\n${note.body ?? ""}\n\n${formatContext(result.context)}`;
    },

    async openchamber_note_edit(args) {
      const payload = {};
      if (args.body !== undefined && args.body !== "") payload.body = String(args.body);
      if (args.pinned !== undefined && args.pinned !== null) payload.pinned = Boolean(args.pinned);
      if (!Object.keys(payload).length) throw new OpenChamberError("nothing to change: pass body and/or pinned");
      const result = await ctx.client.call(pid(args.directory), `/notes/${encodeURIComponent(String(args.note_id))}`, "PATCH", payload);
      return `note updated:\n${formatContext(result.context ?? result)}`;
    },

    async openchamber_note_delete(args) {
      const result = await ctx.client.call(pid(args.directory), `/notes/${encodeURIComponent(String(args.note_id))}`, "DELETE");
      // The DELETE endpoint returns the bare context object, not {context}.
      return `note deleted:\n${formatContext(result.context ?? result)}`;
    },

    async openchamber_todo_add(args) {
      const projectId = pid(args.directory);
      const context = await ctx.client.readContext(projectId);
      const todo = { id: randomUUID(), text: String(args.text ?? ""), completed: false, createdAt: Date.now() };
      const updated = await ctx.client.call(projectId, "/todos", "PUT", { todos: [...(context.todos || []), todo] });
      return `todo added [${todo.id}]:\n${formatContext(updated)}`;
    },

    async openchamber_todo_toggle(args) {
      const projectId = pid(args.directory);
      const context = await ctx.client.readContext(projectId);
      const todos = context.todos || [];
      const todo = todos.find((t) => t.id === String(args.todo_id));
      if (!todo) throw new OpenChamberError(`todo ${args.todo_id} not found; call openchamber_context for current ids`);
      todo.completed = !todo.completed;
      const updated = await ctx.client.call(projectId, "/todos", "PUT", { todos });
      return `todo toggled:\n${formatContext(updated)}`;
    },

    async openchamber_todo_delete(args) {
      const projectId = pid(args.directory);
      const context = await ctx.client.readContext(projectId);
      const todos = context.todos || [];
      const remaining = todos.filter((t) => t.id !== String(args.todo_id));
      if (remaining.length === todos.length) {
        throw new OpenChamberError(`todo ${args.todo_id} not found; call openchamber_context for current ids`);
      }
      const updated = await ctx.client.call(projectId, "/todos", "PUT", { todos: remaining });
      return `todo deleted:\n${formatContext(updated)}`;
    },

    async openchamber_plan_read(args) {
      const plan = await ctx.client.call(pid(args.directory), `/plans/${encodeURIComponent(String(args.plan_id))}`);
      return String(plan.body ?? JSON.stringify(plan).slice(0, 2000));
    },
  };
}

/** Tools advertised over MCP. JSON-schema inputs, ha-mcp-server style. */
export function toolDefinitions() {
  const directoryProp = { type: "string", description: "Absolute project directory; defaults to the current project" };
  return [
    {
      name: "openchamber_context",
      description:
        "Read the OpenChamber project notes surface for a directory: its notes, todos, and list of plans. This is the same data the OpenChamber web UI shows under Project Notes. Use openchamber_note_add/todo_add to record things the user wants visible there, and read this before claiming a project has no notes.",
      inputSchema: { type: "object", properties: { directory: directoryProp } },
    },
    {
      name: "openchamber_note_add",
      description:
        "Add a note to the OpenChamber project notes. Use for durable project information: decisions, preferences, context the user wants kept with the project. The note is marked with source agent.",
      inputSchema: { type: "object", properties: { body: { type: "string", description: "Note text (markdown allowed)" }, directory: directoryProp }, required: ["body"] },
    },
    {
      name: "openchamber_note_edit",
      description: "Edit an OpenChamber note's text and/or pinned flag. Get the note id from openchamber_context.",
      inputSchema: {
        type: "object",
        properties: {
          note_id: { type: "string", description: "Note id from openchamber_context" },
          body: { type: "string", description: "New note text; omit to leave unchanged" },
          pinned: { type: "boolean", description: "Pinned state; omit to leave unchanged" },
          directory: directoryProp,
        },
        required: ["note_id"],
      },
    },
    {
      name: "openchamber_note_delete",
      description: "Delete an OpenChamber note. Get the note id from openchamber_context.",
      inputSchema: { type: "object", properties: { note_id: { type: "string", description: "Note id from openchamber_context" }, directory: directoryProp }, required: ["note_id"] },
    },
    {
      name: "openchamber_todo_add",
      description: "Add a todo item to the OpenChamber project todo list.",
      inputSchema: { type: "object", properties: { text: { type: "string", description: "Todo text" }, directory: directoryProp }, required: ["text"] },
    },
    {
      name: "openchamber_todo_toggle",
      description: "Toggle an OpenChamber todo between open and completed. Get the id from openchamber_context.",
      inputSchema: { type: "object", properties: { todo_id: { type: "string", description: "Todo id from openchamber_context" }, directory: directoryProp }, required: ["todo_id"] },
    },
    {
      name: "openchamber_todo_delete",
      description: "Delete an OpenChamber todo item. Get the id from openchamber_context.",
      inputSchema: { type: "object", properties: { todo_id: { type: "string", description: "Todo id from openchamber_context" }, directory: directoryProp }, required: ["todo_id"] },
    },
    {
      name: "openchamber_plan_read",
      description: "Read the markdown body of one OpenChamber plan. Get the plan id from openchamber_context.",
      inputSchema: { type: "object", properties: { plan_id: { type: "string", description: "Plan id from openchamber_context" }, directory: directoryProp }, required: ["plan_id"] },
    },
  ];
}

function bearerRealmUnauthorized(res) {
  res.writeHead(401, {
    "content-type": "application/json",
    "www-authenticate": 'Bearer realm="openchamber-mcp"',
  });
  res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32001, message: "unauthorized" }, id: null }));
}

/**
 * Stateless streamable-HTTP plumbing around one Server instance — the same
 * shape as the OpenCode add-on's ha-mcp-server lib/http-transport.js: every
 * request gets a fresh StreamableHTTPServerTransport, connected and
 * disconnected again once the response closes, serialized through a promise
 * chain because the SDK allows one connected transport at a time.
 */
export async function start({ url, token, port = 4100, host = "0.0.0.0" }) {
  const { Server } = await import("@modelcontextprotocol/sdk/server/index.js");
  const { StreamableHTTPServerTransport } = await import("@modelcontextprotocol/sdk/server/streamableHttp.js");
  const { ListToolsRequestSchema, CallToolRequestSchema } = await import("@modelcontextprotocol/sdk/types.js");

  const client = createClient(url);
  const handlers = toolHandlers({ client, defaultDir: "/homeassistant" });
  const definitions = toolDefinitions();

  const server = new Server(
    { name: "openchamber", version: "1.0.0", description: "OpenChamber project notes, todos and plans for agent clients." },
    { capabilities: { tools: { listChanged: false } } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: definitions }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const name = request.params?.name;
    const args = request.params?.arguments || {};
    const handler = handlers[name];
    if (!handler) {
      return {
        content: [{ type: "text", text: `error: unknown tool ${name}` }],
        isError: true,
      };
    }
    try {
      const text = await handler(args);
      return { content: [{ type: "text", text: String(text) }] };
    } catch (error) {
      return {
        content: [{ type: "text", text: `error: ${error?.message ?? error}` }],
        isError: true,
      };
    }
  });

  let chain = Promise.resolve();
  const httpServer = createServer(function listener(req, res) {
    const requestUrl = new URL(req.url ?? "/", "http://localhost");
    if (req.method === "GET" && requestUrl.pathname === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: "ok" }));
      return;
    }
    if (requestUrl.pathname !== "/mcp") {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not found" }));
      return;
    }
    if (!tokenMatches(bearerFrom(req.headers), token)) {
      bearerRealmUnauthorized(res);
      return;
    }
    // This server never pushes messages, so the standalone GET stream gets a
    // spec-compliant 405 instead of the transport's empty SSE stream: with
    // sessionIdGenerator undefined the SDK still opens that stream, and Node
    // SDK clients (opencode among them) deadlock on the zombie stream while
    // processing later JSON POST responses. Python clients never notice.
    if (req.method === "GET") {
      res.writeHead(405, { "content-type": "application/json", allow: "POST, DELETE" });
      res.end(
        JSON.stringify({
          jsonrpc: "2.0",
          error: { code: -32000, message: "no standalone SSE stream: stateless server" },
          id: null,
        }),
      );
      return;
    }
    chain = chain.then(async () => {
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      res.on("close", () => transport.close().catch(() => {}));
      await server.connect(transport);
      await transport.handleRequest(req, res);
    }).catch((error) => {
      if (!res.headersSent) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32603, message: "internal error" }, id: null }));
      }
    });
  });

  await new Promise((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(port, host, resolve);
  });
  return httpServer;
}

// ============================================================================
// ENTRY POINT
// ============================================================================

if (import.meta.url === `file://${process.argv[1]}`) {
  const url = process.env.OPENCHAMBER_URL || "http://127.0.0.1:3010";
  const token = process.env.MCP_TOKEN || "";
  const port = parseInt(process.env.MCP_PORT || "4100", 10);
  if (!token) {
    console.error("MCP_TOKEN is required; refusing to serve unauthenticated");
    process.exit(1);
  }
  start({ url, token, port })
    .then(() => {
      console.error(`openchamber MCP server listening on 0.0.0.0:${port}/mcp (HTTP, bearer authenticated)`);
      console.error(`OpenChamber REST API: ${url}/api/project-context (loopback)`);
    })
    .catch((error) => {
      console.error(`openchamber MCP server failed to start: ${error?.message ?? error}`);
      process.exit(1);
    });
}
