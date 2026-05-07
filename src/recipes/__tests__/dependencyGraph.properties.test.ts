import fc from "fast-check";
import { describe, expect, test } from "vitest";
import { buildDependencyGraph, getReadySteps } from "../dependencyGraph.js";

const stepIdGen = fc
  .string({ minLength: 1, maxLength: 8 })
  .filter((s) => /^[a-zA-Z][a-zA-Z0-9_]*$/.test(s));

/**
 * Generate a list of steps where every entry has a unique id and any
 * declared `awaits` references an earlier id. By construction this is
 * acyclic — used for invariants that only hold on DAGs.
 */
const acyclicStepListGen = fc
  .array(stepIdGen, { minLength: 1, maxLength: 8 })
  .map((ids) => Array.from(new Set(ids)))
  .filter((ids) => ids.length >= 1)
  .chain((ids) =>
    fc
      .tuple(
        ...ids.map((_id, i) =>
          fc.array(fc.integer({ min: 0, max: Math.max(0, i - 1) }), {
            maxLength: i,
          }),
        ),
      )
      .map((deps) =>
        ids.map((id, i) => ({
          id,
          awaits: Array.from(new Set(deps[i] ?? [])).map(
            (j) => ids[j] as string,
          ),
        })),
      ),
  );

/**
 * Generate arbitrary step lists (may contain cycles, missing deps, dupes).
 * Used for totality + crash-safety invariants.
 */
const arbitraryStepListGen = fc.array(
  fc.record({
    id: stepIdGen,
    awaits: fc.array(stepIdGen, { maxLength: 5 }),
  }),
  { maxLength: 8 },
);

describe("dependencyGraph properties — totality", () => {
  test("buildDependencyGraph never throws for arbitrary input", () => {
    fc.assert(
      fc.property(arbitraryStepListGen, (steps) => {
        buildDependencyGraph(steps);
        return true;
      }),
    );
  });

  test("buildDependencyGraph never throws for empty input", () => {
    const g = buildDependencyGraph([]);
    expect(g.steps).toEqual([]);
    expect(g.hasCycles).toBe(false);
    expect(g.topologicalOrder).toEqual([]);
  });

  test("getReadySteps never throws for any (graph, completed) pair", () => {
    fc.assert(
      fc.property(
        arbitraryStepListGen,
        fc.array(stepIdGen, { maxLength: 8 }),
        (steps, completed) => {
          const graph = buildDependencyGraph(steps);
          const result = getReadySteps(graph, new Set(completed));
          return Array.isArray(result);
        },
      ),
    );
  });
});

describe("dependencyGraph properties — DAG invariants", () => {
  test("acyclic input never reports cycles", () => {
    fc.assert(
      fc.property(acyclicStepListGen, (steps) => {
        const g = buildDependencyGraph(steps);
        return g.hasCycles === false;
      }),
    );
  });

  test("topological order contains every node exactly once on DAG", () => {
    fc.assert(
      fc.property(acyclicStepListGen, (steps) => {
        const g = buildDependencyGraph(steps);
        const inOrder = new Set(g.topologicalOrder);
        const allIds = new Set(steps.map((s) => s.id));
        // Every node appears
        if (inOrder.size !== g.topologicalOrder.length) return false;
        // No extras, no missing
        return (
          inOrder.size === allIds.size &&
          [...inOrder].every((id) => allIds.has(id))
        );
      }),
    );
  });

  test("topological order respects dependencies on DAG", () => {
    fc.assert(
      fc.property(acyclicStepListGen, (steps) => {
        const g = buildDependencyGraph(steps);
        const position = new Map<string, number>();
        for (let i = 0; i < g.topologicalOrder.length; i++) {
          const id = g.topologicalOrder[i];
          if (id !== undefined) position.set(id, i);
        }
        for (const step of steps) {
          const myPos = position.get(step.id);
          if (myPos === undefined) return false;
          for (const dep of step.awaits) {
            const depPos = position.get(dep);
            if (depPos === undefined) continue; // missing deps OK
            if (depPos >= myPos) return false;
          }
        }
        return true;
      }),
    );
  });

  test("buildDependencyGraph is order-independent on the input list", () => {
    fc.assert(
      fc.property(acyclicStepListGen, (steps) => {
        const reversed = [...steps].reverse();
        const a = buildDependencyGraph(steps);
        const b = buildDependencyGraph(reversed);
        // Topological orders may differ when multiple valid orders exist,
        // but cycle detection and node membership must agree.
        return (
          a.hasCycles === b.hasCycles &&
          new Set(a.topologicalOrder).size ===
            new Set(b.topologicalOrder).size &&
          [...new Set(a.topologicalOrder)].every((id) =>
            new Set(b.topologicalOrder).has(id),
          )
        );
      }),
    );
  });
});

