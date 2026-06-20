/**
 * TA-cycles signal orchestrator.
 *
 * `computeSignals` runs the frozen rule set over a candle series and returns
 * the current price levels (from the most recent confirmed swing-low →
 * swing-high range) and the time-cycle pivots projected from the most recent
 * reversal. For a walk-forward backtest, pass a slice of candles ending at the
 * cursor — the no-lookahead guarantee is structural (detectSwings excludes the
 * trailing N bars).
 */

import { projectTimePivots } from "./cycles.js";
import { computeLevels } from "./levels.js";
import { detectSwings, latestReversal, latestSwing } from "./swings.js";
import {
  type Candle,
  METHOD_VERSION,
  type SignalResult,
  type Timeframe,
} from "./types.js";

export interface ComputeOptions {
  timeframe: Timeframe;
  /** Fractal half-width. Default 2 (5-bar). Pinned by METHOD_VERSION. */
  fractalN?: number;
  /** Ladder depth in R/3 steps. Default 9. */
  maxK?: number;
}

export function computeSignals(
  candles: Candle[],
  opts: ComputeOptions,
): SignalResult {
  const fractalN = opts.fractalN ?? 2;
  const warnings: string[] = [];
  const asOfTime =
    candles.length > 0 ? candles[candles.length - 1]!.closeTime : 0;

  const swings = detectSwings(candles, fractalN);
  const latestSwingHigh = latestSwing(swings, "high");
  const latestSwingLow = latestSwing(swings, "low");

  let levels = null;
  if (latestSwingLow && latestSwingHigh) {
    levels = computeLevels(
      latestSwingLow.price,
      latestSwingHigh.price,
      opts.maxK,
    );
    if (!levels) {
      warnings.push(
        "latest swing high is not above latest swing low — no level range",
      );
    }
  } else {
    warnings.push("insufficient confirmed swings to define a level range");
  }

  const reversal = latestReversal(swings);
  const timePivots = reversal
    ? projectTimePivots(reversal, opts.timeframe)
    : [];
  if (!reversal) warnings.push("no confirmed swing to project cycles from");

  return {
    methodVersion: METHOD_VERSION,
    asOfTime,
    timeframe: opts.timeframe,
    fractalN,
    latestSwingHigh,
    latestSwingLow,
    levels,
    timePivots,
    warnings,
  };
}

export { projectTimePivots } from "./cycles.js";
export { computeLevels, FOURTH_LEVEL_TOP_HINT } from "./levels.js";
export { detectSwings, latestReversal, latestSwing } from "./swings.js";
export * from "./types.js";
