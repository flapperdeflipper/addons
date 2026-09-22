// VictoriaMetrics MCP server module - a fork of the prometheus-mcp-server
// 1.0.1 tool set (MIT, eagle1e6/prometheus-mcp-server), rewritten against
// plain fetch so the hub carries no axios dependency, and served statelessly
// through the hub's streamable-HTTP handler instead of stdio.
//
// Tool names, input schemas and response shapes are kept identical to the
// upstream stdio server so existing agent sessions keep working when their
// config switches from the per-session npx spawn to the hub.

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { createVictoriaMetricsClient } from "./client.js";

export const TOOLS = [
  {
    name: "prom_query",
    description: "Execute a PromQL instant query",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "PromQL query expression" },
        time: { type: "string", description: "Evaluation timestamp (optional)" },
        includes: { type: "array", items: { type: "string" }, description: "Metric properties to include in response (optional)" },
      },
      required: ["query"],
    },
  },
  {
    name: "prom_range",
    description: "Execute a PromQL range query",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "PromQL query expression" },
        start: { type: "string", description: "Start timestamp" },
        end: { type: "string", description: "End timestamp" },
        step: { type: "string", description: 'Step interval (e.g., "15s", "1m")' },
        includes: { type: "array", items: { type: "string" }, description: "Metric properties to include in response (optional)" },
      },
      required: ["query", "start", "end", "step"],
    },
  },
  {
    name: "prom_discover",
    description: "Discover all available metrics",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "prom_metadata",
    description: "Get metric metadata",
    inputSchema: {
      type: "object",
      properties: {
        metric: { type: "string", description: "Metric name (optional)" },
      },
    },
  },
  {
    name: "prom_targets",
    description: "Get scrape target information",
    inputSchema: {
      type: "object",
      properties: {
        state: { type: "string", enum: ["active", "dropped", "any"] },
      },
    },
  },
];

function isPromQueryArgs(args) {
  return typeof args === "object" && args !== null && "query" in args;
}

function isPromRangeArgs(args) {
  return typeof args === "object" && args !== null &&
    "query" in args && "start" in args && "end" in args && "step" in args;
}

function isPromMetadataArgs(args) {
  return typeof args === "object" && args !== null;
}

function isPromTargetsArgs(args) {
  return typeof args === "object" && args !== null;
}

export function createHandleToolCall(client) {
  return async function handleToolCall(request) {
    const { name, arguments: args } = request.params;
    try {
      let result;
      switch (name) {
        case "prom_query": {
          if (!isPromQueryArgs(args)) {
            throw new Error("Invalid arguments for prom_query");
          }
          const { query, time, includes } = args;
          result = await client.query(query, time, includes);
          break;
        }
        case "prom_range": {
          if (!isPromRangeArgs(args)) {
            throw new Error("Invalid arguments for prom_range");
          }
          const { query, start, end, step, includes } = args;
          result = await client.range(query, start, end, step, includes);
          break;
        }
        case "prom_discover": {
          result = await client.discover();
          break;
        }
        case "prom_metadata": {
          if (!isPromMetadataArgs(args)) {
            throw new Error("Invalid arguments for prom_metadata");
          }
          const { metric } = args;
          result = await client.metadata(metric);
          break;
        }
        case "prom_targets": {
          if (!isPromTargetsArgs(args)) {
            throw new Error("Invalid arguments for prom_targets");
          }
          const { state } = args;
          result = await client.targets(state);
          break;
        }
        default:
          throw new Error(`Unknown tool: ${name}`);
      }
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "Unknown error";
      return {
        content: [{ type: "text", text: `Error: ${errorMessage}` }],
        isError: true,
      };
    }
  };
}

export default {
  id: "victoriametrics",
  title: "VictoriaMetrics",
  kind: "mcp",
  enabledOption: "victoriametrics_enabled",

  createServer(ctx) {
    const { config, log } = ctx;
    const client = createVictoriaMetricsClient({
      baseUrl: config.victoriametrics_url,
      username: config.victoriametrics_username,
      password: config.victoriametrics_password,
      timeoutMs: 30000,
      log,
    });
    const server = new Server(
      { name: "victoriametrics", version: "1.0.0" },
      { capabilities: { tools: {} } }
    );
    const handleToolCall = createHandleToolCall(client);
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));
    server.setRequestHandler(CallToolRequestSchema, handleToolCall);
    return server;
  },
};
