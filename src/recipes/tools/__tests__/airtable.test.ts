/**
 * Airtable recipe-step tool tests.
 *
 * Mocks the airtable connector module so each tool's `execute` can be driven
 * without network access, then fetches each registered tool from the recipe
 * tool registry by id and asserts:
 *   - the correct connector method is called with faithfully-mirrored args,
 *   - the JSON-stringified connector result is returned verbatim,
 *   - read/write + risk metadata is what the registry advertises.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

// ── Connector mock ────────────────────────────────────────────────────────────
// The tool modules `await import("../../connectors/airtable.js")` lazily, so the
// mock must be hoisted (vi.mock is hoisted automatically) and expose
// getAirtableConnector returning an object of spies.

const listRecords = vi.fn();
const getRecord = vi.fn();
const createRecord = vi.fn();
const listBases = vi.fn();

vi.mock("../../../connectors/airtable.js", () => ({
  getAirtableConnector: () => ({
    listRecords,
    getRecord,
    createRecord,
    listBases,
  }),
}));

// Import AFTER the mock is declared so the self-registering module picks it up.
import "../airtable.js";
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

describe("airtable recipe-step tools", () => {
  describe("airtable.list_records", () => {
    it("is registered read-only / low risk", () => {
      const tool = getTool("airtable.list_records");
      expect(tool).toBeDefined();
      expect(tool?.isWrite).toBe(false);
      expect(tool?.riskDefault).toBe("low");
      expect(tool?.isConnector).toBe(true);
    });

    it("calls listRecords(baseId, table, params) and returns its JSON", async () => {
      const result = {
        records: [{ id: "rec1", createdTime: "t", fields: {} }],
      };
      listRecords.mockResolvedValue(result);

      const tool = getTool("airtable.list_records");
      const out = await tool?.execute(
        ctx({
          baseId: "appABC",
          tableIdOrName: "Tasks",
          filterByFormula: "{Done}=0",
          view: "Grid",
          maxRecords: 50,
          pageSize: 25,
          fields: ["Name", "Status"],
          sort: [{ field: "Name", direction: "asc" }],
        }),
      );

      expect(listRecords).toHaveBeenCalledWith("appABC", "Tasks", {
        filterByFormula: "{Done}=0",
        view: "Grid",
        maxRecords: 50,
        pageSize: 25,
        fields: ["Name", "Status"],
        sort: [{ field: "Name", direction: "asc" }],
      });
      expect(out).toBe(JSON.stringify(result));
    });

    it("passes undefined for omitted optional params", async () => {
      listRecords.mockResolvedValue({ records: [] });
      const tool = getTool("airtable.list_records");
      await tool?.execute(ctx({ baseId: "appABC", tableIdOrName: "Tasks" }));

      expect(listRecords).toHaveBeenCalledWith("appABC", "Tasks", {
        filterByFormula: undefined,
        view: undefined,
        maxRecords: undefined,
        pageSize: undefined,
        fields: undefined,
        sort: undefined,
      });
    });
  });

  describe("airtable.get_record", () => {
    it("is registered read-only / low risk", () => {
      const tool = getTool("airtable.get_record");
      expect(tool?.isWrite).toBe(false);
      expect(tool?.riskDefault).toBe("low");
    });

    it("calls getRecord(baseId, table, recordId) and returns its JSON", async () => {
      const record = { id: "rec1", createdTime: "t", fields: { Name: "x" } };
      getRecord.mockResolvedValue(record);

      const tool = getTool("airtable.get_record");
      const out = await tool?.execute(
        ctx({ baseId: "appABC", tableIdOrName: "Tasks", recordId: "rec1" }),
      );

      expect(getRecord).toHaveBeenCalledWith("appABC", "Tasks", "rec1");
      expect(out).toBe(JSON.stringify(record));
    });
  });

  describe("airtable.create_record", () => {
    it("is registered as a write / medium risk tool", () => {
      const tool = getTool("airtable.create_record");
      expect(tool).toBeDefined();
      expect(tool?.isWrite).toBe(true);
      expect(tool?.riskDefault).toBe("medium");
      expect(tool?.isConnector).toBe(true);
    });

    it("calls createRecord(baseId, table, fields) and returns its JSON", async () => {
      const created = {
        id: "recNew",
        createdTime: "t",
        fields: { Name: "New" },
      };
      createRecord.mockResolvedValue(created);

      const tool = getTool("airtable.create_record");
      const out = await tool?.execute(
        ctx({
          baseId: "appABC",
          tableIdOrName: "Tasks",
          fields: { Name: "New" },
        }),
      );

      expect(createRecord).toHaveBeenCalledWith("appABC", "Tasks", {
        Name: "New",
      });
      expect(out).toBe(JSON.stringify(created));
    });

    it("defaults to empty fields object when fields is absent", async () => {
      createRecord.mockResolvedValue({ id: "r", createdTime: "t", fields: {} });
      const tool = getTool("airtable.create_record");
      await tool?.execute(ctx({ baseId: "appABC", tableIdOrName: "Tasks" }));

      expect(createRecord).toHaveBeenCalledWith("appABC", "Tasks", {});
    });
  });

  describe("airtable.list_bases", () => {
    it("is registered read-only / low risk", () => {
      const tool = getTool("airtable.list_bases");
      expect(tool?.isWrite).toBe(false);
      expect(tool?.riskDefault).toBe("low");
    });

    it("calls listBases() with no args and returns its JSON", async () => {
      const bases = { bases: [{ id: "appABC", name: "My Base" }] };
      listBases.mockResolvedValue(bases);

      const tool = getTool("airtable.list_bases");
      const out = await tool?.execute(ctx({}));

      expect(listBases).toHaveBeenCalledWith();
      expect(out).toBe(JSON.stringify(bases));
    });
  });
});
