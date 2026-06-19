/**
 * deskLedger.ts — the moat-native ledger spine, on a SEPARATE file.
 *
 *   ~/.patchwork/qumo-ledger.jsonl   (NEVER the shared ta-ledger.jsonl —
 *   ta.score parses ALL rows asset-filtered-only, so QUMO types there would
 *   pollute the local crypto-daily-brief scorer.)
 *
 * Daily reads the matured summary (cheap). Nightly --backtest reruns cells +
 * dartboard + kill-gate and rewrites the summary. Emits ONLY the genuine
 * ScoreSummary {matured,scorable,holds,holdRate,baselineRate,edge} + altsetup
 * kill-gate state (N/40 + permutation p). Only-positive cells are PAIRED with a
 * falsified/banned audit view (price-fifty −0.53, ichimoku) shown by name.
 * NO totalR / avgR / grade.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { mulberry32 } from "../backtest/scoring.js";
import { LEDGER_BASELINE, parseLedger, scoreLedger } from "../ledger.js";
import type { Candle } from "../types.js";
import type { CellStatus, LedgerCell } from "./types.js";

const PATCHWORK = path.join(homedir(), ".patchwork");
export const QUMO_LEDGER = path.join(PATCHWORK, "qumo-ledger.jsonl");
export const QUMO_SUMMARY = path.join(PATCHWORK, "qumo-ledger-summary.json");

/** Setup-cell arms we track (paired against a dartboard arm). */
const SETUP_ARMS = ["kodama"] as const;
const GATE = 40;

/** The static falsified/banned audit rows — visible by name, never hidden. */
export const FALSIFIED_AUDIT: LedgerCell[] = [
  {
    type: "wp-level-fifty",
    timeframe: "4h",
    status: "FALSIFIED",
    edge: -0.53,
    note: "falsified — banned even as reference (mirrors closed price-fifty @4h)",
  },
  {
    type: "ichimoku-family",
    timeframe: "1d",
    status: "BANNED",
    note: "closed 2026-06-11 — banned even as reference",
  },
];

export interface LedgerSummary {
  asOf: string;
  cells: LedgerCell[];
  openClaims: number;
  gradedClaims: number;
}

/** Read the cached daily summary. Returns a degraded shell if missing. */
export function readLedgerSummary(): LedgerSummary {
  try {
    if (existsSync(QUMO_SUMMARY)) {
      const j = JSON.parse(
        readFileSync(QUMO_SUMMARY, "utf-8"),
      ) as LedgerSummary;
      if (j && Array.isArray(j.cells)) return j;
    }
  } catch {
    // fall through to degraded shell
  }
  return {
    asOf: new Date().toISOString(),
    cells: [...FALSIFIED_AUDIT],
    openClaims: 0,
    gradedClaims: 0,
  };
}

interface SetupCardRow {
  id: string;
  asset: string;
  type: string;
  direction?: "long" | "short";
  lastClose?: number;
  invalidation?: number;
  rRef?: number;
  madeAt: string;
  outcomeWindowEndsAt: string;
}

/** Race a setup card to win/loss/push/unscorable (altsetup-killgate pattern). */
function raceCard(
  r: SetupCardRow,
  candles: Candle[],
): "win" | "loss" | "push" | "unscorable" {
  if (
    !(r.rRef && r.rRef > 0) ||
    !(r.lastClose && r.lastClose > 0) ||
    r.invalidation === undefined
  ) {
    return "unscorable";
  }
  const start = Date.parse(r.madeAt);
  const end = Date.parse(r.outcomeWindowEndsAt);
  const window = candles.filter((c) => c.openTime > start && c.openTime <= end);
  if (window.length === 0) return "unscorable";
  const long = r.direction !== "short";
  for (const c of window) {
    const loss = long ? c.low <= r.invalidation : c.high >= r.invalidation;
    const win = long ? c.high >= r.rRef : c.low <= r.rRef;
    if (loss) return "loss";
    if (win) return "win";
  }
  return "push";
}

/**
 * Run the nightly backtest: score level-cells via scoreLedger, setup arms via
 * the paired-dartboard kill-gate, write the summary. `candlesByAsset` supplies
 * the OHLCV the rows need; an empty map → cells stay WATCH/empty (honest).
 */
