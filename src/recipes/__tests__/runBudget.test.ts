import { describe, expect, it } from "vitest";
import { DEFAULT_MODEL } from "../agentExecutor.js";
import type { PriceTable } from "../pricing/priceTable.js";
import { RunBudget } from "../runBudget.js";

/** Deterministic price table injected so USD tests don't read ~/.patchwork. */
const TABLE: PriceTable = {
  _meta: {
    _generatedAt: "2026-06-03",
    _unit: "usd_per_million_tokens",
    _source: "test",
    _note: "test",
  },
  prices: {
    m1: { input: 1, output: 1 }, // $1/1M in, $1/1M out
    m2: { input: 2, output: 4 }, // $2/1M in, $4/1M out
    [DEFAULT_MODEL]: { input: 1, output: 5 }, // the omitted-model fallback
  },
};

describe("RunBudget — no policy", () => {
  it("admits everything when no policy is set", () => {
    const b = new RunBudget();
    expect(b.admit().admitted).toBe(true);
    b.reconcile("anthropic", { inputTokens: 100, outputTokens: 50 });
    expect(b.admit().admitted).toBe(true);
    expect(b.totals().total).toBe(0); // no-policy short-circuits reconcile
  });
});

describe("RunBudget — tokensMax with default halt", () => {
  it("admits while under cap and refuses when total >= tokensMax", () => {
    const b = new RunBudget({ tokensMax: 1000 });
    expect(b.admit().admitted).toBe(true);

    b.reconcile("anthropic", { inputTokens: 400, outputTokens: 400 });
    // total = 800, still under cap
    expect(b.admit().admitted).toBe(true);

    b.reconcile("anthropic", { inputTokens: 200, outputTokens: 100 });
    // total = 1100, breached
    const a = b.admit();
    expect(a.admitted).toBe(false);
    expect(a.reason).toMatch(/budget_exceeded/);
    expect(a.reason).toMatch(/tokensMax=1000/);
  });

  it("totals() reports remaining and breached state", () => {
    const b = new RunBudget({ tokensMax: 500 });
    b.reconcile("anthropic", { inputTokens: 200, outputTokens: 150 });
    expect(b.totals()).toMatchObject({
      inputTokens: 200,
      outputTokens: 150,
      total: 350,
      remaining: 150,
      breached: false,
      haltOnBreach: true,
    });
    b.reconcile("anthropic", { inputTokens: 200, outputTokens: 0 });
    expect(b.totals().breached).toBe(true);
    expect(b.totals().remaining).toBe(0);
  });
});

describe("RunBudget — onBreach=warn", () => {
  it("never refuses admission; emits one in-band warning on first breach", () => {
    const b = new RunBudget({ tokensMax: 100, onBreach: "warn" });
    b.reconcile("anthropic", { inputTokens: 60, outputTokens: 60 });
    expect(b.admit().admitted).toBe(true);
    expect(b.totals().breached).toBe(true);
    expect(b.warnings().some((w) => /exceeded/i.test(w))).toBe(true);
    // Subsequent reconciles don't duplicate the breach warning
    b.reconcile("anthropic", { inputTokens: 50, outputTokens: 50 });
    expect(b.warnings().filter((w) => /exceeded/i.test(w))).toHaveLength(1);
  });
});

describe("RunBudget — subscription-driver fail-open", () => {
  it("records a deduped warning per unmeasured driver, never blocks", () => {
    const b = new RunBudget({ tokensMax: 100 });
    b.reconcile("subprocess", undefined);
    b.reconcile("subprocess", undefined);
    b.reconcile("claude-code", undefined);
    const warns = b.warnings();
    expect(
      warns.filter((w) => /subprocess.*does not report/i.test(w)),
    ).toHaveLength(1);
    expect(
      warns.filter((w) => /claude-code.*does not report/i.test(w)),
    ).toHaveLength(1);
    expect(b.totals().total).toBe(0);
    expect(b.admit().admitted).toBe(true);
  });

  it("does not record warnings when no tokensMax is configured", () => {
    const b = new RunBudget();
    b.reconcile("subprocess", undefined);
    expect(b.warnings()).toHaveLength(0);
  });
});

