/**
 * Fractal swing detection — the frozen, no-lookahead foundation.
 *
 * A bar is a swing high iff its high is STRICTLY greater than the highs of the
 * `n` bars on each side (symmetric for lows). Strictness means ties are not
 * swings. Because a swing needs `n` bars on BOTH sides, the most recent `n`
 * bars of any array can never be classified — that is the structural guarantee
 * that a walk-forward backtest (which slices candles to the cursor) can never
 * "see" a swing that depends on future bars.
 */

import type { Candle, Swing, SwingKind } from "./types.js";

/**
 * Is bar `i` a fractal high — high strictly greater than the `n` bars on each
 * side? Returns false if `i` is too close to either edge to be confirmed.
 * Exported so the backtest scorer shares one definition of "reversal extreme".
 */
export function isFractalHigh(
  candles: Candle[],
  i: number,
  n: number,
): boolean {
  if (i - n < 0 || i + n >= candles.length) return false;
  const h = candles[i]!.high;
  for (let j = i - n; j <= i + n; j++) {
    if (j === i) continue;
    if (candles[j]!.high >= h) return false; // strict: ties disqualify
  }
  return true;
}

/** Is bar `i` a fractal low — low strictly less than the `n` bars on each side? */
export function isFractalLow(candles: Candle[], i: number, n: number): boolean {
  if (i - n < 0 || i + n >= candles.length) return false;
  const l = candles[i]!.low;
  for (let j = i - n; j <= i + n; j++) {
    if (j === i) continue;
    if (candles[j]!.low <= l) return false; // strict: ties disqualify
  }
  return true;
}

/**
 * All confirmed swings in `candles`, in chronological order. Only indices in
 * [n, length-1-n] are considered, so the trailing `n` bars (unconfirmed) are
 * never returned. A bar that is both a high and a low (degenerate flat window)
 * is impossible under strict comparison; highs are checked first regardless.
 */
export function detectSwings(candles: Candle[], n = 2): Swing[] {
  if (n < 1) throw new Error(`fractal N must be >= 1, got ${n}`);
  const swings: Swing[] = [];
  for (let i = n; i <= candles.length - 1 - n; i++) {
    if (isFractalHigh(candles, i, n)) {
      swings.push({
        index: i,
        time: candles[i]!.openTime,
        price: candles[i]!.high,
        kind: "high",
      });
    } else if (isFractalLow(candles, i, n)) {
      swings.push({
        index: i,
        time: candles[i]!.openTime,
        price: candles[i]!.low,
        kind: "low",
      });
    }
  }
  return swings;
}

/** The most recent swing of `kind` in a chronological swing list, or null. */
export function latestSwing(swings: Swing[], kind: SwingKind): Swing | null {
  for (let i = swings.length - 1; i >= 0; i--) {
    if (swings[i]!.kind === kind) return swings[i]!;
  }
  return null;
}

/** The most recent swing of either kind (the latest reversal), or null. */
export function latestReversal(swings: Swing[]): Swing | null {
  return swings.length > 0 ? swings[swings.length - 1]! : null;
}
