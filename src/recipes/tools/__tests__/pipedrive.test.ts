/**
 * Pipedrive recipe-step tool tests.
 *
 * Mocks the pipedrive connector module so each tool's `execute` can be driven
 * without network access, then fetches each registered tool from the recipe
 * tool registry by id and asserts:
 *   - the correct connector method is called with faithfully-mirrored args,
 *   - the JSON-stringified connector result is returned verbatim,
 *   - read/write + risk metadata is what the registry advertises.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

// ── Connector mock ────────────────────────────────────────────────────────────
// The tool module `await import("../../connectors/pipedrive.js")` lazily, so the
// mock must be hoisted (vi.mock is hoisted automatically) and expose
// getPipedriveConnector returning an object of spies. Path is THREE levels up
// from this test file to land on src/connectors/pipedrive.js.

const getDeals = vi.fn();
const createDeal = vi.fn();
const getPersons = vi.fn();
const getPipelines = vi.fn();

vi.mock("../../../connectors/pipedrive.js", () => ({
  getPipedriveConnector: () => ({
    getDeals,
    createDeal,
    getPersons,
    getPipelines,
  }),
}));

// Import AFTER the mock is declared so the self-registering module picks it up.
import "../pipedrive.js";
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

describe("pipedrive recipe-step tools", () => {
  describe("pipedrive.list_deals", () => {
    it("is registered read-only / low risk", () => {
      const tool = getTool("pipedrive.list_deals");
      expect(tool).toBeDefined();
      expect(tool?.isWrite).toBe(false);
      expect(tool?.riskDefault).toBe("low");
      expect(tool?.isConnector).toBe(true);
    });

    it("calls getDeals(params) with mirrored args and returns its JSON", async () => {
      const deals = [{ id: 1, title: "Deal A" }];
      getDeals.mockResolvedValue(deals);

      const tool = getTool("pipedrive.list_deals");
      const out = await tool?.execute(
        ctx({ status: "open", start: 10, limit: 25 }),
      );

      expect(getDeals).toHaveBeenCalledWith({
        status: "open",
        start: 10,
        limit: 25,
      });
      expect(out).toBe(JSON.stringify(deals));
    });

    it("passes undefined for omitted optional params", async () => {
      getDeals.mockResolvedValue([]);
      const tool = getTool("pipedrive.list_deals");
      await tool?.execute(ctx({}));

      expect(getDeals).toHaveBeenCalledWith({
        status: undefined,
        start: undefined,
        limit: undefined,
      });
    });
  });

  describe("pipedrive.create_deal", () => {
    it("is registered as a write / medium risk tool", () => {
      const tool = getTool("pipedrive.create_deal");
      expect(tool).toBeDefined();
      expect(tool?.isWrite).toBe(true);
      expect(tool?.riskDefault).toBe("medium");
      expect(tool?.isConnector).toBe(true);
    });

    it("calls createDeal(params) with mirrored args and returns its JSON", async () => {
      const created = { id: 99, title: "New Deal" };
      createDeal.mockResolvedValue(created);

      const tool = getTool("pipedrive.create_deal");
      const out = await tool?.execute(
        ctx({
          title: "New Deal",
          value: 5000,
          currency: "USD",
          stageId: 3,
          personId: 7,
          orgId: 11,
          status: "open",
          expectedCloseDate: "2026-07-01",
        }),
      );

      expect(createDeal).toHaveBeenCalledWith({
        title: "New Deal",
        value: 5000,
        currency: "USD",
        stageId: 3,
        personId: 7,
        orgId: 11,
        status: "open",
        expectedCloseDate: "2026-07-01",
      });
      expect(out).toBe(JSON.stringify(created));
    });

    it("passes only title when optional params are omitted", async () => {
      createDeal.mockResolvedValue({ id: 1, title: "Bare" });
      const tool = getTool("pipedrive.create_deal");
      await tool?.execute(ctx({ title: "Bare" }));

      expect(createDeal).toHaveBeenCalledWith({
        title: "Bare",
        value: undefined,
        currency: undefined,
        stageId: undefined,
        personId: undefined,
        orgId: undefined,
        status: undefined,
        expectedCloseDate: undefined,
      });
    });
  });

  describe("pipedrive.list_persons", () => {
    it("is registered read-only / low risk", () => {
      const tool = getTool("pipedrive.list_persons");
      expect(tool?.isWrite).toBe(false);
      expect(tool?.riskDefault).toBe("low");
      expect(tool?.isConnector).toBe(true);
    });

    it("calls getPersons(params) with mirrored args and returns its JSON", async () => {
      const persons = [{ id: 5, name: "Ada" }];
      getPersons.mockResolvedValue(persons);

      const tool = getTool("pipedrive.list_persons");
      const out = await tool?.execute(ctx({ start: 20, limit: 50 }));

      expect(getPersons).toHaveBeenCalledWith({ start: 20, limit: 50 });
      expect(out).toBe(JSON.stringify(persons));
    });

    it("passes undefined for omitted optional params", async () => {
      getPersons.mockResolvedValue([]);
      const tool = getTool("pipedrive.list_persons");
      await tool?.execute(ctx({}));

      expect(getPersons).toHaveBeenCalledWith({
        start: undefined,
        limit: undefined,
      });
    });
  });

  describe("pipedrive.list_pipelines", () => {
    it("is registered read-only / low risk", () => {
      const tool = getTool("pipedrive.list_pipelines");
      expect(tool?.isWrite).toBe(false);
      expect(tool?.riskDefault).toBe("low");
      expect(tool?.isConnector).toBe(true);
    });

    it("calls getPipelines() with no args and returns its JSON", async () => {
      const pipelines = [{ id: 1, name: "Sales" }];
      getPipelines.mockResolvedValue(pipelines);

      const tool = getTool("pipedrive.list_pipelines");
      const out = await tool?.execute(ctx({}));

      expect(getPipelines).toHaveBeenCalledWith();
      expect(out).toBe(JSON.stringify(pipelines));
    });
  });
});
