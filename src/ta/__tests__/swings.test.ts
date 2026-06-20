import { describe, expect, it } from "vitest";
import { detectSwings, latestReversal, latestSwing } from "../swings.js";
import type { Candle } from "../types.js";

const DAY = 86_400_000;

/** Build candles from high/low arrays; open/close/volume are immaterial here. */
function mk(highs: number[], lows: number[]): Candle[] {
  return highs.map((h, i) => ({
    openTime: i * DAY,
    open: h,
    high: h,
    low: lows[i]!,
    close: h,
    volume: 0,
    closeTime: i * DAY + (DAY - 1),
  }));
}

describe("detectSwings", () => {
  it("detects a clear swing high (strictly greater both sides, N=2)", () => {
    const c = mk([10, 11, 15, 11, 10], [5, 5, 5, 5, 5]);
    const s = detectSwings(c, 2);
    expect(s).toHaveLength(1);
    expect(s[0]).toMatchObject({ index: 2, kind: "high", price: 15 });
  });

  it("detects a clear swing low", () => {
    const c = mk([20, 20, 20, 20, 20], [10, 9, 5, 9, 10]);
    const s = detectSwings(c, 2);
    expect(s).toHaveLength(1);
    expect(s[0]).toMatchObject({ index: 2, kind: "low", price: 5 });
  });

  it("rejects ties (strict comparison) — equal adjacent high is not a swing", () => {
    const c = mk([10, 11, 15, 15, 10], [5, 5, 5, 5, 5]);
    expect(detectSwings(c, 2)).toHaveLength(0);
  });

  it("never classifies the trailing N bars (no-lookahead guarantee)", () => {
    // bar 2 is a confirmed swing high; bar 7 (the global max, 25) is in the
    // trailing N window and MUST NOT be returned — a walk-forward cursor here
    // has not yet seen the bars that would confirm it.
    const c = mk([10, 11, 20, 11, 10, 9, 8, 25], [5, 5, 5, 5, 5, 5, 5, 5]);
    const s = detectSwings(c, 2);
    expect(s).toHaveLength(1);
    expect(s[0]).toMatchObject({ index: 2, kind: "high" });
    expect(s.every((x) => x.index <= c.length - 1 - 2)).toBe(true);
  });

  it("returns swings in chronological order", () => {
    const c = mk([10, 11, 20, 11, 10, 11, 12], [5, 5, 5, 5, 2, 5, 5]);
    const s = detectSwings(c, 2);
    expect(s.map((x) => x.index)).toEqual([2, 4]);
    expect(s[0]!.kind).toBe("high");
    expect(s[1]!.kind).toBe("low");
  });

  it("throws on N < 1", () => {
    expect(() => detectSwings(mk([1, 2, 3], [0, 0, 0]), 0)).toThrow();
  });
});

describe("latestSwing / latestReversal", () => {
  const c = mk([10, 11, 20, 11, 10, 11, 12], [5, 5, 5, 5, 2, 5, 5]);
  const s = detectSwings(c, 2);

  it("finds the most recent swing of a kind", () => {
    expect(latestSwing(s, "high")).toMatchObject({ index: 2 });
    expect(latestSwing(s, "low")).toMatchObject({ index: 4 });
  });

  it("latestReversal returns the most recent swing of either kind", () => {
    expect(latestReversal(s)).toMatchObject({ index: 4, kind: "low" });
  });

  it("returns null when no swing of the kind exists", () => {
    expect(latestSwing([], "high")).toBeNull();
    expect(latestReversal([])).toBeNull();
  });
});
