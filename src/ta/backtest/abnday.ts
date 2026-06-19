/**
 * abnday-1 — post-abnormal-day behavior backtest (Phase 1a).
 *
 * Frozen by docs/phase1a-precommit.md (refuter-amended): k = 2 only, four
 * per-cell SIGNED predictions from Caporale & Plastun 2020 (BTC+ → reversal,
 * BTC− → continuation, ETH+ → continuation, ETH− → reversal), baseline =
 * sign-matched normal-day cohort (|r| < 1σ60) scored with the identical
 * prediction. σ60 is computed from bars STRICTLY before t.
 */

import type { Candle } from "../types.js";
import { mean, stdDev } from "./tsmom.js";

export type AbndaySign = "pos" | "neg";

export interface AbndayCohort {
  n: number;
  hits: number;
  hitRate: number;
  meanSignedNextDay: number;
}

export interface AbndayCell {
  asset: string;
  sign: AbndaySign;
  /** hit iff next-day open→close return satisfies this predicate */
  prediction: "reversal" | "continuation";
  window: string;
  event: AbndayCohort;
  eventNonOverlap: AbndayCohort;
  normal: AbndayCohort;
  /** event.hitRate − normal.hitRate */
  delta: number;
  p: number;
  insufficientN: boolean;
}

/**
 * Registered prediction per (asset, sign of r_t): the *direction of ρ =
 * close[t+1]/open[t+1] − 1 that counts as a hit*.
 *   BTC+ reversal → ρ < 0;  BTC− continuation → ρ < 0;
 *   ETH+ continuation → ρ > 0;  ETH− reversal → ρ > 0.
 */
export function registeredHitDirection(
  asset: string,
  _sign: AbndaySign,
): 1 | -1 {
  // Registered directions happen to collapse per asset (both BTC cells hit on
  // a down next-day, both ETH cells on an up one); the sign param is kept so
  // call sites read as (asset, sign) cells per the precommit table.
  if (asset.startsWith("BTC")) return -1;
  return 1;
}

export function predictionLabel(
  asset: string,
  sign: AbndaySign,
): "reversal" | "continuation" {
  const dir = registeredHitDirection(asset, sign);
  const moveDir = sign === "pos" ? 1 : -1;
  return dir === moveDir ? "continuation" : "reversal";
}

/** σ60(t) over log returns r_{t−60}..r_{t−1} — strictly before t. */
export function sigma60(logReturns: number[], t: number): number | null {
  if (t < 61) return null; // r is defined from index 1; need 60 prior returns
  return stdDev(logReturns.slice(t - 60, t));
}

export interface AbndayDay {
  t: number;
  sign: AbndaySign;
  kind: "event" | "normal" | "neither";
  /** ρ = close[t+1]/open[t+1] − 1 */
  nextDay: number;
}

/** Classify every scorable day. r_t = ln(close_t/close_{t−1}). */
export function classifyDays(candles: Candle[]): AbndayDay[] {
  const logr = candles.map((c, t) =>
    t === 0 ? Number.NaN : Math.log(c.close / candles[t - 1]!.close),
  );
  const out: AbndayDay[] = [];
  for (let t = 1; t < candles.length - 1; t++) {
    const sd = sigma60(logr, t);
    if (sd === null || sd === 0) continue;
    const r = logr[t]!;
    if (r === 0) continue;
    const kind =
      Math.abs(r) >= 2 * sd
        ? "event"
        : Math.abs(r) < 1 * sd
          ? "normal"
          : "neither";
    out.push({
      t,
      sign: r > 0 ? "pos" : "neg",
      kind,
      nextDay: candles[t + 1]!.close / candles[t + 1]!.open - 1,
    });
  }
  return out;
}

function cohort(days: AbndayDay[], hitDir: 1 | -1): AbndayCohort {
  let hits = 0;
  const signed: number[] = [];
  for (const d of days) {
    if (hitDir * d.nextDay > 0) hits++;
    signed.push(hitDir * d.nextDay);
  }
  return {
    n: days.length,
    hits,
    hitRate: days.length ? hits / days.length : 0,
    meanSignedNextDay: mean(signed),
  };
}

/** Two-proportion z-test, two-sided (Abramowitz & Stegun normal CDF). */
export function twoPropP(
  h1: number,
  n1: number,
  h2: number,
  n2: number,
): number {
  if (n1 === 0 || n2 === 0) return 1;
  const p1 = h1 / n1;
  const p2 = h2 / n2;
  const p = (h1 + h2) / (n1 + n2);
  const se = Math.sqrt(p * (1 - p) * (1 / n1 + 1 / n2));
  if (se === 0) return 1;
  const z = Math.abs((p1 - p2) / se);
  const t = 1 / (1 + 0.2316419 * z);
  const d = 0.3989422804014327 * Math.exp(-(z * z) / 2);
  const tail =
    d *
    t *
    (0.31938153 +
      t *
        (-0.356563782 +
          t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return 2 * tail;
}

export function evalAbndayCell(
  asset: string,
  candles: Candle[],
  sign: AbndaySign,
  windowName: string,
  inWindow: (t: number) => boolean,
): AbndayCell {
  const hitDir = registeredHitDirection(asset, sign);
  const days = classifyDays(candles).filter(
    (d) => d.sign === sign && inWindow(d.t),
  );
  const events = days.filter((d) => d.kind === "event");
  const normals = days.filter((d) => d.kind === "normal");
  // Non-overlap robustness: drop an event whose previous day (t−1) was ALSO
  // an event of either sign.
  const eventTs = new Set(
    classifyDays(candles)
      .filter((d) => d.kind === "event")
      .map((d) => d.t),
  );
  const nonOverlap = events.filter((d) => !eventTs.has(d.t - 1));

  const event = cohort(events, hitDir);
  const normal = cohort(normals, hitDir);
  return {
    asset,
    sign,
    prediction: predictionLabel(asset, sign),
    window: windowName,
    event,
    eventNonOverlap: cohort(nonOverlap, hitDir),
    normal,
    delta: event.hitRate - normal.hitRate,
    p: twoPropP(event.hits, event.n, normal.hits, normal.n),
    insufficientN: event.n < 30,
  };
}
