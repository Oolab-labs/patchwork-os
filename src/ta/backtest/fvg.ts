/**
 * fvg-1 — liquidity-void (fair value gap) backtest (Phase 1d).
 *
 * Frozen by docs/phase1d-precommit.md. Detection constants come verbatim from
 * the user's EW_Fib_Liquidity.pine (ATR(100)×0.5 gap, ATR(14)×1.0 displacement,
 * 10% penetration, CE midpoint); the refuter-amended baselines are matched
 * random bands (H-magnet) and displacement-matched non-void days
 * (H-continuation), with block bootstrap over event clusters because void
 * outcome windows overlap. All randomness via frozen mulberry32 seeds.
 */

import type { Candle } from "../types.js";
import { mean } from "./tsmom.js";

/** Deterministic PRNG (frozen seeds in the precommit). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Wilder RMA ATR; index i uses true ranges of bars ≤ i. null during warm-up. */
export function atrWilder(
  candles: Candle[],
  period: number,
): (number | null)[] {
  const out: (number | null)[] = new Array(candles.length).fill(null);
  let prev: number | null = null;
  let sum = 0;
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i]!;
    const tr =
      i === 0
        ? c.high - c.low
        : Math.max(
            c.high - c.low,
            Math.abs(c.high - candles[i - 1]!.close),
            Math.abs(c.low - candles[i - 1]!.close),
          );
    if (i < period) {
      sum += tr;
      if (i === period - 1) {
        prev = sum / period;
        out[i] = prev;
      }
    } else {
      prev = (prev! * (period - 1) + tr) / period;
      out[i] = prev;
    }
  }
  return out;
}

export interface VoidEvent {
  /** +1 bullish (zone below price), −1 bearish (zone above price) */
  dir: 1 | -1;
  /** event bar index — LAST bar of a stacked run (merge rule) */
  t: number;
  vTop: number;
  vBot: number;
  ce: number;
  width: number;
  /** |close[t] − nearest zone edge| at the event bar */
  distance: number;
  /** formation displacement ratio |close[t−1]−open[t−1]| / ATR14[t] */
  dispRatio: number;
  /** ATR100 at the event bar (for vol-decile matching) */
  atr100: number;
}

/** Raw per-bar detection flag (before stacking merge); exported for controls. */
export function rawVoidFlags(
  candles: Candle[],
  atr100: (number | null)[],
  atr14: (number | null)[],
): (1 | -1 | 0)[] {
  const flags: (1 | -1 | 0)[] = new Array(candles.length).fill(0);
  for (let t = 2; t < candles.length; t++) {
    const a100 = atr100[t];
    const a14 = atr14[t];
    if (
      a100 === null ||
      a100 === undefined ||
      a14 === null ||
      a14 === undefined
    )
      continue;
    const disp = Math.abs(candles[t - 1]!.close - candles[t - 1]!.open);
    if (disp <= a14 * 1.0) continue;
    const bullGap = candles[t]!.low - candles[t - 2]!.high;
    if (
      bullGap > a100 * 0.5 &&
      candles[t]!.low > candles[t - 2]!.high &&
      candles[t - 1]!.close > candles[t - 2]!.high
    ) {
      flags[t] = 1;
      continue;
    }
    const bearGap = candles[t - 2]!.low - candles[t]!.high;
    if (
      bearGap > a100 * 0.5 &&
      candles[t]!.high < candles[t - 2]!.low &&
      candles[t - 1]!.close < candles[t - 2]!.low
    ) {
      flags[t] = -1;
    }
  }
  return flags;
}

/** Detect voids with the stacked-merge rule (consecutive same-dir → one event). */
export function detectVoids(candles: Candle[]): VoidEvent[] {
  const atr100 = atrWilder(candles, 100);
  const atr14 = atrWilder(candles, 14);
  const flags = rawVoidFlags(candles, atr100, atr14);
  const out: VoidEvent[] = [];
  let i = 0;
  while (i < candles.length) {
    const dir = flags[i];
    if (dir === 0 || dir === undefined) {
      i++;
      continue;
    }
    let last = i;
    while (last + 1 < candles.length && flags[last + 1] === dir) last++;
    const first = i;
    const vTop = dir === 1 ? candles[last]!.low : candles[first - 2]!.low;
    const vBot = dir === 1 ? candles[first - 2]!.high : candles[last]!.high;
    if (vTop > vBot) {
      const t = last;
      const close = candles[t]!.close;
      const nearest = dir === 1 ? vTop : vBot;
      out.push({
        dir,
        t,
        vTop,
        vBot,
        ce: (vTop + vBot) / 2,
        width: vTop - vBot,
        distance: Math.abs(close - nearest),
        dispRatio:
          Math.abs(candles[t - 1]!.close - candles[t - 1]!.open) /
          (atr14[t] ?? Number.NaN),
        atr100: atr100[t] ?? Number.NaN,
      });
    }
    i = last + 1;
  }
  return out;
}