describe("RunBudget — usdMax (cost-routing Phase 3)", () => {
  it("enforces usdMax for a measured + priced call (halt)", () => {
    const b = new RunBudget({ usdMax: 10 }, TABLE);
    expect(b.admit().admitted).toBe(true);
    // m1 = $1/1M each side → 5M in + 5M out = $10.00.
    b.reconcile(
      "openai",
      { inputTokens: 5_000_000, outputTokens: 5_000_000 },
      "m1",
    );
    expect(b.totals().usd).toBeCloseTo(10, 6);
    expect(b.totals().usdBreached).toBe(true);
    const a = b.admit();
    expect(a.admitted).toBe(false);
    expect(a.reason).toMatch(/budget_exceeded/);
    expect(a.reason).toMatch(/usdMax=\$10/);
  });

  it("admits under the cap and reports usd / usdRemaining", () => {
    const b = new RunBudget({ usdMax: 10 }, TABLE);
    b.reconcile("openai", { inputTokens: 1_000_000, outputTokens: 0 }, "m1"); // $1
    expect(b.admit().admitted).toBe(true);
    expect(b.totals().usd).toBeCloseTo(1, 6);
    expect(b.totals().usdRemaining).toBeCloseTo(9, 6);
    expect(b.totals().usdBreached).toBe(false);
  });

  it("fails open for an unpriced model (warn once, no spend, never halts)", () => {
    const b = new RunBudget({ usdMax: 1 }, TABLE);
    const huge = { inputTokens: 9_000_000, outputTokens: 9_000_000 };
    b.reconcile("openai", huge, "unknown-model");
    b.reconcile("openai", huge, "unknown-model");
    expect(b.totals().usd).toBe(0);
    expect(b.admit().admitted).toBe(true);
    expect(
      b.warnings().filter((w) => /not in the price table/i.test(w)),
    ).toHaveLength(1);
  });

  it("fails open for an unmeasured driver under a usd cap", () => {
    const b = new RunBudget({ usdMax: 1 }, TABLE);
    b.reconcile("subprocess", undefined, "m1");
    expect(b.totals().usd).toBe(0);
    expect(b.admit().admitted).toBe(true);
    expect(
      b.warnings().some((w) => /does not report token usage/i.test(w)),
    ).toBe(true);
  });

  it("warn mode never refuses on a usd breach", () => {
    const b = new RunBudget({ usdMax: 1, onBreach: "warn" }, TABLE);
    b.reconcile("openai", { inputTokens: 2_000_000, outputTokens: 0 }, "m1"); // $2
    expect(b.admit().admitted).toBe(true);
    expect(b.warnings().some((w) => /USD budget exceeded.*warn/i.test(w))).toBe(
      true,
    );
  });

  it("computes no usd when usdMax is absent", () => {
    const b = new RunBudget({ tokensMax: 100 }, TABLE);
    b.reconcile("openai", { inputTokens: 1_000_000, outputTokens: 0 }, "m1");
    expect(b.totals().usd).toBeUndefined();
  });

  it("enforces tokensMax and usdMax together (usd trips first here)", () => {
    const b = new RunBudget({ tokensMax: 10_000_000, usdMax: 3 }, TABLE);
    // m2 output $4/1M → 1M out = $4 ≥ $3 while only 1M << 10M tokens.
    b.reconcile("openai", { inputTokens: 0, outputTokens: 1_000_000 }, "m2");
    const a = b.admit();
    expect(a.admitted).toBe(false);
    expect(a.reason).toMatch(/usd=/);
  });

  it("does not enforce usd for a non-billable driver (local), even with a priced model", () => {
    // Regression: `local` reports usage but costs no real money. A priced
    // model (or the Haiku default stamp) must not charge it notional $.
    const b = new RunBudget({ usdMax: 0.5 }, TABLE);
    b.reconcile(
      "local",
      { inputTokens: 9_000_000, outputTokens: 9_000_000 },
      "m1",
    );
    expect(b.totals().usd).toBe(0);
    expect(b.admit().admitted).toBe(true);
    expect(
      b.warnings().some((w) => /does not incur metered API cost/i.test(w)),
    ).toBe(true);
  });

  it("never poisons usd accounting for a prototype-key model name", () => {
    // Regression: a model id colliding with an Object.prototype key
    // ("__proto__", "constructor", …) must resolve to unpriced (undefined),
    // not a prototype member → NaN → permanently-disabled cap.
    const b = new RunBudget({ usdMax: 1 }, TABLE);
    for (const evil of ["__proto__", "constructor", "toString", "valueOf"]) {
      b.reconcile(
        "openai",
        { inputTokens: 9_000_000, outputTokens: 9_000_000 },
        evil,
      );
    }
    expect(b.totals().usd).toBe(0);
    expect(Number.isNaN(b.totals().usd as number)).toBe(false);
    expect(b.admit().admitted).toBe(true);
    // A genuinely-priced call afterward still enforces (accounting not poisoned).
    b.reconcile(
      "openai",
      { inputTokens: 5_000_000, outputTokens: 5_000_000 },
      "m1",
    );
    expect(b.totals().usd).toBeCloseTo(10, 6);
    expect(b.admit().admitted).toBe(false);
  });
});

