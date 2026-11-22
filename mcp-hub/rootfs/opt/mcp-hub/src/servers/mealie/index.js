// Mealie MCP server module: recipes, meal plans and shopping lists from the
// Mealie add-on, through its REST API with a dedicated API token. Written for
// the hub (no community server is a Node in-process fit); tools return the
// compact shapes from client.js.

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { createMealieClient } from "./client.js";

const ENTRY_TYPES = ["breakfast", "lunch", "dinner", "side", "snack", "drink", "dessert"];

export const TOOLS = [
  {
    name: "mealie_search_recipes",
    description: "Search the recipe collection by text, tags or categories. Returns compact summaries (slug, name, description, times, tags).",
    inputSchema: {
      type: "object",
      properties: {
        search: { type: "string", description: "Free-text search over names, descriptions and ingredients" },
        tags: { type: "array", items: { type: "string" }, description: "Tag slugs or ids; recipes must have any of them" },
        categories: { type: "array", items: { type: "string" }, description: "Category slugs or ids" },
        page: { type: "integer", minimum: 1, description: "Page number (default 1)" },
        perPage: { type: "integer", minimum: 1, maximum: 100, description: "Results per page (default 20)" },
      },
    },
  },
  {
    name: "mealie_get_recipe",
    description: "Get one recipe with its ingredients, instructions and notes.",
    inputSchema: {
      type: "object",
      properties: {
        recipe: { type: "string", description: "Recipe slug or id" },
      },
      required: ["recipe"],
    },
  },
  {
    name: "mealie_import_recipe_url",
    description: "Import a recipe from a web page with Mealie's scraper. Pages without structured recipe data fall back to the AI provider configured in Mealie.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "Recipe page URL" },
        includeTags: { type: "boolean", description: "Keep the page's keywords as tags (default true)" },
      },
      required: ["url"],
    },
  },
  {
    name: "mealie_import_recipe_ai",
    description: "Create a recipe with Mealie's AI import from a URL, pasted text/HTML, or both (content adds to and overrides the URL). Needs an AI provider in Mealie's group settings.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "Page or video URL (optional if content is given)" },
        content: { type: "string", description: "Recipe text, HTML or schema.org JSON, or notes that refine the URL import" },
        translateLanguage: { type: "string", description: "Translate the recipe into this language (e.g. 'nl-NL'); omit to keep the source language" },
        createNewOrganizers: { type: "boolean", description: "Create tags/categories/tools that do not exist yet (default false)" },
      },
    },
  },
  {
    name: "mealie_mealplan_list",
    description: "List meal plan entries in a date range (YYYY-MM-DD). Omit both dates for upcoming entries.",
    inputSchema: {
      type: "object",
      properties: {
        startDate: { type: "string", description: "First day, YYYY-MM-DD" },
        endDate: { type: "string", description: "Last day, YYYY-MM-DD" },
      },
    },
  },
  {
    name: "mealie_mealplan_add",
    description: "Add a meal plan entry: a recipe, or a free-text note when no recipe fits.",
    inputSchema: {
      type: "object",
      properties: {
        date: { type: "string", description: "Day, YYYY-MM-DD" },
        entryType: { type: "string", enum: ENTRY_TYPES, description: "Meal slot (default dinner)" },
        recipe: { type: "string", description: "Recipe slug or id" },
        title: { type: "string", description: "Title for a note entry without a recipe" },
        text: { type: "string", description: "Extra note text" },
      },
      required: ["date"],
    },
  },
  {
    name: "mealie_shopping_lists",
    description: "List shopping lists, or with `list` the unchecked items of one list.",
    inputSchema: {
      type: "object",
      properties: {
        list: { type: "string", description: "Shopping list name or id (optional)" },
      },
    },
  },
  {
    name: "mealie_shopping_add_items",
    description: "Add free-text items (e.g. '2 onions') to a shopping list.",
    inputSchema: {
      type: "object",
      properties: {
        list: { type: "string", description: "Shopping list name or id" },
        items: { type: "array", items: { type: "string" }, minItems: 1, description: "Items to add" },
      },
      required: ["list", "items"],
    },
  },
];

function requireString(args, key) {
  const value = args?.[key];
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${key} is required`);
  }
  return value.trim();
}

export function createHandleToolCall(client) {
  return async function handleToolCall(request) {
    const { name, arguments: rawArgs } = request.params;
    const args = rawArgs || {};
    try {
      let result;
      switch (name) {
        case "mealie_search_recipes":
          result = await client.searchRecipes(args);
          break;
        case "mealie_get_recipe":
          result = await client.getRecipe(requireString(args, "recipe"));
          break;
        case "mealie_import_recipe_url":
          result = await client.importRecipeUrl({ url: requireString(args, "url"), includeTags: args.includeTags });
          break;
        case "mealie_import_recipe_ai":
          result = await client.importRecipeAi(args);
          break;
        case "mealie_mealplan_list":
          result = await client.listMealplans(args);
          break;
        case "mealie_mealplan_add":
          if (args.entryType && !ENTRY_TYPES.includes(args.entryType)) {
            throw new Error(`entryType must be one of ${ENTRY_TYPES.join(", ")}`);
          }
          result = await client.addMealplan({ ...args, date: requireString(args, "date") });
          break;
        case "mealie_shopping_lists":
          result = await client.shoppingLists(args);
          break;
        case "mealie_shopping_add_items":
          result = await client.addShoppingItems({ list: requireString(args, "list"), items: args.items });
          break;
        default:
          throw new Error(`Unknown tool: ${name}`);
      }
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      return { content: [{ type: "text", text: `Error: ${message}` }], isError: true };
    }
  };
}

export default {
  id: "mealie",
  title: "Mealie (recipes, meal plans, shopping lists)",
  kind: "mcp",
  enabledOption: "mealie_enabled",

  createServer(ctx) {
    const { config } = ctx;
    const client = createMealieClient({ baseUrl: config.mealie_url, token: config.mealie_token });
    const server = new Server({ name: "mealie", version: "1.0.0" }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));
    server.setRequestHandler(CallToolRequestSchema, createHandleToolCall(client));
    return server;
  },
};
