/**
 * Elasticsearch recipe-step tools — read-only set (search, count, list_indices,
 * cluster_health).
 *
 * Mocks the Elasticsearch connector module so the self-registering tool module
 * can be imported and each tool exercised through the registry without network
 * or stored credentials. Asserts faithful positional param mapping into the
 * connector calls, that the raw connector return type is JSON-stringified back
 * out, and that every tool is read-only (isWrite: false / low risk).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getTool } from "../../toolRegistry.js";
import type { RunContext, StepDeps } from "../../yamlRunner.js";

// ── Connector mock ───────────────────────────────────────────────────────────
// One shared connector object with spy methods. getElasticsearchConnector
// returns it.

const search = vi.fn();
const count = vi.fn();
const listIndices = vi.fn();
const clusterHealth = vi.fn();

vi.mock("../../../connectors/elasticsearch.js", () => ({
  getElasticsearchConnector: () => ({
    search,
    count,
    listIndices,
    clusterHealth,
  }),
}));

// Importing the module self-registers the tools into the shared registry.
import "../elasticsearch.js";

function makeContext(params: Record<string, unknown>) {
  return {
    params,
    step: {},
    ctx: { env: {}, steps: {} } as unknown as RunContext,
    deps: {} as StepDeps,
  };
}

describe("elasticsearch recipe-step tools", () => {
  beforeEach(() => {
    search.mockReset();
    count.mockReset();
    listIndices.mockReset();
    clusterHealth.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── registration metadata ──────────────────────────────────────────────────

  it("registers all four tools as read-only / low-risk connector tools", () => {
    for (const id of [
      "elasticsearch.search",
      "elasticsearch.count",
      "elasticsearch.list_indices",
      "elasticsearch.cluster_health",
    ]) {
      const tool = getTool(id);
      expect(tool, `tool ${id} should be registered`).toBeDefined();
      expect(tool?.namespace).toBe("elasticsearch");
      expect(tool?.isWrite).toBe(false);
      expect(tool?.riskDefault).toBe("low");
      expect(tool?.isConnector).toBe(true);
      expect(tool?.outputSchema).toBeDefined();
    }
  });

  // ── elasticsearch.search ────────────────────────────────────────────────────

  it("search forwards index/query/size/from/sort/_source positionally and stringifies", async () => {
    const response = {
      took: 3,
      hits: { total: { value: 1 }, hits: [{ _id: "1", _source: { a: 1 } }] },
    };
    search.mockResolvedValue(response);

    const query = { match: { title: "hello" } };
    const sort = [{ created_at: "desc" }];
    const _source = ["title", "created_at"];
    const tool = getTool("elasticsearch.search");
    const out = await tool?.execute(
      makeContext({
        index: "logs-*",
        query,
        size: 25,
        from: 50,
        sort,
        _source,
      }),
    );

    expect(search).toHaveBeenCalledWith("logs-*", query, 25, 50, sort, _source);
    expect(out).toBe(JSON.stringify(response));
  });

  it("search passes undefined for omitted/wrong-typed size+from and passes sort/_source as-is", async () => {
    search.mockResolvedValue({ hits: { hits: [] } });

    const query = { match_all: {} };
    const tool = getTool("elasticsearch.search");
    await tool?.execute(
      makeContext({ index: "idx", query, size: "nope", from: null }),
    );

    expect(search).toHaveBeenCalledWith(
      "idx",
      query,
      undefined,
      undefined,
      undefined,
      undefined,
    );
  });

  // ── elasticsearch.count ─────────────────────────────────────────────────────

  it("count forwards index + query positionally and stringifies", async () => {
    const response = { count: 42, _shards: { total: 1 } };
    count.mockResolvedValue(response);

    const query = { term: { status: "active" } };
    const tool = getTool("elasticsearch.count");
    const out = await tool?.execute(makeContext({ index: "users", query }));

    expect(count).toHaveBeenCalledWith("users", query);
    expect(out).toBe(JSON.stringify(response));
  });

  it("count passes undefined query when omitted", async () => {
    count.mockResolvedValue({ count: 0 });

    const tool = getTool("elasticsearch.count");
    await tool?.execute(makeContext({ index: "users" }));

    expect(count).toHaveBeenCalledWith("users", undefined);
  });

  // ── elasticsearch.list_indices ──────────────────────────────────────────────

  it("list_indices calls the connector with no args and stringifies the array", async () => {
    const indices = [
      { index: "logs-2026", "docs.count": "1000", "store.size": "5mb" },
    ];
    listIndices.mockResolvedValue(indices);

    const tool = getTool("elasticsearch.list_indices");
    const out = await tool?.execute(makeContext({}));

    expect(listIndices).toHaveBeenCalledWith();
    expect(out).toBe(JSON.stringify(indices));
  });

  // ── elasticsearch.cluster_health ────────────────────────────────────────────

  it("cluster_health calls the connector with no args and stringifies the result", async () => {
    const health = {
      cluster_name: "es-prod",
      status: "green",
      number_of_nodes: 3,
      active_shards: 12,
    };
    clusterHealth.mockResolvedValue(health);

    const tool = getTool("elasticsearch.cluster_health");
    const out = await tool?.execute(makeContext({}));

    expect(clusterHealth).toHaveBeenCalledWith();
    expect(out).toBe(JSON.stringify(health));
  });
});
