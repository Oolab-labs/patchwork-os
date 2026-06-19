import { describe, expect, it } from "vitest";
import type { Candle } from "../../types.js";
import { mulberry32, priceLevelHit, reversalNear, wilson } from "../scoring.js";

const DAY = 86_400_000;
function mk(highs: number[], lows: number[]): Candle[] {
  return highs.map((h, i) => ({
    openTime: i * DAY,
    open: h,
    high: h,
    low: lows[i]!,
    close: (h + lows[i]!) / 2,
    volume: 0,
    closeTime: i * DAY + (DAY - 1),
  }));
}

describe("priceLevelHit", () => {
  it("hits when a bar's range comes within ±0.5% of the level", () => {
    const future = mk([101, 100.4, 99], [100.1, 99.6, 98]);
    expect(priceLevelHit(100, future)).toBe(true); // 100±0.5 = [99.5,100.5]
  });
  it("misses when no bar comes within the band", () => {
    const future = mk([90, 91], [88, 89]);
    expect(priceLevelHit(100, future)).toBe(false);
  });
});

describe("reversalNear", () => {
  it("detects a fractal-high reversal that drops ≥1.5%", () => {
    // bar 3 is a fractal high (100), then price falls >1.5% to 98 within 5 bars
    const c = mk([90, 92, 95, 100, 96, 94, 93], [88, 90, 93, 98, 94, 92, 91]);
    expect(reversalNear(c, 3, 2)).toBe(true);
  });
  it("returns false when no qualifying reversal is near the index", () => {
    const c = mk([90, 91, 92, 93, 94, 95, 96], [89, 90, 91, 92, 93, 94, 95]);
    expect(reversalNear(c, 3, 2)).toBe(false);
  });
});

describe("wilson", () => {
  it("returns [0,0] for n=0 and a bounded interval otherwise", () => {
    expect(wilson(0, 0)).toEqual({ lo: 0, hi: 0 });
    const ci = wilson(5, 10);
    expect(ci.lo).toBeGreaterThan(0);
    expect(ci.hi).toBeLessThan(1);
    expect(ci.lo).toBeLessThan(ci.hi);
  });
});

describe("mulberry32", () => {
  it("is deterministic for a given seed (reproducible baselines)", () => {
    const a = mulberry32(42);
    const b = mulberry32(42);
    expect([a(), a(), a()]).toEqual([b(), b(), b()]);
  });
});
