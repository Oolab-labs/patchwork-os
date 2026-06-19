/**
 * liqTape.ts tests — render correctness + contract number registration.
 */

import { describe, expect, it } from "vitest";
import type { LiqTapeSummary } from "../liqTape.js";
import { renderLiqTape } from "../render.js";

function makeSummary(overrides: Partial<LiqTapeSummary> = {}): LiqTapeSummary {
  return {
    windowHours: 24,
    asOf: Date.now(),
    totalLongUsd: 1_200_000_000, // $1.2B
    totalShortUsd: 800_000_000, // $0.8B
    longCount: 3421,
    shortCount: 2118,
    topSymbols: [
      { sym: "BTCUSDT", longUsd: 600_000_000, shortUsd: 300_000_000 },
      { sym: "ETHUSDT", longUsd: 300_000_000, shortUsd: 200_000_000 },
    ],
    ...overrides,
  };
}

describe("renderLiqTape", () => {
  it("includes long and short USD values in md", () => {
    const frag = renderLiqTape(makeSummary());
    expect(frag.md).toContain("1.20");
    expect(frag.md).toContain("0.80");
  });

  it("includes long-liquidation share in md", () => {
    const frag = renderLiqTape(makeSummary());
    // 1.2 / (1.2 + 0.8) = 60.0%
    expect(frag.md).toContain("60.0%");
  });

  it("includes top symbol names in md", () => {
    const frag = renderLiqTape(makeSummary());
    expect(frag.md).toContain("BTCUSDT");
    expect(frag.md).toContain("ETHUSDT");
  });

  it("says 'not a forecast' to satisfy moat rule", () => {
    const frag = renderLiqTape(makeSummary());
    expect(frag.md).toContain("not a forecast");
  });

  it("includes window hours in md", () => {
    const frag = renderLiqTape(makeSummary({ windowHours: 24 }));
    expect(frag.md).toContain("24h");
  });

  it("registers longB token in numbers", () => {
    const frag = renderLiqTape(makeSummary());
    const tokens = frag.numbers.map((n) => n.token);
    expect(tokens).toContain("1.20"); // $1.2B
  });

  it("registers shortB token in numbers", () => {
    const frag = renderLiqTape(makeSummary());
    const tokens = frag.numbers.map((n) => n.token);
    expect(tokens).toContain("0.80"); // $0.8B
  });

  it("registers skew token in numbers", () => {
    const frag = renderLiqTape(makeSummary());
    const tokens = frag.numbers.map((n) => n.token);
    expect(tokens).toContain("60.0"); // skew %
  });

  it("registers count tokens in numbers", () => {
    const frag = renderLiqTape(
      makeSummary({ longCount: 3421, shortCount: 2118 }),
    );
    const tokens = frag.numbers.map((n) => n.token);
    expect(tokens).toContain("3421");
    expect(tokens).toContain("2118");
  });

  it("all numbers tokens have provenance", () => {
    const frag = renderLiqTape(makeSummary());
    for (const n of frag.numbers) {
      expect(n.provenance).toBeTruthy();
    }
  });

  it("handles zero events gracefully", () => {
    const frag = renderLiqTape(
      makeSummary({
        totalLongUsd: 0,
        totalShortUsd: 0,
        longCount: 0,
        shortCount: 0,
        topSymbols: [],
      }),
    );
    expect(frag.md).toContain("50.0%"); // zero events → 50% skew
  });
});
