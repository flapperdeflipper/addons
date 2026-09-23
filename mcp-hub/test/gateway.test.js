// Integration tests for the gateway: auth, routing, and one round-trip per
// module kind (mcp, forwarder, upstream). Uses ephemeral ports and a
// throwaway HTTP server as the upstream child - no network access needed.

const assert = require("node:assert/strict");
const path = require("node:path");
const { createRequire } = require("node:module");
const { after, before, describe, it } = require("node:test");

const SERVER_PACKAGE = path.join(__dirname, "..", "rootfs", "opt", "mcp-hub", "package.json");
const SERVER_SRC = path.join(__dirname, "..", "rootfs", "opt", "mcp-hub", "src");

const TOKEN = "integration-test-token";
const MCP_ACCEPT = "application/json, text/event-stream";
const UPSTREAM_PORT = 47101;

let Server;
let CallToolRequestSchema;
let ListToolsRequestSchema;
let createGateway;
let validateJsonRpcMessage;

function echoMcpModule() {
  const server = new Server({ name: "echo", version: "0.0.1" }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [{ name: "echo", description: "echo", inputSchema: { type: "object", properties: {} } }],
  }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => ({
    content: [{ type: "text", text: `echo:${request.params.name}` }],
  }));
  return {
    id: "echo",
    title: "Echo",
    kind: "mcp",
    enabledOption: "echo_enabled",
    createServer() {
      return server;
    },
  };
}

function fakeForwarderModule() {
  return {
    id: "fwd",
    title: "Forwarder",
    kind: "forwarder",
    enabledOption: "fwd_enabled",
    validateJsonRpcMessage,
    createForwarder() {
      return {
        async send(message) {
          if (message.id === undefined) return null;
          return { jsonrpc: "2.0", id: message.id, result: { forwarded: true } };
        },
      };
    },
  };
}

// Stand-in for the playwright child: any request gets a plain 200 reply.
function fakeUpstreamModule() {
  const script = `
    require("http").createServer((req, res) => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("upstream-ok:" + req.url + " host=" + req.headers.host);
    }).listen(${UPSTREAM_PORT}, "127.0.0.1");
  `;
  return {
    id: "up",
    title: "Upstream",
    kind: "upstream",
    enabledOption: "up_enabled",
    spawn() {
      return { command: process.execPath, args: ["-e", script], port: UPSTREAM_PORT };
    },
  };
}

let gateway;
let baseUrl;

async function waitForUpstream() {
  for (let i = 0; i < 50; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${UPSTREAM_PORT}/`);
      if (res.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("fake upstream never became ready");
}

before(async () => {
  const requireFromServer = createRequire(SERVER_PACKAGE);
  ({ Server } = requireFromServer("@modelcontextprotocol/sdk/server/index.js"));
  ({ CallToolRequestSchema, ListToolsRequestSchema } =
    requireFromServer("@modelcontextprotocol/sdk/types.js"));
  ({ createGateway } = await import(path.join(SERVER_SRC, "gateway.js")));
  ({ validateJsonRpcMessage } = await import(
    path.join(SERVER_SRC, "servers", "ha-native", "native-mcp.js")
  ));

  gateway = createGateway({
    config: {
      token: TOKEN,
      echo_enabled: true,
      fwd_enabled: true,
      up_enabled: true,
      brokenfwd_enabled: true,
      off_enabled: false,
    },
    modules: [echoMcpModule(), fakeForwarderModule(), fakeUpstreamModule(), {
      id: "brokenfwd",
      title: "Broken Forwarder",
      kind: "forwarder",
      enabledOption: "brokenfwd_enabled",
      createForwarder() {
        throw new Error("must not be called");
      },
    }, {
      id: "off",
      title: "Disabled",
      kind: "forwarder",
      enabledOption: "off_enabled",
      validateJsonRpcMessage,
      createForwarder() {
        throw new Error("must not be called");
      },
    }],
    env: {},
    log: () => {},
  });
  const httpServer = await gateway.start({ port: 0, host: "127.0.0.1" });
  baseUrl = `http://127.0.0.1:${httpServer.address().port}`;
  await waitForUpstream();
});

after(async () => {
  if (gateway) await gateway.stop();
});

function authed(path, init = {}) {
  return fetch(baseUrl + path, {
    ...init,
    headers: { authorization: `Bearer ${TOKEN}`, ...(init.headers || {}) },
  });
}

