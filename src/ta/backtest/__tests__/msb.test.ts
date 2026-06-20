import { describe, expect, it } from "vitest";
import type { Candle } from "../../types.js";
import { breakFailed, fractalPivots, scanMsb, signedForward } from "../msb.js";

function bars(rows: [number, number, number, number][]): Candle[] {
  return rows.map(([o, h, l, c], t) => ({
    openTime: t * 14_400_000,
    open: o,
    high: h,
    low: l,
    close: c,
    volume: 100,
    closeTime: t * 14_400_000 + 14_399_999,
  }));
}

/** Gentle wave with a clear local high at bar 10 and low at bar 20. */
function waveRows(): [number, number, number, number][] {
  const rows: [number, number, number, number][] = [];
  for (let t = 0; t < 40; t++) {
    let mid = 100;
    if (t <= 10)
      mid = 100 + t; // rises into bar 10 (high 110)
    else if (t <= 20)
      mid = 110 - (t - 10) * 1.5; // falls into bar 20 (95)
    else mid = 95 + (t - 20) * 0.5;
    rows.push([mid, mid + 1, mid - 1, mid]);
  }
  return rows;
}

describe("fractalPivots", () => {
  it("finds the strict N-bar pivot and stamps the confirmation lag", () => {
    const { highs, lows } = fractalPivots(bars(waveRows()), 4);
    const ph = highs.find((p) => p.bar === 10);
    expect(ph).toBeDefined();
    expect(ph!.price).toBeCloseTo(111, 6);
    expect(ph!.confirmedAt).toBe(14);
    const pl = lows.find((p) => p.bar === 20);
    expect(pl).toBeDefined();
    expect(pl!.confirmedAt).toBe(24);
  });

  it("LOOK-AHEAD GUARD: pivots usable at t are unchanged by future bars", () => {
    const a = waveRows();
    const b = a.map((r, i) =>
      i >= 30 ? ([500, 600, 400, 550] as [number, number, number, number]) : r,
    );
    const pa = fractalPivots(bars(a), 4);
    const pb = fractalPivots(bars(b), 4);
    const usableA = pa.highs.filter((p) => p.confirmedAt <= 29);
    const usableB = pb.highs.filter((p) => p.confirmedAt <= 29);
    expect(usableB).toEqual(usableA);
  });
});

describe("scanMsb — arms, one-shot guards, CHoCH", () => {
  it("Arm A fires once per level on a closed break; Arm B on a sweep", () => {
    const rows = waveRows();
    // After PL at bar 20 (price 94) confirms at 24:
    rows[26] = [96, 97, 93.5, 96.5]; // sweep: low < 94, close > 94 → Arm B bull
    rows[28] = [96, 97, 93.5, 93.6]; // close < 94 → Arm A bear
    rows[29] = [93.6, 95, 93, 94.5]; // second sweep of same level → suppressed
    const { events } = scanMsb(bars(rows), 4);
    const armB = events.filter((e) => e.arm === "B" && e.dir === 1);
    expect(armB).toHaveLength(1);
    expect(armB[0]!.t).toBe(26);
    expect(armB[0]!.wickExtent).toBeGreaterThan(0);
    const armA = events.filter((e) => e.arm === "A" && e.dir === -1);
    expect(armA).toHaveLength(1);
    expect(armA[0]!.t).toBe(28);
  });

  it("rawBreach marks crossing bars even when one-shot suppresses the event", () => {
    const rows = waveRows();
    rows[26] = [96, 97, 93.5, 96.5];
    rows[29] = [96, 97, 93.5, 96.2]; // second sweep — no event, still a breach
    const { events, rawBreach } = scanMsb(bars(rows), 4);
    expect(events.filter((e) => e.arm === "B" && e.t === 29)).toHaveLength(0);
    expect(rawBreach[26]).toBe(true);
    expect(rawBreach[29]).toBe(true);
  });

  it("CHoCH context: bullish events qualified by descending pivot lows", () => {
    // build two descending confirmed lows then a bullish break
    const rows: [number, number, number, number][] = [];
    const path = [
      100, 104, 108, 104, 100, 96, 92, 96, 100, 104, 100, 96, 90, 94, 98, 102,
      106, 110, 114, 118, 122, 126, 130, 134, 138,
    ];
    for (const mid of path) rows.push([mid, mid + 1, mid - 1, mid]);
    const { events } = scanMsb(bars(rows), 2);
    const bullA = events.find((e) => e.arm === "A" && e.dir === 1);
    expect(bullA).toBeDefined();
    expect(bullA!.choch).toBe(true); // lows at 91 then 89 — descending
  });
});

describe("outcome helpers", () => {
  it("signedForward signs by claim direction; breakFailed detects re-cross", () => {
    const rows = waveRows();
    rows[28] = [96, 97, 93.5, 93.6]; // Arm A bear at 28, level 94
    rows[30] = [94, 96, 93.5, 95]; // close back above 94 within 10 bars
    const candles = bars(rows);
    const { events } = scanMsb(candles, 4);
    const ev = events.find((e) => e.arm === "A" && e.dir === -1)!;
    expect(breakFailed(candles, ev, 10)).toBe(true);
    const r = signedForward(candles, ev.t, 5, ev.dir);
    expect(r).not.toBeNull();
    // bearish claim: positive when price fell — bar 33 close vs bar 28 close
    expect(r!).toBeCloseTo(
      -Math.log(candles[33]!.close / candles[28]!.close),
      10,
    );
  });
});
