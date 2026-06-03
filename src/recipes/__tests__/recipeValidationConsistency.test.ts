/**
 * Regression tests for recipe-validation consistency fixes:
 *
 *   Bug 2 — `risk` was never validated. The compiler bucketed unknown risk
 *           values fail-OPEN (→ allow). `validateRecipeDefinition` now emits
 *           an UNCONDITIONAL error for any risk outside low|medium|high,
 *           not gated behind FLAG_SCHEMA_LINT.
 *
 *   Bug 3 — an `awaits:` target that matches no real step was silently
 *           dropped from the topological order (the step AND its dependents
 *           never ran, yet the run reported success). The static check now
 *           flags unknown awaits targets at lint/doctor time.
 */

import { describe, expect, it } from "vitest";
import { validateRecipeDefinition } from "../validation.js";

const base = {
  name: "consistency-test",
  description: "test recipe",
  trigger: { type: "manual" as const },
  steps: [{ id: "s1", agent: { prompt: "hi" } }],
};

describe("risk enum validation (unconditional, not gated on FLAG_SCHEMA_LINT)", () => {
  it("flags a typo'd risk value ('hgh') as an error", () => {
    const result = validateRecipeDefinition({
      ...base,
      steps: [{ id: "s1", tool: "file.write", params: {}, risk: "hgh" }],
    });
    const errors = result.issues.filter((i) => i.level === "error");
    expect(errors.some((e) => /risk/i.test(e.message))).toBe(true);
    expect(result.valid).toBe(false);
  });

  it("accepts low | medium | high", () => {
    for (const risk of ["low", "medium", "high"] as const) {
      const result = validateRecipeDefinition({
        ...base,
        steps: [{ id: "s1", tool: "file.write", params: {}, risk }],
      });
      expect(
        result.issues.filter(
          (i) => i.level === "error" && /risk/i.test(i.message),
        ),
      ).toHaveLength(0);
    }
  });

  it("reads risk from the nested agent object too", () => {
    const result = validateRecipeDefinition({
      ...base,
      steps: [{ id: "s1", agent: { prompt: "hi", risk: "bogus" } }],
    });
    const errors = result.issues.filter(
      (i) => i.level === "error" && /risk/i.test(i.message),
    );
    expect(errors.length).toBeGreaterThan(0);
  });

  it("does not flag steps without a risk field", () => {
    const result = validateRecipeDefinition({
      ...base,
      steps: [{ id: "s1", tool: "file.write", params: {} }],
    });
    expect(
      result.issues.filter(
        (i) => i.level === "error" && /risk/i.test(i.message),
      ),
    ).toHaveLength(0);
  });
});

describe("unknown awaits-target validation", () => {
  it("flags an awaits target that matches no step id", () => {
    const result = validateRecipeDefinition({
      ...base,
      trigger: { type: "chained" },
      steps: [
        { id: "a", tool: "file.read", params: {} },
        { id: "b", tool: "file.write", params: {}, awaits: ["ghost"] },
      ],
    });
    const errors = result.issues.filter((i) => i.level === "error");
    expect(errors.some((e) => /awaits/i.test(e.message))).toBe(true);
    expect(errors.some((e) => e.message.includes("ghost"))).toBe(true);
    expect(result.valid).toBe(false);
  });

  it("does not flag a valid awaits chain", () => {
    const result = validateRecipeDefinition({
      ...base,
      trigger: { type: "chained" },
      steps: [
        { id: "a", tool: "file.read", params: {} },
        { id: "b", tool: "file.write", params: {}, awaits: ["a"] },
      ],
    });
    expect(
      result.issues.filter(
        (i) => i.level === "error" && /awaits/i.test(i.message),
      ),
    ).toHaveLength(0);
  });

  // Regression: `awaits: [<parallel-group-id>]` is VALID at runtime —
  // chainedRunner.expandParallelSteps rewrites a group-id await to the
  // expanded child ids. But `flattenValidationSteps` hoists the children
  // and DROPS the container id, so the naive (normalized-only) known-id
  // collection produced a false positive on shipped templates
  // (project-health-check.yaml, business-decision-brief.yaml). The fix
  // also collects known ids from the RAW recipe steps.
  it("does NOT flag a step that awaits a parallel-group container id", () => {
    const result = validateRecipeDefinition({
      ...base,
      trigger: { type: "chained" },
      steps: [
        {
          id: "gather",
          parallel: [
            { id: "commits", tool: "git.log_since" },
            { id: "issues", tool: "github.list_issues" },
          ],
        },
        { id: "summarize", agent: { prompt: "x" }, awaits: ["gather"] },
      ],
    });
    expect(
      result.issues.filter(
        (i) => i.level === "error" && /awaits/i.test(i.message),
      ),
    ).toHaveLength(0);
  });

  // …but a genuine typo of a group id (present in neither the raw nor the
  // flattened step list) MUST still error — detection isn't weakened.
  it("still flags a typo'd parallel-group id (gather2)", () => {
    const result = validateRecipeDefinition({
      ...base,
      trigger: { type: "chained" },
      steps: [
        {
          id: "gather",
          parallel: [{ id: "commits", tool: "git.log_since" }],
        },
        { id: "summarize", agent: { prompt: "x" }, awaits: ["gather2"] },
      ],
    });
    const errors = result.issues.filter(
      (i) => i.level === "error" && /awaits/i.test(i.message),
    );
    expect(errors.some((e) => e.message.includes("gather2"))).toBe(true);
  });
});

