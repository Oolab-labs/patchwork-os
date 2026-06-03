/**
 * Salesforce recipe-step tools — read wrappers (query, search, get_object)
 * plus a write-gated create_record.
 *
 * Salesforce uses the MODULE-FUNCTION pattern (no getSalesforceConnector()) —
 * the connector exports standalone async functions. This test mocks those
 * exported functions, imports the self-registering tool module, exercises each
 * tool through the registry, and asserts:
 *   - the EXACT exported function is called with faithfully mapped params
 *     (mirroring the signatures in src/connectors/salesforce.ts), and
 *   - the raw connector return value is JSON-stringified back out.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getTool } from "../../toolRegistry.js";
import type { RunContext, StepDeps } from "../../yamlRunner.js";

// ── Connector mock ───────────────────────────────────────────────────────────
// Mock the module-function exports (three levels up from this test dir).

const query = vi.fn();
const searchSosl = vi.fn();
const getObject = vi.fn();
const createRecord = vi.fn();

vi.mock("../../../connectors/salesforce.js", () => ({
  query,
  searchSosl,
  getObject,
  createRecord,
}));

// Importing the module self-registers the tools into the shared registry.
import "../salesforce.js";

function makeContext(params: Record<string, unknown>) {
  return {
    params,
    step: {},
    ctx: { env: {}, steps: {} } as unknown as RunContext,
    deps: {} as StepDeps,
  };
}

// Representative connector return values (raw shapes from salesforce.ts).
const soqlResult = {
  totalSize: 2,
  done: true,
  records: [
    { Id: "001AAA", Name: "Acme" },
    { Id: "001BBB", Name: "Globex" },
  ],
};

const soslResult = {
  searchRecords: [
    { Id: "003CCC", attributes: { type: "Contact" } },
    { Id: "001AAA", attributes: { type: "Account" } },
  ],
};

const objectResult = {
  Id: "001AAA",
  Name: "Acme",
  Industry: "Technology",
};

const createResult = {
  id: "001ZZZ",
  success: true,
  errors: [],
};

describe("salesforce recipe-step tools", () => {
  beforeEach(() => {
    query.mockReset();
    searchSosl.mockReset();
    getObject.mockReset();
    createRecord.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── registration metadata ──────────────────────────────────────────────────

  it("registers read tools as low risk / non-write", () => {
    for (const id of [
      "salesforce.query",
      "salesforce.search",
      "salesforce.get_object",
    ]) {
      const tool = getTool(id);
      expect(tool, `tool ${id} should be registered`).toBeDefined();
      expect(tool?.namespace).toBe("salesforce");
      expect(tool?.isWrite).toBe(false);
      expect(tool?.riskDefault).toBe("low");
      expect(tool?.isConnector).toBe(true);
      expect(tool?.outputSchema).toBeDefined();
    }
  });

  it("registers create_record as a medium-risk write tool", () => {
    const tool = getTool("salesforce.create_record");
    expect(tool).toBeDefined();
    expect(tool?.namespace).toBe("salesforce");
    expect(tool?.isWrite).toBe(true);
    expect(tool?.riskDefault).toBe("medium");
    expect(tool?.isConnector).toBe(true);
    expect(tool?.outputSchema).toBeDefined();
  });

  // ── salesforce.query ────────────────────────────────────────────────────────

  it("query forwards soql + limit and stringifies the result", async () => {
    query.mockResolvedValue(soqlResult);

    const tool = getTool("salesforce.query");
    const out = await tool?.execute(
      makeContext({ soql: "SELECT Id, Name FROM Account", limit: 50 }),
    );

    expect(query).toHaveBeenCalledWith("SELECT Id, Name FROM Account", {
      limit: 50,
    });
    expect(out).toBe(JSON.stringify(soqlResult));
  });

  it("query passes undefined opts when limit is omitted / wrong-typed", async () => {
    query.mockResolvedValue(soqlResult);

    const tool = getTool("salesforce.query");
    await tool?.execute(
      makeContext({ soql: "SELECT Id FROM Contact", limit: "big" }),
    );

    expect(query).toHaveBeenCalledWith("SELECT Id FROM Contact", undefined);
  });

  // ── salesforce.search ───────────────────────────────────────────────────────

  it("search forwards the sosl expression and stringifies the result", async () => {
    searchSosl.mockResolvedValue(soslResult);

    const tool = getTool("salesforce.search");
    const out = await tool?.execute(
      makeContext({ sosl: "FIND {Acme} IN ALL FIELDS" }),
    );

    expect(searchSosl).toHaveBeenCalledWith("FIND {Acme} IN ALL FIELDS");
    expect(out).toBe(JSON.stringify(soslResult));
  });

  // ── salesforce.get_object ───────────────────────────────────────────────────

  it("get_object forwards object_name + record_id and stringifies the result", async () => {
    getObject.mockResolvedValue(objectResult);

    const tool = getTool("salesforce.get_object");
    const out = await tool?.execute(
      makeContext({ object_name: "Account", record_id: "001AAA0000000001" }),
    );

    expect(getObject).toHaveBeenCalledWith("Account", "001AAA0000000001");
    expect(out).toBe(JSON.stringify(objectResult));
  });

  // ── salesforce.create_record ────────────────────────────────────────────────

  it("create_record forwards object_name + fields and stringifies the result", async () => {
    createRecord.mockResolvedValue(createResult);

    const tool = getTool("salesforce.create_record");
    const fields = { Name: "Acme", Industry: "Technology" };
    const out = await tool?.execute(
      makeContext({ object_name: "Account", fields }),
    );

    expect(createRecord).toHaveBeenCalledWith("Account", fields);
    expect(out).toBe(JSON.stringify(createResult));
  });

  it("create_record passes an empty object when fields is missing / wrong-typed", async () => {
    createRecord.mockResolvedValue(createResult);

    const tool = getTool("salesforce.create_record");
    await tool?.execute(makeContext({ object_name: "Lead", fields: "nope" }));

    expect(createRecord).toHaveBeenCalledWith("Lead", {});
  });
});