export function runBacktest(
  candlesByAsset: Map<string, Candle[]>,
  nowMs: number,
): LedgerSummary {
  const cells: LedgerCell[] = [];
  let openClaims = 0;
  let gradedClaims = 0;

  let rows: SetupCardRow[] = [];
  if (existsSync(QUMO_LEDGER)) {
    try {
      rows = parseLedger(
        readFileSync(QUMO_LEDGER, "utf-8"),
      ) as unknown as SetupCardRow[];
    } catch {
      rows = [];
    }
  }

  // 1) Level-cells via scoreLedger (price-only, backtestable immediately).
  const btc = candlesByAsset.get("BTCUSDT") ?? [];
  if (btc.length > 0 && rows.length > 0) {
    const levelRows = (
      rows as unknown as Parameters<typeof scoreLedger>[0]
    ).filter((r) => (r as { kind?: string }).kind !== "card");
    const summaries = scoreLedger(levelRows, btc, nowMs);
    for (const s of summaries) {
      if (s.scorable < 30 || s.matured < 10) {
        cells.push({
          type: s.type,
          timeframe: s.timeframe,
          status: "WATCH",
          matured: s.matured,
          scorable: s.scorable,
          decided: s.scorable,
          gate: GATE,
        });
      } else {
        // No statistical test on this path — positive edge alone cannot earn GRADED.
        // FALSIFIED is valid (enough data, edge ≤ 0); GRADED requires the kill-gate in section 2.
        const status: CellStatus = s.edge > 0 ? "WATCH" : "FALSIFIED";
        cells.push({
          type: s.type,
          timeframe: s.timeframe,
          status,
          matured: s.matured,
          scorable: s.scorable,
          holds: s.holds,
          holdRate: Number(s.holdRate.toFixed(2)),
          baselineRate: s.baselineRate,
          edge: Number(s.edge.toFixed(2)),
        });
        if (status === "GRADED") gradedClaims++;
      }
    }
  }

  // 2) Setup arms via paired-dartboard kill-gate (altsetup-killgate pattern).
  for (const arm of SETUP_ARMS) {
    const byDate = new Map<
      string,
      Record<string, { wins: number; decided: number }>
    >();
    const totals: Record<string, { wins: number; decided: number }> = {
      [arm]: { wins: 0, decided: 0 },
      dartboard: { wins: 0, decided: 0 },
    };
    const cards = rows.filter(
      (r) =>
        (r as { kind?: string }).kind === "card" &&
        (r.type === arm || r.type === "dartboard") &&
        nowMs >= Date.parse(r.outcomeWindowEndsAt),
    );
    for (const r of cards) {
      const t = totals[r.type];
      if (!t) continue;
      const candles = candlesByAsset.get(r.asset) ?? [];
      const res = raceCard(r, candles);
      if (res !== "win" && res !== "loss") continue;
      t.decided++;
      if (res === "win") t.wins++;
      const dk = r.madeAt.slice(0, 10);
      const d = byDate.get(dk) ?? {};
      const slot = d[r.type] ?? { wins: 0, decided: 0 };
      slot.decided++;
      if (res === "win") slot.wins++;
      d[r.type] = slot;
      byDate.set(dk, d);
    }
    const decided = Math.min(totals[arm]?.decided, totals.dartboard?.decided);
    if (decided < GATE) {
      cells.push({
        type: arm,
        timeframe: "1d",
        status: "WATCH",
        decided,
        gate: GATE,
        note: "accumulating — no test run",
      });
    } else {
      const deltas: number[] = [];
      for (const [, d] of byDate) {
        const a = d[arm];
        const b = d.dartboard;
        if (!a?.decided || !b?.decided) continue;
        deltas.push(a.wins / a.decided - b.wins / b.decided);
      }
      const meanD =
        deltas.reduce((x, y) => x + y, 0) / Math.max(1, deltas.length);
      const rng = mulberry32(777);
      let ge = 0;
      for (let i = 0; i < 1000; i++) {
        let s = 0;
        for (const dd of deltas) s += rng() < 0.5 ? -dd : dd;
        if (s / Math.max(1, deltas.length) >= meanD) ge++;
      }
      const p = (1 + ge) / 1001;
      const holdRate = totals[arm]?.wins / totals[arm]?.decided;
      const baseRate =
        totals.dartboard?.wins / Math.max(1, totals.dartboard?.decided);
      const edge = holdRate - baseRate;
      cells.push({
        type: arm,
        timeframe: "1d",
        status: meanD > 0 && p < 0.05 ? "GRADED" : "FALSIFIED",
        decided,
        gate: GATE,
        holdRate: Number(holdRate.toFixed(2)),
        baselineRate: Number(baseRate.toFixed(2)),
        edge: Number(edge.toFixed(2)),
        permutationP: Number(p.toFixed(3)),
      });
      if (meanD > 0 && p < 0.05) gradedClaims++;
    }
  }

  // 3) Live signal audit — count open forward claims.
  openClaims = rows.filter(
    (r) => nowMs < Date.parse(r.outcomeWindowEndsAt),
  ).length;

  // 4) ALWAYS append the falsified/banned audit view (survivorship guard).
  cells.push(...FALSIFIED_AUDIT);

  const summary: LedgerSummary = {
    asOf: new Date(nowMs).toISOString(),
    cells,
    openClaims,
    gradedClaims,
  };
  try {
    mkdirSync(PATCHWORK, { recursive: true });
    writeFileSync(QUMO_SUMMARY, JSON.stringify(summary, null, 2));
  } catch {
    // summary write failure is non-fatal for a --backtest invocation
  }
  return summary;
}

export { LEDGER_BASELINE };