describe("judge refine-loop field validation (max_revisions / on_exhausted)", () => {
  it("accepts max_revisions on a proper judge step (kind:judge + reviews)", () => {
    const result = validateRecipeDefinition({
      ...base,
      steps: [
        { id: "draft", agent: { prompt: "make", into: "draft" } },
        {
          id: "review",
          agent: {
            prompt: "review",
            kind: "judge",
            reviews: "draft",
            max_revisions: 2,
            on_exhausted: "proceed",
          },
        },
      ],
    });
    const errors = result.issues.filter(
      (i) =>
        i.level === "error" &&
        /max_revisions|on_exhausted|refine/i.test(i.message),
    );
    expect(errors).toHaveLength(0);
  });

  it("rejects max_revisions on a non-judge agent step", () => {
    const result = validateRecipeDefinition({
      ...base,
      steps: [{ id: "s1", agent: { prompt: "hi", max_revisions: 2 } }],
    });
    const errors = result.issues.filter(
      (i) => i.level === "error" && /max_revisions/i.test(i.message),
    );
    expect(errors.length).toBeGreaterThan(0);
    expect(result.valid).toBe(false);
  });

  it("rejects max_revisions on a judge step without reviews", () => {
    const result = validateRecipeDefinition({
      ...base,
      steps: [
        { id: "s1", agent: { prompt: "hi", kind: "judge", max_revisions: 1 } },
      ],
    });
    const errors = result.issues.filter(
      (i) => i.level === "error" && /max_revisions|reviews/i.test(i.message),
    );
    expect(errors.length).toBeGreaterThan(0);
  });

  it("rejects a negative / non-integer max_revisions", () => {
    for (const bad of [-1, 1.5, "two"]) {
      const result = validateRecipeDefinition({
        ...base,
        steps: [
          {
            id: "s1",
            agent: {
              prompt: "hi",
              kind: "judge",
              reviews: "draft",
              max_revisions: bad,
            },
          },
        ],
      });
      const errors = result.issues.filter(
        (i) => i.level === "error" && /max_revisions/i.test(i.message),
      );
      expect(errors.length).toBeGreaterThan(0);
    }
  });

  it("rejects an out-of-enum on_exhausted", () => {
    const result = validateRecipeDefinition({
      ...base,
      steps: [
        {
          id: "s1",
          agent: {
            prompt: "hi",
            kind: "judge",
            reviews: "draft",
            on_exhausted: "explode",
          },
        },
      ],
    });
    const errors = result.issues.filter(
      (i) => i.level === "error" && /on_exhausted/i.test(i.message),
    );
    expect(errors.length).toBeGreaterThan(0);
  });
});
