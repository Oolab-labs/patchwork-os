/**
 * Tests for `trigger.vars` / `trigger.inputs` name validation in
 * `validateRecipeDefinition`. The audit (2026-05-06) found `MY VAR`,
 * `123start`, and `my.var` all saved HTTP 200, then silently never
 * resolved as `{{...}}` at runtime because the template-reference
 * regex needs a valid identifier.
 */

import { describe, expect, it } from "vitest";
import { validateRecipeDefinition } from "../validation.js";

const baseRecipe = {
  name: "var-test",
  description: "test recipe",
  trigger: { type: "manual" as const },
  steps: [{ id: "s1", agent: { prompt: "hi" } }],
};

function validateWithVar(name: string) {
  return validateRecipeDefinition({
    ...baseRecipe,
    trigger: { type: "manual", vars: [{ name }] },
  });
}

describe("trigger.vars[].name validation", () => {
  it.each([
    "MY VAR",
    "my.var",
    "123start",
    "with-hyphen",
    "spaces in name",
    "trailing ",
    " leading",
    "$result",
    "weird@char",
  ])("rejects invalid name: %s", (name) => {
    const result = validateWithVar(name);
    const errors = result.issues.filter((i) => i.level === "error");
    expect(errors.some((e) => e.message.includes(`"${name}"`))).toBe(true);
  });

  it.each([
    "SENTRY_ISSUE_ID",
    "LINEAR_TEAM_KEY",
    "output_path",
    "team",
    "_internal",
    "x",
    "X",
  ])("accepts valid name: %s", (name) => {
    const result = validateWithVar(name);
    const errors = result.issues.filter(
      (i) => i.level === "error" && i.message.includes("trigger.vars"),
    );
    expect(errors).toEqual([]);
  });

  it("rejects empty name", () => {
    const result = validateWithVar("");
    const errors = result.issues.filter((i) => i.level === "error");
    expect(errors.some((e) => e.message.includes("required"))).toBe(true);
  });

  it.each([
    "payload",
    "file",
    "hash",
    "date",
    "this",
    "branch",
    "webhook_payload",
  ])("rejects reserved built-in name: %s", (name) => {
    const result = validateWithVar(name);
    const errors = result.issues.filter((i) => i.level === "error");
    expect(
      errors.some((e) => e.message.includes("shadows a reserved built-in")),
    ).toBe(true);
  });

  it("validates trigger.inputs the same way as trigger.vars", () => {
    const result = validateRecipeDefinition({
      ...baseRecipe,
      trigger: { type: "webhook", inputs: [{ name: "MY BAD" }] },
    });
    const errors = result.issues.filter((i) => i.level === "error");
    expect(
      errors.some((e) => e.message.includes("trigger.inputs[0].name")),
    ).toBe(true);
  });

  it("valid recipes from production survey lint clean", () => {
    // Mirrors the var-name conventions in ~/.patchwork/recipes/.
    const validVarShapes = [
      // SCREAMING_SNAKE (sentry-to-linear)
      ["SENTRY_ISSUE_ID", "LINEAR_TEAM_KEY", "LINEAR_PRIORITY"],
      // lowercase_snake (most others)
      ["message_id", "team", "channel", "draft", "input_glob", "output_path"],
    ];
    for (const names of validVarShapes) {
      const result = validateRecipeDefinition({
        ...baseRecipe,
        trigger: {
          type: "manual",
          vars: names.map((n) => ({ name: n, required: true })),
        },
      });
      const varErrors = result.issues.filter(
        (i) =>
          i.level === "error" &&
          (i.message.includes("trigger.vars") || i.message.includes("shadows")),
      );
      expect(varErrors).toEqual([]);
    }
  });

  it("multi-entry list reports each invalid entry by index", () => {
    const result = validateRecipeDefinition({
      ...baseRecipe,
      trigger: {
        type: "manual",
        vars: [
          { name: "VALID_ONE" },
          { name: "MY BAD" },
          { name: "VALID_TWO" },
          { name: "payload" }, // reserved
        ],
      },
    });
    const errors = result.issues.filter((i) => i.level === "error");
    // index 1 is invalid shape
    expect(
      errors.some((e) => e.message.match(/trigger\.vars\[1\].*MY BAD/)),
    ).toBe(true);
    // index 3 is reserved
    expect(
      errors.some((e) =>
        e.message.match(/trigger\.vars\[3\].*payload.*shadows/),
      ),
    ).toBe(true);
    // valid entries (0 and 2) should NOT generate errors
    expect(
      errors.filter((e) => e.message.match(/trigger\.vars\[(0|2)\]/)),
    ).toEqual([]);
  });
});
