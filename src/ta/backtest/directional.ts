/**
 * Directional / tradeable test for the retracement levels.
 *
 * The pre-registered backtest only asked "does a level get TOUCHED more than a
 * random level" (answer: barely — touching is near-universal in a range). This
 * asks the question that actually matters for trading: when price reaches the
 * level, does it HOLD (bounce away in the approach-implied direction with
 * tradeable R:R) more often than at a random level?
 *
 * Approach direction is read from the bar before the touch: approaching from
 * above → support (held = bounces up); from below → resistance (held = rejects
 * down). An outcome is counted only if it resolves to hold or break within K
 * bars — undecided touches are excluded, not scored as misses.
 */

import { computeLevels } from "../levels.js";
import { detectSwings, latestSwing } from "../swings.js";
import type { Candle, Timeframe } from "../types.js";
import { firstTouchIndex, mulberry32, OUTCOME_WINDOW } from "./scoring.js";

const RESOLVE_BARS = 10;
const MOVE_PCT = 0.015;

export type Resolution = "hold" | "break" | "none";

/**
 * Classify how price behaved at a level touch: held (bounced in the
 * approach-implied direction), broke through, or did not resolve within K bars.
 * Shared by the directional backtest and the live ledger scorer so both use one
 * definition of "the level held".
 */
export function resolveTouch(
  candles: Candle[],
  f: number,
  level: number,
): Resolution {
  if (f < 1) return "none";
  const support = candles[f - 1]!.close > level; // approached from above
  const up = level * (1 + MOVE_PCT);
  const down = level * (1 - MOVE_PCT);
  const end = Math.min(candles.length - 1, f + RESOLVE_BARS);
  for (let k = f + 1; k <= end; k++) {
    const c = candles[k]!;
    if (support) {
      if (c.low <= down) return "break"; // fell through support
      if (c.high >= up) return "hold"; // bounced
    } else {
      if (c.high >= up) return "break"; // broke through resistance
      if (c.low <= down) return "hold"; // rejected down
    }
  }
  return "none";
}

export interface DirectionalOptions {
  asset: string;
  timeframe: Timeframe;
  fractalN?: number;
  warmup?: number;
  seed?: number;
}

/**
 * One scored setup. The method and baseline are each scored ONLY when their own
 * touch resolves to hold/break — so both hold-rates share the same conditional
 * denominator (resolved touches). Counting baseline no-touch/undecided cases as
 * misses (the earlier bug) deflated the baseline and inflated the edge.
 */
export interface DirRecord {
  asset: string;
  timeframe: Timeframe;
  type: "price-third" | "price-fifty";
  /** Method touched + resolved here (always true — unresolved are not emitted). */
  methodHold: boolean;
  /** Random in-range control touched + resolved within the same window. */
  baselineResolved: boolean;
  /** If the baseline resolved, did it hold? (false when unresolved.) */
  baselineHold: boolean;
}

export function runDirectional(
  candles: Candle[],
  opts: DirectionalOptions,
): DirRecord[] {
  const fractalN = opts.fractalN ?? 2;
  const warmup = opts.warmup ?? 60;
  const rng = mulberry32(opts.seed ?? 0x5eed);
  const out: DirRecord[] = [];
  const emitted = new Set<string>();
  const allSwings = detectSwings(candles, fractalN);
  const lastCursor = candles.length - 1 - OUTCOME_WINDOW;

  for (let t = warmup; t <= lastCursor; t++) {
    const avail = allSwings.filter((s) => s.index <= t - fractalN);
    const hi = latestSwing(avail, "high");
    const lo = latestSwing(avail, "low");
    if (!hi || !lo) continue;
    const levels = computeLevels(lo.price, hi.price);
    if (!levels) continue;
    const rangeKey = `${lo.time}:${hi.time}`;
    const from = t + 1;
    const to = t + OUTCOME_WINDOW;

    const targets: { type: "price-third" | "price-fifty"; level: number }[] = [
      { type: "price-third", level: levels.ladder[1]!.price },
      { type: "price-third", level: levels.ladder[2]!.price },
      { type: "price-fifty", level: levels.fifty },
    ];

    for (let i = 0; i < targets.length; i++) {
      const { type, level } = targets[i]!;
      const key = `${type}:${i}:${rangeKey}`;
      if (emitted.has(key)) continue;
      const touch = firstTouchIndex(level, candles, from, to);
      if (touch === -1) continue;
      const res = resolveTouch(candles, touch, level);
      if (res === "none") continue; // method undecided → not a sample
      emitted.add(key);

      // baseline: a random in-range level, scored on the SAME conditional basis
      const randLevel = lo.price + rng() * levels.range;
      const rt = firstTouchIndex(randLevel, candles, from, to);
      const rres = rt === -1 ? "none" : resolveTouch(candles, rt, randLevel);

      out.push({
        asset: opts.asset,
        timeframe: opts.timeframe,
        type,
        methodHold: res === "hold",
        baselineResolved: rres !== "none",
        baselineHold: rres === "hold",
      });
    }
  }
  return out;
}
