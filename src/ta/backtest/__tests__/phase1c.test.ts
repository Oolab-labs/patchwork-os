import { describe, expect, it } from "vitest";
import type { Candle } from "../../types.js";
import {
  disagreementReturns,
  gateReturns,
  ichimoku,
  sharpeFull,
  shiftNullP,
  smaGate,
} from "../ichimoku.js";
import {
  absRet20,
  bbwSeries,
  detectSqueezes,
  firstBreakoutDir,
  fwdRV,
  rv4hDaily,
  trailing252Pctile,
  trailingRank,
} from "../volsq.js";

function bars(closes: number[], spread = 0.5): Candle[] {
  return closes.map((c, t) => ({
    openTime: t * 86_400_000,
    open: t === 0 ? c : closes[t - 1]!,
    high: Math.max(c, t === 0 ? c : closes[t - 1]!) + spread,
    low: Math.min(c, t === 0 ? c : closes[t - 1]!) - spread,
    close: c,
    volume: 100,
    closeTime: t * 86_400_000 + 86_399_999,
  }));
}

/** Alternating ±amp% closes — constant-vol base series. */
function wiggle(n: number, amp: number, start = 100): number[] {
  const out = [start];
  for (let t = 1; t < n; t++)
    out.push(out[t - 1]! * (t % 2 === 0 ? 1 + amp : 1 - amp));
  return out;
}

describe("volsq-1 primitives", () => {
  it("detects a squeeze when vol compresses below trailing P10, with non-overlap", () => {
    // 300 normal-vol days, then a 40-day dead-flat stretch
    const closes = [...wiggle(300, 0.02), ...wiggle(41, 0.0005, 100).slice(1)];
    const candles = bars(closes, 0.1);
    const bbw = bbwSeries(candles);
    const events = detectSqueezes(bbw);
    const inFlat = events.filter((t) => t >= 300);
    expect(inFlat.length).toBeGreaterThanOrEqual(1);
    // non-overlap: consecutive events ≥ 20 bars apart
    for (let i = 1; i < events.length; i++)
      expect(events[i]! - events[i - 1]!).toBeGreaterThanOrEqual(20);
  });

  it("LOOK-AHEAD GUARD: trailing percentile + rank ignore values at/after t", () => {
    const series: (number | null)[] = Array.from(
      { length: 400 },
      (_, i) => i * 0.001,
    );
    const mangled = [...series];
    for (let i = 300; i < 400; i++) mangled[i] = 999;
    expect(trailing252Pctile(mangled, 300, 0.1)).toEqual(
      trailing252Pctile(series, 300, 0.1),
    );
    expect(trailingRank(mangled, 300)).toEqual(trailingRank(series, 300));
  });

  it("rv4hDaily uses only 4h bars closed at/before the daily close", () => {
    const daily = bars(wiggle(80, 0.01));
    const fourH: Candle[] = [];
    for (let i = 0; i < 80 * 6; i++) {
      const c = 100 * (1 + 0.001 * Math.sin(i / 5));
      fourH.push({
        openTime: i * 14_400_000,
        open: c,
        high: c + 0.1,
        low: c - 0.1,
        close: c,
        volume: 1,
        closeTime: i * 14_400_000 + 14_399_999,
      });
    }
    const a = rv4hDaily(daily, fourH);
    // mangle 4h bars AFTER day 40's close
    const cutoff = daily[40]!.closeTime;
    const mangled = fourH.map((b) =>
      b.closeTime > cutoff ? { ...b, close: b.close * 3 } : b,
    );
    const b = rv4hDaily(daily, mangled);
    for (let t = 0; t <= 40; t++) expect(b[t]).toEqual(a[t]);
  });

  it("outcome helpers: fwdRV/absRet need t+20; breakout direction detects the side", () => {
    const closes = [...wiggle(60, 0.001), ...wiggle(30, 0.04, 100).slice(1)];
    // append a strong up-move so the first band breach is upward
    const up = [...closes];
    for (let i = 0; i < 25; i++) up.push(up[up.length - 1]! * 1.03);
    const candles = bars(up, 0.05);
    expect(fwdRV(candles, up.length - 5)).toBeNull();
    expect(absRet20(candles, 30)).not.toBeNull();
    expect(firstBreakoutDir(candles, 85)).toBe(1);
  });
});

describe("ichimoku-arb-1 primitives", () => {
  it("cloud at t uses bars ≤ t−26 (LOOK-AHEAD GUARD)", () => {
    const closes = wiggle(200, 0.01);
    const a = ichimoku(bars(closes));
    const mangled = [...closes];
    for (let i = 150; i < 200; i++) mangled[i] = mangled[i]! * 4;
    const b = ichimoku(bars(mangled));
    for (let t = 0; t < 150; t++) {
      expect(b.senkouA[t]).toEqual(a.senkouA[t]);
      expect(b.senkouB[t]).toEqual(a.senkouB[t]);
      expect(b.gate[t]).toEqual(a.gate[t]);
    }
  });

  it("gate is long above the cloud in a sustained uptrend; smaGate similar", () => {
    const closes: number[] = [100];
    for (let t = 1; t < 200; t++)
      closes.push(closes[t - 1]! * (t % 2 === 0 ? 1.012 : 1.008));
    const candles = bars(closes);
    const ich = ichimoku(candles);
    const sma = smaGate(candles, 50);
    expect(ich.gate.slice(120, 190).every((g) => g === 1)).toBe(true);
    expect(sma.slice(120, 190).every((g) => g === 1)).toBe(true);
    const rs = gateReturns(candles, ich.gate);
    expect(sharpeFull(rs.slice(120))).toBeGreaterThan(0);
  });

  it("disagreementReturns splits ichi-only vs sma-only days", () => {
    const candles = bars(wiggle(60, 0.01));
    const ichi: (0 | 1)[] = candles.map((_, t) => (t % 2 === 0 ? 1 : 0));
    const sma: (0 | 1)[] = candles.map((_, t) => (t % 3 === 0 ? 1 : 0));
    const { d1, d2 } = disagreementReturns(candles, ichi, sma, () => true);
    // t even & not div3 → d1; t div3 & odd → d2
    expect(d1.length).toBeGreaterThan(0);
    expect(d2.length).toBeGreaterThan(0);
  });

  it("shiftNullP: a constant gate has p ≈ 1 (every shift identical)", () => {
    const candles = bars(wiggle(300, 0.01));
    const always: (0 | 1)[] = candles.map(() => 1);
    const out = shiftNullP(candles, always, () => true);
    expect(out.p).toBeGreaterThan(0.9);
  });
});
