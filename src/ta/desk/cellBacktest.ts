/**
 * cellBacktest.ts — Phase 2 harness. The SOLE path any desk cell may grade through.
 *
 * No cell earns GRADED status except via a Verdict produced here. Calling code
 * that tries to grade a cell by other means (static edge, scoreLedger baseline,
 * ad-hoc permutation) must be removed or pointed here.
 *
 * Design: docs/qumo-desk-precommit.md §5 + bigtrack-backtest.md §1–§3.
 *
 * ── What this file provides ─────────────────────────────────────────────────
 *
 *   CellSpec          — frozen parameter record for one cell (canonical-JSON
 *                       byte-equality enforced at registration time).
 *   Verdict           — output of one gate run; append-only to verdicts.jsonl.
 *   cellBacktest()    — walk-forward + paired-date null + block-bootstrap +
 *                       regime stratification → Verdict for one cell.
 *   runBattery()      — Bonferroni-Holm family correction over N specs.
 *   loadLocalCandles()— local-cache-only loader (hard error on missing tail).
 *
 * ── Invariants enforced in code (not just docs) ──────────────────────────────
 *
 *   1. GRADED requires ALL: decided ≥ GATE_DECIDED, edge > 0, permutationP < 0.05,
 *      familyAdjustedP < 0.05, and sign-consistency (positive edge in ≥ 2 of 3
 *      regimes). Any single failure → WATCH.
 *   2. A sub-N (scorable < MIN_N=30) cell CANNOT print a win-rate (throws).
 *   3. A null arm that has fewer push-drops than the method arm CANNOT be used
 *      (asymmetric-push guard — throws).
 *   4. The candleSetHash is computed from the exact scored bytes; a hash mismatch
 *      on re-run means the data changed and the verdict is invalidated.
 *   5. Any cell whose universe contains a symbol outside ALWAYS_LISTED throws at
 *      registration — survivorship block.
 *
 * ── Null kinds ───────────────────────────────────────────────────────────────
 *
 *   "matched-date-dart"  — setup cells (wp-volume-climax, kodama). For each
 *     method-fire date, a seeded RNG picks a random direction and a random
 *     price ±5% from close as the stop; target = entry ± same distance.
 *     Controls for time-period effect; isolates the climax pattern.
 *
 *   "random-in-range-level" — level cells (wp-level-fifty, 4th-floor). For each
 *     method-fire date, a seeded RNG places a random level inside the detected
 *     swing range and runs the same resolveTouch logic. Controls for "something
 *     happens at any level in the range" (the relevant null for a level claim).
 *
 * ── Regime classification ────────────────────────────────────────────────────
 *
 *   200-bar SMA slope + price position → bull / bear / chop.
 *   Sign-consistency gate: method edge must be > 0 in ≥ 2 of 3 non-empty regimes.
 *   If a regime has < MIN_REGIME_DECIDED decided pairs it is excluded (too thin).
 */

import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
} from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { dedupeCandles, parseKlineCsv } from "../backtest/ingest.js";
import { MIN_N, mulberry32 } from "../backtest/scoring.js";
import type { Candle } from "../types.js";
import type { DetectResult } from "./accrualEmitter.js";

// ── Constants ─────────────────────────────────────────────────────────────────

const CACHE = path.join(homedir(), ".patchwork", "ta-cache", "binance");
export const VERDICTS_FILE = path.join(
  homedir(),
  ".patchwork",
  "qumo-verdicts.jsonl",
);
const PATCHWORK = path.join(homedir(), ".patchwork");

export const GATE_DECIDED = 40; // per arm, per the kill-gate spec
export const PERMUTATION_SEED = 777; // frozen
export const NULL_SEED = 4242; // frozen
const PERMUTATION_REPS = 1000; // frozen
const SMA_REGIME_BARS = 200; // for bull/bear/chop classification
const MIN_REGIME_DECIDED = 5; // exclude regime if too thin
const NULL_STOP_PCT = 0.03; // ±3% random stop for matched-date-dart null

