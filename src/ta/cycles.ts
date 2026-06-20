/**
 * Time-cycle pivots — candle-count projection.
 *
 * From a confirmed swing extreme (the reversal bar, count 0), pivots project
 * forward at n ∈ PIVOT_SEQUENCE closed bars: `projectedTime = swing.time +
 * n · barInterval`. The method claims higher timeframes are more reliable, so
 * 1d pivots are flagged `moreReliable`.
 */

import {
  BAR_INTERVAL_MS,
  PIVOT_SEQUENCE,
  type Swing,
  type Timeframe,
  type TimePivot,
} from "./types.js";

/**
 * Project all PIVOT_SEQUENCE pivots from a swing on the given timeframe.
 * Returns every pivot (caller filters for "upcoming" when needed; the backtest
 * scores all of them).
 */
export function projectTimePivots(
  swing: Swing,
  timeframe: Timeframe,
): TimePivot[] {
  const interval = BAR_INTERVAL_MS[timeframe];
  const moreReliable = timeframe === "1d";
  return PIVOT_SEQUENCE.map((n) => {
    const projectedTime = swing.time + n * interval;
    return {
      n,
      projectedTime,
      projectedDate: new Date(projectedTime).toISOString(),
      fromSwingIndex: swing.index,
      fromSwingKind: swing.kind,
      fromSwingTime: swing.time,
      moreReliable,
    };
  });
}
