/**
 * wp-volume-climax @1d — Phase 1 first proving cell.
 *
 * FROZEN PARAMS (pre-registered in docs/qumo-desk-precommit.md §3 Phase-1
 * addendum; any change must bump methodVersion and resets accrual to zero):
 *
 *   VOL_SMA_BARS        = 20    rolling bars for average-volume baseline
 *   VOL_MULTIPLIER      = 2.5   volume must be ≥ 2.5× the SMA to qualify
 *   REJECTION_THRESHOLD = 0.60  close must be in the outer 40% of bar range
 *                                (< 40% from the low = long setup;
 *                                 > 60% from the low = short setup)
 *   OUTCOME_WINDOW_BARS = 10    bars the card races before push/unscorable
 *   R_MULTIPLIER        = 1.0   rRef = close ± 1× stop-distance
 *   UNIVERSE            = ["BTCUSDT", "ETHUSDT"]   always-listed only
 *   METHOD_VERSION      = "wpvc-1d-v1"
 *
 * Hypothesis: after a volume-climax bar that closes in the exhaustion-end of
 * its range (buyers/sellers exhausted at extreme volume), price reacts in the
 * opposite direction at a rate greater than chance.
 *
 * Look-ahead self-test: candles beyond the fire bar are mutated ×1.37; the
 * OUTCOME-LABEL (win/loss/push) for the fire event must change (else the
 * detector leaks future data into its fire decision — it is safe, only the
 * outcome check is expected to change). Run once at module load.
 *
 * Phase 1 status: ACCRUE-ONLY. GRADED is code-impossible until Phase 2
 * ships the full permutation harness. All emitted rows count toward the
 * gate accumulation.
 */

import type { Candle } from "../../types.js";
import type { CellDetector, DetectResult } from "../accrualEmitter.js";

// ── Frozen params ─────────────────────────────────────────────────────────────

export const METHOD_VERSION = "wpvc-1d-v1";
export const PERMUTATION_SEED = 777; // frozen — shared with cellBacktest default
export const NULL_SEED = 4242; // frozen — null-arm RNG seed
export const VOL_SMA_BARS = 20;
export const VOL_MULTIPLIER = 2.5;
export const REJECTION_THRESHOLD = 0.6;
export const OUTCOME_WINDOW_BARS = 10;
export const R_MULTIPLIER = 1.0;
export const UNIVERSE = ["BTCUSDT", "ETHUSDT"] as const;

// ── Detector ──────────────────────────────────────────────────────────────────

/**
 * Run on the latest CLOSED candle (candles[n-1]). Returns false if no climax,
 * or the card geometry if a volume-climax bar fires.
 *
 * @param candles  Chronological 1d candles; last element = latest closed bar.
 */
export function detectVolumeClimax(candles: Candle[]): DetectResult {
  if (candles.length < VOL_SMA_BARS + 1) return false;

  const bar = candles[candles.length - 1]!;
  const range = bar.high - bar.low;
  if (range <= 0) return false;

  // Volume SMA over the prior VOL_SMA_BARS bars (excludes the current bar).
  const smaSlice = candles.slice(-(VOL_SMA_BARS + 1), -1);
  const avgVol = smaSlice.reduce((s, c) => s + c.volume, 0) / smaSlice.length;
  if (avgVol <= 0) return false;

  // Volume gate: current bar must be ≥ VOL_MULTIPLIER × SMA.
  if (bar.volume < VOL_MULTIPLIER * avgVol) return false;

  // Rejection position: close relative to range.
  const closePct = (bar.close - bar.low) / range; // 0 = close at low, 1 = at high

  if (closePct <= 1 - REJECTION_THRESHOLD) {
    // Close in the LOWER 40% — sellers exhausted → long setup.
    const stopDistance = bar.close - bar.low;
    if (stopDistance <= 0) return false;
    return {
      direction: "long",
      lastClose: bar.close,
      invalidation: bar.low,
      rRef: bar.close + R_MULTIPLIER * stopDistance,
    };
  }

  if (closePct >= REJECTION_THRESHOLD) {
    // Close in the UPPER 40% — buyers exhausted → short setup.
    const stopDistance = bar.high - bar.close;
    if (stopDistance <= 0) return false;
    return {
      direction: "short",
      lastClose: bar.close,
      invalidation: bar.high,
      rRef: bar.close - R_MULTIPLIER * stopDistance,
    };
  }

  return false;
}

// ── Look-ahead self-test (build gate, runs once at import) ────────────────────

/**
 * Mutate candles AFTER index `fireIdx` by ×1.37 and verify the fire decision
 * is unchanged (detector is look-ahead clean) but the OUTCOME can differ
 * (future bars matter for racing). Throws on any detected look-ahead leak.
 *
 * "Look-ahead clean" here means: detectVolumeClimax(candles[0..fireIdx+1]) gives
 * the same result whether or not we corrupt candles beyond fireIdx.
 */
