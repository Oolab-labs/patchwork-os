/**
 * accrualEmitter.ts — Phase 0(b) accrual emitter for the QUMO desk.
 *
 * Writes dated card/level rows to ~/.patchwork/qumo-ledger.jsonl (NEVER the shared
 * ta-ledger.jsonl). Called once per daily engine run after feeds are collected.
 *
 * Design:
 *   - A `CellDetector` registry maps cellType → detector function + geometry.
 *   - On each daily run: for each registered detector, for each asset in its universe,
 *     run the detector on the latest closed candle. If it fires, append a row.
 *   - Deduplication: one row per {cellType, asset, candleDay}. Duplicate writes
 *     for the same day are silently dropped (idempotent).
 *   - Startup check: if qumo-ledger.jsonl EXISTS (not first run) and a registered
 *     cell has 0 rows AND the file has at least MIN_EMITTER_RUNS rows from other
 *     cells, throw — the emitter is wired but not writing for that cell.
 *
 * Phase 0 ships with an empty registry (no detectors wired yet). Phase 1 wires
 * wp-volume-climax. The infrastructure — writer, dedup, startup check — is the
 * deliverable.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import type { Candle } from "../types.js";
import { QUMO_LEDGER } from "./deskLedger.js";

const PATCHWORK = path.join(homedir(), ".patchwork");

/** Minimum total row count in the ledger before we enforce per-cell emitter checks. */
const MIN_EMITTER_RUNS = 10;

export type DetectResult =
  | false // no fire on this candle
  | {
      direction: "long" | "short";
      lastClose: number;
      invalidation: number;
      rRef: number;
    };

/**
 * A cell the emitter tracks.
 *   detector: given candles[0..n] where candles[n] is the latest CLOSED candle,
 *             return false or the card geometry.
 *   outcomeWindowBars: the window in bars for the card's outcome race.
 *   assets: universe the cell applies to (always-listed subset only).
 *   timeframe: "1d" etc.
 */
export interface CellDetector {
  cellType: string;
  timeframe: "1d" | "4h";
  assets: readonly string[];
  outcomeWindowBars: number;
  /** Run at bar-close. candles are chronological; last element is the just-closed bar. */
  detect: (candles: Candle[]) => DetectResult;
}

/** The registry of registered detectors. Add via registerDetector(). */
const REGISTRY: CellDetector[] = [];

export function registerDetector(d: CellDetector): void {
  if (REGISTRY.some((r) => r.cellType === d.cellType)) {
    throw new Error(
      `accrualEmitter: duplicate registration for cellType "${d.cellType}"`,
    );
  }
  REGISTRY.push(d);
}

function isoDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** Read all existing rows from qumo-ledger.jsonl. Returns empty array on missing/corrupt file. */
function readRows(): Array<Record<string, unknown>> {
  if (!existsSync(QUMO_LEDGER)) return [];
  try {
    return readFileSync(QUMO_LEDGER, "utf-8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  } catch {
    return [];
  }
}

/** Append a single JSON row to qumo-ledger.jsonl (O_APPEND). */
function appendRow(row: Record<string, unknown>): void {
  mkdirSync(PATCHWORK, { recursive: true });
  appendFileSync(QUMO_LEDGER, JSON.stringify(row) + "\n", {
    encoding: "utf-8",
  });
}

/**
 * Startup self-check. If the ledger is large enough (MIN_EMITTER_RUNS rows) and a
 * registered detector has zero rows, the emitter is broken — throw.
 * Call this BEFORE emitting new rows.
 */
export function startupCheck(): void {
  if (REGISTRY.length === 0) return; // nothing registered — no check needed
  const rows = readRows();
  if (rows.length < MIN_EMITTER_RUNS) return; // too early to enforce
  for (const det of REGISTRY) {
    const typeRows = rows.filter((r) => r["type"] === det.cellType);
    if (typeRows.length === 0) {
      throw new Error(
        `accrualEmitter startup check FAILED: registered cell "${det.cellType}" has 0 rows ` +
          `in ${QUMO_LEDGER} but the ledger has ${rows.length} rows (emitter not writing for this cell).`,
      );
    }
  }
}

/**
 * Emit card rows for today's closed candles.
 * Called once per daily engine run. Idempotent — duplicate rows for the same day are dropped.
 *
 * @param candlesByAsset  Map from symbol → candles (chronological, latest closed).
 * @param nowMs           Current timestamp (Date.now()).
 * @returns count of new rows written.
 */
export function emitTodayCards(
  candlesByAsset: Map<string, Candle[]>,
  nowMs: number,
): number {
  if (REGISTRY.length === 0) return 0;

  const existingRows = readRows();
  // Build dedup key set: "cellType:asset:candleDay"
  const seen = new Set(
    existingRows
      .filter((r) => r["type"] && r["asset"] && r["madeAt"])
      .map(
        (r) => `${r["type"]}:${r["asset"]}:${String(r["madeAt"]).slice(0, 10)}`,
      ),
  );

  let written = 0;
  for (const det of REGISTRY) {
    for (const asset of det.assets) {
      const candles = candlesByAsset.get(asset);
      if (!candles || candles.length === 0) continue;

      const result = det.detect(candles);
      if (!result) continue;

      const lastCandle = candles[candles.length - 1]!;
      const candleDay = isoDay(lastCandle.openTime);
      const dedupKey = `${det.cellType}:${asset}:${candleDay}`;
      if (seen.has(dedupKey)) continue;

      // Outcome window ends W bars from the fire candle's close time.
      // Use closeTime + (W-1)*86400000 for daily bars (rough; exact window is
      // evaluated by the backtest using candles, not wall-clock).
      const barMs = det.timeframe === "1d" ? 86_400_000 : 14_400_000;
      const outcomeWindowEndsAt = new Date(
        lastCandle.closeTime + (det.outcomeWindowBars - 1) * barMs,
      ).toISOString();

      const row: Record<string, unknown> = {
        id: `${det.cellType}-${asset}-${candleDay}`,
        kind: "card",
        type: det.cellType,
        timeframe: det.timeframe,
        asset,
        direction: result.direction,
        lastClose: result.lastClose,
        invalidation: result.invalidation,
        rRef: result.rRef,
        madeAt: new Date(nowMs).toISOString(),
        outcomeWindowEndsAt,
        candleDay,
        // methodVersion is set at registration time in the CellSpec (Phase 1+)
      };

      appendRow(row);
      seen.add(dedupKey);
      written++;
    }
  }
  return written;
}