export interface MachineOutcome {
  tested: boolean;
  ceReached: boolean;
  filled: boolean;
  /** first bar index with a >10%-penetration touch while not yet filled */
  touchBar: number | null;
  /** 5-bar log return from touch close, signed AWAY from the zone */
  reaction: number | null;
}

/**
 * Run the frozen state machine on a zone from bar `from`+1 for `window` bars.
 * Works identically for real voids and control bands (dir gives zone side).
 */
export function runStateMachine(
  candles: Candle[],
  dir: 1 | -1,
  vTop: number,
  vBot: number,
  from: number,
  window = 30,
): MachineOutcome {
  const width = vTop - vBot;
  let tested = false;
  let ceReached = false;
  let filled = false;
  let touchBar: number | null = null;
  const ce = (vTop + vBot) / 2;
  const end = Math.min(candles.length - 1, from + window);
  for (let i = from + 1; i <= end; i++) {
    const c = candles[i]!;
    if (dir === 1) {
      // zone below price: penetration measured downward from vTop
      const pen = vTop - c.low;
      if (!filled && pen > 0.1 * width) {
        if (!tested) {
          tested = true;
          touchBar = i;
        }
      }
      if (c.low <= ce) ceReached = true;
      if (c.low < vBot) {
        filled = true;
        break;
      }
    } else {
      const pen = c.high - vBot;
      if (!filled && pen > 0.1 * width) {
        if (!tested) {
          tested = true;
          touchBar = i;
        }
      }
      if (c.high >= ce) ceReached = true;
      if (c.high > vTop) {
        filled = true;
        break;
      }
    }
  }
  let reaction: number | null = null;
  if (touchBar !== null && touchBar + 5 < candles.length) {
    const r = Math.log(candles[touchBar + 5]!.close / candles[touchBar]!.close);
    reaction = dir === 1 ? r : -r; // away from the zone
  }
  return { tested, ceReached, filled, touchBar, reaction };
}

/** Decile index (0-9) of x against frozen sorted boundaries. */
export function decileOf(sorted: number[], x: number): number {
  if (sorted.length === 0) return 0;
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid]! <= x) lo = mid + 1;
    else hi = mid;
  }
  const frac = lo / sorted.length;
  return Math.min(9, Math.floor(frac * 10));
}

/** Cluster events whose event bars are < gap bars apart (block bootstrap unit). */
export function clusterIndices(eventBars: number[], gap = 30): number[][] {
  const clusters: number[][] = [];
  let cur: number[] = [];
  for (let i = 0; i < eventBars.length; i++) {
    if (cur.length === 0 || eventBars[i]! - eventBars[i - 1]! < gap) {
      cur.push(i);
    } else {
      clusters.push(cur);
      cur = [i];
    }
  }
  if (cur.length) clusters.push(cur);
  return clusters;
}

/**
 * One-sided cluster-bootstrap p for Δ = mean(eventStat) − mean(controlStat),
 * H1: Δ > 0. Pairs travel together (each event carries its control mean).
 * p = (1 + #{boot Δ ≤ 0}) / (B + 1). Frozen seed per call site.
 */
export function clusterBootstrapP(
  eventStats: number[],
  controlStats: (number | null)[],
  clusters: number[][],
  seed: number,
  B = 1000,
): { delta: number; p: number } {
  const valid = (i: number) => controlStats[i] !== null;
  const obsEvent = mean(eventStats.filter((_, i) => valid(i)));
  const obsCtrl = mean(controlStats.filter((x): x is number => x !== null));
  const delta = obsEvent - obsCtrl;
  const rng = mulberry32(seed);
  let le = 0;
  for (let b = 0; b < B; b++) {
    const es: number[] = [];
    const cs: number[] = [];
    for (let k = 0; k < clusters.length; k++) {
      const cl = clusters[Math.floor(rng() * clusters.length)]!;
      for (const i of cl) {
        if (!valid(i)) continue;
        es.push(eventStats[i]!);
        cs.push(controlStats[i] as number);
      }
    }
    if (es.length === 0) {
      le++;
      continue;
    }
    if (mean(es) - mean(cs) <= 0) le++;
  }
  return { delta, p: (1 + le) / (B + 1) };
}
