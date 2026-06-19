/**
 * tsmom-1 — short-horizon time-series momentum backtest (Phase 1a).
 *
 * Frozen by docs/phase1a-precommit.md. Variant (a) sign-of-trailing-return is
 * the only KILL-gating variant; (b) vol-scaled and (c) volume-composite are
 * descriptive contrasts. The null is the refuter-amended EXHAUSTIVE circular
 * shift of the signal series against identical trade mechanics — it preserves
 * the signal's long fraction and streak structure exactly, so it eats both
 * the unconditional up-drift and serial-dependence artifacts. Deterministic:
 * no RNG anywhere.
 */

import type { Candle } from "../types.js";

export interface TradeStats {
  n: number;
  hits: number;
  hitRate: number;
  meanReturn: number;
  sharpe: number;
}

export interface TsmomCell {
  asset: string;
  L: number;
  horizon: 1 | 5;
  window: string;
  observed: TradeStats;
  nullCount: number;
  nullMeanHitRate: number;
  nullMeanSharpe: number;
  /** observed.hitRate − nullMeanHitRate */
  edge: number;
  /** observed.sharpe − nullMeanSharpe */
  sharpeDelta: number;
  pHit: number;
  pSharpe: number;
  /** max(pHit, pSharpe) — both must clear, per precommit */
  p: number;
  buyHoldSharpe: number;
  insufficientN: boolean;
}

export function mean(xs: number[]): number {
  return xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length;
}

export function stdDev(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(
    xs.reduce((a, b) => a + (b - m) * (b - m), 0) / (xs.length - 1),
  );
}

export function sharpeOf(tradeReturns: number[], horizon: number): number {
  const sd = stdDev(tradeReturns);
  if (sd === 0) return 0;
  return (mean(tradeReturns) / sd) * Math.sqrt(365 / horizon);
}

/** s_t = sign(close[t]/close[t−L] − 1); 0 when t < L or ratio exactly 1. */
export function tsmomSignals(closes: number[], L: number): number[] {
  return closes.map((c, t) => {
    if (t < L) return 0;
    const d = c / closes[t - L]! - 1;
    return d > 0 ? 1 : d < 0 ? -1 : 0;
  });
}

/**
 * Score a signal series against candles with the frozen trade mechanics.
 * `inWindow(t)` selects which SIGNAL dates belong to the scored window.
 * H1: r = close[t+1]/open[t+1] − 1; H5: non-overlapping scan, r =
 * close[t+5]/open[t+1] − 1. Hit = signal-signed r > 0.
 */
export function scoreSignal(
  candles: Candle[],
  signals: number[],
  horizon: 1 | 5,
  inWindow: (t: number) => boolean,
): TradeStats {
  const returns: number[] = [];
  let hits = 0;
  let nextEligible = 0;
  for (let t = 0; t < candles.length; t++) {
    if (t + horizon >= candles.length) break;
    const s = signals[t]!;
    if (s === 0 || !inWindow(t)) continue;
    if (horizon === 5) {
      if (t < nextEligible) continue;
      nextEligible = t + 5;
    }
    const entry = candles[t + 1]!.open;
    const exit = candles[t + horizon]!.close;
    const r = s * (exit / entry - 1);
    returns.push(r);
    if (r > 0) hits++;
  }
  return {
    n: returns.length,
    hits,
    hitRate: returns.length ? hits / returns.length : 0,
    meanReturn: mean(returns),
    sharpe: sharpeOf(returns, horizon),
  };
}

/** Buy-and-hold on the cell's own entry/exit grid: always-long signal. */
export function buyHoldStats(
  candles: Candle[],
  horizon: 1 | 5,
  inWindow: (t: number) => boolean,
): TradeStats {
  return scoreSignal(
    candles,
    candles.map(() => 1),
    horizon,
    inWindow,
  );
}

/**
 * Evaluate one (asset × L × horizon × window) cell with the exhaustive
 * circular-shift null: every offset k ∈ [L+1, N−L−1], identical mechanics.
 */
