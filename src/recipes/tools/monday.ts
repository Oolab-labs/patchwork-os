/**
 * Monday.com tools — read wrappers (list_boards, list_items, get_item) plus a
 * single write (create_item).
 *
 * Self-registering tool module for the recipe tool registry. The Monday
 * connector (src/connectors/monday.ts) uses a MODULE-FUNCTION pattern: it
 * exports standalone async functions rather than a class + `getMondayConnector()`
 * accessor. Each tool lazily imports the connector module and destructures the
 * specific exported function, returning the connector result verbatim via
 * JSON.stringify.
 *
 * Connector functions mirrored (see src/connectors/monday.ts):
 *   - listBoards(limit?) -> MondayBoardSummary[]
 *   - listItems(boardId, limit?, cursor?) -> MondayItemsPage ({ cursor, items })
 *   - getItem(itemId) -> MondayItemDetail | null
 *   - createItem(boardId, groupId, itemName, columnValues?) -> MondayCreatedItem ({ id, name })
 *
 * Read tools declare `isWrite: false` / `riskDefault: "low"`; create_item
 * declares `isWrite: true` / `riskDefault: "medium"` so the approval queue and
 * kill-switch gate it appropriately.
 */

import { CommonSchemas, registerTool } from "../toolRegistry.js";

// ============================================================================
// monday.list_boards
// ============================================================================

registerTool({
  id: "monday.list_boards",
  namespace: "monday",
  description:
    "List Monday.com boards the authenticated user can access (id, name, description, state, board_kind, workspace).",
  paramsSchema: {
    type: "object",
    properties: {
      limit: {
        type: "number",
        description: "Max number of boards to return (default 50)",
        default: 50,
      },
      into: CommonSchemas.into,
    },
    required: [],
  },
  outputSchema: {
    type: "array",
    items: {
      type: "object",
      properties: {
        id: { type: "string" },
        name: { type: "string" },
        description: { type: "string" },
        state: { type: "string" },
        board_kind: { type: "string" },
        workspace: {
          type: ["object", "null"],
          properties: {
            id: { type: "string" },
            name: { type: "string" },
          },
        },
      },
    },
  },
  riskDefault: "low",
  isWrite: false,
  isConnector: true,
  execute: async ({ params }) => {
    const { listBoards } = await import("../../connectors/monday.js");
    const limit = typeof params.limit === "number" ? params.limit : undefined;
    const boards = await listBoards(limit);
    return JSON.stringify(boards);
  },
});

// ============================================================================
// monday.list_items
// ============================================================================

registerTool({
  id: "monday.list_items",
  namespace: "monday",
  description:
    "List items on a Monday.com board (cursor-paginated). Returns { cursor, items } where each item has id, name, state, created_at, updated_at.",
  paramsSchema: {
    type: "object",
    properties: {
      boardId: {
        type: "string",
        description: "Monday board id to list items from",
      },
      limit: {
        type: "number",
        description: "Max number of items per page (default 50)",
        default: 50,
      },
      cursor: {
        type: "string",
        description: "Opaque pagination cursor from a previous page",
      },
      into: CommonSchemas.into,
    },
    required: ["boardId"],
  },
  outputSchema: {
    type: "object",
    properties: {
      cursor: { type: ["string", "null"] },
      items: {
        type: "array",
        items: {
          type: "object",
          properties: {
            id: { type: "string" },
            name: { type: "string" },
            state: { type: "string" },
            created_at: { type: "string" },
            updated_at: { type: "string" },
          },
        },
      },
    },
  },
  riskDefault: "low",
  isWrite: false,
  isConnector: true,
  execute: async ({ params }) => {
    const { listItems } = await import("../../connectors/monday.js");
    const limit = typeof params.limit === "number" ? params.limit : undefined;
    const cursor =
      typeof params.cursor === "string" ? params.cursor : undefined;
    const page = await listItems(params.boardId as string, limit, cursor);
    return JSON.stringify(page);
  },
});

// ============================================================================
// monday.get_item
// ============================================================================

registerTool({
  id: "monday.get_item",
  namespace: "monday",
  description:
    "Fetch a single Monday.com item by id, including board, group, column values, subitems, and updates. Returns null when the item is not found.",
  paramsSchema: {
    type: "object",
    properties: {
      itemId: {
        type: "string",
        description: "Monday item id",
      },
      into: CommonSchemas.into,
    },
    required: ["itemId"],
  },
  outputSchema: {
    type: ["object", "null"],
    properties: {
      id: { type: "string" },
      name: { type: "string" },
      state: { type: "string" },
      created_at: { type: "string" },
      updated_at: { type: "string" },
      board: {
        type: "object",
        properties: {
          id: { type: "string" },
          name: { type: "string" },
        },
      },
      group: {
        type: "object",
        properties: {
          id: { type: "string" },
          title: { type: "string" },
        },
      },
      column_values: {
        type: "array",
        items: {
          type: "object",
          properties: {
            id: { type: "string" },
            text: { type: ["string", "null"] },
            value: { type: ["string", "null"] },
            type: { type: "string" },
          },
        },
      },
      subitems: { type: "array", items: { type: "object" } },
      updates: { type: "array", items: { type: "object" } },
    },
  },
  riskDefault: "low",
  isWrite: false,
  isConnector: true,
  execute: async ({ params }) => {
    const { getItem } = await import("../../connectors/monday.js");
    const item = await getItem(params.itemId as string);
    return JSON.stringify(item);
  },
});

// ============================================================================
// monday.create_item  (write-gated)
// ============================================================================

registerTool({
  id: "monday.create_item",
  namespace: "monday",
  description:
    'Create a new item on a Monday.com board within a group. `columnValues` is an optional JSON-encoded string of column values (e.g. JSON.stringify({ status: { label: "Done" } })).',
  paramsSchema: {
    type: "object",
    properties: {
      boardId: {
        type: "string",
        description: "Monday board id to create the item on (required)",
      },
      groupId: {
        type: "string",
        description: "Monday group id within the board (required)",
      },
      itemName: {
        type: "string",
        description: "Name/title of the new item (required)",
      },
      columnValues: {
        type: "string",
        description:
          'Optional JSON-encoded string of column values (e.g. JSON.stringify({ status: { label: "Done" } }))',
      },
      into: CommonSchemas.into,
    },
    required: ["boardId", "groupId", "itemName"],
  },
  outputSchema: {
    type: "object",
    properties: {
      id: { type: "string" },
      name: { type: "string" },
    },
  },
  riskDefault: "medium",
  isWrite: true,
  isConnector: true,
  execute: async ({ params }) => {
    const { createItem } = await import("../../connectors/monday.js");
    const columnValues =
      typeof params.columnValues === "string" ? params.columnValues : undefined;
    const created = await createItem(
      params.boardId as string,
      params.groupId as string,
      params.itemName as string,
      columnValues,
    );
    return JSON.stringify(created);
  },
});
