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

  it("bills the gemini API driver against usdMax (does not fail open)", () => {
    const b = new RunBudget({ usdMax: 10 }, TABLE);
    // m1 = $1/1M each side → 5M in + 5M out = $10.00.
    b.reconcile(
      "gemini",
      { inputTokens: 5_000_000, outputTokens: 5_000_000 },
      "m1",
    );
    expect(b.totals().usd).toBeCloseTo(10, 6);
    expect(b.totals().usdBreached).toBe(true);
    const a = b.admit();
    expect(a.admitted).toBe(false);
    expect(a.reason).toMatch(/budget_exceeded/);
    // No "not-billed" fail-open warning for gemini.
    expect(b.warnings().some((w) => /does not incur metered/.test(w))).toBe(
      false,
    );
  });

  it("quoteUsd prices a gemini call (mirrors reconcile billing)", () => {
    const b = new RunBudget({ usdMax: 10 }, TABLE);
    const q = b.quoteUsd("gemini", "m1", 1_000_000, 0); // $1
    expect(q).toBeCloseTo(1, 6);
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

  it("does not enforce usd for the codex driver (ChatGPT subscription, not metered API billing)", () => {
    // Regression: `codex` spawns under the user's own ChatGPT-subscription CLI
    // auth, same as the Claude/Gemini subprocess drivers — not a per-token API
    // key. Even a model id that happens to collide with a priced entry must
    // not be charged notional $.
    const b = new RunBudget({ usdMax: 0.5 }, TABLE);
    b.reconcile(
      "codex",
      { inputTokens: 9_000_000, outputTokens: 9_000_000 },
      "m1",
    );
    expect(b.totals().usd).toBe(0);
    expect(b.admit().admitted).toBe(true);
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
    // non-billable driver (codex — ChatGPT subscription, not metered) → undefined.
    expect(b.quoteUsd("codex", "m1", 1_000_000, 1_000_000)).toBeUndefined();
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

// LOW #8 — priceTable loaded once at construction; stale for long runs.
// RunBudget must expose a refreshPrices() method and/or honour a TTL so that
// a user updating their price config mid-run is eventually picked up.
describe("RunBudget — stale price table refresh (audit 2026-06-03 LOW #8)", () => {
  const initialTable: PriceTable = {
    _meta: {
      _generatedAt: "2026-01-01",
      _unit: "usd_per_million_tokens",
      _source: "test",
      _note: "initial",
    },
    prices: { m1: { input: 1, output: 1 } }, // $1/1M each side
  };

  const updatedTable: PriceTable = {
    _meta: {
      _generatedAt: "2026-06-07",
      _unit: "usd_per_million_tokens",
      _source: "test",
      _note: "updated",
    },
    prices: { m1: { input: 10, output: 10 } }, // $10/1M each side — 10× price change
  };

  it("refreshPrices() replaces the live price table and subsequent reconcile uses new prices", () => {
    const b = new RunBudget({ usdMax: 100 }, initialTable);
    // First reconcile: $1/1M → 1M in + 0 out = $1.
    b.reconcile("openai", { inputTokens: 1_000_000, outputTokens: 0 }, "m1");
    expect(b.totals().usd).toBeCloseTo(1, 6);

    // Swap to the updated price table.
    b.refreshPrices(updatedTable);

    // Second reconcile: should use $10/1M → 1M in = $10.
    b.reconcile("openai", { inputTokens: 1_000_000, outputTokens: 0 }, "m1");
    // Total should be $1 (old) + $10 (new) = $11.
    expect(b.totals().usd).toBeCloseTo(11, 6);
  });

  it("refreshPrices() affects quoteUsd estimates too", () => {
    const b = new RunBudget({ usdMax: 100 }, initialTable);
    expect(b.quoteUsd("openai", "m1", 1_000_000, 0)).toBeCloseTo(1, 6);

    b.refreshPrices(updatedTable);
    expect(b.quoteUsd("openai", "m1", 1_000_000, 0)).toBeCloseTo(10, 6);
  });
});

describe("RunBudget — gemini-api driver (audit 2026-06-10 recipe-budget-1)", () => {
  it("charges metered gemini-api calls against usdMax (previously skipped)", () => {
    const b = new RunBudget({ usdMax: 100 }, TABLE);
    // $1/1M in → 1M input tokens = $1. Must be billed for "gemini-api".
    b.reconcile(
      "gemini-api",
      { inputTokens: 1_000_000, outputTokens: 0 },
      "m1",
    );
    expect(b.totals().usd).toBeCloseTo(1, 6);
    // No "notbilled" warning should be emitted for a billable driver.
    expect(b.warnings().some((w) => /not.*metered|notbilled/i.test(w))).toBe(
      false,
    );
  });

  it("enforces the usdMax cap for gemini-api spend", () => {
    const b = new RunBudget({ usdMax: 0.5 }, TABLE);
    b.reconcile(
      "gemini-api",
      { inputTokens: 1_000_000, outputTokens: 0 },
      "m1",
    );
    // $1 spent > $0.5 cap → next admission must be refused.
    expect(b.admit().admitted).toBe(false);
  });
});

describe("RunBudget — adversarial token counts (audit 2026-06-10 recipe-budget-5)", () => {
  it("ignores negative token counts instead of reducing usdSpent", () => {
    const b = new RunBudget({ usdMax: 100 }, TABLE);
    // Spend $1 legitimately.
    b.reconcile("anthropic", { inputTokens: 1_000_000, outputTokens: 0 }, "m1");
    expect(b.totals().usd).toBeCloseTo(1, 6);
    // Adversarial negative usage must NOT decrease usdSpent.
    b.reconcile(
      "anthropic",
      { inputTokens: -1_000_000, outputTokens: 0 },
      "m1",
    );
    expect(b.totals().usd).toBeCloseTo(1, 6);
    expect(b.totals().total).toBe(1_000_000); // negative tokens not added
  });

  it("ignores non-finite token counts", () => {
    const b = new RunBudget({ tokensMax: 1000 });
    b.reconcile("anthropic", {
      inputTokens: Number.POSITIVE_INFINITY,
      outputTokens: 0,
    });
    expect(b.totals().total).toBe(0);
    expect(b.admit().admitted).toBe(true);
  });
});