describe("RunBudget — routing helpers (cost-routing Phase 4)", () => {
  it("remainingUsd tracks spend; undefined without a usd cap", () => {
    expect(
      new RunBudget({ tokensMax: 100 }, TABLE).remainingUsd(),
    ).toBeUndefined();
    const b = new RunBudget({ usdMax: 10 }, TABLE);
    expect(b.remainingUsd()).toBe(10);
    b.reconcile("openai", { inputTokens: 1_000_000, outputTokens: 0 }, "m1"); // $1
    expect(b.remainingUsd()).toBeCloseTo(9, 6);
  });

  it("quoteUsd prices a billable+priced call; undefined otherwise", () => {
    const b = new RunBudget({ usdMax: 10 }, TABLE);
    // m1 $1/1M each side → 1M+1M = $2.
    expect(b.quoteUsd("openai", "m1", 1_000_000, 1_000_000)).toBeCloseTo(2, 6);
    // undefined driver (auto-detect) is treated as billable (anthropic).
    expect(b.quoteUsd(undefined, "m1", 1_000_000, 0)).toBeCloseTo(1, 6);
    // non-billable driver (local) → undefined (free, never enforced).
    expect(b.quoteUsd("local", "m1", 1_000_000, 1_000_000)).toBeUndefined();
    // unpriced model → undefined.
    expect(b.quoteUsd("openai", "nope", 1_000_000, 1_000_000)).toBeUndefined();
    // openai with missing model → undefined (provider default unknown here).
    expect(
      b.quoteUsd("openai", undefined, 1_000_000, 1_000_000),
    ).toBeUndefined();
  });

  it("quoteUsd mirrors reconcile resolution for the anthropic aliases (review fix)", () => {
    const b = new RunBudget({ usdMax: 10 }, TABLE);
    // "api" and "claude" both resolve to the billable anthropic path, so they
    // must be priced exactly like an explicit "anthropic" — not treated as free
    // (the bug: the router never downshifted driver: api/claude steps).
    const expected = b.quoteUsd("anthropic", "m1", 1_000_000, 1_000_000);
    expect(expected).toBeCloseTo(2, 6);
    expect(b.quoteUsd("api", "m1", 1_000_000, 1_000_000)).toBe(expected);
    expect(b.quoteUsd("claude", "m1", 1_000_000, 1_000_000)).toBe(expected);
  });

  it("quoteUsd prices an omitted model on the anthropic path at DEFAULT_MODEL", () => {
    const b = new RunBudget({ usdMax: 10 }, TABLE);
    // DEFAULT_MODEL priced $1 in / $5 out → 1M+1M = $6 — what reconcile charges.
    expect(
      b.quoteUsd("anthropic", undefined, 1_000_000, 1_000_000),
    ).toBeCloseTo(6, 6);
    expect(b.quoteUsd(undefined, undefined, 1_000_000, 1_000_000)).toBeCloseTo(
      6,
      6,
    );
  });

  it("quoteUsd is undefined when no usd cap is set (no routing)", () => {
    const b = new RunBudget({ tokensMax: 100 }, TABLE);
    expect(b.quoteUsd("openai", "m1", 1_000_000, 1_000_000)).toBeUndefined();
  });
});

