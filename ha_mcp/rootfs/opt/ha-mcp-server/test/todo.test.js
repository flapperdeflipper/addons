import { describe, it, expect } from "vitest";

import { buildMovePlan, findTodoItem, normalizeTodoItems, splitDueField } from "../lib/todo.js";

const itemFixture = (overrides = {}) => ({
  uid: "uid-1",
  summary: "Water the plants",
  status: "needs_action",
  due: null,
  description: null,
  completed: null,
  ...overrides,
});

describe("normalizeTodoItems", () => {
  it("drops null fields and keeps set ones", () => {
    const rows = normalizeTodoItems([itemFixture({ due: "2026-09-20", description: "Use rain water" })]);
    expect(rows).toEqual([
      { uid: "uid-1", summary: "Water the plants", status: "needs_action", due: "2026-09-20", description: "Use rain water" },
    ]);
  });

  it("keeps completed timestamps and skips non-object entries", () => {
    const rows = normalizeTodoItems([null, 5, "x", itemFixture({ status: "completed", completed: "2026-09-19T17:16:38+00:00" })]);
    expect(rows).toEqual([
      { uid: "uid-1", summary: "Water the plants", status: "completed", completed: "2026-09-19T17:16:38+00:00" },
    ]);
  });

  it("returns an empty array for missing or non-list input", () => {
    expect(normalizeTodoItems(undefined)).toEqual([]);
    expect(normalizeTodoItems({})).toEqual([]);
  });
});

describe("findTodoItem", () => {
  const items = [itemFixture(), itemFixture({ uid: "uid-2", summary: "Fork padspanHA" })];

  it("matches by uid first, then summary, like Home Assistant", () => {
    expect(findTodoItem(items, "uid-2").summary).toBe("Fork padspanHA");
    expect(findTodoItem(items, "Water the plants").uid).toBe("uid-1");
  });

  it("returns null for unknown items and non-list input", () => {
    expect(findTodoItem(items, "nope")).toBeNull();
    expect(findTodoItem(null, "uid-1")).toBeNull();
  });
});

describe("splitDueField", () => {
  it("sends date-only values as due_date and datetimes as due_datetime", () => {
    expect(splitDueField("2026-09-20")).toEqual({ due_date: "2026-09-20" });
    expect(splitDueField("2026-09-20T13:30:00+02:00")).toEqual({ due_datetime: "2026-09-20T13:30:00+02:00" });
  });

  it("returns no field for absent values", () => {
    expect(splitDueField(null)).toEqual({});
    expect(splitDueField(undefined)).toEqual({});
    expect(splitDueField("")).toEqual({});
  });
});

describe("buildMovePlan", () => {
  it("moves the bare minimum and removes by summary when no uid exists", () => {
    const plan = buildMovePlan(itemFixture({ uid: null }), "todo.source", "todo.target");
    expect(plan).toEqual({
      addItem: { entity_id: "todo.target", item: "Water the plants" },
      restoreStatus: null,
      removeItem: { entity_id: "todo.source", item: "Water the plants" },
    });
  });

  it("carries due and description over and removes by uid", () => {
    const plan = buildMovePlan(
      itemFixture({ due: "2026-09-20", description: "Use rain water" }),
      "todo.source",
      "todo.target"
    );
    expect(plan.addItem).toEqual({
      entity_id: "todo.target",
      item: "Water the plants",
      due_date: "2026-09-20",
      description: "Use rain water",
    });
    expect(plan.removeItem).toEqual({ entity_id: "todo.source", item: "uid-1" });
  });

  it("splits datetime due values onto due_datetime", () => {
    const plan = buildMovePlan(itemFixture({ due: "2026-09-20T13:30:00+02:00" }), "todo.source", "todo.target");
    expect(plan.addItem.due_datetime).toBe("2026-09-20T13:30:00+02:00");
    expect(plan.addItem.due_date).toBeUndefined();
  });

  it("plans a status restore only for completed items", () => {
    const plan = buildMovePlan(itemFixture({ status: "completed" }), "todo.source", "todo.target");
    expect(plan.restoreStatus).toEqual({ entity_id: "todo.target", item: "Water the plants", status: "completed" });

    const openPlan = buildMovePlan(itemFixture(), "todo.source", "todo.target");
    expect(openPlan.restoreStatus).toBeNull();
  });
});
