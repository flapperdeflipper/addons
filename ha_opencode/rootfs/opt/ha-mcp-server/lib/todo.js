/**
 * Pure helpers for the Home Assistant to-do tools.
 *
 * Item addressing mirrors Home Assistant's own `_find_by_uid_or_summary`:
 * the `item` string in every to-do service call may be the item's uid or its
 * exact summary text. The websocket `todo/item/list` command is the read
 * path; all writes go through the `todo.*` entity services.
 */

const TODO_ITEM_FIELDS = ["uid", "summary", "status", "due", "description", "completed"];

/**
 * The websocket API serializes every TodoItem field, including nulls; drop
 * the nulls so MCP responses only carry what the list actually set.
 */
export function normalizeTodoItems(rawItems) {
  const rows = [];
  for (const raw of Array.isArray(rawItems) ? rawItems : []) {
    if (!raw || typeof raw !== "object") continue;
    const row = {};
    for (const key of TODO_ITEM_FIELDS) {
      if (raw[key] !== null && raw[key] !== undefined) row[key] = raw[key];
    }
    rows.push(row);
  }
  return rows;
}

export function findTodoItem(items, item) {
  for (const candidate of Array.isArray(items) ? items : []) {
    if (!candidate || typeof candidate !== "object") continue;
    if (item === candidate.uid || item === candidate.summary) return candidate;
  }
  return null;
}

/**
 * The websocket API reports one `due` value; the services split it into
 * `due_date` (date-only) and `due_datetime` (with a time component).
 */
export function splitDueField(due) {
  if (due === null || due === undefined || due === "") return {};
  const text = String(due);
  return text.includes("T") ? { due_datetime: text } : { due_date: text };
}

/**
 * Home Assistant has no move-item-between-lists service; the frontend moves
 * items by add-then-remove. `add_item` always creates items as
 * needs_action, so a completed source item needs a follow-up `update_item`
 * to restore its status. Removal prefers the uid when the source list
 * provided one.
 */
export function buildMovePlan(item, sourceEntityId, targetEntityId) {
  const addItem = { entity_id: targetEntityId, item: item.summary ?? "" };
  Object.assign(addItem, splitDueField(item.due));
  if (item.description) addItem.description = item.description;

  const restoreStatus = item.status === "completed"
    ? { entity_id: targetEntityId, item: item.summary ?? "", status: "completed" }
    : null;

  const removeItem = { entity_id: sourceEntityId, item: item.uid ?? item.summary ?? "" };

  return { addItem, restoreStatus, removeItem };
}
