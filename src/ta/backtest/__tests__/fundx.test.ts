import { describe, expect, it } from "vitest";
import type { Candle } from "../../types.js";
import {
  detectEvents,
  f7Series,
  fwdMaxDrawdown,
  fwdReturn,
  mannWhitneyP,
  matchedBaseline,
  trail14,
  trailingPercentile,
} from "../fundx.js";

const DAY = 86_400_000;

function candlesFrom(closes: number[]): Candle[] {
  return closes.map((c, t) => ({
    openTime: t * DAY,
    open: t === 0 ? c : closes[t - 1]!,
    high: Math.max(c, t === 0 ? c : closes[t - 1]!) * 1.001,
    low: Math.min(c, t === 0 ? c : closes[t - 1]!) * 0.999,
    close: c,
    volume: 100,
    closeTime: t * DAY + DAY - 1,
  }));
}

/** Mild deterministic uptrend. */
function uptrend(n: number): number[] {
  const closes = [100];
  for (let t = 1; t < n; t++) {
    closes.push(closes[t - 1]! * (t % 3 === 0 ? 0.998 : 1.004));
  }
  return closes;
}

/** Full 8h funding grid: 3 prints/day at 00:00, 08:00, 16:00, constant rate. */
function fundingGrid(
  days: number,
  rateAt: (day: number) => number,
): { fundingTime: number; fundingRate: number }[] {
  const out: { fundingTime: number; fundingRate: number }[] = [];
  for (let d = 0; d < days; d++) {
    for (const off of [0, 8, 16]) {
      out.push({
        fundingTime: d * DAY + off * 3_600_000,
        fundingRate: rateAt(d),
      });
    }
  }
  return out;
}

describe("f7Series", () => {
  it("means the prints strictly before the day's open over 7 days", () => {
    const candles = candlesFrom(uptrend(20));
    const prints = fundingGrid(20, () => 0.0002);
    const f7 = f7Series(candles, prints);
    // day 7: prints from day 0..6 inclusive (21 prints) → 0.0002
    expect(f7[7]).toBeCloseTo(0.0002, 10);
    // early days lack 15 prints → null
    expect(f7[2]).toBeNull();
  });

  it("LOOK-AHEAD GUARD: F7(t) is unchanged by prints at/after the open", () => {
    const candles = candlesFrom(uptrend(20));
    const base = fundingGrid(20, () => 0.0001);
    const mangled = base.map((p) =>
      p.fundingTime >= 10 * DAY ? { ...p, fundingRate: 0.05 } : p,
    );
    const fa = f7Series(candles, base);
    const fb = f7Series(candles, mangled);
    for (let t = 0; t <= 10; t++) expect(fb[t]).toEqual(fa[t]);
  });
});

describe("trailingPercentile", () => {
  it("uses days [t−365, t−1] and needs ≥200 usable values", () => {
    const f7: (number | null)[] = Array.from({ length: 400 }, (_, i) =>
      i < 150 ? null : i * 1e-6,
    );
    // at t=300: usable trailing = days 150..299 → 150 values < 200 → null
    expect(trailingPercentile(f7, 300, 0.5)).toBeNull();
    // at t=399: usable trailing = 150..398 → 249 values → defined
    expect(trailingPercentile(f7, 399, 0.5)).not.toBeNull();
  });

  it("LOOK-AHEAD GUARD: percentile at t ignores values at/after t", () => {
    const f7: (number | null)[] = Array.from(
      { length: 400 },
      (_, i) => i * 1e-6,
    );
    const mangled = [...f7];
    for (let i = 350; i < 400; i++) mangled[i] = 99;
    expect(trailingPercentile(mangled, 350, 0.9)).toEqual(
      trailingPercentile(f7, 350, 0.9),
    );
  });
});

