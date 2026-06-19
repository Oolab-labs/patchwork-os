import { describe, expect, it } from "vitest";
import type { Candle } from "../../types.js";
import {
  bhSurvivors,
  evalTsmomCell,
  scoreSignal,
  tsmomSignals,
  volumeCompositeSignals,
} from "../tsmom.js";

/** Candles from closes; open = prior close (gap-free), volume constant. */
function candlesFrom(closes: number[], volumes?: number[]): Candle[] {
  return closes.map((c, t) => ({
    openTime: t * 86_400_000,
    open: t === 0 ? c : closes[t - 1]!,
    high: Math.max(c, t === 0 ? c : closes[t - 1]!),
    low: Math.min(c, t === 0 ? c : closes[t - 1]!),
    close: c,
    volume: volumes?.[t] ?? 100,
    closeTime: t * 86_400_000 + 86_399_999,
  }));
}

/** Deterministic block-trending closes: +1%/day then −1%/day in 25-bar blocks. */
function blockTrend(n: number): number[] {
  const closes: number[] = [100];
  for (let t = 1; t < n; t++) {
    const up = Math.floor(t / 25) % 2 === 0;
    closes.push(closes[t - 1]! * (up ? 1.01 : 0.99));
  }
  return closes;
}

describe("tsmomSignals", () => {
  it("computes sign of trailing L-bar return; 0 during warm-up", () => {
    const closes = [100, 101, 102, 103, 102, 101, 100, 99, 98, 97, 96, 95];
    const s = tsmomSignals(closes, 10);
    expect(s.slice(0, 10)).toEqual(Array(10).fill(0));
    expect(s[10]).toBe(-1); // 96 < 100
    expect(s[11]).toBe(-1); // 95 < 101
  });

  it("LOOK-AHEAD GUARD: signal at t is unchanged by future bars", () => {
    const a = blockTrend(120);
    const b = [...a];
    for (let t = 61; t < b.length; t++) b[t] = b[t]! * 3; // mangle the future
    const sa = tsmomSignals(a, 10);
    const sb = tsmomSignals(b, 10);
    expect(sb.slice(0, 61)).toEqual(sa.slice(0, 61));
  });
});

describe("scoreSignal", () => {
  it("H1 mechanics: enter open[t+1], exit close[t+1], signed hit", () => {
    // closes: 100 → 110 → 99 (open[t+1]=close[t] by construction)
    const candles = candlesFrom([100, 110, 99]);
    const stats = scoreSignal(candles, [1, -1, 0], 1, () => true);
    // t=0: long, r = 110/100 − 1 = +10% hit; t=1: short, r = −(99/110 − 1) = +10% hit
    expect(stats.n).toBe(2);
    expect(stats.hits).toBe(2);
    expect(stats.meanReturn).toBeCloseTo(0.1, 10);
  });

  it("H5 non-overlap: entries at least 5 bars apart", () => {
    const candles = candlesFrom(blockTrend(40));
    const always = candles.map(() => 1);
    const stats = scoreSignal(candles, always, 5, () => true);
    // entries at t = 0,5,10,... with t+5 < 40 → t ≤ 34 → 7 trades
    expect(stats.n).toBe(7);
  });

  it("respects the window filter on signal dates", () => {
    const candles = candlesFrom(blockTrend(40));
    const always = candles.map(() => 1);
    const stats = scoreSignal(candles, always, 1, (t) => t < 10);
    expect(stats.n).toBe(10);
  });
});

describe("evalTsmomCell — exhaustive circular-shift null", () => {
  it("a constant signal has zero edge (every shift is identical)", () => {
    const candles = candlesFrom(blockTrend(120));
    // Constant signal: tsmom on a monotone series. Use L=10 on pure uptrend.
    const up = Array.from({ length: 120 }, (_, t) => 100 * 1.01 ** t);
    const cell = evalTsmomCell("X", candlesFrom(up), 10, 1, "all", () => true);
    // Signal is +1 everywhere post-warm-up; shifts only move the warm-up
    // zeros around → null ≈ observed → no edge, p ≈ 1.
    expect(Math.abs(cell.edge)).toBeLessThan(0.02);
    expect(cell.p).toBeGreaterThan(0.5);
    void candles;
  });

  it("an aligned signal on single-regime-change data beats its own shifts", () => {
    // 150 bars up then 150 bars down: aperiodic, so no circular shift can
    // realign the momentum signal (a periodic fixture WOULD realign at
    // multiples of its period — the null catching periodicity is by design).
    const closes: number[] = [100];
    for (let t = 1; t < 300; t++) {
      closes.push(closes[t - 1]! * (t < 150 ? 1.01 : 0.99));
    }
    const cell = evalTsmomCell(
      "X",
      candlesFrom(closes),
      10,
      1,
      "all",
      () => true,
    );
    expect(cell.edge).toBeGreaterThan(0.1);
    expect(cell.p).toBeLessThan(0.05);
    expect(cell.observed.n).toBeGreaterThan(30);
  });
});

describe("bhSurvivors", () => {
  it("classic BH example at q=0.05", () => {
    const ps = [0.001, 0.008, 0.039, 0.041, 0.042, 0.06, 0.074, 0.205];
    const out = bhSurvivors(ps, 0.05);
    // k threshold: largest k with p(k) ≤ k/8·0.05 → 0.041 ≤ 4/8·0.05? 0.041 > 0.025;
    // 0.039 ≤ 3/8·0.05=0.01875? no; 0.008 ≤ 0.0125 yes → first two survive.
    expect(out).toEqual([true, true, false, false, false, false, false, false]);
  });
});

describe("volumeCompositeSignals", () => {
  it("LOOK-AHEAD GUARD: composite signal at t unchanged by future bars", () => {
    const closes = blockTrend(260);
    const volsA = closes.map((_, t) => 100 + (t % 7));
    const a = candlesFrom(closes, volsA);
    const b = candlesFrom(
      closes.map((c, t) => (t >= 230 ? c * 5 : c)),
      volsA.map((v, t) => (t >= 230 ? v * 9 : v)),
    );
    const sa = volumeCompositeSignals(a);
    const sb = volumeCompositeSignals(b);
    expect(sb.slice(0, 230)).toEqual(sa.slice(0, 230));
  });
});
