// Tests for the Mealie module: tool contract, request shapes against a mocked
// Mealie API (auth header, query params, JSON/multipart bodies, slug and list
// name resolution), compact responses and error surfacing.

const assert = require("node:assert/strict");
const path = require("node:path");
const { describe, it } = require("node:test");

const SERVER_SRC = path.join(__dirname, "..", "rootfs", "opt", "mcp-hub", "src");
const indexPromise = import(path.join(SERVER_SRC, "servers", "mealie", "index.js"));
const clientPromise = import(path.join(SERVER_SRC, "servers", "mealie", "client.js"));

const RECIPE_ID = "0a1b2c3d-0000-4000-8000-000000000001";
const LIST_ID = "0a1b2c3d-0000-4000-8000-000000000002";

const FULL_RECIPE = {
  id: RECIPE_ID,
  slug: "next-level-fried-chicken",
  name: "Next level fried chicken",
  description: "Crispy",
  totalTime: "1 hour",
  recipeYield: "4 servings",
  orgURL: "https://www.example.org/fried-chicken",
  tags: [{ name: "Chicken" }],
  recipeCategory: [{ name: "Dinner" }],
  recipeIngredient: [{ display: "4 chicken thighs" }, { note: "salt" }],
  recipeInstructions: [{ text: "Brine." }, { title: "Fry", text: "Fry until golden." }],
  notes: [],
  nutrition: { calories: "900" },
};

// Routes keyed by "METHOD pathname"; every request is recorded.
function mockMealie(routes) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const u = new URL(url);
    calls.push({ method: init.method, path: u.pathname, params: Object.fromEntries(u.searchParams), init });
    const handler = routes[`${init.method} ${u.pathname}`];
    if (!handler) {
      return { ok: false, status: 404, text: async () => JSON.stringify({ detail: "not found" }) };
    }
    const payload = typeof handler === "function" ? handler(u, init) : handler;
    return { ok: true, status: 200, text: async () => JSON.stringify(payload) };
  };
  return { calls, fetchImpl };
}

describe("mealie tool contract", async () => {
  const { TOOLS } = await indexPromise;

  it("exposes the agreed tool set", () => {
    assert.deepEqual(TOOLS.map((tool) => tool.name), [
      "mealie_search_recipes",
      "mealie_get_recipe",
      "mealie_import_recipe_url",
      "mealie_import_recipe_ai",
      "mealie_mealplan_list",
      "mealie_mealplan_add",
      "mealie_shopping_lists",
      "mealie_shopping_add_items",
    ]);
  });

  it("declares required arguments", () => {
    const required = Object.fromEntries(TOOLS.map((t) => [t.name, t.inputSchema.required || []]));
    assert.deepEqual(required.mealie_get_recipe, ["recipe"]);
    assert.deepEqual(required.mealie_import_recipe_url, ["url"]);
    assert.deepEqual(required.mealie_mealplan_add, ["date"]);
    assert.deepEqual(required.mealie_shopping_add_items, ["list", "items"]);
  });
});

