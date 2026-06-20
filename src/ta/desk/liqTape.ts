/**
 * liqTape.ts — read the local liquidation tape JSONL files and produce
 * a per-asset 24h summary for the desk's liquidations surface.
 *
 * Data source: qumo-liq-collector.ts (resident VPS process, writes daily files).
 * File format: one JSON row per line:
 *   { ts: number, sym: string, side: "long"|"short", qty: number, price: number, usd: number }
 *
 * Called from collectors.ts when QUMO_LIQ_DIR is set and tape files exist.
 * NEVER throws — returns empty tape on any error.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

const LIQ_DIR = process.env.QUMO_LIQ_DIR ?? path.join(homedir(), ".patchwork");

export interface LiqRow {
  ts: number;
  sym: string;
  side: "long" | "short";
  qty: number;
  price: number;
  usd: number;
}

export interface LiqTapeSummary {
  windowHours: number;
  asOf: number; // epoch ms of the latest event seen
  totalLongUsd: number;
  totalShortUsd: number;
  longCount: number;
  shortCount: number;
  topSymbols: Array<{ sym: string; longUsd: number; shortUsd: number }>;
}

function tapePath(dateStr: string): string {
  return path.join(LIQ_DIR, `qumo-liq-tape-${dateStr}.jsonl`);
}

function utcDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** Read rows from the tape files covering the last `windowHours` hours. */
function readRows(windowHours: number, nowMs: number): LiqRow[] {
  const cutoff = nowMs - windowHours * 3_600_000;
  const rows: LiqRow[] = [];

  // Cover today and yesterday (two dates are enough for any window ≤ 48h).
  const dates = new Set([utcDate(nowMs), utcDate(cutoff)]);
  for (const d of dates) {
    const file = tapePath(d);
    if (!existsSync(file)) continue;
    try {
      for (const line of readFileSync(file, "utf-8")
        .split("\n")
        .filter(Boolean)) {
        const r = JSON.parse(line) as LiqRow;
        if (r.ts >= cutoff) rows.push(r);
      }
    } catch {
      // corrupt tail line — continue
    }
  }
  return rows;
}

/**
 * Produce a 24h liquidation summary from the local tape.
 * Returns null if no tape files exist (collector not yet running).
 */
export function readLiqTape(
  nowMs: number,
  windowHours = 24,
): LiqTapeSummary | null {
  let rows: LiqRow[];
  try {
    rows = readRows(windowHours, nowMs);
  } catch {
    return null;
  }

  if (rows.length === 0) return null;

  let totalLongUsd = 0;
  let totalShortUsd = 0;
  let longCount = 0;
  let shortCount = 0;
  let asOf = 0;
  const bySymbol = new Map<string, { longUsd: number; shortUsd: number }>();

  for (const r of rows) {
    if (r.ts > asOf) asOf = r.ts;
    if (r.side === "long") {
      totalLongUsd += r.usd;
      longCount++;
    } else {
      totalShortUsd += r.usd;
      shortCount++;
    }
    const s = bySymbol.get(r.sym) ?? { longUsd: 0, shortUsd: 0 };
    if (r.side === "long") s.longUsd += r.usd;
    else s.shortUsd += r.usd;
    bySymbol.set(r.sym, s);
  }

  const topSymbols = [...bySymbol.entries()]
    .map(([sym, v]) => ({ sym, ...v }))
    .sort((a, b) => b.longUsd + b.shortUsd - (a.longUsd + a.shortUsd))
    .slice(0, 5);

  return {
    windowHours,
    asOf,
    totalLongUsd,
    totalShortUsd,
    longCount,
    shortCount,
    topSymbols,
  };
}
