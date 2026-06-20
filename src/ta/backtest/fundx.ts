/**
 * fundx-1 — funding-rate extremes backtest (Phase 1b).
 *
 * Frozen by docs/phase1b-precommit.md. Two legs: LONG (sustained crowded
 * shorts → forward returns vs a matched-neutral baseline) and RISK (crowded-
 * long p90 crossings → deeper forward drawdowns vs the same construction).
 * Baselines are CONDITIONAL: neutral-funding days matched on trailing 14d
 * return, so the long leg must beat post-crash mean reversion, not drift.
 * Deterministic — Mann–Whitney is closed-form, no RNG.
 */

import type { Candle } from "../types.js";
import { mean, stdDev } from "./tsmom.js";

export interface FundingPrint {
  fundingTime: number;
  fundingRate: number;
}

const DAY = 86_400_000;

/**
 * F7(t) per candle: mean of funding rates with fundingTime in
 * [openTime(t) − 7d, openTime(t)) — strictly before the day's open.
 * null when fewer than 15 prints fall in the window.
 */
export function f7Series(
  candles: Candle[],
  prints: FundingPrint[],
): (number | null)[] {
  const sorted = [...prints].sort((a, b) => a.fundingTime - b.fundingTime);
  const times = sorted.map((p) => p.fundingTime);
  // prefix sums for O(1) range means
  const prefix: number[] = [0];
  for (const p of sorted)
    prefix.push(prefix[prefix.length - 1]! + p.fundingRate);
  const lowerBound = (x: number): number => {
    let lo = 0;
    let hi = times.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (times[mid]! < x) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };
  return candles.map((c) => {
    const from = lowerBound(c.openTime - 7 * DAY);
    const to = lowerBound(c.openTime); // strictly before open
    const n = to - from;
    if (n < 15) return null;
    return (prefix[to]! - prefix[from]!) / n;
  });
}

/**
 * Trailing percentile of the usable F7 values for days [t−365, t−1]
 * (bar-indexed on the daily series — daily candles are calendar days).
 * null when fewer than 200 usable trailing values.
 */
export function trailingPercentile(
  f7: (number | null)[],
  t: number,
  pctile: number,
): number | null {
  const from = Math.max(0, t - 365);
  const vals: number[] = [];
  for (let i = from; i < t; i++) {
    const v = f7[i];
    if (v !== null && v !== undefined) vals.push(v);
  }
  if (vals.length < 200) return null;
  vals.sort((a, b) => a - b);
  const idx = (vals.length - 1) * pctile;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  return vals[lo]! + (vals[hi]! - vals[lo]!) * (idx - lo);
}

export interface FundxEvents {
  longEvents: number[];
  riskEvents: number[];
  /** usable days (F7 + percentiles available + trailing-14d return defined) */
  usable: number[];
  /** neutral days: F7 ∈ [p25, p75] */
  neutral: number[];
}

/** Trailing 14d return at t: close[t]/close[t−14] − 1 (bars ≤ t only). */
export function trail14(candles: Candle[], t: number): number | null {
  if (t < 14) return null;
  return candles[t]!.close / candles[t - 14]!.close - 1;
}

export function detectEvents(
  candles: Candle[],
  f7: (number | null)[],
): FundxEvents {
  const n = candles.length;
  const longEvents: number[] = [];
  const riskEvents: number[] = [];
  const usable: number[] = [];
  const neutral: number[] = [];

  let negStreak = 0;
  let longSuppressUntil = -1;
  let riskSuppressed = false;
  let riskSuppressStart = -1;
  // previous USABLE day's position vs its own p90 — the spec's crossing
  // requires "yesterday below its own p90, today at/above".
  let prevBelowP90: boolean | null = null;

  for (let t = 0; t < n; t++) {
    const v = f7[t];
    const p25 = trailingPercentile(f7, t, 0.25);
    const p75 = trailingPercentile(f7, t, 0.75);
    const p90 = trailingPercentile(f7, t, 0.9);
    const tr = trail14(candles, t);
    if (
      v === null ||
      v === undefined ||
      p25 === null ||
      p75 === null ||
      p90 === null ||
      tr === null
    ) {
      negStreak = 0; // unusable day breaks the consecutive-day requirement
      continue;
    }
    usable.push(t);
    if (v >= p25 && v <= p75) neutral.push(t);

    // LONG: F7 ≤ −0.0001 for ≥5 consecutive usable days, fire on day 5,
    // suppress 30 calendar days (bar-indexed: daily candles).
    if (v <= -0.0001) {
      negStreak++;
      if (negStreak === 5 && t > longSuppressUntil) {
        longEvents.push(t);
        longSuppressUntil = t + 30;
      } else if (negStreak > 5 && t > longSuppressUntil) {
        // streak continues past a suppression window — re-fire once eligible
        longEvents.push(t);
        longSuppressUntil = t + 30;
      }
    } else {
      negStreak = 0;
    }

    // RISK: STRICT crossing ≥ p90 — previous usable day below its own p90,
    // today at/above (precommit; refuter amendment 2: independent episodes).
    // Suppression releases when F7 < p75 or ≥14 days elapse, but a re-fire
    // still requires a fresh below→above crossing.
    if (riskSuppressed) {
      if (v < p75 || t - riskSuppressStart >= 14) riskSuppressed = false;
    }
    if (!riskSuppressed && v >= p90 && prevBelowP90 === true) {
      riskEvents.push(t);
      riskSuppressed = true;
      riskSuppressStart = t;
    }
    prevBelowP90 = v < p90;
  }
  return { longEvents, riskEvents, usable, neutral };
}

