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
}

/**
 * Summarise the shadow ledger — the number this phase exists to produce.
 *
 * Malformed lines are SKIPPED but counted in nothing; a half-written row from
 * an interrupted append is not evidence of anything and must not inflate a
 * count someone is about to make a decision on.
 */
export function summariseShadowLog(opts: { dir?: string } = {}): ShadowSummary {
  const empty: ShadowSummary = {
    total: 0,
    confirmed: 0,
    junk: 0,
    unknown: 0,
    wouldCount: 0,
  };
  const p = shadowLogPath(opts.dir);
  if (!existsSync(p)) return empty;
  let text: string;
  try {
    text = readFileSync(p, "utf-8");
  } catch {
    return empty;
  }
  const out = { ...empty };
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
    out.total++;
    out[row.disposition]++;
    if (row.wouldCountAsEvidence) out.wouldCount++;
  }
  return out;
}