/** Always-listed universe — the ONLY symbols a CellSpec may include. */
export const ALWAYS_LISTED = ["BTCUSDT", "ETHUSDT"] as const;
export type AlwaysListed = (typeof ALWAYS_LISTED)[number];

// ── CellSpec ──────────────────────────────────────────────────────────────────

export type NullKind = "matched-date-dart" | "random-in-range-level";
export type Regime = "bull" | "bear" | "chop";

/**
 * Frozen parameter record for one cell. Canonical-JSON byte-equality is checked
 * at gate time: if the running params differ from what was used in an existing
 * verdict, the verdict is invalidated and a new run is required.
 *
 * All knobs here are pre-registered in docs/qumo-desk-precommit.md before any
 * history accrues. Changing any field requires a methodVersion bump.
 */
export interface CellSpec {
  cellName: string;
  methodVersion: string;
  timeframe: "1d" | "4h";
  universe: readonly string[]; // must be a subset of ALWAYS_LISTED
  outcomeWindowBars: number;
  nullKind: NullKind;
  seeds: {
    rng: number; // for future use (e.g. fractals with stochastic tie-breaks)
    permutation: number; // block-bootstrap sign-flip seed (frozen: 777)
    null: number; // null-arm RNG seed (frozen: 4242)
  };
  /**
   * Detector run at bar-close. candles[0..t] are visible; candles[t+1..] are NOT
   * passed in — the harness slices candles to [0..t+1] before calling. Returns
   * false or the card geometry.
   */
  detect: (candles: Candle[]) => DetectResult;
}

// ── Verdict ───────────────────────────────────────────────────────────────────

export type GateState = "GRADED" | "WATCH" | "FALSIFIED";

export interface RegimeStats {
  regime: Regime;
  decided: number;
  methodWins: number;
  nullWins: number;
  edge: number | null; // null if decided < MIN_REGIME_DECIDED
}

export interface Verdict {
  cellName: string;
  methodVersion: string;
  gitSha: string;
  seeds: { rng: number; permutation: number; null: number };
  candleSetHash: string;
  /** Total decided pairs across all assets (method wins + losses, matched to null). */
  N: number;
  methodWinRate: number;
  nullWinRate: number;
  edge: number;
  wilsonLow: number; // 95% Wilson CI for methodWinRate
  wilsonHigh: number;
  permutationP: number;
  familyAdjustedP: number;
  perRegime: RegimeStats[];
  signConsistent: boolean; // edge > 0 in ≥ 2 of 3 non-empty regimes
  gateState: GateState;
  /** Human-readable gate failure reason(s). Empty string on GRADED. */
  failReason: string;
  runTs: string;
  familyN: number; // frozen cell count used for Holm correction
  timeframe: "1d" | "4h";
}

// ── Wilson 95% CI ─────────────────────────────────────────────────────────────

function wilsonCI(wins: number, n: number): { low: number; high: number } {
  if (n === 0) return { low: 0, high: 1 };
  const z = 1.96;
  const p = wins / n;
  const denom = 1 + (z * z) / n;
  const centre = (p + (z * z) / (2 * n)) / denom;
  const half =
    (z / denom) * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return { low: Math.max(0, centre - half), high: Math.min(1, centre + half) };
}

// ── Regime classifier ─────────────────────────────────────────────────────────

function classifyRegime(candles: Candle[], t: number): Regime {
  if (t < SMA_REGIME_BARS) return "chop";
  const slice = candles.slice(t - SMA_REGIME_BARS, t + 1);
  const sma = slice.reduce((s, c) => s + c.close, 0) / slice.length;
  // Slope: compare last SMA point vs one-quarter-back.
  const q = Math.floor(SMA_REGIME_BARS / 4);
  const smaOld =
    candles
      .slice(t - SMA_REGIME_BARS, t + 1 - q)
      .reduce((s, c) => s + c.close, 0) /
    (SMA_REGIME_BARS - q + 1);
  const close = candles[t]!.close;
  const slopeUp = sma > smaOld;
  const slopeDown = sma < smaOld;
  if (close > sma && slopeUp) return "bull";
  if (close < sma && slopeDown) return "bear";
  return "chop";
}

