/**
 * Regression tests for template-reference validation (audit 2026-06-10):
 *  - recipe-validation-1: the builtin date keys (YYYY, YYYY-MM, YYYY-MM-DD,
 *    ISO_NOW, HH, MM, SS) are injected at runtime on BOTH the flat and chained
 *    paths and accepted by lint, so {{YYYY-MM-DD}} renders a real value;
 *    genuine unknown refs (typos) are still flagged.
 *  - recipe-validation-4: collectParallelEachKeys did not recurse into
 *    `parallel: [...]` group arrays, so a nested map-reduce loop variable was
 *    reported as an unknown template reference (false positive blocking valid
 *    recipes).
 */

import { describe, expect, it } from "vitest";
import { validateRecipeDefinition } from "../validation.js";

function unknownTemplateErrors(recipe: unknown): string[] {
  const result = validateRecipeDefinition(recipe);
  return result.issues
    .filter((i) => /unknown template reference/i.test(i.message))
    .map((i) => i.message);
}

describe("recipe-validation-1: builtin date keys are injected, not phantom", () => {
  it("accepts {{YYYY-MM-DD}} (now injected at runtime on both paths)", () => {
    const recipe = {
      name: "real-date-ymd",
      trigger: { type: "manual" },
      steps: [
        { id: "s1", tool: "slack.post", message: "Today is {{YYYY-MM-DD}}" },
      ],
    };
    expect(unknownTemplateErrors(recipe)).toHaveLength(0);
  });

  it("accepts {{ISO_NOW}} and {{YYYY-MM}} (now injected at runtime)", () => {
    const recipe = {
      name: "real-iso",
      trigger: { type: "manual" },
      steps: [
        {
          id: "s1",
          tool: "slack.post",
          message: "At {{ISO_NOW}} ({{YYYY-MM}})",
        },
      ],
    };
    expect(unknownTemplateErrors(recipe)).toHaveLength(0);
  });

  it("still accepts the real {{date}} / {{time}} builtins", () => {
    const recipe = {
      name: "real-date",
      trigger: { type: "manual" },
      steps: [{ id: "s1", tool: "slack.post", message: "{{date}} {{time}}" }],
    };
    expect(unknownTemplateErrors(recipe)).toHaveLength(0);
  });

  it("still flags a genuine unknown/typo template reference", () => {
    const recipe = {
      name: "typo-ref",
      trigger: { type: "manual" },
      steps: [
        { id: "s1", tool: "slack.post", message: "Hello {{notARealKey}}" },
      ],
    };
    expect(unknownTemplateErrors(recipe).join(" ")).toMatch(/notARealKey/);
  });
});

describe("recipe-validation-4: nested parallel-each loop variable", () => {
  it("does not flag {{item}} inside a parallel group's map-reduce child", () => {
    const recipe = {
      name: "nested-map-reduce",
      trigger: { type: "chained" },
      steps: [
        {
          parallel: [
            {
              id: "p1",
              parallel: {
                each: "{{items}}",
                as: "item",
                steps: [{ id: "s1", tool: "slack.post", message: "{{item}}" }],
              },
            },
          ],
        },
      ],
    };
    const errs = unknownTemplateErrors(recipe);
    expect(errs.join(" ")).not.toMatch(/\bitem\b/);
  });
});
