// Unit tests for the agent MCP server's pure surface. The MCP SDK import in
// server.mjs is dynamic (start() only), so this file imports the module
// without any node_modules present — same zero-dependency rule as the other
// openchamber tests.

const assert = require("node:assert/strict");
const path = require("node:path");
const { describe, it } = require("node:test");

const serverPath = path.join(__dirname, "..", "rootfs", "opt", "openchamber-mcp", "server.mjs");

async function loadServer() {
  return import(serverPath);
}

/** In-memory stand-in for the OpenChamber REST API. */
function mockClient(state) {
  const calls = [];
  return {
    calls,
    async call(projectId, route, method = "GET", body) {
      calls.push({ projectId, route, method, body });
      if (method === "POST" && route === "/notes") {
        const note = { id: `n${state.notes.length + 1}`, body: body.body, source: body.source, pinned: false };
        state.notes.push(note);
        return { note, context: state };
      }
      if (method === "PUT" && route === "/todos") {
        state.todos = body.todos;
        return state;
      }
      return state;
    },
    async readContext(projectId) {
      calls.push({ projectId, route: "", method: "GET" });
      return state;
    },
  };
}

describe("openchamber MCP server: project id rule", () => {
  it("matches OpenChamber's path_<base64url> ids", async () => {
    const { projectIdFor } = await loadServer();
    assert.equal(projectIdFor("/homeassistant"), "path_L2hvbWVhc3Npc3RhbnQ");
    assert.equal(projectIdFor("/homeassistant/addons"), "path_L2hvbWVhc3Npc3RhbnQvYWRkb25z");
    assert.equal(projectIdFor("/data"), "path_L2RhdGE");
    assert.equal(projectIdFor("/homeassistant/"), "path_L2hvbWVhc3Npc3RhbnQ");
  });

  it("hashes over-long ids to the path_sha256_<digest> stem", async () => {
    const { createHash } = require("node:crypto");
    const { projectIdFor } = await loadServer();
    const directory = "/" + "a".repeat(300);
    const raw = `path_${Buffer.from(directory).toString("base64url")}`;
    const expected = `path_sha256_${createHash("sha256").update(raw, "utf8").digest("hex")}`;
    assert.equal(projectIdFor(directory), expected);
  });
});

describe("openchamber MCP server: bearer auth", () => {
  it("matches only the exact token, constant-time path included", async () => {
    const { tokenMatches, bearerFrom } = await loadServer();
    assert.equal(tokenMatches("abc", "abc"), true);
    assert.equal(tokenMatches("abc", "abd"), false);
    assert.equal(tokenMatches("", "abc"), false);
    assert.equal(bearerFrom({ authorization: "Bearer abc" }), "abc");
    assert.equal(bearerFrom({ authorization: "bearer abc" }), "abc");
    assert.equal(bearerFrom({ authorization: "Basic abc" }), "");
    assert.equal(bearerFrom({}), "");
  });
});

describe("openchamber MCP server: tools", () => {
  it("advertises the eight project-notes tools with JSON schemas", async () => {
    const { toolDefinitions } = await loadServer();
    const tools = toolDefinitions();
    assert.deepEqual(
      tools.map((t) => t.name),
      [
        "openchamber_context",
        "openchamber_note_add",
        "openchamber_note_edit",
        "openchamber_note_delete",
        "openchamber_todo_add",
        "openchamber_todo_toggle",
        "openchamber_todo_delete",
        "openchamber_plan_read",
      ],
    );
    for (const tool of tools) {
      assert.equal(tool.inputSchema.type, "object");
      assert.ok(tool.description.length > 20, `${tool.name} needs a description`);
    }
  });

  it("handlers read, add notes (source agent) and toggle todos through the client", async () => {
    const { toolHandlers } = await loadServer();
    const state = {
      version: 2,
      notes: [],
      todos: [{ id: "t1", text: "first", completed: false, createdAt: 1 }],
      plans: [],
    };
    const client = mockClient(state);
    const handlers = toolHandlers({ client, defaultDir: "/homeassistant" });

    const context = await handlers.openchamber_context({});
    assert.match(context, /todos \(1\):/);
    assert.match(context, /\[t1\] \[ \] first/);

    const added = await handlers.openchamber_note_add({ body: "decision: use mqtt" });
    assert.match(added, /note saved as \[n1\]/);
    assert.equal(state.notes[0].source, "agent");

    const toggled = await handlers.openchamber_todo_toggle({ todo_id: "t1" });
    assert.match(toggled, /\[t1\] \[x\] first/);
    assert.equal(state.todos[0].completed, true);

    // directory scoping reaches other projects by their own id
    await handlers.openchamber_context({ directory: "/data" });
    assert.ok(client.calls.some((c) => c.projectId === "path_L2RhdGE"));
  });

  it("unknown todos fail with the ids hint instead of writing", async () => {
    const { toolHandlers } = await loadServer();
    const state = { version: 2, notes: [], todos: [], plans: [] };
    const client = mockClient(state);
    const handlers = toolHandlers({ client, defaultDir: "/homeassistant" });
    await assert.rejects(
      () => handlers.openchamber_todo_toggle({ todo_id: "nope" }),
      /not found; call openchamber_context/,
    );
    assert.ok(!client.calls.some((c) => c.method === "PUT"), "no todo write may happen on a miss");
  });
});

describe("openchamber MCP server: package wiring", () => {
  it("the server lives inside the SDK prefix it resolves from", async () => {
    const fs = require("node:fs");
    const pkg = JSON.parse(
      fs.readFileSync(path.join(__dirname, "..", "rootfs", "opt", "openchamber-mcp", "package.json"), "utf8"),
    );
    assert.equal(pkg.type, "module");
    assert.ok(pkg.dependencies["@modelcontextprotocol/sdk"], "SDK pin lives in version control");
  });
});
