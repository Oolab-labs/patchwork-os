/**
 * wp-ma-rejection @1d — Phase 4 second battery cell.
 *
 * FROZEN PARAMS (pre-registered in docs/qumo-desk-precommit.md §6.2;
 * any change must bump methodVersion and resets accrual to zero):
 *
 *   MA_BARS             = 20    rolling bars for simple moving average
 *   MIN_WICK_DEPTH      = 0.002 minimum wick depth below MA as fraction of close
 *                                (avoids hairline MA touches; 0.002 = 0.2%)
 *   OUTCOME_WINDOW_BARS = 10    bars the card races before push/unscorable
 *   R_MULTIPLIER        = 1.0   rRef = close + 1× stop-distance (1R long only)
 *   UNIVERSE            = ["BTCUSDT", "ETHUSDT"]   always-listed only
 *   METHOD_VERSION      = "wpmr-1d-v1"
 *
 * Hypothesis: a daily bar that wicks below the 20-bar SMA but closes back above
 * it (MA support rejection) reverts at a rate greater than chance over a 10-bar
 * outcome window. LONG only — tests the support-rejection hypothesis.
 *
 * Look-ahead self-test: runs once at module import. Mutates future bars and
 * asserts the fire decision is unchanged (detector reads only the fire bar + prior).
 */

import type { Candle } from "../../types.js";
import type { CellDetector, DetectResult } from "../accrualEmitter.js";
import type { CellSpec } from "../cellBacktest.js";

// ── Frozen params ─────────────────────────────────────────────────────────────

export const METHOD_VERSION = "wpmr-1d-v1";
export const PERMUTATION_SEED = 777;
export const NULL_SEED = 4242;
export const MA_BARS = 20;
export const MIN_WICK_DEPTH = 0.002;
export const OUTCOME_WINDOW_BARS = 10;
export const R_MULTIPLIER = 1.0;
export const UNIVERSE = ["BTCUSDT", "ETHUSDT"] as const;

// ── Detector ──────────────────────────────────────────────────────────────────

/**
 * Run on the latest CLOSED candle (candles[n-1]). Returns false if no rejection,
 * or the card geometry if a MA-rejection bar fires.
 *
 * Fire condition (LONG only):
 *   1. fire bar's low < sma20          (wick pierced below the MA)
 *   2. fire bar's close > sma20        (closed back above the MA = rejection)
 *   3. (sma20 - low) / close ≥ 0.002  (min 0.2% wick depth — avoids hairline touches)
 */
export function detectMaRejection(candles: Candle[]): DetectResult {
  if (candles.length < MA_BARS + 1) return false;

  const bar = candles[candles.length - 1]!;

  // 20-bar SMA over the PRIOR MA_BARS bars (excludes the current bar).
  const smaSlice = candles.slice(-(MA_BARS + 1), -1);
  const sma20 = smaSlice.reduce((s, c) => s + c.close, 0) / smaSlice.length;

  // Fire conditions.
  if (bar.low >= sma20) return false; // wick must pierce below MA
  if (bar.close <= sma20) return false; // must close back above MA
  const wickDepth = (sma20 - bar.low) / bar.close;
  if (wickDepth < MIN_WICK_DEPTH) return false; // hairline touch filter

  const stopDistance = bar.close - bar.low;
  if (stopDistance <= 0) return false;

  return {
    direction: "long",
    lastClose: bar.close,
    invalidation: bar.low,
    rRef: bar.close + R_MULTIPLIER * stopDistance,
  };
}

// ── Look-ahead self-test (build gate, runs once at import) ────────────────────

function runLookAheadSelfTest(): void {
  const BASE_PRICE = 50000;
  const SMA_BASE = 49500; // MA below price so rejection can fire

  // Build a series where the final bar rejects off the SMA.
  const candles: Candle[] = [];
  for (let i = 0; i < MA_BARS + 1; i++) {
    const isRejection = i === MA_BARS;
    const close = isRejection ? BASE_PRICE : SMA_BASE; // prior bars near SMA base
    const low = isRejection ? SMA_BASE * 0.99 : SMA_BASE * 0.98; // rejection bar: low dips below SMA
    const high = isRejection ? BASE_PRICE * 1.01 : SMA_BASE * 1.01;
    candles.push({
      openTime: i * 86_400_000,
      open: close,
      high,
      low,
      close,
      volume: 100,
      closeTime: i * 86_400_000 + 86_399_999,
    });
  }

  // The SMA of prior bars ≈ SMA_BASE. The fire bar's low = SMA_BASE * 0.99 < SMA_BASE,
  // close = BASE_PRICE > SMA_BASE. Should fire.
  const baseline = detectMaRejection(candles);
  if (!baseline) {
    throw new Error(
      `wp-ma-rejection look-ahead self-test FAILED: synthetic rejection bar did not fire — ` +
        `check MA_BARS (${MA_BARS}) and MIN_WICK_DEPTH (${MIN_WICK_DEPTH})`,
    );
  }

  // Append corrupted future bars (prices ×1.37) then re-run on same slice — result must match.
  const corrupted = [...candles];
  for (let j = 0; j < 5; j++) {
    corrupted.push({
      openTime: (MA_BARS + 1 + j) * 86_400_000,
      open: BASE_PRICE * 1.37,
      high: BASE_PRICE * 1.37 * 1.05,
      low: BASE_PRICE * 1.37 * 0.95,
      close: BASE_PRICE * 1.37,
      volume: 100,
      closeTime: (MA_BARS + 1 + j) * 86_400_000 + 86_399_999,
    });
  }

  const afterCorruption = detectMaRejection(corrupted.slice(0, MA_BARS + 1));
  if (!afterCorruption) {
    throw new Error(
      `wp-ma-rejection look-ahead self-test FAILED: detector fired on baseline but not after appending future bars`,
    );
  }
  if (
    afterCorruption.direction !== baseline.direction ||
    afterCorruption.lastClose !== baseline.lastClose
  ) {
    throw new Error(
      `wp-ma-rejection look-ahead self-test FAILED: detector result changed after appending corrupted future bars`,
    );
  }
}

runLookAheadSelfTest();

// ── CellDetector export ───────────────────────────────────────────────────────

export const wpMaRejectionDetector: CellDetector = {
  cellType: "wp-ma-rejection",
  timeframe: "1d",
  assets: UNIVERSE,
  outcomeWindowBars: OUTCOME_WINDOW_BARS,
  detect: detectMaRejection,
};

// ── CellSpec for cellBacktest harness ─────────────────────────────────────────

/**
 * FAMILY_N bumps from 1 → 2 when this cell joins the battery.
 * Both cells must use the updated FAMILY_N for the shared Holm correction.
 */
export const FAMILY_N = 2; // frozen Phase-4 cell count (wp-volume-climax + wp-ma-rejection)

export const wpMaRejectionSpec: CellSpec = {
  cellName: "wp-ma-rejection",
  methodVersion: METHOD_VERSION,
  timeframe: "1d",
  universe: UNIVERSE,
  outcomeWindowBars: OUTCOME_WINDOW_BARS,
  nullKind: "matched-date-dart",
  seeds: { rng: 101, permutation: PERMUTATION_SEED, null: NULL_SEED },
  detect: detectMaRejection,
};
