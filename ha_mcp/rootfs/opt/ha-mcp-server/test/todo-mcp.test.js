import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const SERVER = join(dirname(fileURLToPath(import.meta.url)), "..", "index.js");
const TIMEOUT_MS = 20_000;
const children = new Set();
const serviceCalls = [];
let mockServer;
let haBaseUrl;

function haResponse(request, response) {
  const chunks = [];
  request.on("data", (chunk) => chunks.push(chunk));
  request.on("end", () => {
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : null;
    serviceCalls.push({ method: request.method, path: request.url.split("?")[0], body });
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify([body?.entity_id].filter(Boolean)));
  });
}

beforeAll(async () => {
  mockServer = createServer(haResponse);
  await new Promise((resolve) => mockServer.listen(0, "127.0.0.1", resolve));
  const { port } = mockServer.address();
  haBaseUrl = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  for (const child of children) child.kill();
  await new Promise((resolve) => mockServer.close(resolve));
});

function spawnServer(profile) {
  const child = spawn(process.execPath, [SERVER], {
    env: {
      ...process.env,
      SUPERVISOR_TOKEN: "test-token",
      HA_API_BASE_URL: haBaseUrl,
      OPENCODE_MCP_TOOL_PROFILE: profile,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  children.add(child);
  return child;
}

function readMessages(child, onMessage) {
  let buffer = "";
  child.stdout.on("data", (chunk) => {
    buffer += chunk.toString();
    let newline;
    while ((newline = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      try {
        onMessage(JSON.parse(line));
      } catch {
        /* ignore non-JSON lines */
      }
    }
  });
}

const INITIALIZE = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "vitest", version: "1" } },
});
const INITIALIZED = JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" });

function listTools(profile) {
  return new Promise((resolve, reject) => {
    const child = spawnServer(profile);
    const timeout = setTimeout(() => finish(reject, new Error("timed out waiting for tool list")), TIMEOUT_MS);
    const finish = (callback, value) => {
      clearTimeout(timeout);
      children.delete(child);
      child.kill();
      callback(value);
    };
    readMessages(child, (message) => {
      if (message.id === 1) {
        child.stdin.write(`${INITIALIZED}\n`);
        child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" })}\n`);
      } else if (message.id === 2) {
        finish(resolve, message.result.tools.map((tool) => tool.name));
      }
    });
    child.on("error", (error) => finish(reject, error));
    child.stdin.write(`${INITIALIZE}\n`);
  });
}

function callTool(toolName, args) {
  return new Promise((resolve, reject) => {
    const child = spawnServer("full");
    const timeout = setTimeout(() => finish(reject, new Error("timed out waiting for MCP response")), TIMEOUT_MS);
    const finish = (callback, value) => {
      clearTimeout(timeout);
      children.delete(child);
      child.kill();
      callback(value);
    };
    readMessages(child, (message) => {
      if (message.id === 1) {
        child.stdin.write(`${INITIALIZED}\n`);
        child.stdin.write(`${JSON.stringify({
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: { name: toolName, arguments: args },
        })}\n`);
      } else if (message.id === 2) {
        finish(resolve, message.result ?? message.error);
      }
    });
    child.on("error", (error) => finish(reject, error));
    child.stdin.write(`${INITIALIZE}\n`);
  });
}

function text(result) {
  return result.content[0].text;
}

const TODO_TOOLS = [
  "get_todo_items",
  "add_todo_item",
  "update_todo_item",
  "remove_todo_item",
  "remove_completed_todo_items",
  "move_todo_item",
];

describe("To-do MCP tools", () => {
  it("serves all six to-do tools in the full profile", async () => {
    const names = await listTools("full");
    for (const name of TODO_TOOLS) expect(names).toContain(name);
  });

  it("exposes only get_todo_items in the compact profile and rejects writes at dispatch", async () => {
    const names = await listTools("compact");
    expect(names).toContain("get_todo_items");
    expect(names).not.toContain("update_todo_item");

    const rejected = await new Promise((resolve, reject) => {
      const child = spawnServer("compact");
      const timeout = setTimeout(() => finish(reject, new Error("timed out waiting for MCP response")), TIMEOUT_MS);
      const finish = (callback, value) => {
        clearTimeout(timeout);
        children.delete(child);
        child.kill();
        callback(value);
      };
      readMessages(child, (message) => {
        if (message.id === 1) {
          child.stdin.write(`${INITIALIZED}\n`);
          child.stdin.write(`${JSON.stringify({
            jsonrpc: "2.0",
            id: 2,
            method: "tools/call",
            params: { name: "update_todo_item", arguments: { entity_id: "todo.ideas", item: "x", rename: "y" } },
          })}\n`);
        } else if (message.id === 2) {
          finish(resolve, message.result ?? message.error);
        }
      });
      child.on("error", (error) => finish(reject, error));
      child.stdin.write(`${INITIALIZE}\n`);
    });
    expect(rejected.isError).toBe(true);
    expect(text(rejected)).toContain("profile");
  });

  it("add_todo_item posts the payload to todo/add_item", async () => {
    const result = await callTool("add_todo_item", {
      entity_id: "todo.ideas",
      item: "Wire the shed",
      due_date: "2026-10-01",
    });
    expect(result.isError).not.toBe(true);
    expect(text(result)).toContain("todo.ideas");
    expect(serviceCalls.at(-1)).toEqual({
      method: "POST",
      path: "/services/todo/add_item",
      body: { entity_id: "todo.ideas", item: "Wire the shed", due_date: "2026-10-01" },
    });
  });

  it("update_todo_item forwards explicit nulls so fields can be cleared", async () => {
    const result = await callTool("update_todo_item", {
      entity_id: "todo.ideas",
      item: "uid-1",
      due_date: null,
      rename: "Wire the shed this autumn",
    });
    expect(result.isError).not.toBe(true);
    expect(serviceCalls.at(-1)).toEqual({
      method: "POST",
      path: "/services/todo/update_item",
      body: { entity_id: "todo.ideas", item: "uid-1", due_date: null, rename: "Wire the shed this autumn" },
    });
  });

  it("update_todo_item without a change field is an error and calls nothing", async () => {
    const before = serviceCalls.length;
    const result = await callTool("update_todo_item", { entity_id: "todo.ideas", item: "uid-1" });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain("at least one");
    expect(serviceCalls.length).toBe(before);
  });

  it("remove_todo_item normalizes a single item to a list", async () => {
    const result = await callTool("remove_todo_item", { entity_id: "todo.ideas", item: "uid-1" });
    expect(result.isError).not.toBe(true);
    expect(serviceCalls.at(-1)).toEqual({
      method: "POST",
      path: "/services/todo/remove_item",
      body: { entity_id: "todo.ideas", item: ["uid-1"] },
    });
  });

  it("remove_completed_todo_items posts to todo/remove_completed_items", async () => {
    const result = await callTool("remove_completed_todo_items", { entity_id: "todo.reminders" });
    expect(result.isError).not.toBe(true);
    expect(serviceCalls.at(-1)).toEqual({
      method: "POST",
      path: "/services/todo/remove_completed_items",
      body: { entity_id: "todo.reminders" },
    });
  });
});
