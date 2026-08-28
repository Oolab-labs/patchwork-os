/**
 * Shadow ledger for graded Butler errand outcomes.
 *
 * A SEPARATE file from `outcome-log.jsonl`, and that separation is the entire
 * safety property of this phase. The trust fold reads `outcome-log.jsonl`; it
 * does not read this file and must not be taught to. Rows here are a
 * measurement of what the grader WOULD have said, recorded so the labelling
 * can be checked against reality before anything moves a worker's dial.
 *
 * This mirrors how the autonomy gate itself was landed — `workers shadow` and
 * `workers backtest` measured divergence for a whole campaign before the gate
 * was allowed to decide anything — and how #1319 was flipped, against a
 * measured delta rather than an argument. The pattern exists because the
 * alternative has failed here repeatedly: a labelling change that looks
 * obviously correct turns out to move real workers in ways nobody predicted,
 * and by then it is already in the ledger the gate rests on.
 *
 * ## What "shadow" costs
 *
 * Nothing observable. No gate decision consults it, no dial reads it, and
 * deleting the file loses only the measurement. That is the point: until
 * someone has read these rows against the real errands they describe, the
 * grader has not earned the right to be evidence.
 *
 * ## Promotion
 *
 * Promoting it means writing graded rows into `outcome-log.jsonl` through
 * `OutcomeStore.upsert` — deliberately NOT implemented here. That step needs
 * the join key to be right (`ref` = `"<tool>:<id>"`, see `actionRef.ts`) and a
 * measured before/after on the real log, exactly as #1319 required.
 */

import { appendFileSync, existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { patchworkHome } from "../patchworkHome.js";
import type { OutcomeDisposition } from "../workers/outcomeStore.js";
import type { GradedOutcome } from "./errandOutcomeGrader.js";

/**
 * Filename. Deliberately NOT `outcome-log.jsonl` and deliberately not in a
 * subdirectory of it — a reader that globs the outcome log must not pick this
 * up by accident.
 */
export const SHADOW_LOG_BASENAME = "butler_outcome_shadow.jsonl";

export function shadowLogPath(override?: string): string {
  return path.join(override ?? patchworkHome(), SHADOW_LOG_BASENAME);
}

export interface ShadowOutcomeRow {
  /**
   * The action this grades, in `canonicalActionRef` form (`"<tool>:<id>"`).
   * Stored so a promoted row can join to the same action the fold would —
   * recording a grade under a key the fold cannot resolve would produce a
   * measurement of nothing.
   */
  ref: string;
  disposition: OutcomeDisposition;
  reason: GradedOutcome["reason"];
  /** When the grade was computed. */
  gradedAt: number;
  /** The recipe that filed the action, for attribution during review. */
  recipe?: string;
  /**
   * Whether the fold WOULD have counted this as evidence. Derived once at
   * write time so a reviewer reading the file does not have to re-derive the
   * withholding rule and risk deriving it differently.
   */
  wouldCountAsEvidence: boolean;
}

/** `unknown` is withheld by the fold; the other two are evidence. */
export function wouldCountAsEvidence(d: OutcomeDisposition): boolean {
  return d !== "unknown";
}

/**
 * Append one graded row. Append-only and best-effort: this is a measurement,
 * and a measurement must never be able to fail an errand it is observing.
 */
export function appendShadowOutcome(
  row: Omit<ShadowOutcomeRow, "wouldCountAsEvidence">,
  opts: { dir?: string } = {},
): void {
  const full: ShadowOutcomeRow = {
    ...row,
    wouldCountAsEvidence: wouldCountAsEvidence(row.disposition),
  };
  try {
    appendFileSync(shadowLogPath(opts.dir), `${JSON.stringify(full)}\n`);
  } catch {
    // Swallowed on purpose. See above: an unwritable shadow ledger must not
    // turn into an errand failure.
  }
}

/**
 * When each ref was FIRST graded, from the ledger itself.
 *
 * No new file: every shadow row already carries `gradedAt`, so the earliest
 * one for a ref IS the moment it came under observation. A separate
 * "first seen" store would be a second source of truth that can disagree with
 * the ledger it describes — and the ledger is the thing a reviewer reads.
 *
 * Refs absent from the map have never been observed; the caller supplies
 * `now`, which is correct: this run is when watching starts.
 */
export function firstSeenByRef(
  opts: { dir?: string } = {},
): Map<string, number> {
  const out = new Map<string, number>();
  const p = shadowLogPath(opts.dir);
  if (!existsSync(p)) return out;
  let text: string;
  try {
    text = readFileSync(p, "utf-8");
  } catch {
    return out;
  }
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let row: ShadowOutcomeRow;
    try {
      row = JSON.parse(line) as ShadowOutcomeRow;
    } catch {
      continue;
    }
    if (typeof row.ref !== "string" || typeof row.gradedAt !== "number") {
      continue;
    }
    const prev = out.get(row.ref);
    if (prev === undefined || row.gradedAt < prev)
      out.set(row.ref, row.gradedAt);
  }
  return out;
}

