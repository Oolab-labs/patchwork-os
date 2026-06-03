/**
 * Monday.com recipe-step tool tests.
 *
 * The Monday connector (src/connectors/monday.ts) uses a MODULE-FUNCTION
 * pattern — it exports standalone async functions (`listBoards`, `listItems`,
 * `getItem`, `createItem`), NOT a class + `getMondayConnector()` accessor. So
 * the mock factory exposes those functions directly as spies, and each tool's
 * `execute` destructures them from the lazy `await import(...)`.
 *
 * Each test fetches a registered tool from the recipe tool registry by id and
 * asserts:
 *   - the correct connector function is called with faithfully-mirrored args,
 *   - the JSON-stringified connector result is returned verbatim,
 *   - read/write + risk metadata is what the registry advertises.
 *
 * Read tools (list_boards/list_items/get_item) are read-only; create_item is a
 * write-gated mutation.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

// ── Connector mock ────────────────────────────────────────────────────────────
// The tool module `await import("../../connectors/monday.js")` lazily, so from
// this test file (in __tests__/) the path is THREE levels up. vi.mock is hoisted
// automatically; the factory exposes the standalone module functions as spies.

const listBoards = vi.fn();
const listItems = vi.fn();
const getItem = vi.fn();
const createItem = vi.fn();

vi.mock("../../../connectors/monday.js", () => ({
  listBoards,
  listItems,
  getItem,
  createItem,
}));

// Import AFTER the mock is declared so the self-registering module picks it up.
import "../monday.js";
import { getTool } from "../../toolRegistry.js";
import type { RunContext, StepDeps } from "../../yamlRunner.js";

/** Minimal ToolContext factory — tools only read `params`. */
function ctx(params: Record<string, unknown>) {
  return {
    params,
    step: {} as Record<string, unknown>,
    ctx: {} as RunContext,
    deps: {} as StepDeps,
  };
}

afterEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

describe("monday recipe-step tools", () => {
  describe("monday.list_boards", () => {
    it("is registered read-only / low risk / connector", () => {
      const tool = getTool("monday.list_boards");
      expect(tool).toBeDefined();
      expect(tool?.isWrite).toBe(false);
      expect(tool?.riskDefault).toBe("low");
      expect(tool?.isConnector).toBe(true);
    });

    it("calls listBoards(limit) and returns its JSON", async () => {
      const boards = [
        {
          id: "1",
          name: "Roadmap",
          description: "Q3 plan",
          state: "active",
          board_kind: "public",
          workspace: { id: "10", name: "Eng" },
        },
      ];
      listBoards.mockResolvedValue(boards);

      const tool = getTool("monday.list_boards");
      const out = await tool?.execute(ctx({ limit: 25 }));

      expect(listBoards).toHaveBeenCalledWith(25);
      expect(out).toBe(JSON.stringify(boards));
    });

    it("omits the limit arg when not supplied (connector default applies)", async () => {
      listBoards.mockResolvedValue([]);
      const tool = getTool("monday.list_boards");
      await tool?.execute(ctx({}));

      expect(listBoards).toHaveBeenCalledWith(undefined);
    });
  });

  describe("monday.list_items", () => {
    it("is registered read-only / low risk / connector", () => {
      const tool = getTool("monday.list_items");
      expect(tool?.isWrite).toBe(false);
      expect(tool?.riskDefault).toBe("low");
      expect(tool?.isConnector).toBe(true);
    });

    it("calls listItems(boardId, limit, cursor) with mirrored params and returns its JSON", async () => {
      const page = {
        cursor: "next",
        items: [
          {
            id: "5",
            name: "Item A",
            state: "active",
            created_at: "t",
            updated_at: "t",
          },
        ],
      };
      listItems.mockResolvedValue(page);

      const tool = getTool("monday.list_items");
      const out = await tool?.execute(
        ctx({ boardId: "1", limit: 100, cursor: "abc" }),
      );

      expect(listItems).toHaveBeenCalledWith("1", 100, "abc");
      expect(out).toBe(JSON.stringify(page));
    });

    it("passes undefined for omitted optional params (limit/cursor)", async () => {
      listItems.mockResolvedValue({ cursor: null, items: [] });
      const tool = getTool("monday.list_items");
      await tool?.execute(ctx({ boardId: "1" }));

      expect(listItems).toHaveBeenCalledWith("1", undefined, undefined);
    });
  });

  describe("monday.get_item", () => {
    it("is registered read-only / low risk / connector", () => {
      const tool = getTool("monday.get_item");
      expect(tool?.isWrite).toBe(false);
      expect(tool?.riskDefault).toBe("low");
      expect(tool?.isConnector).toBe(true);
    });

    it("calls getItem(itemId) and returns its JSON", async () => {
      const item = {
        id: "5",
        name: "Item A",
        state: "active",
        created_at: "t",
        updated_at: "t",
        board: { id: "1", name: "Roadmap" },
        column_values: [
          { id: "status", text: "Done", value: null, type: "color" },
        ],
      };
      getItem.mockResolvedValue(item);

      const tool = getTool("monday.get_item");
      const out = await tool?.execute(ctx({ itemId: "5" }));

      expect(getItem).toHaveBeenCalledWith("5");
      expect(out).toBe(JSON.stringify(item));
    });

    it("returns JSON null when the connector returns null", async () => {
      getItem.mockResolvedValue(null);
      const tool = getTool("monday.get_item");
      const out = await tool?.execute(ctx({ itemId: "missing" }));

      expect(getItem).toHaveBeenCalledWith("missing");
      expect(out).toBe(JSON.stringify(null));
    });
  });

  describe("monday.create_item", () => {
    it("is registered write / medium risk / connector", () => {
      const tool = getTool("monday.create_item");
      expect(tool?.isWrite).toBe(true);
      expect(tool?.riskDefault).toBe("medium");
      expect(tool?.isConnector).toBe(true);
    });

    it("calls createItem(boardId, groupId, itemName, columnValues) and returns its JSON", async () => {
      const created = { id: "99", name: "New Item" };
      createItem.mockResolvedValue(created);

      const tool = getTool("monday.create_item");
      const columnValues = JSON.stringify({ status: { label: "Done" } });
      const out = await tool?.execute(
        ctx({
          boardId: "1",
          groupId: "topics",
          itemName: "New Item",
          columnValues,
        }),
      );

      expect(createItem).toHaveBeenCalledWith(
        "1",
        "topics",
        "New Item",
        columnValues,
      );
      expect(out).toBe(JSON.stringify(created));
    });

    it("passes undefined for omitted optional columnValues", async () => {
      createItem.mockResolvedValue({ id: "100", name: "Bare" });
      const tool = getTool("monday.create_item");
      await tool?.execute(
        ctx({ boardId: "1", groupId: "topics", itemName: "Bare" }),
      );

      expect(createItem).toHaveBeenCalledWith("1", "topics", "Bare", undefined);
    });
  });
});