export function evalTsmomCell(
  asset: string,
  candles: Candle[],
  L: number,
  horizon: 1 | 5,
  windowName: string,
  inWindow: (t: number) => boolean,
): TsmomCell {
  const closes = candles.map((c) => c.close);
  const signals = tsmomSignals(closes, L);
  const observed = scoreSignal(candles, signals, horizon, inWindow);

  const N = signals.length;
  let nullCount = 0;
  let geHit = 0;
  let geSharpe = 0;
  let sumHit = 0;
  let sumSharpe = 0;
  for (let k = L + 1; k <= N - L - 1; k++) {
    const shifted = signals.map((_, t) => signals[(t + k) % N]!);
    const s = scoreSignal(candles, shifted, horizon, inWindow);
    nullCount++;
    sumHit += s.hitRate;
    sumSharpe += s.sharpe;
    if (s.hitRate >= observed.hitRate) geHit++;
    if (s.sharpe >= observed.sharpe) geSharpe++;
  }
  const pHit = (1 + geHit) / (nullCount + 1);
  const pSharpe = (1 + geSharpe) / (nullCount + 1);
  return {
    asset,
    L,
    horizon,
    window: windowName,
    observed,
    nullCount,
    nullMeanHitRate: nullCount ? sumHit / nullCount : 0,
    nullMeanSharpe: nullCount ? sumSharpe / nullCount : 0,
    edge: observed.hitRate - (nullCount ? sumHit / nullCount : 0),
    sharpeDelta: observed.sharpe - (nullCount ? sumSharpe / nullCount : 0),
    pHit,
    pSharpe,
    p: Math.max(pHit, pSharpe),
    buyHoldSharpe: buyHoldStats(candles, horizon, inWindow).sharpe,
    insufficientN: observed.n < 30,
  };
}

/** Benjamini–Hochberg: returns per-input boolean "survives at q". */
export function bhSurvivors(ps: number[], q: number): boolean[] {
  const order = ps.map((p, i) => ({ p, i })).sort((a, b) => a.p - b.p);
  const m = ps.length;
  let maxK = -1;
  for (let k = 0; k < m; k++) {
    if (order[k]!.p <= ((k + 1) / m) * q) maxK = k;
  }
  const out = ps.map(() => false);
  for (let k = 0; k <= maxK; k++) out[order[k]!.i] = true;
  return out;
}

// ── Variants (descriptive only) ──────────────────────────────────────────────

/** (b) vol-scaled positions: s_t × min(2, 0.5/annRV20(t)); RV over bars ≤ t. */
export function volScaledPositions(
  candles: Candle[],
  signals: number[],
): number[] {
  const logr = candles.map((c, t) =>
    t === 0 ? 0 : Math.log(c.close / candles[t - 1]!.close),
  );
  return signals.map((s, t) => {
    if (s === 0 || t < 20) return 0;
    const rv = stdDev(logr.slice(t - 19, t + 1)) * Math.sqrt(365);
    if (rv === 0) return 0;
    return s * Math.min(2, 0.5 / rv);
  });
}

/**
 * (c) volume-composite signal: equal-weight mean of trailing-180-bar z-scores
 * of ret7/ret14/ret28 and 1w-vs-4w volume deviation; sign of the mean.
 */
export function volumeCompositeSignals(candles: Candle[]): number[] {
  const n = candles.length;
  const closes = candles.map((c) => c.close);
  const vols = candles.map((c) => c.volume);
  const comp: number[][] = [[], [], [], []];
  for (let t = 0; t < n; t++) {
    comp[0]!.push(t >= 7 ? closes[t]! / closes[t - 7]! - 1 : Number.NaN);
    comp[1]!.push(t >= 14 ? closes[t]! / closes[t - 14]! - 1 : Number.NaN);
    comp[2]!.push(t >= 28 ? closes[t]! / closes[t - 28]! - 1 : Number.NaN);
    if (t >= 27) {
      const w1 = mean(vols.slice(t - 6, t + 1));
      const w4 = mean(vols.slice(t - 27, t + 1));
      comp[3]!.push(w4 === 0 ? Number.NaN : w1 / w4 - 1);
    } else {
      comp[3]!.push(Number.NaN);
    }
  }
  const Z = 180;
  const out: number[] = [];
  for (let t = 0; t < n; t++) {
    if (t < Z + 28) {
      out.push(0);
      continue;
    }
    const zs: number[] = [];
    for (const series of comp) {
      const hist = series.slice(t - Z, t).filter((x) => !Number.isNaN(x));
      const cur = series[t]!;
      const sd = stdDev(hist);
      if (Number.isNaN(cur) || sd === 0) continue;
      zs.push((cur - mean(hist)) / sd);
    }
    const z = mean(zs);
    out.push(z > 0 ? 1 : z < 0 ? -1 : 0);
  }
  return out;
}

/** Sharpe of a sized-position series with the H1 mechanics (descriptive). */
export function positionSharpeH1(
  candles: Candle[],
  positions: number[],
  inWindow: (t: number) => boolean,
): { n: number; sharpe: number } {
  const rets: number[] = [];
  for (let t = 0; t < candles.length - 1; t++) {
    const pos = positions[t]!;
    if (pos === 0 || !inWindow(t)) continue;
    rets.push(pos * (candles[t + 1]!.close / candles[t + 1]!.open - 1));
  }
  return { n: rets.length, sharpe: sharpeOf(rets, 1) };
}
