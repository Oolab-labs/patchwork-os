/**
 * TA-cycles shared types.
 *
 * A deterministic, no-LLM reimplementation of a mechanical time/price TA
 * system (see docs/ta-cycles-backtest-precommit.md). Generic by mechanism —
 * fractal swings, range-thirds price levels, candle-count time cycles — with
 * no proprietary branding. `METHOD_VERSION` pins the frozen rule set; any
 * change to swing detection, the level ladder, or the cycle sequence MUST bump
 * it so historical predictions remain scorable under the rules they were made
 * under.
 */

/** Frozen rule-set identifier. Bump on ANY change to swings/levels/cycles. */
export const METHOD_VERSION = "ta-cycles-1";

/** Candle-count sequence for time-cycle pivots (frozen). */
export const PIVOT_SEQUENCE = [7, 9, 13, 14, 18, 21, 26, 28] as const;

/** Supported timeframes and their bar interval in milliseconds. */
export type Timeframe = "1d" | "4h";

export const BAR_INTERVAL_MS: Record<Timeframe, number> = {
  "1d": 86_400_000,
  "4h": 14_400_000,
};

export interface Candle {
  /** Bar open time, ms epoch (UTC). */
  openTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  /** Bar close time, ms epoch (UTC). */
  closeTime: number;
}

export type SwingKind = "high" | "low";

export interface Swing {
  /** Index into the candle array the swing was detected in. */
  index: number;
  /** openTime of the swing bar, ms epoch (UTC). */
  time: number;
  /** Swing price: the bar high (kind "high") or low (kind "low"). */
  price: number;
  kind: SwingKind;
}

export interface PriceLevels {
  swingLow: number;
  swingHigh: number;
  /** swingHigh - swingLow (always > 0; computeLevels returns null otherwise). */
  range: number;
  /** 50% retracement (low + range/2), tracked separately from the ladder. */
  fifty: number;
  /** Ladder: low + k·(range/3) for k = 0..maxK. k=3 is the swing high. */
  ladder: { k: number; price: number }[];
  /** Level k=4 (high + range/3) — the claimed ~78% top, or null if maxK < 4. */
  fourthLevel: number | null;
  /** Static annotation of the claimed top probability. NOT a learned value. */
  fourthLevelTopProbabilityHint: number;
}

export interface TimePivot {
  /** Cycle length in bars (a member of PIVOT_SEQUENCE). */
  n: number;
  /** Projected pivot time, ms epoch (UTC). */
  projectedTime: number;
  /** Projected pivot time, ISO-8601 (UTC). */
  projectedDate: string;
  fromSwingIndex: number;
  fromSwingKind: SwingKind;
  fromSwingTime: number;
  /** True for timeframes the method claims are more reliable (1d > 4h). */
  moreReliable: boolean;
}

export interface SignalResult {
  methodVersion: string;
  /** closeTime of the last candle the signals were computed from. */
  asOfTime: number;
  timeframe: Timeframe;
  fractalN: number;
  latestSwingHigh: Swing | null;
  latestSwingLow: Swing | null;
  levels: PriceLevels | null;
  timePivots: TimePivot[];
  warnings: string[];
}
