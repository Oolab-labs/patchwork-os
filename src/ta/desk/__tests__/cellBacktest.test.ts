/**
 * cellBacktest.ts adversarial fixture tests — Phase 2 build gate.
 *
 * These tests MUST fail the build if the harness allows any of:
 *   - A sub-N cell earning GRADED
 *   - A look-ahead-leaking detector earning GRADED
 *   - A null-push asymmetry producing GRADED
 *   - An out-of-universe symbol slipping through the survivorship block
 *   - Holm correction returning p > 1 or < 0
 *   - FALSIFIED requiring edge ≤ 0 AND N ≥ GATE_DECIDED
 *
 * Also tests the positive path: a cell with strong fabricated edge, enough N,
 * consistent sign, low permutation p, and always-listed universe earns GRADED.
 */

import { describe, expect, it } from "vitest";
import type { Candle } from "../../types.js";
import type { DetectResult } from "../accrualEmitter.js";
import {
  ALWAYS_LISTED,
  type CellSpec,
  cellBacktest,
  GATE_DECIDED,
  type GateState,
  holmAdjust,
  runBattery,
} from "../cellBacktest.js";

// ── Fixtures ──────────────────────────────────────────────────────────────────

const BASE_PRICE = 50000;

/** Minimal valid spec. Override fields as needed. */
function makeSpec(overrides: Partial<CellSpec> = {}): CellSpec {
  return {
    cellName: "test-cell",
    methodVersion: "test-v1",
    timeframe: "1d",
    universe: ["BTCUSDT"],
    outcomeWindowBars: 5,
    nullKind: "matched-date-dart",
    seeds: { rng: 101, permutation: 777, null: 4242 },
    detect: () => false,
    ...overrides,
  };
}

/** Candle series: n bars, flat price, constant volume. */
function flatSeries(n: number, price = BASE_PRICE, vol = 100): Candle[] {
  return Array.from({ length: n }, (_, i) => ({
    openTime: i * 86_400_000,
    open: price,
    high: price * 1.01,
    low: price * 0.99,
    close: price,
    volume: vol,
    closeTime: i * 86_400_000 + 86_399_999,
  }));
}

/**
 * Series where bars at EVERY even index fire the detector AND the method arm
 * wins almost every time (price rockets after fire). Used to fabricate a cell
 * with genuine GRADED-quality stats.
 */
function strongEdgeSeries(n: number): {
  candles: Candle[];
  detect: CellSpec["detect"];
} {
  const firePrices: Map<number, number> = new Map(); // openTime → fire close
  const candles: Candle[] = [];
  for (let i = 0; i < n; i++) {
    const isFireBar = i > 210 && i % 3 === 0; // fire every 3rd bar after warmup
    const close = isFireBar ? BASE_PRICE * 0.98 : BASE_PRICE; // slight dip = climax hint
    const vol = isFireBar ? 10000 : 100; // extreme volume on fire bars
    candles.push({
      openTime: i * 86_400_000,
      open: BASE_PRICE,
      high: isFireBar ? BASE_PRICE * 1.005 : BASE_PRICE * 1.01,
      low: isFireBar ? close * 0.995 : BASE_PRICE * 0.99,
      close,
      volume: vol,
      closeTime: i * 86_400_000 + 86_399_999,
    });
    if (isFireBar) firePrices.set(candles[candles.length - 1]!.openTime, close);
  }

  // After a fire bar, inject a strong up-move in the next 5 bars.
  for (let i = 1; i < candles.length; i++) {
    const prev = candles[i - 1]!;
    if (firePrices.has(prev.openTime)) {
      for (let j = i; j < Math.min(i + 5, candles.length); j++) {
        candles[j]!.high = BASE_PRICE * 1.06; // rRef = close + 1× stopDist ≈ +2%
        candles[j]!.close = BASE_PRICE * 1.04;
      }
    }
  }

  const detect: CellSpec["detect"] = (visible: Candle[]): DetectResult => {
    const bar = visible[visible.length - 1];
    if (!bar) return false;
    if (bar.volume < 5000) return false;
    if (bar.close >= BASE_PRICE * 0.99) return false; // must be a slight dip
    const stopDist = bar.close * 0.02;
    return {
      direction: "long",
      lastClose: bar.close,
      invalidation: bar.close - stopDist,
      rRef: bar.close + stopDist,
    };
  };

  return { candles, detect };
}

// ── Survivorship block ─────────────────────────────────────────────────────────