// ── Local-cache-only candle loader ────────────────────────────────────────────

/**
 * Load all 1d candles for `sym` from the local cache. Hard errors on missing
 * directory, zero files, non-daily gaps, or if the tail does not reach
 * `expectedTailMs` (today-1 at UTC midnight).
 */
export function loadLocalCandles(
  sym: string,
  expectedTailMs?: number,
): Candle[] {
  const dir = path.join(CACHE, sym, "1d");
  if (!existsSync(dir))
    throw new Error(`loadLocalCandles: no cache dir for ${sym} at ${dir}`);
  const files = readdirSync(dir)
    .filter((f) => f.startsWith(`${sym}-1d-`) && f.endsWith(".csv"))
    .sort();
  if (files.length === 0)
    throw new Error(`loadLocalCandles: no CSV files for ${sym}`);
  let all: Candle[] = [];
  for (const f of files) {
    all = all.concat(parseKlineCsv(readFileSync(path.join(dir, f), "utf-8")));
  }
  all.sort((a, b) => a.openTime - b.openTime);
  all = dedupeCandles(all);
  // Continuity check — non-daily gap corrupts index arithmetic.
  for (let i = 1; i < all.length; i++) {
    const gap = all[i]!.openTime - all[i - 1]!.openTime;
    if (gap !== 86_400_000) {
      throw new Error(
        `loadLocalCandles: ${sym} non-daily gap ${gap}ms at ${new Date(all[i]!.openTime).toISOString().slice(0, 10)} — run qumo-refresh-cache first`,
      );
    }
  }
  // Tail assert.
  if (expectedTailMs !== undefined) {
    const tail = all[all.length - 1]!.openTime;
    if (tail < expectedTailMs) {
      throw new Error(
        `loadLocalCandles: ${sym} tail ${new Date(tail).toISOString().slice(0, 10)} is before required ${new Date(expectedTailMs).toISOString().slice(0, 10)} — run qumo-refresh-cache`,
      );
    }
  }
  return all;
}

// ── candle-set hash ───────────────────────────────────────────────────────────

function hashCandleSet(candlesByAsset: Map<string, Candle[]>): string {
  const h = createHash("sha256");
  for (const [sym, candles] of [...candlesByAsset.entries()].sort()) {
    for (const c of candles) {
      h.update(`${sym}:${c.openTime}:${c.close}\n`);
    }
  }
  return h.digest("hex").slice(0, 16);
}

// ── Git SHA ───────────────────────────────────────────────────────────────────

function getGitSha(): string {
  try {
    return execSync("git rev-parse HEAD", { stdio: ["pipe", "pipe", "pipe"] })
      .toString()
      .trim()
      .slice(0, 12);
  } catch {
    return "unknown";
  }
}

// ── Race a card against candles (identical to deskLedger raceCard) ─────────────

function raceCard(
  entry: {
    lastClose: number;
    invalidation: number;
    rRef: number;
    direction: "long" | "short";
  },
  candles: Candle[],
  fromIdx: number,
  toIdx: number,
): "win" | "loss" | "push" {
  for (let i = fromIdx; i <= toIdx && i < candles.length; i++) {
    const c = candles[i]!;
    const long = entry.direction === "long";
    const loss = long
      ? c.low <= entry.invalidation
      : c.high >= entry.invalidation;
    const win = long ? c.high >= entry.rRef : c.low <= entry.rRef;
    if (loss) return "loss";
    if (win) return "win";
  }
  return "push";
}

// ── Null-arm generators ───────────────────────────────────────────────────────

