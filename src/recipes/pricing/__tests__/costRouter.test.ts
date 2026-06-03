/**
 * Cost-aware routing Phase 4 — the pure model selector. Author-ordered
 * candidates [preferred, ...downshift]; pick the most-preferred that fits the
 * remaining USD budget. Absent downshift ⇒ preferred unchanged.
 */
import { describe, expect, it } from "vitest";
import { costRouter, type RouteCandidate } from "../costRouter.js";

/** quote by model from a fixture; undefined = free/unpriced (always affordable). */
function quoteFrom(prices: Record<string, number | undefined>) {
  return (_driver: string | undefined, model: string | undefined) =>
    model ? prices[model] : undefined;
}

const PREF: RouteCandidate = { driver: "openai", model: "gpt-4o" };

describe("costRouter", () => {
  it("returns preferred unchanged when downshift is absent or empty", () => {
    expect(
      costRouter(PREF, undefined, { remainingUsd: 0, quote: () => 999 }),
    ).toEqual(PREF);
    expect(costRouter(PREF, [], { remainingUsd: 0, quote: () => 999 })).toEqual(
      PREF,
    );
  });

  it("keeps preferred when it fits the remaining budget", () => {
    const out = costRouter(PREF, [{ model: "cheap" }], {
      remainingUsd: 5,
      quote: quoteFrom({ "gpt-4o": 2, cheap: 0.1 }),
    });
    expect(out).toEqual({ driver: "openai", model: "gpt-4o" });
  });

  it("downshifts to the first cheaper candidate that fits", () => {
    const out = costRouter(PREF, [{ model: "mid" }, { model: "cheap" }], {
      remainingUsd: 1,
      quote: quoteFrom({ "gpt-4o": 5, mid: 2, cheap: 0.5 }),
    });
    expect(out).toEqual({ driver: "openai", model: "cheap" });
  });

  it("inherits the preferred driver for a model-only downshift entry", () => {
    const out = costRouter(PREF, [{ model: "cheap" }], {
      remainingUsd: 0.1,
      quote: quoteFrom({ "gpt-4o": 5, cheap: 0.05 }),
    });
    expect(out).toEqual({ driver: "openai", model: "cheap" });
  });

  it("treats a free/unpriced candidate (quote undefined) as affordable", () => {
    const out = costRouter(PREF, [{ driver: "local", model: "llama3" }], {
      remainingUsd: 0,
      quote: (driver) => (driver === "local" ? undefined : 999),
    });
    expect(out).toEqual({ driver: "local", model: "llama3" });
  });

  it("falls back to the cheapest listed when none fit (admit then halts)", () => {
    const out = costRouter(PREF, [{ model: "mid" }, { model: "cheap" }], {
      remainingUsd: 0.01,
      quote: quoteFrom({ "gpt-4o": 5, mid: 2, cheap: 0.5 }),
    });
    expect(out).toEqual({ driver: "openai", model: "cheap" }); // last listed
  });
});
