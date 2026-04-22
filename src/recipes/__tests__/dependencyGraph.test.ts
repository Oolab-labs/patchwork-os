import { describe, expect, it } from "vitest";
import {
  buildDependencyGraph,
  executeWithDependencies,
  getReadySteps,
} from "../dependencyGraph.js";

describe("buildDependencyGraph", () => {
  it("builds graph with no dependencies", () => {
    const g = buildDependencyGraph([{ id: "a" }, { id: "b" }]);
    expect(g.hasCycles).toBe(false);
    expect(g.topologicalOrder).toContain("a");
    expect(g.topologicalOrder).toContain("b");
  });

  it("builds graph respecting awaits order", () => {
    const g = buildDependencyGraph([
      { id: "a" },
      { id: "b", awaits: ["a"] },
      { id: "c", awaits: ["b"] },
    ]);
    expect(g.hasCycles).toBe(false);
    const order = g.topologicalOrder;
    expect(order.indexOf("a")).toBeLessThan(order.indexOf("b"));
    expect(order.indexOf("b")).toBeLessThan(order.indexOf("c"));
  });

  it("detects direct cycle", () => {
    const g = buildDependencyGraph([
      { id: "a", awaits: ["b"] },
      { id: "b", awaits: ["a"] },
    ]);
    expect(g.hasCycles).toBe(true);
  });

  it("detects longer cycle", () => {
    const g = buildDependencyGraph([
      { id: "a", awaits: ["c"] },
      { id: "b", awaits: ["a"] },
      { id: "c", awaits: ["b"] },
    ]);
    expect(g.hasCycles).toBe(true);
  });

  it("handles single step", () => {
    const g = buildDependencyGraph([{ id: "only" }]);
    expect(g.hasCycles).toBe(false);
    expect(g.topologicalOrder).toEqual(["only"]);
  });

  it("handles diamond dependency", () => {
    const g = buildDependencyGraph([
      { id: "a" },
      { id: "b", awaits: ["a"] },
      { id: "c", awaits: ["a"] },
      { id: "d", awaits: ["b", "c"] },
    ]);
    expect(g.hasCycles).toBe(false);
    const order = g.topologicalOrder;
    expect(order.indexOf("a")).toBeLessThan(order.indexOf("b"));
    expect(order.indexOf("a")).toBeLessThan(order.indexOf("c"));
    expect(order.indexOf("b")).toBeLessThan(order.indexOf("d"));
    expect(order.indexOf("c")).toBeLessThan(order.indexOf("d"));
  });
});

describe("executeWithDependencies", () => {
  it("executes all steps and returns results", async () => {
    const g = buildDependencyGraph([{ id: "a" }, { id: "b" }]);
    const executed: string[] = [];
    const results = await executeWithDependencies(
      g,
      async (id) => {
        executed.push(id);
      },
      { maxConcurrency: 2 },
    );
    expect(executed.sort()).toEqual(["a", "b"]);
    expect(results.get("a")?.success).toBe(true);
    expect(results.get("b")?.success).toBe(true);
  });

  it("records step failure without crashing", async () => {
    const g = buildDependencyGraph([{ id: "fail" }, { id: "ok" }]);
    const results = await executeWithDependencies(
      g,
      async (id) => {
        if (id === "fail") throw new Error("boom");
      },
      { maxConcurrency: 2 },
    );
    expect(results.get("fail")?.success).toBe(false);
    expect(results.get("fail")?.error?.message).toBe("boom");
    expect(results.get("ok")?.success).toBe(true);
  });

  it("respects dependency order (b runs after a)", async () => {
    const order: string[] = [];
    const g = buildDependencyGraph([{ id: "a" }, { id: "b", awaits: ["a"] }]);
    await executeWithDependencies(
      g,
      async (id) => {
        order.push(id);
      },
      { maxConcurrency: 4 },
    );
    expect(order.indexOf("a")).toBeLessThan(order.indexOf("b"));
  });

  it("fires onStepStart and onStepComplete callbacks", async () => {
    const g = buildDependencyGraph([{ id: "x" }]);
    const started: string[] = [];
    const completed: string[] = [];
    await executeWithDependencies(g, async () => {}, {
      maxConcurrency: 1,
      onStepStart: (id) => started.push(id),
      onStepComplete: (id) => completed.push(id),
    });
    expect(started).toEqual(["x"]);
    expect(completed).toEqual(["x"]);
  });

  it("skips dependent steps when upstream fails (C1)", async () => {
    const g = buildDependencyGraph([
      { id: "a" },
      { id: "b", awaits: ["a"] },
      { id: "c", awaits: ["b"] },
    ]);
    const executed: string[] = [];
    const results = await executeWithDependencies(
      g,
      async (id) => {
        executed.push(id);
        if (id === "a") throw new Error("upstream failure");
      },
      { maxConcurrency: 4 },
    );
    expect(executed).toEqual(["a"]);
    expect(results.get("a")?.success).toBe(false);
    expect(results.get("b")?.success).toBe(false);
    expect(results.get("b")?.error?.message).toMatch(/upstream/);
    expect(results.get("c")?.success).toBe(false);
  });

  it("fires onStepComplete with error for failed step (W1)", async () => {
    const g = buildDependencyGraph([{ id: "bad" }]);
    const errors: (Error | undefined)[] = [];
    await executeWithDependencies(
      g,
      async () => {
        throw new Error("oops");
      },
      { maxConcurrency: 1, onStepComplete: (_, err) => errors.push(err) },
    );
    expect(errors[0]).toBeInstanceOf(Error);
    expect(errors[0]?.message).toBe("oops");
  });

  it("throws on cyclic graph", async () => {
    const g = buildDependencyGraph([
      { id: "a", awaits: ["b"] },
      { id: "b", awaits: ["a"] },
    ]);
    await expect(
      executeWithDependencies(g, async () => {}, { maxConcurrency: 1 }),
    ).rejects.toThrow("cycles");
  });
});

describe("getReadySteps", () => {
  it("returns steps with no uncompleted deps", () => {
    const g = buildDependencyGraph([
      { id: "a" },
      { id: "b", awaits: ["a"] },
      { id: "c" },
    ]);
    expect(getReadySteps(g, new Set()).sort()).toEqual(["a", "c"]);
    expect(getReadySteps(g, new Set(["a"]))).toContain("b");
    expect(getReadySteps(g, new Set(["a"])).sort()).toContain("c");
  });

  it("excludes already completed steps", () => {
    const g = buildDependencyGraph([{ id: "a" }, { id: "b" }]);
    expect(getReadySteps(g, new Set(["a"]))).toEqual(["b"]);
  });
});