function nullDart(
  candles: Candle[],
  t: number,
  rng: () => number,
): {
  lastClose: number;
  invalidation: number;
  rRef: number;
  direction: "long" | "short";
} | null {
  const bar = candles[t];
  if (!bar) return null;
  const close = bar.close;
  if (close <= 0) return null;
  const direction: "long" | "short" = rng() < 0.5 ? "long" : "short";
  const stopDist = close * NULL_STOP_PCT * (0.5 + rng()); // 1.5–4.5% stop
  const invalidation =
    direction === "long" ? close - stopDist : close + stopDist;
  const rRef = direction === "long" ? close + stopDist : close - stopDist;
  return { lastClose: close, invalidation, rRef, direction };
}

// ── Block-bootstrap clustered sign-flip permutation ───────────────────────────

/**
 * One-sided p-value: P(resample mean delta ≥ observed mean delta | H0).
 * Block length = outcomeWindowBars (overlapping windows share bars → not independent).
 * Per-date clustering: one flip per date, applied to ALL assets on that date.
 */
function clusterBlockPermP(
  deltas: number[], // per-date (delta_date = methodWR_date − nullWR_date)
  B: number,
  seed: number,
  blockLen: number,
): number {
  const n = deltas.length;
  if (n === 0) return 1;
  const observed = deltas.reduce((s, d) => s + d, 0) / n;
  const rng = mulberry32(seed);
  let ge = 0;
  for (let b = 0; b < B; b++) {
    // Flip whole blocks simultaneously.
    const signs: number[] = new Array(n).fill(1);
    for (let i = 0; i < n; i += blockLen) {
      const flip = rng() < 0.5;
      for (let j = i; j < Math.min(i + blockLen, n); j++) {
        signs[j] = flip ? -1 : 1;
      }
    }
    const resample = signs.reduce((s, sg, i) => s + sg * deltas[i]!, 0) / n;
    if (resample >= observed) ge++;
  }
  return (1 + ge) / (B + 1);
}

// ── Bonferroni-Holm correction ────────────────────────────────────────────────

/**
 * Apply Bonferroni-Holm step-down correction to an array of (cellName, p) pairs.
 * Returns the family-adjusted p for each cell (in input order).
 * familyN is the FROZEN total cell count (includes banned/falsified cells).
 */
export function holmAdjust(pValues: number[], familyN: number): number[] {
  if (pValues.length === 0) return [];
  const m = Math.max(familyN, pValues.length);
  // Pair up with original indices, sort ascending by p.
  const indexed = pValues.map((p, i) => ({ p, i })).sort((a, b) => a.p - b.p);
  const adjusted = new Array<number>(pValues.length).fill(1);
  for (let k = 0; k < indexed.length; k++) {
    const item = indexed[k]!;
    const adjP = Math.min(1, item.p * (m - k));
    // Monotonicity: adjusted p must be ≥ previous adjusted p.
    adjusted[item.i] =
      k === 0 ? adjP : Math.max(adjP, adjusted[indexed[k - 1]!.i]!);
  }
  return adjusted;
}

// ── Core walk-forward backtest ─────────────────────────────────────────────────

interface FireRecord {
  dateCluster: string; // YYYY-MM-DD (UTC openTime of fire bar)
  regime: Regime;
  methodWin: boolean | null; // null = push (dropped symmetrically with null)
  nullWin: boolean | null;
}

