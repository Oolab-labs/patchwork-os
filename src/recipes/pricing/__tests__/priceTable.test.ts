/**
 * Cost-aware routing Phase 2 — price table data + loader.
 * Pins the override precedence (env > ~/.patchwork > built-in), fail-open on
 * unknown model / malformed override, costUsd math, and the pure staleness
 * helper. The table itself is dormant (no consumer yet) — these tests are the
 * contract Phase 3's RunBudget will build on.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  BUILTIN_PRICE_TABLE,
  costUsd,
  isPriceTableStale,
  loadPriceTable,
  priceFor,
} from "../priceTable.js";

let tmp = "";
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "pw-prices-"));
});
afterEach(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

function writeHomePrices(home: string, json: unknown): void {
  mkdirSync(join(home, ".patchwork"), { recursive: true });
  writeFileSync(join(home, ".patchwork", "prices.json"), JSON.stringify(json));
}

describe("BUILTIN_PRICE_TABLE", () => {
  it("every entry has non-negative numeric input/output prices", () => {
    for (const [model, p] of Object.entries(BUILTIN_PRICE_TABLE.prices)) {
      expect(typeof p.input, model).toBe("number");
      expect(typeof p.output, model).toBe("number");
      expect(p.input, model).toBeGreaterThanOrEqual(0);
      expect(p.output, model).toBeGreaterThanOrEqual(0);
    }
  });

  it("carries a parseable, non-future _generatedAt that is not yet stale", () => {
    const { _generatedAt } = BUILTIN_PRICE_TABLE._meta;
    expect(Number.isNaN(Date.parse(_generatedAt))).toBe(false);
    expect(isPriceTableStale(_generatedAt, Date.now())).toBe(false);
  });

  it("prices the default agent model (claude-haiku-4-5-20251001)", () => {
    expect(priceFor("claude-haiku-4-5-20251001")).toBeDefined();
  });
});

describe("costUsd", () => {
  it("computes input+output cost from per-million prices", () => {
    // gpt-4o = $2.5/1M in, $10/1M out. 400k in + 100k out = 1.0 + 1.0 = $2.00.
    const cost = costUsd("gpt-4o", {
      inputTokens: 400_000,
      outputTokens: 100_000,
    });
    expect(cost).toBeCloseTo(2.0, 6);
  });

  it("returns undefined for an unpriced model (fail-open)", () => {
    expect(
      costUsd("some-unknown-model", { inputTokens: 1000, outputTokens: 1000 }),
    ).toBeUndefined();
  });

  it("returns undefined (not NaN) for a prototype-key model name", () => {
    // Regression: bare bracket lookup would return Object.prototype members.
    for (const evil of ["__proto__", "constructor", "toString", "valueOf"]) {
      expect(priceFor(evil), evil).toBeUndefined();
      const cost = costUsd(evil, {
        inputTokens: 1_000_000,
        outputTokens: 1_000_000,
      });
      expect(cost, evil).toBeUndefined();
    }
  });
});

describe("loadPriceTable precedence", () => {
  it("returns the built-in table when no override exists", () => {
    const t = loadPriceTable({ env: {}, homeDir: tmp });
    expect(t.prices).toEqual(BUILTIN_PRICE_TABLE.prices);
    expect(t._meta._override).toBeUndefined();
  });

  it("merges ~/.patchwork/prices.json over the built-in", () => {
    writeHomePrices(tmp, {
      prices: {
        "gpt-4o": { input: 99, output: 99 }, // override existing
        "my-local-model": { input: 0, output: 0 }, // add new
      },
    });
    const t = loadPriceTable({ env: {}, homeDir: tmp });
    expect(t.prices["gpt-4o"]).toEqual({ input: 99, output: 99 });
    expect(t.prices["my-local-model"]).toEqual({ input: 0, output: 0 });
    // untouched built-in entries survive
    expect(t.prices["claude-haiku-4-5-20251001"]).toEqual(
      BUILTIN_PRICE_TABLE.prices["claude-haiku-4-5-20251001"],
    );
    expect(t._meta._override).toContain("prices.json");
  });

  it("env PATCHWORK_PRICE_TABLE takes precedence over ~/.patchwork", () => {
    writeHomePrices(tmp, { prices: { "gpt-4o": { input: 1, output: 1 } } });
    const envFile = join(tmp, "env-prices.json");
    writeFileSync(
      envFile,
      JSON.stringify({ prices: { "gpt-4o": { input: 42, output: 42 } } }),
    );
    const t = loadPriceTable({
      env: { PATCHWORK_PRICE_TABLE: envFile },
      homeDir: tmp,
    });
    expect(t.prices["gpt-4o"]).toEqual({ input: 42, output: 42 });
  });

  it("accepts a bare {model: price} map (no wrapping `prices`)", () => {
    writeHomePrices(tmp, { "gpt-4o": { input: 7, output: 7 } });
    const t = loadPriceTable({ env: {}, homeDir: tmp });
    expect(t.prices["gpt-4o"]).toEqual({ input: 7, output: 7 });
  });

  it("ignores malformed entries but keeps valid ones", () => {
    writeHomePrices(tmp, {
      prices: {
        "gpt-4o": { input: "free", output: 5 }, // bad input type → skipped
        "ok-model": { input: 1, output: 2 }, // valid → kept
      },
    });
    const t = loadPriceTable({ env: {}, homeDir: tmp });
    expect(t.prices["gpt-4o"]).toEqual(BUILTIN_PRICE_TABLE.prices["gpt-4o"]);
    expect(t.prices["ok-model"]).toEqual({ input: 1, output: 2 });
  });

  it("fails open to the built-in on unreadable / malformed JSON", () => {
    mkdirSync(join(tmp, ".patchwork"), { recursive: true });
    writeFileSync(join(tmp, ".patchwork", "prices.json"), "{ not valid json");
    const t = loadPriceTable({ env: {}, homeDir: tmp });
    expect(t.prices).toEqual(BUILTIN_PRICE_TABLE.prices);
  });
});

describe("isPriceTableStale", () => {
  const now = Date.parse("2026-06-10T00:00:00Z");

  it("is false for a recent date", () => {
    expect(isPriceTableStale("2026-06-03", now)).toBe(false);
  });

  it("is true past the max age", () => {
    expect(isPriceTableStale("2020-01-01", now)).toBe(true);
  });

  it("is true for a future date", () => {
    expect(isPriceTableStale("2099-01-01", now)).toBe(true);
  });

  it("is true for an unparseable date", () => {
    expect(isPriceTableStale("not-a-date", now)).toBe(true);
  });

  it("honours a custom maxAgeDays", () => {
    // 100 days old, threshold 30 → stale.
    const old = Date.parse("2026-03-02T00:00:00Z");
    expect(isPriceTableStale("2026-03-02", old + 100 * 86_400_000, 30)).toBe(
      true,
    );
  });
});
