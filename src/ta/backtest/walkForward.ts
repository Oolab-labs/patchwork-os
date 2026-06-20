/**
 * Walk-forward backtest loop.
 *
 * At each cursor t, only swings confirmed by t (index ≤ t − N) are visible and
 * outcomes are scored strictly on bars after t — the no-lookahead guarantee.
 * Detecting all swings once and filtering by index is provably identical to
 * re-running detection on candles[0..t] (a fractal at i needs only bars i±N,
 * all ≤ t when i ≤ t − N) and is far cheaper.
 *
 * Each distinct setup (a swing range, or a swing+cycle) is emitted ONCE, at the
 * first cursor it appears, so correlated repeats don't inflate N.
 */

import { computeLevels } from "../levels.js";
import { detectSwings, latestReversal, latestSwing } from "../swings.js";
import { type Candle, PIVOT_SEQUENCE, type Timeframe } from "../types.js";
import {
  CYCLE_WINDOW,
  firstTouchIndex,
  mulberry32,
  OUTCOME_WINDOW,
  priceLevelHit,
  reversalNear,
} from "./scoring.js";

export type ClaimType =
  | "price-third"
  | "price-fifty"
  | "fourth-level-top"
  | "time-cycle";

export interface Prediction {
  asset: string;
  timeframe: Timeframe;
  type: ClaimType;
  n?: number;
  cursorIndex: number;
  hit: boolean;
  baselineHit: boolean;
}

export interface WalkForwardOptions {
  asset: string;
  timeframe: Timeframe;
  fractalN?: number;
  /** Bars to skip at the start (need swing history). */
  warmup?: number;
  /** PRNG seed for reproducible random baselines. */
  seed?: number;
  /**
   * Cycle bar-counts projected from reversals (default PIVOT_SEQUENCE — the
   * ta-cycles-1 set). fibtime-1 passes the Fibonacci set; the paired-baseline
   * scoring is otherwise identical.
   */
  cycleSequence?: readonly number[];
}

export function runWalkForward(
  candles: Candle[],
  opts: WalkForwardOptions,
): Prediction[] {
  const fractalN = opts.fractalN ?? 2;
  const warmup = opts.warmup ?? 60;
  const cycleSequence = opts.cycleSequence ?? PIVOT_SEQUENCE;
  const rng = mulberry32(opts.seed ?? 0x5eed);
  const preds: Prediction[] = [];
  const emitted = new Set<string>();

  const allSwings = detectSwings(candles, fractalN);
  const lastCursor = candles.length - 1 - OUTCOME_WINDOW;

  for (let t = warmup; t <= lastCursor; t++) {
    const avail = allSwings.filter((s) => s.index <= t - fractalN);
    if (avail.length === 0) continue;
    const hi = latestSwing(avail, "high");
    const lo = latestSwing(avail, "low");
    const rev = latestReversal(avail);
    const from = t + 1;
    const to = t + OUTCOME_WINDOW;
    const future = candles.slice(from, to + 1);

    // ── Price levels (S/R retracements + fourth-level top) ──────────────────
    if (hi && lo) {
      const levels = computeLevels(lo.price, hi.price);
      if (levels) {
        const rangeKey = `${lo.time}:${hi.time}`;
        const randLevel = () => lo.price + rng() * levels.range;

        // R/3 and 2R/3 retracements → price-third
        for (const k of [1, 2]) {
          const key = `third${k}:${rangeKey}`;
          if (!emitted.has(key)) {
            emitted.add(key);
            const level = levels.ladder[k]!.price;
            preds.push({
              asset: opts.asset,
              timeframe: opts.timeframe,
              type: "price-third",
              cursorIndex: t,
              hit: priceLevelHit(level, future),
              baselineHit: priceLevelHit(randLevel(), future),
            });
          }
        }

        // 50% retracement → price-fifty
        const fiftyKey = `fifty:${rangeKey}`;
        if (!emitted.has(fiftyKey)) {
          emitted.add(fiftyKey);
          preds.push({
            asset: opts.asset,
            timeframe: opts.timeframe,
            type: "price-fifty",
            cursorIndex: t,
            hit: priceLevelHit(levels.fifty, future),
            baselineHit: priceLevelHit(randLevel(), future),
          });
        }

        // Fourth level (high + R/3): a top claim — only resolves if price
        // reaches it within the window; hit = reversal at the touch.
        const topKey = `top:${rangeKey}`;
        if (levels.fourthLevel !== null && !emitted.has(topKey)) {
          const touch = firstTouchIndex(levels.fourthLevel, candles, from, to);
          if (touch !== -1) {
            emitted.add(topKey);
            const randIdx = from + Math.floor(rng() * (to - from + 1));
            preds.push({
              asset: opts.asset,
              timeframe: opts.timeframe,
              type: "fourth-level-top",
              cursorIndex: t,
              hit: reversalNear(candles, touch, fractalN),
              baselineHit: reversalNear(candles, randIdx, fractalN),
            });
          }
        }
      }
    }

    // ── Time cycles from the latest reversal ────────────────────────────────
    if (rev) {
      for (const n of cycleSequence) {
        const target = rev.index + n;
        if (target <= t || target > to) continue; // must land in the future window
        if (target + CYCLE_WINDOW >= candles.length) continue;
        const key = `cycle:${rev.time}:${n}`;
        if (emitted.has(key)) continue;
        emitted.add(key);
        const randIdx = from + Math.floor(rng() * (to - from + 1));
        preds.push({
          asset: opts.asset,
          timeframe: opts.timeframe,
          type: "time-cycle",
          n,
          cursorIndex: t,
          hit: reversalNear(candles, target, fractalN),
          baselineHit: reversalNear(candles, randIdx, fractalN),
        });
      }
    }
  }

  return preds;
}

/** Unconditional context stats — the "dumb" reference rates. */
export function contextStats(
  candles: Candle[],
  fractalN = 2,
): { reversalBaseRate: number; upRate: number; bars: number } {
  let reversals = 0;
  let ups = 0;
  let denom = 0;
  for (let i = fractalN; i < candles.length - OUTCOME_WINDOW; i++) {
    if (reversalNear(candles, i, fractalN)) reversals++;
    if (candles[i + OUTCOME_WINDOW]!.close > candles[i]!.close) ups++;
    denom++;
  }
  return {
    reversalBaseRate: denom ? reversals / denom : 0,
    upRate: denom ? ups / denom : 0,
    bars: denom,
  };
}