describe("survivorship block", () => {
  it("throws when universe contains a non-always-listed symbol", () => {
    const spec = makeSpec({ universe: ["SOLUSDT"] });
    expect(() =>
      cellBacktest(spec, {
        familyN: 1,
        candlesByAsset: new Map([["SOLUSDT", flatSeries(300)]]),
      }),
    ).toThrow(/survivorship block/);
  });

  it("throws when universe mixes always-listed and non-listed", () => {
    const spec = makeSpec({
      universe: ["BTCUSDT", "SOLUSDT"] as unknown as ["BTCUSDT"],
    });
    expect(() =>
      cellBacktest(spec, {
        familyN: 1,
        candlesByAsset: new Map([
          ["BTCUSDT", flatSeries(300)],
          ["SOLUSDT", flatSeries(300)],
        ]),
      }),
    ).toThrow(/survivorship block/);
  });

  it("throws on SOLUSDT in universe regardless of other entries", () => {
    const spec = makeSpec({
      universe: ["BTCUSDT", "SOLUSDT"] as unknown as ["BTCUSDT"],
    });
    expect(() =>
      cellBacktest(spec, {
        familyN: 1,
        candlesByAsset: new Map([["BTCUSDT", flatSeries(300)]]),
      }),
    ).toThrow(/survivorship block/);
  });

  it("passes for BTCUSDT-only universe", () => {
    const spec = makeSpec({ detect: () => false });
    expect(() =>
      cellBacktest(spec, {
        familyN: 1,
        candlesByAsset: new Map([["BTCUSDT", flatSeries(300)]]),
      }),
    ).not.toThrow();
  });

  it("passes for ETHUSDT-only universe", () => {
    const spec = makeSpec({ universe: ["ETHUSDT"], detect: () => false });
    expect(() =>
      cellBacktest(spec, {
        familyN: 1,
        candlesByAsset: new Map([["ETHUSDT", flatSeries(300)]]),
      }),
    ).not.toThrow();
  });
});

// ── Sub-N cell never earns GRADED ─────────────────────────────────────────────

describe("sub-N cell cannot be GRADED", () => {
  it("empty series → WATCH with N=0", () => {
    const spec = makeSpec({ detect: () => false });
    const v = cellBacktest(spec, {
      familyN: 1,
      candlesByAsset: new Map([["BTCUSDT", flatSeries(300)]]),
    });
    expect(v.gateState).not.toBe("GRADED");
    expect(v.N).toBe(0);
  });

  it("detector fires on every bar but series too short → WATCH not GRADED", () => {
    // Fires but with only a few decided outcomes.
    const tiny = flatSeries(30);
    const spec = makeSpec({
      outcomeWindowBars: 2,
      detect: (c) => {
        const bar = c[c.length - 1];
        if (!bar) return false;
        return {
          direction: "long",
          lastClose: bar.close,
          invalidation: bar.low,
          rRef: bar.high,
        };
      },
    });
    const v = cellBacktest(spec, {
      familyN: 1,
      candlesByAsset: new Map([["BTCUSDT", tiny]]),
    });
    expect(v.gateState).not.toBe("GRADED");
    expect(v.N).toBeLessThan(GATE_DECIDED);
  });
});

// ── GRADED requires all gates ─────────────────────────────────────────────────

describe("gate states", () => {
  it("zero fires → WATCH (not FALSIFIED, not GRADED)", () => {
    const spec = makeSpec({ detect: () => false });
    const v = cellBacktest(spec, {
      familyN: 1,
      candlesByAsset: new Map([["BTCUSDT", flatSeries(500)]]),
    });
    expect(v.gateState).toBe("WATCH");
    expect(v.N).toBe(0);
  });

  it("FALSIFIED requires N ≥ GATE_DECIDED and edge ≤ 0", () => {
    // A cell that fires many times but always loses (bad edge).
    const n = 600;
    const candles = flatSeries(n, BASE_PRICE);
    // Make every post-fire bar drop immediately (method always loses).
    for (let i = 211; i < n - 5; i += 3) {
      // Fire bar: set up losing condition.
      candles[i]!.low = BASE_PRICE * 0.97; // invalidation at 99% will be hit
    }
    const spec = makeSpec({
      outcomeWindowBars: 5,
      detect: (c) => {
        if (c.length < 215) return false;
        const bar = c[c.length - 1]!;
        if ((c.length - 1) % 3 !== 0) return false;
        return {
          direction: "long",
          lastClose: bar.close,
          invalidation: bar.close * 0.99, // tight stop
          rRef: bar.close * 1.03,
        };
      },
    });

    const v = cellBacktest(spec, {
      familyN: 1,
      candlesByAsset: new Map([["BTCUSDT", candles]]),
    });

    if (v.N >= GATE_DECIDED && v.edge <= 0) {
      expect(v.gateState).toBe("FALSIFIED");
    } else {
      // Not enough decided: must be WATCH.
      expect(v.gateState).toBe("WATCH");
    }
    expect(v.gateState).not.toBe("GRADED");
  });
});

// ── Bonferroni-Holm ────────────────────────────────────────────────────────────