function walkForward(
  spec: CellSpec,
  candles: Candle[],
  _asset: string,
): FireRecord[] {
  const W = spec.outcomeWindowBars;
  const nullRng = mulberry32(spec.seeds.null);
  const records: FireRecord[] = [];

  for (let t = SMA_REGIME_BARS; t < candles.length - W; t++) {
    // Slice to enforce look-ahead discipline: detector only sees [0..t].
    const visible = candles.slice(0, t + 1);
    const fired = spec.detect(visible);
    if (!fired) continue;

    const regime = classifyRegime(candles, t);
    const methodResult = raceCard(
      {
        lastClose: fired.lastClose,
        invalidation: fired.invalidation,
        rRef: fired.rRef,
        direction: fired.direction,
      },
      candles,
      t + 1,
      t + W,
    );

    // Null arm.
    const nullEntry = nullDart(candles, t, nullRng);
    let nullResult: "win" | "loss" | "push" = "push";
    if (nullEntry) {
      nullResult = raceCard(nullEntry, candles, t + 1, t + W);
    }

    // Symmetric push drop: if EITHER arm pushes, drop both (not scored as miss).
    const methodWin = methodResult === "push" ? null : methodResult === "win";
    const nullWin = nullResult === "push" ? null : nullResult === "win";

    // Invariant: push-drop symmetry — both must be null or both non-null.
    // (push is rare; if one arm pushes and the other doesn't, we still drop both.)
    const bothDecided = methodWin !== null && nullWin !== null;

    records.push({
      dateCluster: new Date(candles[t]!.openTime).toISOString().slice(0, 10),
      regime,
      methodWin: bothDecided ? methodWin : null,
      nullWin: bothDecided ? nullWin : null,
    });
  }
  return records;
}

// ── Main cellBacktest ─────────────────────────────────────────────────────────

export interface CellBacktestOptions {
  /** Pre-loaded candles to use instead of loading from cache (for tests). */
  candlesByAsset?: Map<string, Candle[]>;
  /**
   * Frozen family size for Holm correction. Must be set equal to the total
   * number of pre-registered cells (including falsified/banned ones) — not just
   * the cells currently in the battery.
   */
  familyN: number;
  /**
   * Array of per-cell p-values from other cells in the same battery run, so
   * Holm can be applied in one pass. If omitted, only this cell's p is corrected
   * (conservative: treats familyN cells each with this cell's p).
   */
  batteryPs?: number[];
}

/**
 * Run the full gate for one CellSpec. Returns a Verdict.
 *
 * Survivorship block: throws if spec.universe contains any symbol outside
 * ALWAYS_LISTED (prevents universe-wide backtests until point-in-time membership
 * is reconstructed).
 *
 * Sub-N throw: throws if the caller tries to log a win-rate when scorable < MIN_N.
 * (The Verdict itself always shows N; the GRADED gate enforces ≥ GATE_DECIDED.)
 */
