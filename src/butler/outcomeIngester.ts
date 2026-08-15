/**
 * Butler errand outcome ingester — grade a batch of observations into the
 * SHADOW ledger, and nothing else.
 *
 * ## What this is for
 *
 * `errandOutcomeGrader.ts` is a pure function and `outcomeShadowLog.ts` is an
 * append-only file. Between them there was nothing: the grader was merged
 * unwired, so no row had ever been written and the measurement the shadow
 * phase exists to produce did not exist. This is the missing middle.
 *
 * ## Where it may be called from, and where it may not
 *
 * Operator paths ONLY — the Bearer-authenticated HTTP route and the CLI, the
 * same shape as `outcomes confirm`. It is deliberately NOT registered in the
 * recipe tool registry, and there is a test asserting that.
 *
 * The reason is the one that makes `outcomes confirm` a CLI verb rather than a
 * recipe step: a worker must not be able to grade its own filings. A recipe
 * step runs as the worker. If grading were reachable from one, a worker whose
 * errands nobody ever looks at could emit `completed: true` for each of them
 * and manufacture the evidence that raises its own trust dial. That is not a
 * hypothetical class of bug in this subsystem — it is the same defect as
 * #1064, #1318/#1319, #1320 and #1322, which is four times.
 *
 * ## No model in the loop
 *
 * Every disposition here comes from `gradeErrandOutcome`, a pure function of
 * observed state and two timestamps. A prior LLM judge in this repo flipped
 * verdicts between runs on identical inputs; a trust ledger you cannot replay
 * is not evidence, it is an opinion with a timestamp.
 *
 * ## It cannot promote
 *
 * This module imports `appendShadowOutcome` and does not import `OutcomeStore`
 * at all, so there is no code path from here into `outcome-log.jsonl`. That is
 * structural, not a convention — promotion needs a measured before/after on
 * the real log, exactly as #1319 required, and until somebody has READ these
 * rows the grader has not earned the right to be evidence.
 */

import {
  type GradeOptions,
  gradeErrandOutcome,
  type ObservedErrandArtifact,
} from "./errandOutcomeGrader.js";
import {
  appendShadowOutcome,
  type ShadowSummary,
  summariseShadowLog,
} from "./outcomeShadowLog.js";

/** One artifact to grade, plus the key it joins on. */
export interface ErrandObservation extends ObservedErrandArtifact {
  /**
   * `canonicalActionRef` form (`"<tool>:<id>"`, or a URL for legacy rows).
   *
   * Required. A graded row under a key the fold could not resolve is a
   * measurement of nothing — it would sit in the shadow ledger inflating the
   * counts somebody reads before deciding to promote.
   */
  ref: string;
  /** The recipe that filed it, for attribution during review. */
  recipe?: string;
}

export interface IngestResult {
  /** Observations accepted and written. */
  graded: number;
  /** Rejected before grading, with why. Never silently dropped. */
  skipped: { ref?: string; reason: "missing-ref" | "duplicate-ref" }[];
  /** Per-disposition counts for THIS batch (not the whole ledger). */
  batch: { confirmed: number; junk: number; unknown: number };
  /** The whole ledger after the write — what a reviewer actually acts on. */
  ledger: ShadowSummary;
}

export interface IngestOptions extends GradeOptions {
  /** Shadow-ledger directory override. Tests pass a temp dir. */
  dir?: string;
}

/**
 * Grade every observation and append a shadow row per accepted one.
 *
 * Duplicate refs within a batch are skipped rather than written twice: the
 * ledger is append-only and the summary counts rows, so a batch that repeated
 * a ref would overstate the evidence available. Duplicates ACROSS batches are
 * deliberately not deduped — successive observations of the same artifact over
 * time are the point, and collapsing them would erase the history that shows
 * an errand going from open to completed.
 */
export function ingestErrandOutcomes(
  observations: readonly ErrandObservation[],
  opts: IngestOptions,
): IngestResult {
  const skipped: IngestResult["skipped"] = [];
  const batch = { confirmed: 0, junk: 0, unknown: 0 };
  const seen = new Set<string>();
  let graded = 0;

  for (const obs of observations) {
    const ref = typeof obs.ref === "string" ? obs.ref.trim() : "";
    if (!ref) {
      skipped.push({ reason: "missing-ref" });
      continue;
    }
    if (seen.has(ref)) {
      skipped.push({ ref, reason: "duplicate-ref" });
      continue;
    }
    seen.add(ref);

    const { disposition, reason } = gradeErrandOutcome(obs, opts);
    appendShadowOutcome(
      {
        ref,
        disposition,
        reason,
        gradedAt: opts.now,
        ...(obs.recipe ? { recipe: obs.recipe } : {}),
      },
      { dir: opts.dir },
    );
    batch[disposition]++;
    graded++;
  }

  return {
    graded,
    skipped,
    batch,
    ledger: summariseShadowLog({ dir: opts.dir }),
  };
}

/**
 * Render the ledger for a human — the "READ the shadow rows" half.
 *
 * States the promotion bar in the output rather than in a doc nobody opens
 * next to the number, because the number's whole purpose is to be weighed
 * against it.
 */
export function formatShadowSummary(s: ShadowSummary): string {
  if (s.total === 0) {
    return [
      "[butler-shadow] no graded rows yet.",
      "",
      "  Nothing has been measured, so nothing may be promoted. Run the",
      "  ingester against real errand observations first.",
    ].join("\n");
  }
  const pct = (n: number) => `${((n / s.total) * 100).toFixed(1)}%`;
  return [
    `[butler-shadow] ${s.total} graded row(s):`,
    `  confirmed  ${s.confirmed} (${pct(s.confirmed)})`,
    `  junk       ${s.junk} (${pct(s.junk)})`,
    `  unknown    ${s.unknown} (${pct(s.unknown)}) — withheld by the fold`,
    "",
    `  ${s.wouldCount} row(s) (${pct(s.wouldCount)}) would have become evidence.`,
    "",
    "  These rows moved nothing. Before promoting, check a sample against the",
    "  real errands they describe — a disposition that reads plausibly in",
    "  aggregate can still be wrong on every individual row.",
  ].join("\n");
}
