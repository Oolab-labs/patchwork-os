/**
 * Recipe-validation parity gaps (Group R2). Each block reproduces a real
 * deficiency in `validateRecipeDefinition` before its fix:
 *   1. root-level `vars:` silently dropped at runtime (only trigger.vars /
 *      trigger.inputs are read — PR#259 trap) → no warning.
 *   2. reserved-var case mismatch — `yyyy` shadows the built-in date key but
 *      passed the reserved-name gate (set stored UPPERCASE, lookup lowercased).
 *   3. driver: claude|anthropic with no ANTHROPIC_API_KEY in env → no warning
 *      (the "driver:claude = API not subscription" trap).
 *   4. duplicate step id → never rejected.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { validateRecipeDefinition } from "../validation.js";

const baseRecipe = {
  name: "parity-test",
  description: "test recipe",
  trigger: { type: "manual" as const },
  steps: [{ id: "s1", agent: { prompt: "hi" } }],
};

describe("root-level vars warning", () => {
  it("warns that a top-level `vars` key is ignored at runtime", () => {
    const result = validateRecipeDefinition({
      ...baseRecipe,
      vars: { foo: "bar" },
    });
    const issue = result.issues.find((i) => i.code === "root-vars-ignored");
    expect(issue).toBeDefined();
    expect(issue?.level).toBe("warning");
  });

  it("does not warn when there is no root vars key", () => {
    const result = validateRecipeDefinition(baseRecipe);
    expect(result.issues.some((i) => i.code === "root-vars-ignored")).toBe(
      false,
    );
  });
});

describe("reserved-var case mismatch", () => {
  it.each([
    "yyyy",
    "YYYY",
    "iso_now",
    "Hh",
  ])("rejects date-key var name regardless of case: %s", (name) => {
    const result = validateRecipeDefinition({
      ...baseRecipe,
      trigger: { type: "manual", vars: [{ name }] },
    });
    const errors = result.issues.filter((i) => i.level === "error");
    expect(
      errors.some((e) => e.message.includes("shadows a reserved built-in")),
    ).toBe(true);
  });
});

describe("driver-api-key preflight", () => {
  const saved = process.env.ANTHROPIC_API_KEY;
  beforeEach(() => {
    delete process.env.ANTHROPIC_API_KEY;
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = saved;
  });

  it.each([
    "claude",
    "anthropic",
  ])("warns when driver:%s is used with no ANTHROPIC_API_KEY", (driver) => {
    const result = validateRecipeDefinition({
      ...baseRecipe,
      steps: [{ id: "s1", agent: { prompt: "hi", driver } }],
    });
    const issue = result.issues.find(
      (i) => i.code === "driver-api-key-required",
    );
    expect(issue).toBeDefined();
    expect(issue?.level).toBe("warning");
  });

  it("does not warn when ANTHROPIC_API_KEY is set", () => {
    process.env.ANTHROPIC_API_KEY = "sk-test";
    const result = validateRecipeDefinition({
      ...baseRecipe,
      steps: [{ id: "s1", agent: { prompt: "hi", driver: "claude" } }],
    });
    expect(
      result.issues.some((i) => i.code === "driver-api-key-required"),
    ).toBe(false);
  });

  it("does not warn for subprocess driver", () => {
    const result = validateRecipeDefinition({
      ...baseRecipe,
      steps: [{ id: "s1", agent: { prompt: "hi", driver: "subprocess" } }],
    });
    expect(
      result.issues.some((i) => i.code === "driver-api-key-required"),
    ).toBe(false);
  });
});

describe("duplicate step id", () => {
  it("rejects two steps with the same id", () => {
    const result = validateRecipeDefinition({
      ...baseRecipe,
      steps: [
        { id: "dup", agent: { prompt: "a" } },
        { id: "dup", agent: { prompt: "b" } },
      ],
    });
    const issue = result.issues.find((i) => i.code === "duplicate-step-id");
    expect(issue).toBeDefined();
    expect(issue?.level).toBe("error");
  });

  it("accepts distinct step ids", () => {
    const result = validateRecipeDefinition({
      ...baseRecipe,
      steps: [
        { id: "one", agent: { prompt: "a" } },
        { id: "two", agent: { prompt: "b" } },
      ],
    });
    expect(result.issues.some((i) => i.code === "duplicate-step-id")).toBe(
      false,
    );
  });
});

// LOW #4 — flattenValidationStep skips validation of conditional step fields
// when `otherwise` is present. A branch entry like { if, step, otherwise }
// should still validate the step fields even though `otherwise` is also present.
describe("branch otherwise does not skip co-located step validation (audit 2026-06-03 LOW #4)", () => {
  it("catches invalid step fields inside a branch entry that also has otherwise", () => {
    const result = validateRecipeDefinition({
      ...baseRecipe,
      steps: [
        {
          branch: [
            {
              if: "{{some_var}}",
              // prompt must be a string; 123 is invalid
              agent: { prompt: 123 },
              otherwise: { id: "fallback", agent: { prompt: "ok" } },
            },
          ],
        },
      ],
    });
    const errors = result.issues.filter((i) => i.level === "error");
    expect(errors.length).toBeGreaterThan(0);
  });

  it("still validates the otherwise block", () => {
    const result = validateRecipeDefinition({
      ...baseRecipe,
      steps: [
        {
          branch: [
            {
              if: "{{some_var}}",
              agent: { prompt: "valid prompt" },
              otherwise: { id: "fallback", agent: { prompt: 999 } },
            },
          ],
        },
      ],
    });
    const errors = result.issues.filter((i) => i.level === "error");
    expect(errors.length).toBeGreaterThan(0);
  });
});

/**
 * `expect.outputs` names step ids on a chained recipe and agent `into:` keys /
 * resolved file paths on a flat one — deliberate, since that is what each
 * runner is keyed by. The failure mode is quiet and expensive: a path-shaped
 * entry on a chained recipe can never match, and only says so at the END of a
 * run that already did all its work.
 */