describe("detectEvents", () => {
  /** f7 fixture: jittered positive baseline, deep-negative stretch, late spike. */
  function fixture(): { candles: Candle[]; f7: (number | null)[] } {
    const n = 420;
    const candles = candlesFrom(uptrend(n));
    const f7: (number | null)[] = Array.from({ length: n }, (_, i) => {
      if (i >= 300 && i < 312) return -0.0003; // sustained crowded shorts
      if (i >= 330 && i < 380) return 0.00005; // flat low plateau (< p75, no crossings)
      if (i >= 380 && i < 384) return 0.005; // crowded-long spike
      return 0.0001 + (i % 10) * 1e-6;
    });
    return { candles, f7 };
  }

  it("LONG fires on the 5th consecutive negative day, then suppresses 30 days", () => {
    const { candles, f7 } = fixture();
    const ev = detectEvents(candles, f7);
    // negative run starts at 300 → 5th usable day = 304
    expect(ev.longEvents).toContain(304);
    // the streak ends at 311 < 304+30 → no second event
    expect(ev.longEvents.filter((t) => t < 350)).toEqual([304]);
  });

  it("RISK fires once on the spike crossing and stays suppressed through it", () => {
    const { candles, f7 } = fixture();
    const ev = detectEvents(candles, f7);
    // Exactly one event inside the spike window — fired at the crossing (380),
    // suppressed for the remaining spike days (381-383). The jittered baseline
    // produces its own occasional p90 crossings outside the window; that is
    // the registered rule's expected behavior (episodic via suppression).
    const inSpike = ev.riskEvents.filter((t) => t >= 378 && t < 386);
    expect(inSpike).toEqual([380]);
  });

  it("an unusable day breaks the LONG consecutive-day streak", () => {
    const { candles, f7 } = fixture();
    const broken = [...f7];
    broken[302] = null; // hole in the negative run
    const ev = detectEvents(candles, broken);
    // streak restarts at 303 → 5th day = 307
    expect(ev.longEvents.filter((t) => t < 350)).toEqual([307]);
  });
});

describe("outcomes + baseline", () => {
  it("fwdReturn and fwdMaxDrawdown use open[t+1] entry", () => {
    const candles = candlesFrom([100, 100, 110, 120, 90, 95]);
    // t=1: entry = open[2] = close[1] = 100
    expect(fwdReturn(candles, 1, 2)).toBeCloseTo(0.2, 10);
    expect(fwdReturn(candles, 1, 10)).toBeNull();
    // maxDD needs t+14 — out of range here
    expect(fwdMaxDrawdown(candles, 1)).toBeNull();
  });

  it("matchedBaseline keeps only neutral days within ±1σ of event-mean trail14", () => {
    const closes = uptrend(100);
    // inject a crash so one neutral day has a wildly different trail14
    for (let t = 60; t < 75; t++) closes[t] = closes[t - 1]! * 0.93;
    for (let t = 75; t < 100; t++) closes[t] = closes[t - 1]! * 1.004;
    const candles = candlesFrom(closes);
    const events = [90];
    const usable = Array.from({ length: 80 }, (_, i) => i + 16);
    const neutral = [50, 74, 95]; // 74 sits at the bottom of the crash
    const out = matchedBaseline(candles, events, neutral, usable);
    expect(out).toContain(95);
    expect(out).not.toContain(74); // crash-trail14 day excluded by matching
    expect(trail14(candles, 14)).not.toBeNull();
  });
});

describe("mannWhitneyP", () => {
  it("clearly greater sample → small one-sided p; reversed direction → large", () => {
    const a = [5, 6, 7, 8, 9, 10, 11, 12];
    const b = [1, 1.5, 2, 2.5, 3, 3.5, 4, 4.5];
    expect(mannWhitneyP(a, b, "greater")).toBeLessThan(0.01);
    expect(mannWhitneyP(a, b, "less")).toBeGreaterThan(0.95);
  });

  it("identical samples → p ≈ 0.5 or higher", () => {
    const a = [1, 2, 3, 4, 5, 6, 7, 8];
    expect(mannWhitneyP(a, a, "greater")).toBeGreaterThan(0.4);
  });
});