/** Forward return close[t+h]/open[t+1] − 1; null if out of range. */
export function fwdReturn(
  candles: Candle[],
  t: number,
  h: number,
): number | null {
  if (t + h >= candles.length) return null;
  return candles[t + h]!.close / candles[t + 1]!.open - 1;
}

/** Forward 14d max drawdown: min(low[t+1..t+14])/open[t+1] − 1. */
export function fwdMaxDrawdown(candles: Candle[], t: number): number | null {
  if (t + 14 >= candles.length) return null;
  const entry = candles[t + 1]!.open;
  let lo = Number.POSITIVE_INFINITY;
  for (let i = t + 1; i <= t + 14; i++) lo = Math.min(lo, candles[i]!.low);
  return lo / entry - 1;
}

/**
 * Matched-neutral baseline days: neutral-funding days whose trailing-14d
 * return lies within ±1σ of the EVENT cohort's mean trailing-14d return; σ is
 * the std of trailing-14d returns over all usable days in the same regime.
 */
export function matchedBaseline(
  candles: Candle[],
  events: number[],
  neutral: number[],
  usable: number[],
): number[] {
  const eventTrails = events
    .map((t) => trail14(candles, t))
    .filter((x): x is number => x !== null);
  if (eventTrails.length === 0) return [];
  const center = mean(eventTrails);
  const sigma = stdDev(
    usable
      .map((t) => trail14(candles, t))
      .filter((x): x is number => x !== null),
  );
  return neutral.filter((t) => {
    const tr = trail14(candles, t);
    return tr !== null && Math.abs(tr - center) <= sigma;
  });
}

/**
 * Mann–Whitney U, one-sided H1: "sample A tends LARGER than sample B" when
 * direction = "greater" (use "less" for the drawdown leg). Normal
 * approximation with tie correction.
 */
export function mannWhitneyP(
  a: number[],
  b: number[],
  direction: "greater" | "less",
): number {
  const nA = a.length;
  const nB = b.length;
  if (nA === 0 || nB === 0) return 1;
  const all = [...a.map((v) => ({ v, g: 0 })), ...b.map((v) => ({ v, g: 1 }))];
  all.sort((x, y) => x.v - y.v);
  // average ranks with ties
  const ranks = new Array<number>(all.length);
  const tieGroups: number[] = [];
  let i = 0;
  while (i < all.length) {
    let j = i;
    while (j + 1 < all.length && all[j + 1]!.v === all[i]!.v) j++;
    const avg = (i + j + 2) / 2;
    for (let k = i; k <= j; k++) ranks[k] = avg;
    tieGroups.push(j - i + 1);
    i = j + 1;
  }
  let rA = 0;
  all.forEach((x, idx) => {
    if (x.g === 0) rA += ranks[idx]!;
  });
  const U = rA - (nA * (nA + 1)) / 2;
  const mu = (nA * nB) / 2;
  const nTot = nA + nB;
  const tieTerm = tieGroups.reduce((s, ti) => s + ti ** 3 - ti, 0);
  const sigma = Math.sqrt(
    ((nA * nB) / 12) * (nTot + 1 - tieTerm / (nTot * (nTot - 1))),
  );
  if (sigma === 0) return 1;
  // continuity correction
  const zRaw = direction === "greater" ? U - mu - 0.5 : mu - U - 0.5;
  const z = zRaw / sigma;
  // one-sided upper tail
  const tNorm = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989422804014327 * Math.exp(-(z * z) / 2);
  const tail =
    d *
    tNorm *
    (0.31938153 +
      tNorm *
        (-0.356563782 +
          tNorm *
            (1.781477937 + tNorm * (-1.821255978 + tNorm * 1.330274429))));
  return z >= 0 ? tail : 1 - tail;
}

export interface FundxCell {
  leg: "LONG-7d" | "LONG-30d" | "RISK-14dMaxDD";
  regime: string;
  nEvents: number;
  nBaseline: number;
  eventMean: number;
  eventMedian: number;
  baselineMean: number;
  baselineMedian: number;
  p: number;
  parked: boolean;
}

function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

export function evalFundxCells(
  candles: Candle[],
  prints: FundingPrint[],
  regimeName: string,
  inRegime: (t: number) => boolean,
): FundxCell[] {
  const f7 = f7Series(candles, prints);
  const ev = detectEvents(candles, f7);
  const longE = ev.longEvents.filter(inRegime);
  const riskE = ev.riskEvents.filter(inRegime);
  const usable = ev.usable.filter(inRegime);
  const neutral = ev.neutral.filter(inRegime);

  const cells: FundxCell[] = [];
  const mk = (
    leg: FundxCell["leg"],
    events: number[],
    outcome: (t: number) => number | null,
    direction: "greater" | "less",
  ) => {
    const baseDays = matchedBaseline(candles, events, neutral, usable);
    const a = events.map(outcome).filter((x): x is number => x !== null);
    const b = baseDays.map(outcome).filter((x): x is number => x !== null);
    cells.push({
      leg,
      regime: regimeName,
      nEvents: a.length,
      nBaseline: b.length,
      eventMean: mean(a),
      eventMedian: median(a),
      baselineMean: mean(b),
      baselineMedian: median(b),
      p: mannWhitneyP(a, b, direction),
      parked: a.length < 8,
    });
  };
  mk("LONG-7d", longE, (t) => fwdReturn(candles, t, 7), "greater");
  mk("LONG-30d", longE, (t) => fwdReturn(candles, t, 30), "greater");
  mk("RISK-14dMaxDD", riskE, (t) => fwdMaxDrawdown(candles, t), "less");
  return cells;
}