describe("chained expect.outputs written in the flat runner's vocabulary", () => {
  const chained = {
    name: "chained-outputs",
    description: "test recipe",
    trigger: { type: "chained" as const },
    steps: [{ id: "fetch", tool: "http.get", url: "https://example.test/x" }],
  };

  it("warns on a path-shaped entry", () => {
    const result = validateRecipeDefinition({
      ...chained,
      expect: { outputs: ["~/.patchwork/inbox/out.md"] },
    });
    const issue = result.issues.find(
      (i) => i.code === "chained-expect-outputs-path",
    );
    expect(issue).toBeDefined();
    expect(issue?.level).toBe("warning");
  });

  it("does not warn on a plain step id", () => {
    const result = validateRecipeDefinition({
      ...chained,
      expect: { outputs: ["fetch"] },
    });
    expect(
      result.issues.some((i) => i.code === "chained-expect-outputs-path"),
    ).toBe(false);
  });

  it("warns once per offending entry and leaves valid ones alone", () => {
    const result = validateRecipeDefinition({
      ...chained,
      expect: { outputs: ["fetch", "/abs/a.md", "~/b.md"] },
    });
    expect(
      result.issues.filter((i) => i.code === "chained-expect-outputs-path"),
    ).toHaveLength(2);
  });

  /**
   * The flat runner is where a path IS the right vocabulary, so the rule must
   * not fire there — otherwise it would train authors to ignore it.
   */
  it("never fires on a flat recipe, where a path is correct", () => {
    const result = validateRecipeDefinition({
      name: "flat-outputs",
      description: "test recipe",
      trigger: { type: "manual" as const },
      steps: [{ id: "s1", agent: { prompt: "hi" }, into: "brief" }],
      expect: { outputs: ["~/.patchwork/inbox/out.md"] },
    });
    expect(
      result.issues.some((i) => i.code === "chained-expect-outputs-path"),
    ).toBe(false);
  });
});
