// LiteLLM Memory MCP server module - the proxy's /v1/memory key-value store
// as stateless MCP tools, so every hub client gets the same cross-session
// memory without a stdio child or a dedicated per-session process.
//
// Search-first by design (the 2026-09-23 memory analysis showed pull-based
// recall by exact key was the weak link): memory_search ranks by keyword and
// tag relevance with snippets instead of full values, memory_tags is the
// cheap topic digest. Scoring mirrors the Python litellm_mcp package
// (litellm add-on, /mcp_servers/litellm_mcp/tools/memory.py) - keep the two
// in sync: exact key-segment match (+6) > exact tag (+5) > substring tag
// (+2) > substring in value (+2); substring KEY matches are deliberately
// absent ("not" inside "note" is noise, not recall).

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { createMemoryClient } from "./client.js";

const VALUE_LIMIT = 4000;
const LIST_VALUE_LIMIT = 160;
const LIST_ENTRY_LIMIT = 100;
const SNIPPET_LIMIT = 160;
const SNIPPET_RADIUS = 70;
const SEARCH_LIMIT_MAX = 25;

export const TOOLS = [
  {
    name: "memory_search",
    description:
      "Search cross-session memories by keywords and/or tag; returns ranked matches with snippets, not full values. " +
      "Scoring favors key matches, then tags, then value text. Call this before substantial tasks instead of guessing exact keys; " +
      "memory_tags lists the tag vocabulary first. memory_get(key) fetches a full entry.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Free keywords; split on non-alphanumerics" },
        tag: { type: "string", description: "Exact tag filter (combined with query when both given)" },
        limit: { type: "number", description: "Max matches to return (default 10, cap 25)" },
      },
    },
  },
  {
    name: "memory_tags",
    description:
      "Tag vocabulary digest: every tag in use with count and sample keys, plus entry/untagged totals. The cheap what-exists call before memory_search.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "memory_get",
    description: "Read one memory entry by its exact key (key, value, tags, metadata, updated_at).",
    inputSchema: {
      type: "object",
      properties: { key: { type: "string" } },
      required: ["key"],
    },
  },
  {
    name: "memory_set",
    description:
      "Create or update (upsert) a memory entry; overwrites the value. One fact per key - the key name should name the fact. " +
      "tags: comma/space-separated labels for search. Omitting tags on an update keeps the existing ones.",
    inputSchema: {
      type: "object",
      properties: {
        key: { type: "string" },
        value: { type: "string" },
        tags: { type: "string", description: "e.g. 'esphome, mqtt'" },
      },
      required: ["key", "value"],
    },
  },
  {
    name: "memory_list",
    description: "List memory entries, optionally filtered by key prefix. Values truncated; memory_get for full content.",
    inputSchema: {
      type: "object",
      properties: { key_prefix: { type: "string" } },
    },
  },
  {
    name: "memory_delete",
    description: "Delete one memory entry by its exact key. Irreversible.",
    inputSchema: {
      type: "object",
      properties: { key: { type: "string" } },
      required: ["key"],
    },
  },
];

function truncate(text, limit) {
  return text.length <= limit ? text : text.slice(0, limit - 1) + "…[truncated]";
}

function tagsOf(entry) {
  const raw = entry?.metadata?.tags;
  const list = typeof raw === "string" ? raw.split(/[,\s]+/) : Array.isArray(raw) ? raw : [];
  return list.filter((t) => typeof t === "string" && t.trim() !== "").map((t) => t.trim().toLowerCase());
}

function parseTags(tags) {
  if (typeof tags !== "string" || tags.trim() === "") return [];
  return tags.trim().toLowerCase().split(/[,\s]+/).filter(Boolean);
}

function termsOf(query) {
  return String(query ?? "").toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length >= 2);
}

function scoreEntry(entry, terms) {
  const key = String(entry.key ?? "").toLowerCase();
  const value = String(entry.value ?? "").toLowerCase();
  const segments = new Set(key.split(/[:/_-]+/).filter(Boolean));
  const tags = tagsOf(entry);
  let score = 0;
  for (const term of terms) {
    if (segments.has(term)) score += 6;
    for (const tag of tags) {
      if (term === tag) score += 5;
      else if (tag.includes(term)) score += 2;
    }
    if (value.includes(term)) score += 2;
  }
  return score;
}

function snippetOf(value, terms, limit = SNIPPET_LIMIT) {
  const text = String(value ?? "").split(/\s+/).join(" ");
  const low = text.toLowerCase();
  let pos = -1;
  for (const term of terms) {
    const i = low.indexOf(term);
    if (i >= 0 && (pos < 0 || i < pos)) pos = i;
  }
  if (pos < 0) return truncate(text, limit);
  const start = Math.max(0, pos - SNIPPET_RADIUS);
  const end = Math.min(text.length, start + limit);
  return (start > 0 ? "…" : "") + text.slice(start, end) + (end < text.length ? "…" : "");
}

function textResult(payload) {
  return { content: [{ type: "text", text: JSON.stringify(payload) }] };
}