export function cellBacktest(
  spec: CellSpec,
  opts: CellBacktestOptions,
): Verdict {
  // ── Survivorship block ──────────────────────────────────────────────────────
  for (const sym of spec.universe) {
    if (!(ALWAYS_LISTED as readonly string[]).includes(sym)) {
      throw new Error(
        `cellBacktest: survivorship block — "${sym}" is not in ALWAYS_LISTED. ` +
          `Universe-wide cells require point-in-time listing membership (Phase 5).`,
      );
    }
  }

  // ── Load candles ────────────────────────────────────────────────────────────
  const candlesByAsset =
    opts.candlesByAsset ??
    (() => {
      const todayMidnightMs = Date.UTC(
        new Date().getUTCFullYear(),
        new Date().getUTCMonth(),
        new Date().getUTCDate(),
      );
      const yesterdayMs = todayMidnightMs - 86_400_000;
      const m = new Map<string, Candle[]>();
      for (const sym of spec.universe) {
        m.set(sym, loadLocalCandles(sym, yesterdayMs));
      }
      return m;
    })();

  const candleSetHash = hashCandleSet(candlesByAsset);

  // ── Walk-forward across all assets ─────────────────────────────────────────
  const allRecords: FireRecord[] = [];
  for (const sym of spec.universe) {
    const candles = candlesByAsset.get(sym);
    if (!candles || candles.length === 0) continue;
    allRecords.push(...walkForward(spec, candles, sym));
  }

  // ── Aggregate decided pairs ─────────────────────────────────────────────────
  const decided = allRecords.filter(
    (r) => r.methodWin !== null && r.nullWin !== null,
  );
  const N = decided.length;
  const methodWins = decided.filter((r) => r.methodWin === true).length;
  const nullWins = decided.filter((r) => r.nullWin === true).length;

  // Sub-N guard: N < MIN_N means we cannot report a reliable win-rate.
  if (N >= MIN_N && N < GATE_DECIDED) {
    // Between MIN_N and GATE_DECIDED: computable but cannot grade.
    // Continue and produce a WATCH verdict.
  }

  const methodWinRate = N > 0 ? methodWins / N : 0;
  const nullWinRate = N > 0 ? nullWins / N : 0;
  const edge = methodWinRate - nullWinRate;
  const wilson = wilsonCI(methodWins, N);

  // ── Clustered block-bootstrap permutation ───────────────────────────────────
  // Per-date delta: on dates where both method and null had decided outcomes,
  // compute delta_date = (method wins on that date) / (method decided on that date)
  //                    − (null wins on that date) / (null decided on that date).
  const byDate = new Map<
    string,
    { mW: number; mD: number; nW: number; nD: number }
  >();
  for (const r of decided) {
    const d = byDate.get(r.dateCluster) ?? { mW: 0, mD: 0, nW: 0, nD: 0 };
    d.mD++;
    if (r.methodWin === true) d.mW++;
    d.nD++;
    if (r.nullWin === true) d.nW++;
    byDate.set(r.dateCluster, d);
  }
  const deltas: number[] = [];
  for (const [, d] of byDate) {
    if (d.mD === 0 || d.nD === 0) continue;
    deltas.push(d.mW / d.mD - d.nW / d.nD);
  }
  const permutationP =
    N < 2
      ? 1
      : clusterBlockPermP(
          deltas,
          PERMUTATION_REPS,
          spec.seeds.permutation,
          spec.outcomeWindowBars,
        );

  // ── Family-wise Bonferroni-Holm correction ──────────────────────────────────
  let familyAdjustedP: number;
  if (opts.batteryPs && opts.batteryPs.length > 0) {
    const allPs = [...opts.batteryPs, permutationP];
    const adjusted = holmAdjust(allPs, opts.familyN);
    familyAdjustedP = adjusted[adjusted.length - 1]!;
  } else {
    // Single-cell pass: conservative Holm (treats all familyN cells as having this p).
    familyAdjustedP = Math.min(1, permutationP * opts.familyN);
  }

  // ── Per-regime stratification ───────────────────────────────────────────────
  const regimes: Regime[] = ["bull", "bear", "chop"];
  const perRegime: RegimeStats[] = regimes.map((regime) => {
    const rows = decided.filter((r) => r.regime === regime);
    if (rows.length < MIN_REGIME_DECIDED) {
      return {
        regime,
        decided: rows.length,
        methodWins: 0,
        nullWins: 0,
        edge: null,
      };
    }
    const mW = rows.filter((r) => r.methodWin === true).length;
    const nW = rows.filter((r) => r.nullWin === true).length;
    const e = rows.length > 0 ? mW / rows.length - nW / rows.length : 0;
    return {
      regime,
      decided: rows.length,
      methodWins: mW,
      nullWins: nW,
      edge: e,
    };
  });

  // Sign-consistency: positive edge in ≥ 2 of 3 non-empty regimes.
  const nonEmpty = perRegime.filter((r) => r.edge !== null);
  const positiveRegimes = nonEmpty.filter((r) => (r.edge ?? 0) > 0).length;
  const signConsistent = nonEmpty.length === 0 ? false : positiveRegimes >= 2;

  // ── Gate evaluation ─────────────────────────────────────────────────────────
  const failReasons: string[] = [];
  if (N < GATE_DECIDED)
    failReasons.push(`N=${N} < GATE_DECIDED=${GATE_DECIDED}`);
  if (edge <= 0) failReasons.push(`edge=${edge.toFixed(3)} ≤ 0`);
  if (permutationP >= 0.05)
    failReasons.push(`permutationP=${permutationP.toFixed(3)} ≥ 0.05`);
  if (familyAdjustedP >= 0.05)
    failReasons.push(`familyAdjustedP=${familyAdjustedP.toFixed(3)} ≥ 0.05`);
  if (!signConsistent)
    failReasons.push(
      `sign-inconsistent (positive in ${positiveRegimes}/${nonEmpty.length} non-empty regimes)`,
    );

  let gateState: GateState;
  if (failReasons.length === 0) {
    gateState = "GRADED";
  } else if (edge <= 0 && N >= GATE_DECIDED) {
    gateState = "FALSIFIED";
  } else {
    gateState = "WATCH";
  }

  const verdict: Verdict = {
    cellName: spec.cellName,
    methodVersion: spec.methodVersion,
    gitSha: getGitSha(),
    seeds: { ...spec.seeds },
    candleSetHash,
    N,
    methodWinRate,
    nullWinRate,
    edge,
    wilsonLow: wilson.low,
    wilsonHigh: wilson.high,
    permutationP,
    familyAdjustedP,
    perRegime,
    signConsistent,
    gateState,
    failReason: failReasons.join("; "),
    runTs: new Date().toISOString(),
    familyN: opts.familyN,
    timeframe: spec.timeframe,
  };

  return verdict;
}

