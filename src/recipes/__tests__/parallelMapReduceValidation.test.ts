/**
 * Regression test — `parallel: { each, as, steps }` map-reduce syntax.
 *
 * Per Bug Fix Protocol — failing-first. The object form of `parallel:` was
 * accepted by the validator (flattened for linting at validation.ts:307) but
 * NO runner executes it: chainedRunner.expandParallelSteps only handles the
 * static-array form (`Array.isArray(step.parallel)`), and the `each` template
 * resolves only at runtime so it cannot be statically expanded. A recipe
 * using this syntax silently no-ops the step at runtime.
 *
 * Fix: validation must REJECT the object form with a clear error pointing at
 * the `fan_out` tool — fail loud at preflight, not silent at runtime.
 */

import { describe, expect, it } from "vitest";
import { validateRecipeDefinition } from "../validation.js";

describe("parallel: { each } map-reduce — unsupported, must fail validation", () => {
  it("rejects a step whose `parallel` is the {each,as,steps} object form", () => {
    const recipe = {
      name: "uses-map-reduce",
      description: "x",
      version: "1.0.0",
      trigger: { type: "manual" },
      steps: [
        {
          id: "spawn",
          parallel: {
            each: "{{plan.threads}}",
            as: "thread",
            steps: [{ id: "agent_x", tool: "file.read", path: "/tmp/x" }],
          },
        },
      ],
    };
    const result = validateRecipeDefinition(recipe);
    expect(result.valid).toBe(false);
    const errs = result.issues.filter((i) => i.level === "error");
    expect(errs.some((e) => /parallel/i.test(e.message))).toBe(true);
    // Error should point the author at the supported alternative.
    expect(errs.some((e) => /fan_out/i.test(e.message))).toBe(true);
  });

  it("still accepts the static-array form of parallel (that one IS executed)", () => {
    const recipe = {
      name: "uses-static-parallel",
      description: "x",
      version: "1.0.0",
      trigger: { type: "manual" },
      steps: [
        {
          id: "grp",
          parallel: [
            { id: "a", tool: "file.read", path: "/tmp/a" },
            { id: "b", tool: "file.read", path: "/tmp/b" },
          ],
        },
      ],
    };
    const result = validateRecipeDefinition(recipe);
    const errs = result.issues.filter((i) => i.level === "error");
    expect(
      errs.some((e) => /parallel.*not.*support|map-reduce/i.test(e.message)),
    ).toBe(false);
  });

  it("detects the object form even when nested inside a static-array parallel", () => {
    const recipe = {
      name: "nested-map-reduce",
      description: "x",
      version: "1.0.0",
      trigger: { type: "manual" },
      steps: [
        {
          id: "outer",
          parallel: [
            {
              id: "inner",
              parallel: {
                each: "{{xs}}",
                as: "x",
                steps: [{ id: "leaf", tool: "file.read", path: "/tmp/x" }],
              },
            },
          ],
        },
      ],
    };
    const result = validateRecipeDefinition(recipe);
    expect(result.valid).toBe(false);
    expect(
      result.issues.some(
        (i) => i.level === "error" && /parallel/i.test(i.message),
      ),
    ).toBe(true);
  });
});