describe("RunBudget — estimateUnmeasured (opt-in ≈$ for subscription drivers)", () => {
  // 4M chars / 4 = 1M tokens each side.
  const est = { inputChars: 4_000_000, outputChars: 4_000_000 };

  it("default (false): an unmeasured driver is skipped, no estimate", () => {
    const b = new RunBudget({ usdMax: 1 }, TABLE);
    b.reconcile("subprocess", undefined, "m1", est);
    expect(b.totals().usdEstimated).toBeUndefined();
    expect(
      b.warnings().some((w) => /does not report token usage/i.test(w)),
    ).toBe(true);
  });

  it("when true: accumulates a notional ≈$ estimate (m1 $1/1M each → $2)", () => {
    const b = new RunBudget({ usdMax: 1, estimateUnmeasured: true }, TABLE);
    b.reconcile("subprocess", undefined, "m1", est);
    expect(b.totals().usdEstimated).toBeCloseTo(2, 6);
    expect(b.warnings().some((w) => /estimating notional/i.test(w))).toBe(true);
  });

  it("NEVER halts on the estimate (warn-only) and never touches measured usd", () => {
    const b = new RunBudget({ usdMax: 0.001, estimateUnmeasured: true }, TABLE);
    b.reconcile("subprocess", undefined, "m1", est); // ≈$2 ≫ $0.001 cap
    expect(b.admit().admitted).toBe(true); // estimate never gates admission
    expect(b.totals().usd).toBe(0); // never enters measured usdSpent
    expect(b.totals().usdBreached).toBe(false);
  });

  it("uses DEFAULT_MODEL when the step omits a model", () => {
    const b = new RunBudget({ usdMax: 1, estimateUnmeasured: true }, TABLE);
    // DEFAULT_MODEL $1 in / $5 out → 1M*$1 + 1M*$5 = $6.
    b.reconcile("subprocess", undefined, undefined, est);
    expect(b.totals().usdEstimated).toBeCloseTo(6, 6);
  });

  it("falls back to the skipped notice when no estimate chars are provided", () => {
    const b = new RunBudget({ usdMax: 1, estimateUnmeasured: true }, TABLE);
    b.reconcile("subprocess", undefined, "m1"); // no estimate arg
    expect(b.totals().usdEstimated).toBeUndefined();
    expect(
      b.warnings().some((w) => /does not report token usage/i.test(w)),
    ).toBe(true);
  });

  it("does nothing when estimateUnmeasured is set but usdMax is not", () => {
    const b = new RunBudget(
      { tokensMax: 100, estimateUnmeasured: true },
      TABLE,
    );
    b.reconcile("subprocess", undefined, "m1", est);
    expect(b.totals().usdEstimated).toBeUndefined();
  });

  it("finalWarnings appends a ≈$ summary; warnings() (live) does not", () => {
    const b = new RunBudget({ usdMax: 1, estimateUnmeasured: true }, TABLE);
    b.reconcile("subprocess", undefined, "m1", est);
    expect(
      b
        .finalWarnings()
        .some((w) => w.includes("≈$2.0000") && /never enforced/i.test(w)),
    ).toBe(true);
    expect(b.warnings().some((w) => /at list prices/i.test(w))).toBe(false);
  });
});