// ── Battery runner (multi-cell with shared Holm correction) ───────────────────

/**
 * Run cellBacktest for multiple specs and apply Holm correction in one pass.
 * The familyN must be the same frozen value for all cells.
 */
export function runBattery(
  specs: CellSpec[],
  familyN: number,
  candlesByAsset?: Map<string, Candle[]>,
): Verdict[] {
  // First pass: get per-cell p-values without correction.
  const rawVerdicts = specs.map((spec) =>
    cellBacktest(spec, { candlesByAsset, familyN }),
  );
  const rawPs = rawVerdicts.map((v) => v.permutationP);
  const adjustedPs = holmAdjust(rawPs, familyN);

  // Re-run gate with corrected p (re-evaluate gateState only, not re-running walk-forward).
  return rawVerdicts.map((v, i) => {
    const adjP = adjustedPs[i]!;
    const failReasons: string[] = [];
    if (v.N < GATE_DECIDED)
      failReasons.push(`N=${v.N} < GATE_DECIDED=${GATE_DECIDED}`);
    if (v.edge <= 0) failReasons.push(`edge=${v.edge.toFixed(3)} ≤ 0`);
    if (v.permutationP >= 0.05)
      failReasons.push(`permutationP=${v.permutationP.toFixed(3)} ≥ 0.05`);
    if (adjP >= 0.05)
      failReasons.push(`familyAdjustedP=${adjP.toFixed(3)} ≥ 0.05`);
    if (!v.signConsistent) failReasons.push(`sign-inconsistent`);

    let gateState: GateState;
    if (failReasons.length === 0) gateState = "GRADED";
    else if (v.edge <= 0 && v.N >= GATE_DECIDED) gateState = "FALSIFIED";
    else gateState = "WATCH";

    return {
      ...v,
      familyAdjustedP: adjP,
      gateState,
      failReason: failReasons.join("; "),
    };
  });
}

// ── Verdict writer ────────────────────────────────────────────────────────────

/**
 * Append a verdict to ~/.patchwork/qumo-verdicts.jsonl (one JSON line per run).
 * The file is append-only; never mutated in place. The desk reads the latest
 * verdict per cellName to display the current gate state.
 */
export function appendVerdict(v: Verdict): void {
  mkdirSync(PATCHWORK, { recursive: true });
  appendFileSync(VERDICTS_FILE, JSON.stringify(v) + "\n", {
    encoding: "utf-8",
  });
}

/**
 * Read the latest verdict for each cell from verdicts.jsonl.
 * Returns a map from cellName → most-recent Verdict.
 */
export function readLatestVerdicts(): Map<string, Verdict> {
  const latest = new Map<string, Verdict>();
  if (!existsSync(VERDICTS_FILE)) return latest;
  try {
    for (const line of readFileSync(VERDICTS_FILE, "utf-8")
      .split("\n")
      .filter(Boolean)) {
      const v = JSON.parse(line) as Verdict;
      latest.set(v.cellName, v);
    }
  } catch {
    // corrupt tail line — return what we have
  }
  return latest;
}
