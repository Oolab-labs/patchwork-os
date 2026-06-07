/**
 * Unit tests for `resolveRouting` — audit 2026-06-03 LOW #7.
 *
 * Bug: the output-token estimate was `estOutputTokens = estInputTokens`
 * (1:1 ratio), making every call appear 2× as expensive as it really is
 * for most tasks. This caused unnecessary downshifts to cheaper models.
 *
 * Fix: use a more realistic default ratio (0.3 output tokens per input
 * token — 0.3:1) so the cost estimate is closer to reality.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PriceTable } from "../pricing/priceTable.js";
import { RunBudget } from "../runBudget.js";
import { resolveRouting } from "../yamlRunner.js";

/**
 * A price table where both models cost exactly $1/1M input + $1/1M output
 * so the arithmetic is easy to reason about.
 */
const TABLE: PriceTable = {
  _meta: {
    _generatedAt: "2026-06-03",
    _unit: "usd_per_million_tokens",
    _source: "test",
    _note: "test",
  },
  prices: {
    "claude-haiku-4-5-20251001": { input: 1, output: 1 },
    // cheaper fallback at $0.25/1M in + out
    "claude-haiku-3-5-20241022": { input: 0.25, output: 0.25 },
  },
};

describe("resolveRouting — output token estimate (audit 2026-06-03 LOW #7)", () => {
  afterEach(() => vi.restoreAllMocks());

  it("estimated output tokens are less than estimated input tokens for a realistic prompt", () => {
    // 4000 chars → ROUTER_CHARS_PER_TOKEN=4 → 1000 input tokens
    const prompt = "a".repeat(4000);

    // Set a USD cap so routing kicks in; remaining budget is generous.
    const budget = new RunBudget({ usdMax: 1 }, TABLE);
    const quoteSpy = vi.spyOn(budget, "quoteUsd");

    const preferred = {
      driver: "anthropic",
      model: "claude-haiku-4-5-20251001",
    };
    const downshift = [
      { driver: "anthropic", model: "claude-haiku-3-5-20241022" },
    ];

    resolveRouting(preferred, downshift, prompt, budget);

    // quoteUsd should have been called for cost comparison.
    expect(quoteSpy).toHaveBeenCalled();

    // For every candidate quote call, the estimated output tokens must be
    // LESS than the estimated input tokens (the 1:1 bug would make them equal).
    const calls = quoteSpy.mock.calls;
    for (const [, , inputTokens, outputTokens] of calls) {
      expect(outputTokens).toBeLessThan(inputTokens);
    }
  });

  it("preferred model is NOT downshifted when it fits the budget at the realistic 0.3 output ratio", () => {
    // 4000 chars → 1000 input tokens
    // At 0.3 output ratio: ~300 output tokens
    // Cost at $1/1M each: (1000 + 300) / 1_000_000 = $0.0013
    // If remainingUsd = $0.0015, the preferred model FITS at the 0.3 ratio
    // but would NOT fit at the old 1:1 ratio (cost = $0.002 > $0.0015).
    const prompt = "a".repeat(4000);

    // Pre-spend to leave exactly $0.0015 remaining (usdMax=0.0025, spend $0.001).
    const budget = new RunBudget({ usdMax: 0.0025 }, TABLE);
    budget.reconcile(
      "anthropic",
      { inputTokens: 500, outputTokens: 500 },
      "claude-haiku-4-5-20251001",
    );

    const preferred = {
      driver: "anthropic",
      model: "claude-haiku-4-5-20251001",
    };
    const downshift = [
      { driver: "anthropic", model: "claude-haiku-3-5-20241022" },
    ];

    const result = resolveRouting(preferred, downshift, prompt, budget);

    // With a 0.3 output ratio, preferred cost ≈ $0.0013 < $0.0015 → no downshift.
    // With the old 1:1 ratio, preferred cost ≈ $0.002 > $0.0015 → would downshift.
    expect(result.model).toBe("claude-haiku-4-5-20251001");
  });
});
