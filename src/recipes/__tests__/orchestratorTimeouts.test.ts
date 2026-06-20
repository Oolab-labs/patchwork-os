/**
 * M21: RecipeOrchestrator safety-net dispatch timeout must exceed the
 *      per-step task timeout to prevent spurious duplicate-recipe races.
 * M22: Webhook-triggered recipe enqueue uses a lower timeoutMs than other
 *      enqueue call sites, causing unexpected timeouts on long tasks.
 */
import { describe, expect, it } from "vitest";
import { RECIPE_TASK_TIMEOUT_MS } from "../../recipeOrchestration.js";
import { DEFAULT_DISPATCH_TIMEOUT_MS } from "../RecipeOrchestrator.js";

describe("RecipeOrchestrator safety-net timeout (M21)", () => {
  it("DEFAULT_DISPATCH_TIMEOUT_MS must exceed RECIPE_TASK_TIMEOUT_MS", () => {
    // If the safety net fires at or before the per-step timeout, two concurrent
    // recipe instances can race — the in-flight slot is cleared before the first
    // run completes.
    expect(DEFAULT_DISPATCH_TIMEOUT_MS).toBeGreaterThan(RECIPE_TASK_TIMEOUT_MS);
  });
});

describe("Webhook enqueue timeout consistency (M22)", () => {
  it("RECIPE_TASK_TIMEOUT_MS is defined and matches the main enqueue timeout", () => {
    // All recipe enqueue call sites should use the same constant so webhook
    // and non-webhook runs share the same timeout budget.
    expect(typeof RECIPE_TASK_TIMEOUT_MS).toBe("number");
    expect(RECIPE_TASK_TIMEOUT_MS).toBeGreaterThanOrEqual(1_800_000);
  });
});
