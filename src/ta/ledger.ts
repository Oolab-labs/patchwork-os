/**
 * Falsification ledger — append-only, live-scored.
 *
 * Pre-registered predictions are appended one JSON object per line (never
 * mutated). Scoring is derived, not stored: given candles covering a
 * prediction's outcome window, we recompute whether the level HELD using the
 * exact directional definition from the backtest (resolveTouch), and report
 * hold-rate minus the backtest baseline. Deriving outcomes (rather than writing
 * them back) keeps the file strictly append-only and always consistent with the
 * frozen rules under `methodVersion`.
 */

import { resolveTouch } from "./backtest/directional.js";
import { firstTouchIndex } from "./backtest/scoring.js";
import type { Candle, Timeframe } from "./types.js";

/** Backtest directional baselines (random in-range level hold-rate), per TF. */
export const LEDGER_BASELINE: Record<Timeframe, number> = {
  "4h": 0.53,
  "1d": 0.43,
};

export interface LedgerRow {
  id: string;
  asset: string;
  type: string;
  predictedLevel: number | null;
  margin: number;
  timeframe: Timeframe;
  madeAt: string;
  outcomeWindowEndsAt: string;
  methodVersion: string;
}

export function serializeRow(row: LedgerRow): string {
  return `${JSON.stringify(row)}\n`;
}

export function parseLedger(text: string): LedgerRow[] {
  const out: LedgerRow[] = [];
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      const r = JSON.parse(t) as LedgerRow;
      if (r && typeof r.id === "string" && typeof r.type === "string")
        out.push(r);
    } catch {
      // skip a corrupt line rather than fail the whole read
    }
  }
  return out;
}

export interface ScoreSummary {
  key: string;
  type: string;
  timeframe: string;
  matured: number;
  scorable: number;
  holds: number;
  holdRate: number;
  baselineRate: number;
  edge: number;
}

/**
 * Score matured predictions against provided candles. A row is matured once
 * `nowMs >= outcomeWindowEndsAt`; it is scorable only if the candle series
 * covers its window. Outcome = the level held (directional bounce).
 */
export function scoreLedger(
  rows: LedgerRow[],
  candles: Candle[],
  nowMs: number,
): ScoreSummary[] {
  const groups = new Map<
    string,
    {
      type: string;
      tf: string;
      matured: number;
      scorable: number;
      holds: number;
    }
  >();

  for (const r of rows) {
    if (r.predictedLevel === null) continue;
    const endMs = Date.parse(r.outcomeWindowEndsAt);
    if (!(nowMs >= endMs)) continue; // not matured yet
    const key = `${r.type}@${r.timeframe}`;
    const g = groups.get(key) ?? {
      type: r.type,
      tf: r.timeframe,
      matured: 0,
      scorable: 0,
      holds: 0,
    };
    g.matured++;

    const startMs = Date.parse(r.madeAt);
    const window = candles.filter(
      (c) => c.openTime >= startMs && c.openTime <= endMs,
    );
    if (window.length >= 2) {
      const touch = firstTouchIndex(
        r.predictedLevel,
        window,
        0,
        window.length - 1,
        r.margin,
      );
      if (touch !== -1) {
        const res = resolveTouch(window, touch, r.predictedLevel);
        if (res !== "none") {
          g.scorable++;
          if (res === "hold") g.holds++;
        }
      }
    }
    groups.set(key, g);
  }

  const out: ScoreSummary[] = [];
  for (const [key, g] of groups) {
    const holdRate = g.scorable ? g.holds / g.scorable : 0;
    const baselineRate = LEDGER_BASELINE[g.tf as Timeframe] ?? 0.5;
    out.push({
      key,
      type: g.type,
      timeframe: g.tf,
      matured: g.matured,
      scorable: g.scorable,
      holds: g.holds,
      holdRate,
      baselineRate,
      edge: holdRate - baselineRate,
    });
  }
  out.sort((a, b) => b.edge - a.edge);
  return out;
}
