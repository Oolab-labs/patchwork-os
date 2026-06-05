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