export function createHandleToolCall(client) {
  return async function handleToolCall(request) {
    const { name, arguments: args = {} } = request.params;
    try {
      switch (name) {
        case "memory_search": {
          const query = String(args.query ?? "");
          const wantTag = String(args.tag ?? "").trim().toLowerCase();
          if (!query && !wantTag) throw new Error("provide a query and/or tag");
          const body = await client.list();
          const entries = body.memories ?? [];
          const terms = termsOf(query);
          const matches = [];
          for (const entry of entries) {
            const tags = tagsOf(entry);
            if (wantTag && !tags.includes(wantTag)) continue;
            const score = scoreEntry(entry, terms);
            if (terms.length > 0 && score <= 0) continue;
            matches.push({ score, entry, tags });
          }
          matches.sort((a, b) => b.score - a.score || String(a.entry.key).localeCompare(String(b.entry.key)));
          const limitRaw = Number(args.limit);
          const limit = Number.isFinite(limitRaw) && limitRaw >= 1 ? Math.min(Math.trunc(limitRaw), SEARCH_LIMIT_MAX) : 10;
          const shown = matches.slice(0, limit).map(({ score, entry, tags }) => {
            const hit = { key: entry.key, tags, updated_at: entry.updated_at };
            if (terms.length > 0) hit.score = score;
            hit.snippet = snippetOf(entry.value, terms);
            return hit;
          });
          return textResult({
            query: query || null,
            tag: wantTag || null,
            matches: shown,
            shown: shown.length,
            candidates: matches.length,
            scanned: entries.length,
          });
        }
        case "memory_tags": {
          const body = await client.list();
          const entries = body.memories ?? [];
          const byTag = new Map();
          let untagged = 0;
          for (const entry of entries) {
            const tags = tagsOf(entry);
            if (tags.length === 0) untagged += 1;
            for (const tag of tags) {
              const info = byTag.get(tag) ?? { count: 0, keys: [] };
              info.count += 1;
              if (info.keys.length < 3) info.keys.push(entry.key);
              byTag.set(tag, info);
            }
          }
          const tags = [...byTag.entries()]
            .sort((a, b) => b[1].count - a[1].count || a[0].localeCompare(b[0]))
            .map(([tag, info]) => ({ tag, count: info.count, keys: info.keys }));
          return textResult({ tags, tag_kinds: tags.length, entries: entries.length, untagged });
        }
        case "memory_get": {
          const key = String(args.key ?? "").trim();
          if (!key) throw new Error("key must not be empty");
          let body;
          try {
            body = await client.get(key);
          } catch (error) {
            if (error?.status === 404) return textResult(`not found: ${key}`);
            throw error;
          }
          return textResult({
            key: body.key ?? key,
            value: truncate(String(body.value ?? ""), VALUE_LIMIT),
            tags: tagsOf(body),
            metadata: body.metadata ?? null,
            updated_at: body.updated_at,
          });
        }
        case "memory_set": {
          const key = String(args.key ?? "").trim();
          if (!key) throw new Error("key must not be empty");
          const tags = parseTags(args.tags);
          const body = await client.set(key, String(args.value ?? ""), tags.length ? { tags } : undefined);
          return textResult({ ok: true, key, tags, updated_at: body.updated_at });
        }
        case "memory_list": {
          const body = await client.list(String(args.key_prefix ?? ""));
          const entries = body.memories ?? [];
          const total = body.total ?? entries.length;
          const shown = entries.slice(0, LIST_ENTRY_LIMIT).map((entry) => ({
            key: entry.key,
            value: truncate(String(entry.value ?? ""), LIST_VALUE_LIMIT),
            tags: tagsOf(entry),
            updated_at: entry.updated_at,
          }));
          const payload = { entries: shown, shown: shown.length, total };
          let text = JSON.stringify(payload);
          if (entries.length > LIST_ENTRY_LIMIT) text += ` [truncated at ${LIST_ENTRY_LIMIT} entries]`;
          return { content: [{ type: "text", text }] };
        }
        case "memory_delete": {
          const key = String(args.key ?? "").trim();
          if (!key) throw new Error("key must not be empty");
          try {
            await client.delete(key);
          } catch (error) {
            if (error?.status === 404) return textResult(`not found: ${key}`);
            throw error;
          }
          return textResult(`deleted: ${key}`);
        }
        default:
          throw new Error(`Unknown tool: ${name}`);
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "Unknown error";
      return { content: [{ type: "text", text: `Error: ${errorMessage}` }], isError: true };
    }
  };
}

export default {
  id: "memory",
  title: "LiteLLM Memory",
  kind: "mcp",
  enabledOption: "memory_enabled",

  createServer(ctx) {
    const { config } = ctx;
    const client = createMemoryClient({
      baseUrl: config.memory_proxy_url,
      apiKey: config.memory_api_key,
      timeoutMs: 30000,
    });
    const server = new Server(
      { name: "litellm-memory", version: "1.0.0" },
      { capabilities: { tools: {} } }
    );
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));
    server.setRequestHandler(CallToolRequestSchema, createHandleToolCall(client));
    return server;
  },
};