describe("gateway auth and routing", () => {
  it("serves /healthz without a token", async () => {
    const res = await fetch(`${baseUrl}/healthz`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.status, "ok");
    assert.equal(body.servers.echo, "running");
    assert.equal(body.servers.off, "disabled");
  });

  it("rejects missing and wrong tokens everywhere else", async () => {
    assert.equal((await fetch(baseUrl + "/")).status, 401);
    assert.equal(
      (await fetch(baseUrl + "/", { headers: { authorization: "Bearer wrong" } })).status,
      401
    );
  });

  it("lists servers on / with a valid token", async () => {
    const res = await authed("/");
    const body = await res.json();
    assert.ok(body.servers.some((s) => s.id === "echo" && s.path === "/mcp/echo"));
  });

  it("404s unknown paths and unknown servers", async () => {
    assert.equal((await authed("/nope")).status, 404);
    assert.equal((await authed("/mcp/nope")).status, 404);
  });

  it("marks a forwarder missing validateJsonRpcMessage as failed (1.0.1)", async () => {
    const res = await fetch(`${baseUrl}/healthz`);
    const body = await res.json();
    assert.equal(body.servers.brokenfwd, "failed");
    const path = await authed("/mcp/brokenfwd", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    assert.equal(path.status, 503);
  });

  it("answers 503 for a disabled server", async () => {
    const res = await authed("/mcp/off", {
      method: "POST",
      headers: { "content-type": "application/json", accept: MCP_ACCEPT },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    assert.equal(res.status, 503);
  });
});

describe("gateway mcp kind", () => {
  it("serves tools/list and tools/call statelessly", async () => {
    const list = await authed("/mcp/echo", {
      method: "POST",
      headers: { "content-type": "application/json", accept: MCP_ACCEPT },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    assert.equal(list.status, 200);
    const listBody = await list.json();
    assert.equal(listBody.result.tools[0].name, "echo");

    const call = await authed("/mcp/echo", {
      method: "POST",
      headers: { "content-type": "application/json", accept: MCP_ACCEPT },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "echo", arguments: {} },
      }),
    });
    const callBody = await call.json();
    assert.equal(callBody.result.content[0].text, "echo:echo");
  });

  it("rejects GET on a stateless server", async () => {
    assert.equal((await authed("/mcp/echo")).status, 405);
  });

  it("rejects sub-paths on a stateless server (1.0.1)", async () => {
    const res = await authed("/mcp/echo/sub", {
      method: "POST",
      headers: { "content-type": "application/json", accept: MCP_ACCEPT },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    assert.equal(res.status, 404);
  });
});

describe("gateway forwarder kind", () => {
  it("forwards well-formed requests and returns their replies", async () => {
    const res = await authed("/mcp/fwd", {
      method: "POST",
      headers: { "content-type": "application/json", accept: MCP_ACCEPT },
      body: JSON.stringify({ jsonrpc: "2.0", id: 5, method: "tools/list" }),
    });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).result.forwarded, true);
  });

  it("returns 202 for notifications and 400 for malformed input", async () => {
    const notification = await authed("/mcp/fwd", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
    });
    assert.equal(notification.status, 202);

    const badJson = await authed("/mcp/fwd", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "not json",
    });
    assert.equal(badJson.status, 400);

    const batch = await authed("/mcp/fwd", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify([{ jsonrpc: "2.0", id: 1, method: "tools/list" }]),
    });
    assert.equal(batch.status, 400);
  });

  it("rejects GET on a forwarder", async () => {
    assert.equal((await authed("/mcp/fwd")).status, 405);
  });
});

describe("gateway upstream kind", () => {
  it("streams-proxies requests to the supervised child", async () => {
    const res = await authed("/mcp/up");
    assert.equal(res.status, 200);
    assert.equal(await res.text(), `upstream-ok:/ host=localhost:${UPSTREAM_PORT}`);
  });

  it("passes sub-paths and query strings through to the child (1.0.1)", async () => {
    const res = await authed("/mcp/up/child/path?x=1");
    assert.equal(res.status, 200);
    assert.equal(await res.text(), `upstream-ok:/child/path?x=1 host=localhost:${UPSTREAM_PORT}`);
  });

  it("rewrites the Host header to the child's localhost name (1.0.2)", async () => {
    const res = await authed("/mcp/up");
    assert.match(await res.text(), new RegExp(`host=localhost:${UPSTREAM_PORT}$`));
  });
});
