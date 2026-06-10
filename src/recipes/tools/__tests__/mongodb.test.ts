/**
 * mongodb recipe-step tools — completes connector-step parity (46/46).
 *
 * The connector exposes a read-only query surface (listDatabases /
 * listCollections / describeCollection / find / aggregate) as module-level
 * functions; these tools wrap them. Mocked via vi.hoisted so the mock factory
 * can reference the stubs directly (the connector has no getXConnector
 * accessor to defer behind).
 */

import { afterEach, describe, expect, it, vi } from "vitest";

const { listDatabases, listCollections, describeCollection, find, aggregate } =
  vi.hoisted(() => ({
    listDatabases: vi.fn(),
    listCollections: vi.fn(),
    describeCollection: vi.fn(),
    find: vi.fn(),
    aggregate: vi.fn(),
  }));

vi.mock("../../../connectors/mongodb.js", () => ({
  listDatabases,
  listCollections,
  describeCollection,
  find,
  aggregate,
}));

import "../mongodb.js";
import { getTool } from "../../toolRegistry.js";
import type { RunContext, StepDeps } from "../../yamlRunner.js";

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
});

describe("mongodb recipe-step tools", () => {
  it("registers all five tools as read-only connector steps", () => {
    for (const id of [
      "mongodb.list_databases",
      "mongodb.list_collections",
      "mongodb.describe_collection",
      "mongodb.find",
      "mongodb.aggregate",
    ]) {
      const tool = getTool(id);
      expect(tool, id).toBeTruthy();
      expect(tool?.isWrite).toBe(false);
      expect(tool?.isConnector).toBe(true);
    }
  });

  it("list_databases returns the connector result as JSON", async () => {
    listDatabases.mockResolvedValue(["admin", "app"]);
    const out = await getTool("mongodb.list_databases")?.execute(ctx({}));
    expect(listDatabases).toHaveBeenCalledTimes(1);
    expect(JSON.parse(out ?? "null")).toEqual(["admin", "app"]);
  });

  it("find forwards database/collection/filter/projection/limit", async () => {
    find.mockResolvedValue([{ _id: 1 }]);
    const out = await getTool("mongodb.find")?.execute(
      ctx({
        database: "app",
        collection: "users",
        filter: { active: true },
        projection: { name: 1 },
        limit: 25,
      }),
    );
    expect(find).toHaveBeenCalledWith(
      "app",
      "users",
      { active: true },
      { projection: { name: 1 }, limit: 25 },
    );
    expect(JSON.parse(out ?? "null")).toEqual([{ _id: 1 }]);
  });

  it("find defaults filter to {} and leaves projection/limit unset", async () => {
    find.mockResolvedValue([]);
    await getTool("mongodb.find")?.execute(
      ctx({ database: "app", collection: "users" }),
    );
    expect(find).toHaveBeenCalledWith(
      "app",
      "users",
      {},
      { projection: undefined, limit: undefined },
    );
  });

  it("aggregate forwards the pipeline and limit", async () => {
    aggregate.mockResolvedValue([{ n: 3 }]);
    const pipeline = [{ $match: { active: true } }];
    await getTool("mongodb.aggregate")?.execute(
      ctx({ database: "app", collection: "users", pipeline, limit: 50 }),
    );
    expect(aggregate).toHaveBeenCalledWith("app", "users", pipeline, 50);
  });

  it("describe_collection returns sample + indexes", async () => {
    describeCollection.mockResolvedValue({ sample: { a: 1 }, indexes: [] });
    const out = await getTool("mongodb.describe_collection")?.execute(
      ctx({ database: "app", collection: "users" }),
    );
    expect(describeCollection).toHaveBeenCalledWith("app", "users");
    expect(JSON.parse(out ?? "null")).toEqual({
      sample: { a: 1 },
      indexes: [],
    });
  });
});