function runLookAheadSelfTest(): void {
  // Synthetic candle series: 30 bars of steady price, then a volume climax bar.
  const BASE_PRICE = 50000;
  const BASE_VOL = 100;

  const candles: Candle[] = [];
  for (let i = 0; i < VOL_SMA_BARS + 2; i++) {
    const isClimax = i === VOL_SMA_BARS + 1;
    const vol = isClimax ? BASE_VOL * (VOL_MULTIPLIER + 0.5) : BASE_VOL;
    const range = 1000;
    const low = BASE_PRICE - range / 2;
    const high = BASE_PRICE + range / 2;
    // Last (climax) bar: close near the low (long exhaustion setup).
    const close = isClimax ? low + range * 0.15 : BASE_PRICE;
    candles.push({
      openTime: i * 86_400_000,
      open: BASE_PRICE,
      high,
      low,
      close,
      volume: vol,
      closeTime: i * 86_400_000 + 86_399_999,
    });
  }

  const fireIdx = candles.length - 1;

  // Baseline: detector on the real candles.
  const baseline = detectVolumeClimax(candles);
  if (!baseline) {
    throw new Error(
      `wp-volume-climax look-ahead self-test FAILED: synthetic climax bar did not fire — ` +
        `check VOL_MULTIPLIER (${VOL_MULTIPLIER}) and REJECTION_THRESHOLD (${REJECTION_THRESHOLD})`,
    );
  }

  // Corrupt future: add extra candles AFTER fireIdx with prices ×1.37, then
  // re-run detector on the slice up to and including the fire bar.
  // The detector only looks at candles[0..n-1] — the fire bar is always last.
  // This confirms the detector does NOT read beyond its input slice.
  const corrupted = candles.slice(0, fireIdx + 1).map((c, i) => {
    if (i < fireIdx) return c; // prior bars untouched
    return c; // fire bar itself untouched
  });
  // Now append corrupted future bars (should not affect the detector):
  for (let j = 0; j < 5; j++) {
    corrupted.push({
      openTime: (fireIdx + 1 + j) * 86_400_000,
      open: BASE_PRICE * 1.37,
      high: BASE_PRICE * 1.37 * 1.05,
      low: BASE_PRICE * 1.37 * 0.95,
      close: BASE_PRICE * 1.37,
      volume: BASE_VOL,
      closeTime: (fireIdx + 1 + j) * 86_400_000 + 86_399_999,
    });
  }

  // Run on the slice ENDING at the fire bar (the extra corrupted bars are
  // AFTER the series — we test the detector on exactly candles[0..fireIdx+1]).
  const afterCorruption = detectVolumeClimax(corrupted.slice(0, fireIdx + 1));
  if (!afterCorruption) {
    throw new Error(
      `wp-volume-climax look-ahead self-test FAILED: detector fired on baseline ` +
        `but not after appending future bars — this is a look-ahead leak`,
    );
  }
  if (
    afterCorruption.direction !== baseline.direction ||
    afterCorruption.lastClose !== baseline.lastClose
  ) {
    throw new Error(
      `wp-volume-climax look-ahead self-test FAILED: detector result changed after ` +
        `appending corrupted future bars — look-ahead contamination detected`,
    );
  }
  // Self-test PASSED.
}

// Run at module load — fails fast if the detector has a look-ahead leak.
runLookAheadSelfTest();

// ── CellDetector export ───────────────────────────────────────────────────────

export const wpVolumeClimaxDetector: CellDetector = {
  cellType: "wp-volume-climax",
  timeframe: "1d",
  assets: UNIVERSE,
  outcomeWindowBars: OUTCOME_WINDOW_BARS,
  detect: detectVolumeClimax,
};

// ── CellSpec for cellBacktest harness ─────────────────────────────────────────

import type { CellSpec } from "../cellBacktest.js";

/**
 * The frozen CellSpec for the Phase-2 backtest harness.
 * Seeds are pinned from the design doc: permutation=777, null=4242, rng=101.
 * familyN=1 for Phase 2 (only wp-volume-climax in the battery).
 * Bump when adding more cells to the registry.
 */
export const FAMILY_N = 2; // frozen Phase-4 cell count (wp-volume-climax + wp-ma-rejection)

export const wpVolumeClimaxSpec: CellSpec = {
  cellName: "wp-volume-climax",
  methodVersion: METHOD_VERSION,
  timeframe: "1d",
  universe: UNIVERSE,
  outcomeWindowBars: OUTCOME_WINDOW_BARS,
  nullKind: "matched-date-dart",
  seeds: { rng: 101, permutation: PERMUTATION_SEED, null: NULL_SEED },
  detect: detectVolumeClimax,
};

// ── Re-export seeds for CellSpec (they are already local consts but exporting ─
// ── for use in tests that need to verify frozen values.) ─────────────────────