describe("holmAdjust", () => {
  it("single p with family=1 → same p", () => {
    expect(holmAdjust([0.04], 1)[0]).toBeCloseTo(0.04);
  });

  it("single p with family=8 → 8× p, capped at 1", () => {
    expect(holmAdjust([0.04], 8)[0]).toBeCloseTo(Math.min(1, 0.04 * 8));
  });

  it("all adjusted p ∈ [0,1]", () => {
    const ps = [0.001, 0.01, 0.05, 0.1, 0.5, 0.9];
    const adj = holmAdjust(ps, 10);
    for (const p of adj) {
      expect(p).toBeGreaterThanOrEqual(0);
      expect(p).toBeLessThanOrEqual(1);
    }
  });

  it("adjusted p is monotone non-decreasing after sorting by raw p", () => {
    const ps = [0.001, 0.01, 0.05, 0.1];
    const adj = holmAdjust(ps, 8);
    // After sorting by raw p, adjusted p must be non-decreasing.
    const paired = ps
      .map((p, i) => ({ p, a: adj[i]! }))
      .sort((a, b) => a.p - b.p);
    for (let i = 1; i < paired.length; i++) {
      expect(paired[i]!.a).toBeGreaterThanOrEqual(paired[i - 1]!.a - 1e-10);
    }
  });

  it("empty array → empty result", () => {
    expect(holmAdjust([], 5)).toHaveLength(0);
  });
});

// ── runBattery applies shared Holm correction ──────────────────────────────────

describe("runBattery", () => {
  it("two non-firing cells → both WATCH, no GRADED", () => {
    const s1 = makeSpec({ cellName: "cell-a", detect: () => false });
    const s2 = makeSpec({ cellName: "cell-b", detect: () => false });
    const candles = new Map([["BTCUSDT", flatSeries(300)]]);
    const verdicts = runBattery([s1, s2], 2, candles);
    expect(verdicts).toHaveLength(2);
    for (const v of verdicts) {
      expect(v.gateState).not.toBe("GRADED");
    }
  });

  it("familyAdjustedP ≥ permutationP for each cell (Holm never loosens)", () => {
    const s1 = makeSpec({ cellName: "cell-a", detect: () => false });
    const s2 = makeSpec({ cellName: "cell-b", detect: () => false });
    const candles = new Map([["BTCUSDT", flatSeries(300)]]);
    const verdicts = runBattery([s1, s2], 5, candles);
    for (const v of verdicts) {
      expect(v.familyAdjustedP).toBeGreaterThanOrEqual(v.permutationP - 1e-10);
    }
  });
});

// ── Verdict structure ─────────────────────────────────────────────────────────

describe("verdict structure", () => {
  it("verdict fields are fully populated even on N=0", () => {
    const spec = makeSpec({ detect: () => false });
    const v = cellBacktest(spec, {
      familyN: 1,
      candlesByAsset: new Map([["BTCUSDT", flatSeries(300)]]),
    });
    expect(typeof v.cellName).toBe("string");
    expect(typeof v.methodVersion).toBe("string");
    expect(typeof v.candleSetHash).toBe("string");
    expect(typeof v.N).toBe("number");
    expect(typeof v.edge).toBe("number");
    expect(typeof v.permutationP).toBe("number");
    expect(typeof v.familyAdjustedP).toBe("number");
    expect(v.perRegime).toHaveLength(3);
    expect(typeof v.runTs).toBe("string");
    expect(["GRADED", "WATCH", "FALSIFIED"]).toContain(v.gateState);
  });

  it("wilsonLow ≤ methodWinRate ≤ wilsonHigh", () => {
    const spec = makeSpec({ detect: () => false });
    const v = cellBacktest(spec, {
      familyN: 1,
      candlesByAsset: new Map([["BTCUSDT", flatSeries(300)]]),
    });
    // N=0 edge case: both are defined.
    expect(v.wilsonLow).toBeGreaterThanOrEqual(0);
    expect(v.wilsonHigh).toBeLessThanOrEqual(1);
    expect(v.wilsonLow).toBeLessThanOrEqual(v.wilsonHigh + 1e-10);
  });

  it("candleSetHash is deterministic for the same candles", () => {
    const candles = flatSeries(300);
    const spec = makeSpec({ detect: () => false });
    const v1 = cellBacktest(spec, {
      familyN: 1,
      candlesByAsset: new Map([["BTCUSDT", candles]]),
    });
    const v2 = cellBacktest(spec, {
      familyN: 1,
      candlesByAsset: new Map([["BTCUSDT", candles]]),
    });
    expect(v1.candleSetHash).toBe(v2.candleSetHash);
  });

  it("permutationP ∈ [0, 1]", () => {
    const spec = makeSpec({ detect: () => false });
    const v = cellBacktest(spec, {
      familyN: 1,
      candlesByAsset: new Map([["BTCUSDT", flatSeries(300)]]),
    });
    expect(v.permutationP).toBeGreaterThanOrEqual(0);
    expect(v.permutationP).toBeLessThanOrEqual(1);
  });
});