describe("mealie client", async () => {
  const { createMealieClient } = await clientPromise;

  it("refuses to start without a url or token", () => {
    assert.throws(() => createMealieClient({ token: "t" }), /mealie_url is required/);
    assert.throws(() => createMealieClient({ baseUrl: "http://mealie:9000" }), /mealie_token is required/);
  });

  it("sends the bearer token and search params, returns compact summaries", async () => {
    const { calls, fetchImpl } = mockMealie({
      "GET /api/recipes": { total: 1, page: 1, total_pages: 1, items: [FULL_RECIPE] },
    });
    const client = createMealieClient({ baseUrl: "http://mealie:9000/", token: "tok", fetchImpl });
    const result = await client.searchRecipes({ search: "chicken", tags: ["chicken", "fried"] });
    assert.equal(calls[0].init.headers.Authorization, "Bearer tok");
    assert.equal(calls[0].params.search, "chicken");
    assert.equal(calls[0].params.tags, "chicken,fried");
    assert.equal(calls[0].params.perPage, "20");
    assert.deepEqual(result.items[0], {
      id: RECIPE_ID,
      slug: "next-level-fried-chicken",
      name: "Next level fried chicken",
      description: "Crispy",
      totalTime: "1 hour",
      recipeYield: "4 servings",
      tags: ["Chicken"],
      categories: ["Dinner"],
    });
  });

  it("flattens a recipe to ingredient and instruction strings", async () => {
    const { fetchImpl } = mockMealie({ "GET /api/recipes/next-level-fried-chicken": FULL_RECIPE });
    const client = createMealieClient({ baseUrl: "http://mealie:9000", token: "tok", fetchImpl });
    const recipe = await client.getRecipe("next-level-fried-chicken");
    assert.deepEqual(recipe.ingredients, ["4 chicken thighs", "salt"]);
    assert.deepEqual(recipe.instructions, ["Brine.", "Fry: Fry until golden."]);
    assert.equal(recipe.sourceUrl, "https://www.example.org/fried-chicken");
    assert.equal(recipe.nutrition, undefined);
  });

  it("imports by URL and returns the created recipe", async () => {
    const { calls, fetchImpl } = mockMealie({
      "POST /api/recipes/create/url": "next-level-fried-chicken",
      "GET /api/recipes/next-level-fried-chicken": FULL_RECIPE,
    });
    const client = createMealieClient({ baseUrl: "http://mealie:9000", token: "tok", fetchImpl });
    const result = await client.importRecipeUrl({ url: "https://www.example.org/fried-chicken" });
    assert.deepEqual(JSON.parse(calls[0].init.body), { url: "https://www.example.org/fried-chicken", includeTags: true });
    assert.equal(result.slug, "next-level-fried-chicken");
    assert.equal(result.recipe.name, "Next level fried chicken");
  });

  it("sends AI imports as multipart form data", async () => {
    const { calls, fetchImpl } = mockMealie({
      "POST /api/recipes/create/ai": "next-level-fried-chicken",
      "GET /api/recipes/next-level-fried-chicken": FULL_RECIPE,
    });
    const client = createMealieClient({ baseUrl: "http://mealie:9000", token: "tok", fetchImpl });
    await client.importRecipeAi({ content: "4 chicken thighs, fry them", translateLanguage: "nl-NL" });
    const form = calls[0].init.body;
    assert.ok(form instanceof FormData);
    assert.equal(form.get("content"), "4 chicken thighs, fry them");
    assert.equal(form.get("translateLanguage"), "nl-NL");
    assert.equal(form.get("createNewOrganizers"), "false");
    assert.equal(calls[0].init.headers["Content-Type"], undefined, "fetch sets the multipart boundary itself");
    await assert.rejects(client.importRecipeAi({}), /give a url, content, or both/);
  });

  it("resolves a recipe slug to its id for meal plan entries", async () => {
    const { calls, fetchImpl } = mockMealie({
      "GET /api/recipes/next-level-fried-chicken": FULL_RECIPE,
      "POST /api/households/mealplans": (_u, init) => ({ id: 7, ...JSON.parse(init.body), recipe: FULL_RECIPE }),
    });
    const client = createMealieClient({ baseUrl: "http://mealie:9000", token: "tok", fetchImpl });
    const entry = await client.addMealplan({ date: "2026-11-23", recipe: "next-level-fried-chicken" });
    const body = JSON.parse(calls[1].init.body);
    assert.equal(body.recipeId, RECIPE_ID);
    assert.equal(body.entryType, "dinner");
    assert.deepEqual(entry.recipe, { id: RECIPE_ID, slug: "next-level-fried-chicken", name: "Next level fried chicken" });
    await assert.rejects(client.addMealplan({ date: "2026-11-23" }), /recipe .* or a title/);
  });

  it("resolves a shopping list by name and bulk-creates note items", async () => {
    const { calls, fetchImpl } = mockMealie({
      "GET /api/households/shopping/lists": { items: [{ id: LIST_ID, name: "Groceries" }] },
      "POST /api/households/shopping/items/create-bulk": { createdItems: [{}, {}] },
    });
    const client = createMealieClient({ baseUrl: "http://mealie:9000", token: "tok", fetchImpl });
    const result = await client.addShoppingItems({ list: "groceries", items: ["2 onions", "flour"] });
    assert.deepEqual(JSON.parse(calls[1].init.body), [
      { shoppingListId: LIST_ID, note: "2 onions", quantity: 0 },
      { shoppingListId: LIST_ID, note: "flour", quantity: 0 },
    ]);
    assert.deepEqual(result, { shoppingListId: LIST_ID, added: 2 });
    await assert.rejects(client.addShoppingItems({ list: "Hardware", items: ["nails"] }), /no shopping list named "Hardware" \(have: Groceries\)/);
  });

  it("returns only unchecked items of a list", async () => {
    const { fetchImpl } = mockMealie({
      [`GET /api/households/shopping/lists/${LIST_ID}`]: {
        id: LIST_ID,
        name: "Groceries",
        listItems: [
          { id: "a", display: "2 onions", checked: false },
          { id: "b", note: "flour", checked: true },
        ],
      },
    });
    const client = createMealieClient({ baseUrl: "http://mealie:9000", token: "tok", fetchImpl });
    const list = await client.shoppingLists({ list: LIST_ID });
    assert.deepEqual(list.items, [{ id: "a", text: "2 onions" }]);
  });

  it("surfaces Mealie errors with the HTTP status", async () => {
    const { fetchImpl } = mockMealie({});
    const client = createMealieClient({ baseUrl: "http://mealie:9000", token: "tok", fetchImpl });
    await assert.rejects(client.getRecipe("missing"), /Mealie GET \/api\/recipes\/missing failed with HTTP 404/);
  });
});

describe("mealie tool handler", async () => {
  const { createHandleToolCall } = await indexPromise;

  it("returns tool errors as isError results instead of throwing", async () => {
    const handle = createHandleToolCall({});
    const result = await handle({ params: { name: "mealie_get_recipe", arguments: {} } });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /recipe is required/);
  });

  it("rejects an unknown meal slot before calling Mealie", async () => {
    let called = false;
    const handle = createHandleToolCall({ addMealplan: async () => { called = true; } });
    const result = await handle({ params: { name: "mealie_mealplan_add", arguments: { date: "2026-11-23", entryType: "brunch" } } });
    assert.equal(result.isError, true);
    assert.equal(called, false);
  });
});
