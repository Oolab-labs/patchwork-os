/**
 * ichimoku-arb-1 — Kumo regime gate vs 50d-SMA arbitration (Phase 1c).
 *
 * Frozen by docs/phase1c-precommit.md. One pre-registered question: does the
 * course's flagship surviving tool add ANYTHING beyond the dumbest trend
 * filter? The whole Ichimoku family (TK cross, Chikou, Kijun, twists)
 * inherits this verdict per setup-hunting §4. Params frozen 9/26/52,
 * displacement 26; gates evaluated at close t, held bar t+1 open→close.
 */

import type { Candle } from "../types.js";
import { mean, stdDev } from "./tsmom.js";

function hh(candles: Candle[], t: number, n: number): number | null {
  if (t < n - 1) return null;
  let v = Number.NEGATIVE_INFINITY;
  for (let i = t - n + 1; i <= t; i++) v = Math.max(v, candles[i]!.high);
  return v;
}
function ll(candles: Candle[], t: number, n: number): number | null {
  if (t < n - 1) return null;
  let v = Number.POSITIVE_INFINITY;
  for (let i = t - n + 1; i <= t; i++) v = Math.min(v, candles[i]!.low);
  return v;
}

export interface IchimokuSeries {
  /** cloud top/bottom AT bar t (computed from bars ≤ t−26) */
  senkouA: (number | null)[];
  senkouB: (number | null)[];
  /** 1 = close above cloud, 0 = not (or cloud undefined) */
  gate: (0 | 1)[];
  /** slope variant: gate AND senkouB rising */
  gateSlope: (0 | 1)[];
}

export function ichimoku(candles: Candle[]): IchimokuSeries {
  const n = candles.length;
  const tenkan: (number | null)[] = new Array(n).fill(null);
  const kijun: (number | null)[] = new Array(n).fill(null);
  for (let t = 0; t < n; t++) {
    const h9 = hh(candles, t, 9);
    const l9 = ll(candles, t, 9);
    const h26 = hh(candles, t, 26);
    const l26 = ll(candles, t, 26);
    if (h9 !== null && l9 !== null) tenkan[t] = (h9 + l9) / 2;
    if (h26 !== null && l26 !== null) kijun[t] = (h26 + l26) / 2;
  }
  const senkouA: (number | null)[] = new Array(n).fill(null);
  const senkouB: (number | null)[] = new Array(n).fill(null);
  for (let t = 26; t < n; t++) {
    const tk = tenkan[t - 26];
    const kj = kijun[t - 26];
    if (tk !== null && tk !== undefined && kj !== null && kj !== undefined) {
      senkouA[t] = (tk + kj) / 2;
    }
    const h52 = hh(candles, t - 26, 52);
    const l52 = ll(candles, t - 26, 52);
    if (h52 !== null && l52 !== null) senkouB[t] = (h52 + l52) / 2;
  }
  const gate: (0 | 1)[] = new Array(n).fill(0);
  const gateSlope: (0 | 1)[] = new Array(n).fill(0);
  for (let t = 0; t < n; t++) {
    const a = senkouA[t];
    const b = senkouB[t];
    if (a === null || a === undefined || b === null || b === undefined)
      continue;
    if (candles[t]!.close > Math.max(a, b)) {
      gate[t] = 1;
      const bPrev = senkouB[t - 1];
      if (bPrev !== null && bPrev !== undefined && b >= bPrev) gateSlope[t] = 1;
    }
  }
  return { senkouA, senkouB, gate, gateSlope };
}

/** SMA-50 gate: 1 iff close(t) > mean of the last 50 closes. */
export function smaGate(candles: Candle[], n = 50): (0 | 1)[] {
  const out: (0 | 1)[] = new Array(candles.length).fill(0);
  let sum = 0;
  for (let t = 0; t < candles.length; t++) {
    sum += candles[t]!.close;
    if (t >= n) sum -= candles[t - n]!.close;
    if (t >= n - 1 && candles[t]!.close > sum / n) out[t] = 1;
  }
  return out;
}

/** Daily strategy returns: r[t] = G[t−1] × (close[t]/open[t] − 1); r[0] = 0. */
export function gateReturns(candles: Candle[], gate: (0 | 1)[]): number[] {
  const out: number[] = new Array(candles.length).fill(0);
  for (let t = 1; t < candles.length; t++) {
    if (gate[t - 1] === 1) out[t] = candles[t]!.close / candles[t]!.open - 1;
  }
  return out;
}

/** Sharpe over the FULL series (flat zeros included) × √365. */
export function sharpeFull(returns: number[]): number {
  const sd = stdDev(returns);
  return sd === 0 ? 0 : (mean(returns) / sd) * Math.sqrt(365);
}

/**
 * Exhaustive circular-shift null on the gate (offsets k ∈ [51, N−51]):
 * p = (1 + #{shifted Sharpe ≥ observed}) / (N_null + 1) within the window.
 */
export function shiftNullP(
  candles: Candle[],
  gate: (0 | 1)[],
  inWindow: (t: number) => boolean,
): { sharpe: number; nullMean: number; p: number; nullCount: number } {
  const N = gate.length;
  const windowed = (g: (0 | 1)[]): number[] => {
    const rs: number[] = [];
    for (let t = 1; t < N; t++) {
      if (!inWindow(t - 1)) continue; // window by signal date
      rs.push(g[t - 1] === 1 ? candles[t]!.close / candles[t]!.open - 1 : 0);
    }
    return rs;
  };
  const observed = sharpeFull(windowed(gate));
  let ge = 0;
  let cnt = 0;
  let sum = 0;
  for (let k = 51; k <= N - 51; k++) {
    const shifted = gate.map((_, t) => gate[(t + k) % N]!);
    const s = sharpeFull(windowed(shifted));
    cnt++;
    sum += s;
    if (s >= observed) ge++;
  }
  return {
    sharpe: observed,
    nullMean: cnt ? sum / cnt : 0,
    p: (1 + ge) / (cnt + 1),
    nullCount: cnt,
  };
}

/** Disagreement-day next-bar returns: D1 = ichi-only longs, D2 = sma-only. */
export function disagreementReturns(
  candles: Candle[],
  ichi: (0 | 1)[],
  sma: (0 | 1)[],
  inWindow: (t: number) => boolean,
): { d1: number[]; d2: number[] } {
  const d1: number[] = [];
  const d2: number[] = [];
  for (let t = 0; t < candles.length - 1; t++) {
    if (!inWindow(t)) continue;
    const r = candles[t + 1]!.close / candles[t + 1]!.open - 1;
    if (ichi[t] === 1 && sma[t] === 0) d1.push(r);
    else if (ichi[t] === 0 && sma[t] === 1) d2.push(r);
  }
  return { d1, d2 };
}
