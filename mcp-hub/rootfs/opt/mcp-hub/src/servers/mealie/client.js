// Mealie REST client for the MCP Hub: plain fetch, bearer API token, and
// compact response shapes so tool results stay small enough for a model's
// context (a full Mealie recipe carries nutrition, assets, settings and
// per-ingredient food/unit objects the agent rarely needs).

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function names(list) {
  return (list || []).map((entry) => entry?.name).filter(Boolean);
}

function compactRecipeSummary(recipe) {
  return {
    id: recipe.id,
    slug: recipe.slug,
    name: recipe.name,
    description: recipe.description || "",
    totalTime: recipe.totalTime || null,
    recipeYield: recipe.recipeYield || null,
    tags: names(recipe.tags),
    categories: names(recipe.recipeCategory),
  };
}

function compactRecipe(recipe) {
  return {
    ...compactRecipeSummary(recipe),
    prepTime: recipe.prepTime || null,
    performTime: recipe.performTime || null,
    sourceUrl: recipe.orgURL || null,
    ingredients: (recipe.recipeIngredient || []).map(
      (ingredient) => ingredient.display || ingredient.note || ingredient.originalText || ""
    ),
    instructions: (recipe.recipeInstructions || []).map((step) =>
      step.title ? `${step.title}: ${step.text}` : step.text
    ),
    notes: (recipe.notes || []).map((note) => (note.title ? `${note.title}: ${note.text}` : note.text)),
  };
}

function compactPlanEntry(entry) {
  return {
    id: entry.id,
    date: entry.date,
    entryType: entry.entryType,
    title: entry.title || "",
    text: entry.text || "",
    recipe: entry.recipe ? { id: entry.recipe.id, slug: entry.recipe.slug, name: entry.recipe.name } : null,
  };
}

export function createMealieClient({ baseUrl, token, timeoutMs = 30000, fetchImpl = fetch } = {}) {
  if (!baseUrl) {
    throw new Error("mealie_url is required (the Mealie add-on's API, e.g. http://<slug>:9000)");
  }
  if (!token) {
    throw new Error("mealie_token is required (an API token from Mealie's user profile)");
  }
  const base = String(baseUrl).replace(/\/+$/, "");

  async function request(method, path, { params, json, form, timeout } = {}) {
    const url = new URL(base + path);
    for (const [key, value] of Object.entries(params || {})) {
      if (value !== undefined && value !== null && value !== "") {
        url.searchParams.set(key, String(value));
      }
    }
    const headers = { Accept: "application/json", Authorization: `Bearer ${token}` };
    let body;
    if (json !== undefined) {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(json);
    } else if (form) {
      body = form;
    }
    const response = await fetchImpl(url, {
      method,
      headers,
      body,
      signal: AbortSignal.timeout(timeout || timeoutMs),
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`Mealie ${method} ${path} failed with HTTP ${response.status}: ${text.slice(0, 300)}`);
    }
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch {
      throw new Error(`Mealie ${method} ${path} returned a non-JSON response: ${text.slice(0, 200)}`);
    }
  }

  async function recipeId(recipe) {
    if (UUID.test(recipe)) return recipe;
    const found = await request("GET", `/api/recipes/${encodeURIComponent(recipe)}`);
    return found.id;
  }

  async function shoppingListId(list) {
    if (UUID.test(list)) return list;
    const lists = await request("GET", "/api/households/shopping/lists", { params: { perPage: 100 } });
    const match = (lists.items || []).find((entry) => entry.name.toLowerCase() === String(list).toLowerCase());
    if (!match) {
      throw new Error(`no shopping list named "${list}" (have: ${names(lists.items).join(", ") || "none"})`);
    }
    return match.id;
  }

  return {
    async searchRecipes({ search, tags, categories, page = 1, perPage = 20 } = {}) {
      const data = await request("GET", "/api/recipes", {
        params: {
          search,
          tags: tags?.length ? tags.join(",") : undefined,
          categories: categories?.length ? categories.join(",") : undefined,
          page,
          perPage,
          orderBy: search ? undefined : "name",
          orderDirection: search ? undefined : "asc",
        },
      });
      return {
        total: data.total,
        page: data.page,
        totalPages: data.total_pages,
        items: (data.items || []).map(compactRecipeSummary),
      };
    },

    async getRecipe(recipe) {
      return compactRecipe(await request("GET", `/api/recipes/${encodeURIComponent(recipe)}`));
    },

    async importRecipeUrl({ url, includeTags = true }) {
      // The scraper fetches the page and, when it has no structured recipe
      // data, hands it to the configured AI provider; allow it time.
      const slug = await request("POST", "/api/recipes/create/url", {
        json: { url, includeTags },
        timeout: 180000,
      });
      return { slug, recipe: compactRecipe(await request("GET", `/api/recipes/${encodeURIComponent(slug)}`)) };
    },

    async importRecipeAi({ url, content, translateLanguage, createNewOrganizers = false }) {
      if (!url && !content) {
        throw new Error("give a url, content, or both");
      }
      const form = new FormData();
      if (url) form.set("url", url);
      if (content) form.set("content", content);
      if (translateLanguage) form.set("translateLanguage", translateLanguage);
      form.set("createNewOrganizers", String(Boolean(createNewOrganizers)));
      const slug = await request("POST", "/api/recipes/create/ai", { form, timeout: 300000 });
      return { slug, recipe: compactRecipe(await request("GET", `/api/recipes/${encodeURIComponent(slug)}`)) };
    },

    async listMealplans({ startDate, endDate } = {}) {
      const data = await request("GET", "/api/households/mealplans", {
        params: { start_date: startDate, end_date: endDate, perPage: 200, orderBy: "date", orderDirection: "asc" },
      });
      return (data.items || []).map(compactPlanEntry);
    },

    async addMealplan({ date, entryType = "dinner", recipe, title, text }) {
      if (!recipe && !title) {
        throw new Error("give a recipe (slug or id) or a title for a note entry");
      }
      const entry = { date, entryType, title: title || "", text: text || "" };
      if (recipe) entry.recipeId = await recipeId(recipe);
      return compactPlanEntry(await request("POST", "/api/households/mealplans", { json: entry }));
    },

    async shoppingLists({ list } = {}) {
      if (!list) {
        const data = await request("GET", "/api/households/shopping/lists", { params: { perPage: 100 } });
        return (data.items || []).map((entry) => ({ id: entry.id, name: entry.name }));
      }
      const id = await shoppingListId(list);
      const data = await request("GET", `/api/households/shopping/lists/${id}`);
      return {
        id: data.id,
        name: data.name,
        items: (data.listItems || [])
          .filter((item) => !item.checked)
          .map((item) => ({ id: item.id, text: item.display || item.note || "" })),
      };
    },

    async addShoppingItems({ list, items }) {
      if (!Array.isArray(items) || items.length === 0) {
        throw new Error("items must be a non-empty list of strings");
      }
      const id = await shoppingListId(list);
      // quantity 0: the note carries any amount; Mealie defaults to 1 and would
      // display "1 2 onions".
      const payload = items.map((note) => ({ shoppingListId: id, note: String(note), quantity: 0 }));
      const data = await request("POST", "/api/households/shopping/items/create-bulk", { json: payload });
      const created = data?.createdItems || [];
      return { shoppingListId: id, added: created.length || items.length };
    },
  };
}
