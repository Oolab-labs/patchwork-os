/**
 * Webflow recipe-step tools — read-only set (list_sites, list_collections,
 * list_collection_items, list_form_submissions).
 *
 * Mocks the Webflow connector module so the self-registering tool module can be
 * imported and each tool exercised through the registry without network or
 * stored credentials. Asserts faithful param mapping into the connector calls
 * and that the raw connector `WebflowListResult<T>` is JSON-stringified back out.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getTool } from "../../toolRegistry.js";
import type { RunContext, StepDeps } from "../../yamlRunner.js";

// ── Connector mock ───────────────────────────────────────────────────────────
// One shared connector object with spy methods. getWebflowConnector returns it.

const listSites = vi.fn();
const listCollections = vi.fn();
const listCollectionItems = vi.fn();
const listFormSubmissions = vi.fn();

vi.mock("../../../connectors/webflow.js", () => ({
  getWebflowConnector: () => ({
    listSites,
    listCollections,
    listCollectionItems,
    listFormSubmissions,
  }),
}));

// Importing the module self-registers the tools into the shared registry.
import "../webflow.js";

function makeContext(params: Record<string, unknown>) {
  return {
    params,
    step: {},
    ctx: { env: {}, steps: {} } as unknown as RunContext,
    deps: {} as StepDeps,
  };
}

describe("webflow recipe-step tools", () => {
  beforeEach(() => {
    listSites.mockReset();
    listCollections.mockReset();
    listCollectionItems.mockReset();
    listFormSubmissions.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── registration metadata ──────────────────────────────────────────────────

  it("registers all four read-only tools with low risk / non-write", () => {
    for (const id of [
      "webflow.list_sites",
      "webflow.list_collections",
      "webflow.list_collection_items",
      "webflow.list_form_submissions",
    ]) {
      const tool = getTool(id);
      expect(tool, `tool ${id} should be registered`).toBeDefined();
      expect(tool?.namespace).toBe("webflow");
      expect(tool?.isWrite).toBe(false);
      expect(tool?.riskDefault).toBe("low");
      expect(tool?.isConnector).toBe(true);
      expect(tool?.outputSchema).toBeDefined();
    }
  });

  // ── webflow.list_sites ──────────────────────────────────────────────────────

  it("list_sites calls the connector with no args and stringifies the result", async () => {
    const result = {
      items: [
        {
          id: "site_1",
          displayName: "My Site",
          shortName: "my-site",
          createdOn: "2026-01-01T00:00:00Z",
        },
      ],
    };
    listSites.mockResolvedValue(result);

    const tool = getTool("webflow.list_sites");
    const out = await tool?.execute(makeContext({}));

    expect(listSites).toHaveBeenCalledWith();
    expect(out).toBe(JSON.stringify(result));
  });

  // ── webflow.list_collections ────────────────────────────────────────────────

  it("list_collections forwards siteId positionally and stringifies the result", async () => {
    const result = {
      items: [{ id: "col_1", displayName: "Blog Posts", slug: "blog-posts" }],
    };
    listCollections.mockResolvedValue(result);

    const tool = getTool("webflow.list_collections");
    const out = await tool?.execute(makeContext({ siteId: "site_1" }));

    expect(listCollections).toHaveBeenCalledWith("site_1");
    expect(out).toBe(JSON.stringify(result));
  });

  // ── webflow.list_collection_items ───────────────────────────────────────────

  it("list_collection_items forwards collectionId + limit/offset and stringifies the result", async () => {
    const result = {
      items: [{ id: "item_1", fieldData: { name: "Hello" } }],
      pagination: { limit: 5, offset: 10, total: 42 },
    };
    listCollectionItems.mockResolvedValue(result);

    const tool = getTool("webflow.list_collection_items");
    const out = await tool?.execute(
      makeContext({ collectionId: "col_1", limit: 5, offset: 10 }),
    );

    expect(listCollectionItems).toHaveBeenCalledWith("col_1", {
      limit: 5,
      offset: 10,
    });
    expect(out).toBe(JSON.stringify(result));
  });

  it("list_collection_items passes undefined for omitted / wrong-typed limit & offset", async () => {
    listCollectionItems.mockResolvedValue({ items: [] });

    const tool = getTool("webflow.list_collection_items");
    await tool?.execute(makeContext({ collectionId: "col_2", limit: "nope" }));

    expect(listCollectionItems).toHaveBeenCalledWith("col_2", {
      limit: undefined,
      offset: undefined,
    });
  });

  // ── webflow.list_form_submissions ───────────────────────────────────────────

  it("list_form_submissions forwards formId + limit/offset and stringifies the result", async () => {
    const result = {
      items: [
        {
          id: "sub_1",
          formId: "form_1",
          dateSubmitted: "2026-02-02T00:00:00Z",
          formResponse: { email: "a@b.com" },
        },
      ],
      pagination: { limit: 20, offset: 0, total: 1 },
    };
    listFormSubmissions.mockResolvedValue(result);

    const tool = getTool("webflow.list_form_submissions");
    const out = await tool?.execute(
      makeContext({ formId: "form_1", limit: 20, offset: 0 }),
    );

    expect(listFormSubmissions).toHaveBeenCalledWith("form_1", {
      limit: 20,
      offset: 0,
    });
    expect(out).toBe(JSON.stringify(result));
  });

  it("list_form_submissions passes undefined for omitted limit & offset", async () => {
    listFormSubmissions.mockResolvedValue({ items: [] });

    const tool = getTool("webflow.list_form_submissions");
    await tool?.execute(makeContext({ formId: "form_2" }));

    expect(listFormSubmissions).toHaveBeenCalledWith("form_2", {
      limit: undefined,
      offset: undefined,
    });
  });
});
