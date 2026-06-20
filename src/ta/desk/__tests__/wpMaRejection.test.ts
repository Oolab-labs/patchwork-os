/**
 * wp-ma-rejection @1d — Phase 4 cell tests.
 *
 * Build-gate invariants:
 *   - detectMaRejection fires only when wick is below SMA and close is above SMA
 *   - MIN_WICK_DEPTH filter rejects hairline touches
 *   - OUTCOME_WINDOW_BARS is pinned at 10
 *   - FAMILY_N is pinned at 2 (shared with wp-volume-climax)
 *   - Detector is look-ahead clean (self-test runs at import)
 */

import { describe, expect, it } from "vitest";
import type { Candle } from "../../types.js";
import {
  detectMaRejection,
  FAMILY_N,
  MA_BARS,
  MIN_WICK_DEPTH,
  OUTCOME_WINDOW_BARS,
} from "../cells/wpMaRejection.js";

// ── Fixtures ──────────────────────────────────────────────────────────────────

const BASE_PRICE = 50000;
const SMA_BASE = 49500;

function flatSeries(n: number, price = BASE_PRICE): Candle[] {
  return Array.from({ length: n }, (_, i) => ({
    openTime: i * 86_400_000,
    open: price,
    high: price * 1.01,
    low: price * 0.99,
    close: price,
    volume: 100,
    closeTime: i * 86_400_000 + 86_399_999,
  }));
}

/**
 * Series where the LAST bar is a MA rejection:
 * prior bars at SMA_BASE so the SMA ≈ SMA_BASE;
 * the last bar wicks below SMA_BASE and closes at BASE_PRICE (above SMA).
 */
function rejectionSeries(): Candle[] {
  const candles: Candle[] = flatSeries(MA_BARS, SMA_BASE);
  candles.push({
    openTime: MA_BARS * 86_400_000,
    open: SMA_BASE,
    high: BASE_PRICE * 1.01,
    low: SMA_BASE * 0.987, // wick 1.3% below SMA
    close: BASE_PRICE, // close well above SMA
    volume: 100,
    closeTime: MA_BARS * 86_400_000 + 86_399_999,
  });
  return candles;
}

// ── Frozen params ──────────────────────────────────────────────────────────────

it("OUTCOME_WINDOW_BARS is pinned at 10", () => {
  expect(OUTCOME_WINDOW_BARS).toBe(10);
});

it("FAMILY_N is pinned at 2 (two battery cells)", () => {
  expect(FAMILY_N).toBe(2);
});

// ── Fire conditions ────────────────────────────────────────────────────────────

describe("detectMaRejection fire conditions", () => {
  it("fires LONG on a clean rejection bar", () => {
    const result = detectMaRejection(rejectionSeries());
    expect(result).not.toBe(false);
    if (result) expect(result.direction).toBe("long");
  });

  it("does NOT fire when close is below SMA (no rejection)", () => {
    const candles = rejectionSeries();
    // Override close to be below SMA_BASE
    const last = candles[candles.length - 1]!;
    candles[candles.length - 1] = { ...last, close: SMA_BASE * 0.99 };
    expect(detectMaRejection(candles)).toBe(false);
  });

  it("does NOT fire when low is above SMA (no wick below MA)", () => {
    const candles = rejectionSeries();
    // Override low to be above SMA
    const last = candles[candles.length - 1]!;
    candles[candles.length - 1] = { ...last, low: SMA_BASE * 1.001 };
    expect(detectMaRejection(candles)).toBe(false);
  });

  it("does NOT fire on hairline touch (below MIN_WICK_DEPTH)", () => {
    // SMA ≈ SMA_BASE, wick just barely below
    const candles = rejectionSeries();
    const last = candles[candles.length - 1]!;
    // wick depth = (SMA_BASE - low) / close; set low so depth < 0.002
    const tinyDip = SMA_BASE - last.close * (MIN_WICK_DEPTH * 0.5);
    candles[candles.length - 1] = { ...last, low: tinyDip };
    expect(detectMaRejection(candles)).toBe(false);
  });

  it("returns LONG direction", () => {
    const result = detectMaRejection(rejectionSeries());
    if (result) expect(result.direction).toBe("long");
  });

  it("sets invalidation to the fire bar's low", () => {
    const candles = rejectionSeries();
    const result = detectMaRejection(candles);
    const lastBar = candles[candles.length - 1]!;
    if (result) expect(result.invalidation).toBe(lastBar.low);
  });

  it("does NOT fire on series too short", () => {
    const short = flatSeries(MA_BARS - 1, SMA_BASE);
    expect(detectMaRejection(short)).toBe(false);
  });

  it("does NOT fire on flat series (no dip below SMA)", () => {
    const candles = flatSeries(MA_BARS + 1, BASE_PRICE);
    // All bars at BASE_PRICE → SMA = BASE_PRICE; last bar's low = 0.99×BASE_PRICE
    // That dips below SMA, but close = BASE_PRICE = SMA exactly → not strictly above
    // Actually low < SMA but close == SMA fails the close > sma20 check
    expect(detectMaRejection(candles)).toBe(false);
  });
});
