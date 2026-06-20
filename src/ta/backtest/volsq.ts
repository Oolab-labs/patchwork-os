/**
 * volsq-1 — volatility compression → expansion backtest (Phase 1c).
 *
 * Frozen by docs/phase1c-precommit.md (refuter-amended: LEVEL metrics only,
 * the FwdRV/TrailingRV ratio is descriptive because its denominator is the
 * conditioning variable; expectation registered as likely-null given GARCH
 * persistence). Two squeeze variants: BBW(20,2) on daily closes and RV from
 * trailing 120 4h returns.
 */

import type { Candle } from "../types.js";
import { mean, stdDev } from "./tsmom.js";

/** Population std (Pine ta.stdev convention) of the last `n` closes at t. */
export function popStdCloses(
  candles: Candle[],
  t: number,
  n: number,
): number | null {
  if (t < n - 1) return null;
  const xs: number[] = [];
  for (let i = t - n + 1; i <= t; i++) xs.push(candles[i]!.close);
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) * (b - m), 0) / xs.length);
}

/** BBW(t) = 4·σ20(t)/SMA20(t); null during warm-up. */
export function bbwSeries(candles: Candle[]): (number | null)[] {
  return candles.map((_, t) => {
    const sd = popStdCloses(candles, t, 20);
    if (sd === null) return null;
    let s = 0;
    for (let i = t - 19; i <= t; i++) s += candles[i]!.close;
    const sma = s / 20;
    return sma !== 0 ? (4 * sd) / sma : null;
  });
}

/**
 * RV variant: per DAILY bar t, sample std of the trailing 120 4h log
 * close-returns among 4h bars with closeTime ≤ closeTime(t), × √(365·6).
 */
export function rv4hDaily(daily: Candle[], fourH: Candle[]): (number | null)[] {
  const logr: number[] = [];
  const closeTimes: number[] = [];
  for (let i = 1; i < fourH.length; i++) {
    logr.push(Math.log(fourH[i]!.close / fourH[i - 1]!.close));
    closeTimes.push(fourH[i]!.closeTime);
  }
  const out: (number | null)[] = [];
  let ptr = 0;
  for (const d of daily) {
    while (ptr < closeTimes.length && closeTimes[ptr]! <= d.closeTime) ptr++;
    // returns [ptr-120, ptr-1] are the trailing 120 ending at/before d.close
    if (ptr < 120) {
      out.push(null);
      continue;
    }
    const window = logr.slice(ptr - 120, ptr);
    out.push(stdDev(window) * Math.sqrt(365 * 6));
  }
  return out;
}

/** Trailing-252 percentile (linear interp) of series[t] history; ≥200 needed. */
export function trailing252Pctile(
  series: (number | null)[],
  t: number,
  pctile: number,
): number | null {
  const from = Math.max(0, t - 252);
  const vals: number[] = [];
  for (let i = from; i < t; i++) {
    const v = series[i];
    if (v !== null && v !== undefined && Number.isFinite(v)) vals.push(v);
  }
  if (vals.length < 200) return null;
  vals.sort((a, b) => a - b);
  const idx = (vals.length - 1) * pctile;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  return vals[lo]! + (vals[hi]! - vals[lo]!) * (idx - lo);
}

/** Percentile RANK (0-1) of series[c] within its own trailing 252 history. */
export function trailingRank(
  series: (number | null)[],
  c: number,
): number | null {
  const v = series[c];
  if (v === null || v === undefined) return null;
  const from = Math.max(0, c - 252);
  let cnt = 0;
  let below = 0;
  for (let i = from; i < c; i++) {
    const x = series[i];
    if (x === null || x === undefined || !Number.isFinite(x)) continue;
    cnt++;
    if (x < v) below++;
  }
  if (cnt < 200) return null;
  return below / cnt;
}

/** Squeeze events: measure[t] < trailing P10, 20-bar non-overlap. */
export function detectSqueezes(measure: (number | null)[]): number[] {
  const out: number[] = [];
  let nextEligible = 0;
  for (let t = 0; t < measure.length; t++) {
    if (t < nextEligible) continue;
    const v = measure[t];
    if (v === null || v === undefined) continue;
    const p10 = trailing252Pctile(measure, t, 0.1);
    if (p10 === null) continue;
    if (v < p10) {
      out.push(t);
      nextEligible = t + 20;
    }
  }
  return out;
}

/** Forward 20-bar realized vol (sample std of daily log returns) × √365. */
export function fwdRV(daily: Candle[], t: number): number | null {
  if (t + 20 >= daily.length) return null;
  const rs: number[] = [];
  for (let i = t + 1; i <= t + 20; i++) {
    rs.push(Math.log(daily[i]!.close / daily[i - 1]!.close));
  }
  return stdDev(rs) * Math.sqrt(365);
}

/** |20-bar forward log return|. */
export function absRet20(daily: Candle[], t: number): number | null {
  if (t + 20 >= daily.length) return null;
  return Math.abs(Math.log(daily[t + 20]!.close / daily[t]!.close));
}

/**
 * Direction sub-claim (exploratory, expected null): sign of the first daily
 * close outside the walk-forward SMA20±2σ bands within 20 bars, else 0.
 */
export function firstBreakoutDir(daily: Candle[], t: number): 1 | -1 | 0 {
  const end = Math.min(daily.length - 1, t + 20);
  for (let i = t + 1; i <= end; i++) {
    const sd = popStdCloses(daily, i, 20);
    if (sd === null) continue;
    let s = 0;
    for (let k = i - 19; k <= i; k++) s += daily[k]!.close;
    const sma = s / 20;
    if (daily[i]!.close > sma + 2 * sd) return 1;
    if (daily[i]!.close < sma - 2 * sd) return -1;
  }
  return 0;
}
