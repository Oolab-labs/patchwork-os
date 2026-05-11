import { describe, expect, it } from "vitest";
import { RunBudget } from "../runBudget.js";

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
