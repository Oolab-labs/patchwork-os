/**
 * Recipe budget validation — cost-routing Phase 3 closes a real gap: before
 * this, validateRecipeDefinition had NO budget checks, so `tokensMax: -5` or
 * `usdMax: "lots"` linted clean and only misbehaved at runtime.
 */
import { describe, expect, it } from "vitest";
import { validateRecipeDefinition } from "../validation.js";

const BASE = {
  name: "b",
  version: "1.0.0",
  trigger: { type: "manual" },
  steps: [{ id: "s", agent: { prompt: "hi" } }],
};

function budgetErrors(budget: unknown): string {
  const r = validateRecipeDefinition({ ...BASE, budget });
  return r.issues
    .filter((i) => i.level === "error")
    .map((i) => i.message)
    .join(" | ");
}

describe("recipe budget validation", () => {
  it("accepts a valid budget (tokensMax + usdMax + onBreach)", () => {
    expect(
      budgetErrors({ tokensMax: 1000, usdMax: 2.5, onBreach: "warn" }),
    ).toBe("");
  });

  it("accepts an absent budget", () => {
    expect(validateRecipeDefinition(BASE).errors).toBe(0);
  });

  it("rejects a non-positive tokensMax (the previously-missing check)", () => {
    expect(budgetErrors({ tokensMax: -5 })).toMatch(
      /tokensMax must be a positive number/,
    );
    expect(budgetErrors({ tokensMax: 0 })).toMatch(
      /tokensMax must be a positive number/,
    );
  });

  it("rejects a non-numeric / non-positive usdMax", () => {
    expect(budgetErrors({ usdMax: "lots" })).toMatch(
      /usdMax must be a positive number/,
    );
    expect(budgetErrors({ usdMax: 0 })).toMatch(
      /usdMax must be a positive number/,
    );
  });

  it("rejects an invalid onBreach", () => {
    expect(budgetErrors({ tokensMax: 10, onBreach: "explode" })).toMatch(
      /onBreach must be/,
    );
  });

  it("rejects a non-object budget", () => {
    expect(budgetErrors("nope")).toMatch(/'budget' must be an object/);
  });
});
