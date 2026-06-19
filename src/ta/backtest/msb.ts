/**
 * msb-1 — market-structure-break backtest (Phase 1d), two antagonistic arms.
 *
 * Frozen by docs/phase1d-precommit.md. Pivot widths {4, 10} and the event
 * definitions come from the user's msb_indicator.pine / eieo_strategy.pine;
 * the refuter-amended controls share everything except the structural
 * element (Arm A matched on trailing-20-bar-return decile so a pass means
 * the pivot adds signal beyond the killed momentum effect; Arm B matched on
 * wick-extent decile so a pass beats a generic long-wick bounce).
 */

import type { Candle } from "../types.js";

export interface ConfirmedPivot {
  /** bar of the pivot extreme */
  bar: number;
  price: number;
  /** bar at which the pivot becomes usable (= bar + N) */
  confirmedAt: number;
}

/** Strict N-bar fractal pivots with confirmation lag (no look-ahead). */
export function fractalPivots(
  candles: Candle[],
  N: number,
): { highs: ConfirmedPivot[]; lows: ConfirmedPivot[] } {
  const highs: ConfirmedPivot[] = [];
  const lows: ConfirmedPivot[] = [];
  for (let p = N; p < candles.length - N; p++) {
    let isH = true;
    let isL = true;
    for (let k = 1; k <= N; k++) {
      if (
        candles[p]!.high <= candles[p - k]!.high ||
        candles[p]!.high <= candles[p + k]!.high
      )
        isH = false;
      if (
        candles[p]!.low >= candles[p - k]!.low ||
        candles[p]!.low >= candles[p + k]!.low
      )
        isL = false;
      if (!isH && !isL) break;
    }
    if (isH)
      highs.push({ bar: p, price: candles[p]!.high, confirmedAt: p + N });
    if (isL) lows.push({ bar: p, price: candles[p]!.low, confirmedAt: p + N });
  }
  return { highs, lows };
}

export interface MsbEvent {
  arm: "A" | "B";
  /** claimed direction: A = break direction; B = against the breach */
  dir: 1 | -1;
  t: number;
  level: number;
  /** |close−open|/open of the event bar */
  bodyPct: number;
  /** ln(close[t]/close[t−20]), null when t < 20 */
  trailing20: number | null;
  /** relevant wick extent for Arm B (null for Arm A or zero-range bars) */
  wickExtent: number | null;
  /** CHoCH context: prior two confirmed pivot lows descending (bullish) / highs ascending (bearish) */
  choch: boolean;
}

export interface MsbScan {
  events: MsbEvent[];
  /** raw breach flags per bar (ignoring one-shot guards) — control exclusion */
  rawBreach: boolean[];
}

/** Walk bars maintaining active levels + per-arm one-shot guards. */
export function scanMsb(candles: Candle[], N: number): MsbScan {
  const { highs, lows } = fractalPivots(candles, N);
  const events: MsbEvent[] = [];
  const rawBreach: boolean[] = new Array(candles.length).fill(false);
  let hi = 0;
  let lo = 0;
  let activePH: ConfirmedPivot | null = null;
  let activePL: ConfirmedPivot | null = null;
  let aPH = false;
  let aPL = false;
  let bPH = false;
  let bPL = false;
  const confirmedLows: number[] = [];
  const confirmedHighs: number[] = [];

  const trailing20 = (t: number): number | null =>
    t >= 20 ? Math.log(candles[t]!.close / candles[t - 20]!.close) : null;

  for (let t = 0; t < candles.length; t++) {
    // confirm pivots that become usable at this bar
    while (hi < highs.length && highs[hi]!.confirmedAt <= t) {
      activePH = highs[hi]!;
      confirmedHighs.push(highs[hi]!.price);
      aPH = false;
      bPH = false;
      hi++;
    }
    while (lo < lows.length && lows[lo]!.confirmedAt <= t) {
      activePL = lows[lo]!;
      confirmedLows.push(lows[lo]!.price);
      aPL = false;
      bPL = false;
      lo++;
    }
    const c = candles[t]!;
    const range = c.high - c.low;
    const bodyPct = c.open !== 0 ? Math.abs(c.close - c.open) / c.open : 0;
    const lastTwoLowsDesc =
      confirmedLows.length >= 2 &&
      confirmedLows[confirmedLows.length - 1]! <
        confirmedLows[confirmedLows.length - 2]!;
    const lastTwoHighsAsc =
      confirmedHighs.length >= 2 &&
      confirmedHighs[confirmedHighs.length - 1]! >
        confirmedHighs[confirmedHighs.length - 2]!;

    if (activePH) {
      const breakUp = c.close > activePH.price;
      const sweepHigh = c.high > activePH.price && c.close < activePH.price;
      if (breakUp || sweepHigh) rawBreach[t] = true;
      if (breakUp && !aPH) {
        aPH = true;
        events.push({
          arm: "A",
          dir: 1,
          t,
          level: activePH.price,
          bodyPct,
          trailing20: trailing20(t),
          wickExtent: null,
          choch: lastTwoLowsDesc,
        });
      }
      if (sweepHigh && !bPH) {
        bPH = true;
        events.push({
          arm: "B",
          dir: -1, // claims reversal DOWN after sweeping the high
          t,
          level: activePH.price,
          bodyPct,
          trailing20: trailing20(t),
          wickExtent:
            range > 0 ? (c.high - Math.max(c.open, c.close)) / range : null,
          choch: lastTwoHighsAsc,
        });
      }
    }
    if (activePL) {
      const breakDn = c.close < activePL.price;
      const sweepLow = c.low < activePL.price && c.close > activePL.price;
      if (breakDn || sweepLow) rawBreach[t] = true;
      if (breakDn && !aPL) {
        aPL = true;
        events.push({
          arm: "A",
          dir: -1,
          t,
          level: activePL.price,
          bodyPct,
          trailing20: trailing20(t),
          wickExtent: null,
          choch: lastTwoHighsAsc,
        });
      }
      if (sweepLow && !bPL) {
        bPL = true;
        events.push({
          arm: "B",
          dir: 1, // claims reversal UP after sweeping the low
          t,
          level: activePL.price,
          bodyPct,
          trailing20: trailing20(t),
          wickExtent:
            range > 0 ? (Math.min(c.open, c.close) - c.low) / range : null,
          choch: lastTwoLowsDesc,
        });
      }
    }
  }
  return { events, rawBreach };
}

/** Forward log return signed in the claimed direction; null if out of range. */
export function signedForward(
  candles: Candle[],
  t: number,
  K: number,
  dir: 1 | -1,
): number | null {
  if (t + K >= candles.length) return null;
  return dir * Math.log(candles[t + K]!.close / candles[t]!.close);
}

/** Arm A break-failure: close back through the level within `window` bars. */
export function breakFailed(
  candles: Candle[],
  ev: MsbEvent,
  window = 10,
): boolean | null {
  if (ev.arm !== "A") return null;
  const end = Math.min(candles.length - 1, ev.t + window);
  for (let i = ev.t + 1; i <= end; i++) {
    if (ev.dir === 1 && candles[i]!.close < ev.level) return true;
    if (ev.dir === -1 && candles[i]!.close > ev.level) return true;
  }
  return false;
}
