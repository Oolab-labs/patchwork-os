/**
 * Recipe `on_error` policy validation — audit 2026-06-03 (MEDIUM): before this,
 * validateRecipeDefinition never checked the on_error block, so a typo'd
 * `fallback`, a non-numeric `retry`, or a negative `retry` (a real runtime
 * footgun — see chainedRunner.withRetry clamp, audit HIGH #8) all linted clean.
 * Mirrors budgetValidation.test.ts.
 */
import { describe, expect, it } from "vitest";
import { validateRecipeDefinition } from "../validation.js";

const BASE = {
  name: "e",
  version: "1.0.0",
  trigger: { type: "manual" },
  steps: [{ id: "s", agent: { prompt: "hi" } }],
};

function onErrorErrors(onError: unknown): string {
  const r = validateRecipeDefinition({ ...BASE, on_error: onError });
  return r.issues
    .filter((i) => i.level === "error")
    .map((i) => i.message)
    .join(" | ");
}

describe("recipe on_error policy validation", () => {
  it("accepts an absent on_error", () => {
    expect(validateRecipeDefinition(BASE).errors).toBe(0);
  });

  it("accepts a valid on_error (retry + retryDelay + fallback)", () => {
    expect(
      onErrorErrors({ retry: 3, retryDelay: 2000, fallback: "log_only" }),
    ).toBe("");
    expect(onErrorErrors({ fallback: "abort" })).toBe("");
    expect(onErrorErrors({ fallback: "deliver_original" })).toBe("");
  });

  it("rejects a negative or non-integer retry (the previously-missing check)", () => {
    expect(onErrorErrors({ retry: -1 })).toMatch(
      /on_error\.retry must be a non-negative integer/,
    );
    expect(onErrorErrors({ retry: 1.5 })).toMatch(
      /on_error\.retry must be a non-negative integer/,
    );
    expect(onErrorErrors({ retry: "lots" })).toMatch(
      /on_error\.retry must be a non-negative integer/,
    );
  });

  it("rejects a negative or non-numeric retryDelay", () => {
    expect(onErrorErrors({ retryDelay: -100 })).toMatch(
      /on_error\.retryDelay must be a non-negative number/,
    );
    expect(onErrorErrors({ retryDelay: "soon" })).toMatch(
      /on_error\.retryDelay must be a non-negative number/,
    );
  });

  it("rejects an unknown fallback enum value", () => {
    expect(onErrorErrors({ fallback: "explode" })).toMatch(
      /on_error\.fallback must be/,
    );
  });

  it("rejects a non-object on_error", () => {
    expect(onErrorErrors("halt")).toMatch(/'on_error' must be an object/);
    expect(onErrorErrors([1, 2])).toMatch(/'on_error' must be an object/);
  });
});
