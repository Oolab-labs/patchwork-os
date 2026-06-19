import { describe, expect, it } from "vitest";
import type { Candle } from "../../types.js";
import {
  atrWilder,
  clusterBootstrapP,
  clusterIndices,
  decileOf,
  detectVoids,
  mulberry32,
  rawVoidFlags,
  runStateMachine,
} from "../fvg.js";

/** Candle builder from [open, high, low, close] rows. */
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

/** Quiet base series long enough to warm up ATR(100). */
function quietRows(n: number, px = 100): [number, number, number, number][] {
  return Array.from({ length: n }, (_, i) => {
    const wiggle = i % 2 === 0 ? 0.2 : -0.2;
    const o = px + wiggle;
    const c = px - wiggle;
    return [o, Math.max(o, c) + 0.3, Math.min(o, c) - 0.3, c];
  });
}

describe("detectVoids — frozen Pine defaults", () => {
  it("detects a bullish void only when gap AND displacement filters pass", () => {
    const rows = quietRows(120);
    // bar 110: displacement candle; bar 111: gap bar leaving low above bar-109 high
    rows[110] = [100, 110, 100, 110]; // big body (displacement on t−1)
    rows[111] = [110, 116, 108, 115]; // low 108 > high[109] ≈ 100.5 → gap
    const candles = bars(rows);
    const voids = detectVoids(candles);
    const bull = voids.filter((v) => v.dir === 1 && v.t === 111);
    expect(bull).toHaveLength(1);
    expect(bull[0]!.vTop).toBeCloseTo(108, 6);
    expect(bull[0]!.vBot).toBeCloseTo(100.5, 6);
    expect(bull[0]!.ce).toBeCloseTo((108 + 100.5) / 2, 6);
  });

  it("rejects the same shape when the displacement filter fails", () => {
    const rows = quietRows(120);
    rows[110] = [100, 110, 100, 100.4]; // tiny body → fails ATR14×1.0
    rows[111] = [110, 116, 108, 115];
    const voids = detectVoids(bars(rows));
    expect(voids.filter((v) => v.t === 111)).toHaveLength(0);
  });

  it("merges stacked consecutive same-direction voids into one event", () => {
    const rows = quietRows(130);
    rows[110] = [100, 112, 100, 112];
    rows[111] = [112, 120, 110, 119]; // void #1 (low 110 > high[109])
    rows[112] = [119, 130, 118, 129]; // void #2 (low 118 > high[110]=112)
    const voids = detectVoids(bars(rows));
    const merged = voids.filter((v) => v.dir === 1 && v.t === 112);
    expect(merged).toHaveLength(1);
    // union zone: vBot = high[first−2] = high[109], vTop = low[last] = 118
    expect(merged[0]!.vTop).toBeCloseTo(118, 6);
    expect(voids.filter((v) => v.t === 111)).toHaveLength(0); // absorbed
  });

  it("LOOK-AHEAD GUARD: flags at t unchanged by future bars", () => {
    const rows = quietRows(140);
    rows[110] = [100, 110, 100, 110];
    rows[111] = [110, 116, 108, 115];
    const a = bars(rows);
    const rowsB = rows.map((r, i) =>
      i >= 120 ? ([500, 600, 400, 550] as [number, number, number, number]) : r,
    );
    const b = bars(rowsB);
    const fa = rawVoidFlags(a, atrWilder(a, 100), atrWilder(a, 14));
    const fb = rawVoidFlags(b, atrWilder(b, 100), atrWilder(b, 14));
    expect(fb.slice(0, 120)).toEqual(fa.slice(0, 120));
  });
});

describe("runStateMachine — frozen thresholds", () => {
  // bull zone [100, 108], CE 104, watched from bar 0
  const zone = { vTop: 108, vBot: 100 };

  it("tested needs >10% penetration; CE and fill at exact boundaries", () => {
    const rows: [number, number, number, number][] = [
      [115, 116, 114, 115],
      [115, 116, 107.5, 115], // pen 0.5 < 0.8 → not tested
      [115, 116, 107, 115.5], // pen 1.0 > 0.8 → tested (touch bar 2)
      [115, 116, 104, 115], // CE reached
      [115, 116, 99.9, 115], // filled (low < 100)
      [115, 116, 114, 115],
      [115, 116, 114, 116],
      [115, 117, 114, 117],
    ];
    const out = runStateMachine(bars(rows), 1, zone.vTop, zone.vBot, 0, 30);
    expect(out.tested).toBe(true);
    expect(out.touchBar).toBe(2);
    expect(out.ceReached).toBe(true);
    expect(out.filled).toBe(true);
    // reaction = ln(close[7]/close[2]) signed away (up) from the zone
    expect(out.reaction).toBeCloseTo(Math.log(117 / 115.5), 10);
  });

  it("respects the 30-bar outcome window", () => {
    const rows = quietRows(50, 115);
    rows[40] = [115, 116, 99, 115]; // would fill, but outside window from bar 5
    const out = runStateMachine(bars(rows), 1, 108, 100, 5, 30);
    expect(out.filled).toBe(false);
  });
});

describe("bootstrap machinery", () => {
  it("clusterIndices groups events < 30 bars apart", () => {
    expect(clusterIndices([10, 25, 100, 250, 260])).toEqual([
      [0, 1],
      [2],
      [3, 4],
    ]);
  });

  it("clusterBootstrapP: clear positive delta → small p; null delta → large p", () => {
    const events = Array.from({ length: 40 }, (_, i) => 1 + (i % 3) * 0.1);
    const ctrls = events.map((x) => x - 0.5);
    const clusters = clusterIndices(events.map((_, i) => i * 100));
    const hit = clusterBootstrapP(events, ctrls, clusters, 777);
    expect(hit.delta).toBeCloseTo(0.5, 6);
    expect(hit.p).toBeLessThan(0.01);
    const noEdge = clusterBootstrapP(events, [...events], clusters, 777);
    expect(noEdge.p).toBeGreaterThan(0.4);
  });

  it("mulberry32 is deterministic; decileOf bins correctly", () => {
    const a = mulberry32(42);
    const b = mulberry32(42);
    expect([a(), a(), a()]).toEqual([b(), b(), b()]);
    const sorted = Array.from({ length: 100 }, (_, i) => i);
    expect(decileOf(sorted, 5)).toBe(0);
    expect(decileOf(sorted, 95)).toBe(9);
  });
});