describe("dependencyGraph properties — cycle detection", () => {
  test("self-dependency is detected as a cycle", () => {
    const g = buildDependencyGraph([{ id: "a", awaits: ["a"] }]);
    expect(g.hasCycles).toBe(true);
  });

  test("two-node cycle is detected", () => {
    const g = buildDependencyGraph([
      { id: "a", awaits: ["b"] },
      { id: "b", awaits: ["a"] },
    ]);
    expect(g.hasCycles).toBe(true);
  });

  test("any cycle inserted into a DAG flips hasCycles to true", () => {
    fc.assert(
      fc.property(acyclicStepListGen, (steps) => {
        if (steps.length < 2) return true;
        // Insert an edge from steps[0] to steps[1] in addition to steps[1]'s
        // existing awaits. Combined with any path from steps[0] back to
        // steps[1] this forms a cycle. To guarantee a cycle we add a forced
        // back-edge: make steps[0] await steps[1] and steps[1] await steps[0].
        const a = steps[0]?.id;
        const b = steps[1]?.id;
        if (!a || !b || a === b) return true;
        const withCycle = steps.map((s) => {
          if (s.id === a) return { ...s, awaits: [...s.awaits, b] };
          if (s.id === b) return { ...s, awaits: [...s.awaits, a] };
          return s;
        });
        return buildDependencyGraph(withCycle).hasCycles === true;
      }),
    );
  });

  test("missing dependency reference does not produce a cycle", () => {
    fc.assert(
      fc.property(stepIdGen, stepIdGen, (existing, missing) => {
        if (existing === missing) return true;
        const g = buildDependencyGraph([{ id: existing, awaits: [missing] }]);
        // Per dependencyGraph.ts:58-61, missing deps are silently ignored
        // during cycle detection — they don't fabricate a cycle.
        return g.hasCycles === false;
      }),
    );
  });

  test("cyclic graph still produces a topological order (Kahn skips cycle nodes)", () => {
    // Kahn's algorithm leaves cycle nodes out of the queue (their in-degree
    // never reaches zero), so the order may be shorter than `steps`. We
    // assert it never contains a cycle node.
    const g = buildDependencyGraph([
      { id: "a", awaits: ["b"] },
      { id: "b", awaits: ["a"] },
      { id: "c", awaits: [] },
    ]);
    expect(g.hasCycles).toBe(true);
    expect(g.topologicalOrder).toEqual(["c"]);
  });
});

describe("dependencyGraph properties — getReadySteps", () => {
  test("ready set with empty completed equals nodes with no awaits (on DAG)", () => {
    fc.assert(
      fc.property(acyclicStepListGen, (steps) => {
        const g = buildDependencyGraph(steps);
        const ready = new Set(getReadySteps(g, new Set()));
        const noAwaits = new Set(
          steps.filter((s) => s.awaits.length === 0).map((s) => s.id),
        );
        return (
          ready.size === noAwaits.size &&
          [...ready].every((id) => noAwaits.has(id))
        );
      }),
    );
  });

  test("ready set is monotone in completed (adding nodes never removes ready ones unless they become completed)", () => {
    fc.assert(
      fc.property(acyclicStepListGen, stepIdGen, (steps, extra) => {
        const g = buildDependencyGraph(steps);
        const before = new Set(getReadySteps(g, new Set()));
        const completed = new Set([extra]);
        const after = new Set(getReadySteps(g, completed));
        // Anything that was ready before and is not now in `completed` must
        // still be ready after.
        for (const id of before) {
          if (completed.has(id)) continue;
          if (!after.has(id)) return false;
        }
        return true;
      }),
    );
  });

  test("a step is ready iff all its awaits are completed and the step itself is not", () => {
    fc.assert(
      fc.property(
        acyclicStepListGen,
        fc.array(stepIdGen, { maxLength: 5 }),
        (steps, completedRaw) => {
          const completed = new Set(completedRaw);
          const g = buildDependencyGraph(steps);
          const ready = new Set(getReadySteps(g, completed));
          for (const step of steps) {
            const allDepsDone = step.awaits.every((d) => completed.has(d));
            const selfDone = completed.has(step.id);
            const expected = allDepsDone && !selfDone;
            if (ready.has(step.id) !== expected) return false;
          }
          return true;
        },
      ),
    );
  });

  test("ready set never contains a step whose awaits include an uncompleted node", () => {
    fc.assert(
      fc.property(
        arbitraryStepListGen,
        fc.array(stepIdGen, { maxLength: 5 }),
        (steps, completedRaw) => {
          const completed = new Set(completedRaw);
          const g = buildDependencyGraph(steps);
          const ready = getReadySteps(g, completed);
          for (const id of ready) {
            const step = steps.find((s) => s.id === id);
            if (!step) continue;
            for (const dep of step.awaits) {
              if (!completed.has(dep)) return false;
            }
          }
          return true;
        },
      ),
    );
  });
});

describe("dependencyGraph properties — input mutation", () => {
  test("buildDependencyGraph does not mutate input array", () => {
    fc.assert(
      fc.property(acyclicStepListGen, (steps) => {
        const snapshot = steps.map((s) => ({
          id: s.id,
          awaits: [...s.awaits],
        }));
        buildDependencyGraph(steps);
        if (steps.length !== snapshot.length) return false;
        for (let i = 0; i < steps.length; i++) {
          const a = steps[i];
          const b = snapshot[i];
          if (!a || !b) return false;
          if (a.id !== b.id) return false;
          if (a.awaits.length !== b.awaits.length) return false;
          for (let j = 0; j < a.awaits.length; j++) {
            if (a.awaits[j] !== b.awaits[j]) return false;
          }
        }
        return true;
      }),
    );
  });
});
