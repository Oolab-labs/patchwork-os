/**
 * Backtest scoring — frozen hit/reversal definitions, baselines, and stats.
 *
 * All thresholds are fixed in docs/ta-cycles-backtest-precommit.md and must NOT
 * be tuned to improve results. The same primitives are reused by the live
 * ledger scorer so a prediction is always judged under the rules it was made
 * under (pinned by METHOD_VERSION).
 */

import { isFractalHigh, isFractalLow } from "../swings.js";
import type { Candle } from "../types.js";

// ── Frozen policy (precommit) ───────────────────────────────────────────────
export const PRICE_MARGIN = 0.005; // ±0.5% band for a price-level "hit"
export const REVERSAL_PCT = 0.015; // ≥1.5% counter-move = a reversal
export const REVERSAL_LOOKAHEAD = 5; // bars to realise the reversal
export const CYCLE_WINDOW = 1; // ±1 bar around a projected pivot
export const OUTCOME_WINDOW = 30; // bars a prediction is live for
export const MIN_N = 30; // suppress hit-rates below this N

/** A later bar's [low,high] comes within ±margin of `level`. */
export function priceLevelHit(
  level: number,
  future: Candle[],
  marginFrac = PRICE_MARGIN,
): boolean {
  const m = level * marginFrac;
  return future.some((c) => c.low <= level + m && c.high >= level - m);
}

/** Index of the first future bar that touches `level` (±margin), or -1. */
export function firstTouchIndex(
  level: number,
  candles: Candle[],
  from: number,
  to: number,
  marginFrac = PRICE_MARGIN,
): number {
  const m = level * marginFrac;
  for (let i = from; i <= to && i < candles.length; i++) {
    const c = candles[i]!;
    if (c.low <= level + m && c.high >= level - m) return i;
  }
  return -1;
}

/**
 * Did a reversal of the frozen definition occur within ±window of centerIndex?
 * A same-N fractal extreme that then moves ≥REVERSAL_PCT against itself within
 * REVERSAL_LOOKAHEAD bars. Used for both cycle pivots and the fourth-level-top
 * claim.
 */
export function reversalNear(
  candles: Candle[],
  centerIndex: number,
  fractalN: number,
  window = CYCLE_WINDOW,
  reversalPct = REVERSAL_PCT,
  lookahead = REVERSAL_LOOKAHEAD,
): boolean {
  for (let j = centerIndex - window; j <= centerIndex + window; j++) {
    if (j < 0 || j >= candles.length) continue;
    if (isFractalHigh(candles, j, fractalN)) {
      const high = candles[j]!.high;
      const end = Math.min(candles.length - 1, j + lookahead);
      for (let k = j + 1; k <= end; k++) {
        if (candles[k]!.low <= high * (1 - reversalPct)) return true;
      }
    }
    if (isFractalLow(candles, j, fractalN)) {
      const low = candles[j]!.low;
      const end = Math.min(candles.length - 1, j + lookahead);
      for (let k = j + 1; k <= end; k++) {
        if (candles[k]!.high >= low * (1 + reversalPct)) return true;
      }
    }
  }
  return false;
}

// ── Stats ───────────────────────────────────────────────────────────────────

/** Wilson 95% interval for a binomial proportion. */
export function wilson(
  hits: number,
  n: number,
  z = 1.96,
): { lo: number; hi: number } {
  if (n === 0) return { lo: 0, hi: 0 };
  const p = hits / n;
  const denom = 1 + (z * z) / n;
  const center = (p + (z * z) / (2 * n)) / denom;
  const margin =
    (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / denom;
  return { lo: Math.max(0, center - margin), hi: Math.min(1, center + margin) };
}

/** Deterministic PRNG (mulberry32) — reproducible random baselines. */
export function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