export interface ShadowSummary {
  total: number;
  confirmed: number;
  junk: number;
  unknown: number;
  /** Rows that would have become evidence had the grader been live. */
  wouldCount: number;
  /**
   * Rows per grading reason.
   *
   * The disposition counts alone cannot answer the only question an operator
   * has when `unknown` dominates: is this channel WORKING on errands that are
   * simply still in flight, or is it seeing nothing at all? Those are
   * `open-recent` and `not-observed`, and they collapse into the same
   * `unknown` bucket while calling for opposite responses — wait, versus go
   * and fix the observation path.
   *
   * The rows have always carried `reason`; only the summary discarded it. Same
   * defect as #1469, where the shadow report named a defaulted-classification
   * count and gave no way to find WHICH recipes to go and label.
   */
  byReason: Record<GradedOutcome["reason"], number>;
}

/** Every reason, so a summary always reports the full space rather than only what it saw. */
export const SHADOW_REASONS: ReadonlyArray<GradedOutcome["reason"]> = [
  "completed",
  "deleted",
  "stale-unactioned",
  "open-recent",
  "not-observed",
];

/**
 * Reasons that mean "the observation channel could not answer", as opposed to
 * "it answered, and the errand is not finished yet". Exported so the formatter
 * and its tests cannot drift on which is which.
 */
export const UNOBSERVED_REASONS: ReadonlyArray<GradedOutcome["reason"]> = [
  "not-observed",
];

/**
 * Summarise the shadow ledger — the number this phase exists to produce.
 *
 * Malformed lines are SKIPPED but counted in nothing; a half-written row from
 * an interrupted append is not evidence of anything and must not inflate a
 * count someone is about to make a decision on.
 */
export function summariseShadowLog(opts: { dir?: string } = {}): ShadowSummary {
  const emptyByReason = () =>
    Object.fromEntries(SHADOW_REASONS.map((r) => [r, 0])) as Record<
      GradedOutcome["reason"],
      number
    >;
  const empty: ShadowSummary = {
    total: 0,
    confirmed: 0,
    junk: 0,
    unknown: 0,
    wouldCount: 0,
    byReason: emptyByReason(),
  };
  const p = shadowLogPath(opts.dir);
  if (!existsSync(p)) return empty;
  let text: string;
  try {
    text = readFileSync(p, "utf-8");
  } catch {
    return empty;
  }
  // Fresh `byReason` rather than sharing `empty`'s. NOT a live bug — `empty` is
  // built per call, so the spread aliasing its object harms nothing today. It is
  // here so that hoisting `empty` to module scope, an obvious tidy-up, cannot
  // silently make every summary cumulative. Deliberately NOT covered by a test:
  // no test can distinguish the two while `empty` stays local, and a test that
  // passes either way would be worse than none.
  const out: ShadowSummary = { ...empty, byReason: emptyByReason() };
  // Fold by ref, LAST GRADE WINS — the identical rule `promoteShadowOutcomes`
  // applies, and deliberately so.
  //
  // The ledger is append-only and an errand is observed repeatedly; that is
  // the design, not a defect. Counting rows therefore counted OBSERVATIONS and
  // called them errands: on the reference machine, four errands observed
  // several times each reported as "17 graded rows, confirmed 3 (17.6%)" when
  // the truth was one confirmed errand of four.
  //
  // Two reasons that is worse than a cosmetic miscount. It DRIFTS — every
  // observation pushes the percentage further from the truth, so scheduling
  // observation degrades the number steadily. And this summary is what a
  // person reads before deciding to promote, which is one-way. This module's
  // own header names the hazard: two readers of one append-only file with two
  // copies of "what counts as a row" is how a report and the thing it reports
  // on come to disagree.
  const latest = new Map<string, ShadowOutcomeRow>();
  for (const row of parseShadowRows(text)) {
    const prev = latest.get(row.ref);
    if (prev === undefined || row.gradedAt >= prev.gradedAt) {
      latest.set(row.ref, row);
    }
  }
  for (const row of latest.values()) {
    out.total++;
    out[row.disposition]++;
    if (row.wouldCountAsEvidence) out.wouldCount++;
    // A row whose reason is outside the known space is counted in `total` but
    // not attributed. Silently coercing it into a known bucket would put a
    // number a person acts on behind a guess.
    if (row.reason in out.byReason) out.byReason[row.reason]++;
  }
  return out;
}

/**
 * Parse well-formed rows out of raw ledger text.
 *
 * The single parse rule, shared by the summary and by promotion. Two readers of
 * one append-only file with two copies of "what counts as a row" is how a
 * report and the thing it reports on come to disagree — and here the report is
 * what a person reads before deciding to promote.
 *
 * Malformed lines are SKIPPED and counted in nothing: a half-written row from
 * an interrupted append is not evidence, and must not inflate a number someone
 * is about to make a trust decision on.
 */
export function parseShadowRows(text: string): ShadowOutcomeRow[] {
  const rows: ShadowOutcomeRow[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let row: ShadowOutcomeRow;
    try {
      row = JSON.parse(line) as ShadowOutcomeRow;
    } catch {
      continue;
    }
    if (
      row.disposition !== "confirmed" &&
      row.disposition !== "junk" &&
      row.disposition !== "unknown"
    ) {
      continue;
    }
    if (typeof row.ref !== "string" || !row.ref) continue;
    rows.push(row);
  }
  return rows;
}

/** Every well-formed row in the ledger, oldest first. */
export function readShadowRows(dir?: string): ShadowOutcomeRow[] {
  const p = shadowLogPath(dir);
  if (!existsSync(p)) return [];
  try {
    return parseShadowRows(readFileSync(p, "utf-8"));
  } catch {
    return [];
  }
}
