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
  firstSeenByRef,
  SHADOW_REASONS,
  type ShadowOutcomeRow,
  type ShadowSummary,
  summariseShadowLog,
  UNOBSERVED_REASONS,
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
  // When each ref came under observation, read from the ledger. An errand
  // first seen in THIS run has been watched for zero time, so the staleness
  // rule cannot yet convert its silence into a negative — the operator was
  // never asked. See `watchedSince` in errandOutcomeGrader.
  const firstSeen = firstSeenByRef({ dir: opts.dir });
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

    const { disposition, reason } = gradeErrandOutcome(
      {
        ...obs,
        watchedSince: obs.watchedSince ?? firstSeen.get(ref) ?? opts.now,
      },
      opts,
    );
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
/**
 * Render the individual graded rows for review.
 *
 * `formatShadowSummary` ends by telling the operator to check a sample against
 * the real errands before promoting. Until this existed there was no way to do
 * that: `butler shadow` printed the aggregate, `--json` printed the same
 * aggregate, and the only caller of `readShadowRows` in the tree was
 * `promoteShadowOutcomes` — the irreversible step. The single piece of code
 * that read the rows was the one that acts on them.
 *
 * That is worth more than a missing flag because promotion is ONE-WAY: trust
 * replay absorbs a folded row into a checkpoint that deleting the row does not
 * undo. "Review before promoting" is the entire safety property of the shadow
 * phase, and it was advice with no surface behind it.
 *
 * Rows that WOULD become evidence are printed first, because those are the only
 * ones promotion acts on — sorting them under a wall of withheld `unknown` rows
 * (8 of 9 on the real ledger when this was written) buries the decision.
 *
 * ## Output is operator data
 *
 * Same rule as `runstore compare` and `privacy receipts`: rows name real
 * installed recipes and carry external record ids for the operator's own
 * errands. Quote a measurement; never paste the rows.
 */
export function formatShadowRows(
  rows: readonly ShadowOutcomeRow[],
  opts: { limit?: number } = {},
): string {
  if (rows.length === 0) {
    return [
      "[butler-shadow] no graded rows to review.",
      "",
      "  Nothing has been measured, so there is nothing to check and nothing",
      "  may be promoted.",
    ].join("\n");
  }

  // Evidence-bearing rows first, then most recently graded. Within the two
  // groups the order is the ledger's own, so a reviewer can find a row again.
  const ordered = [...rows].sort((a, b) => {
    if (a.wouldCountAsEvidence !== b.wouldCountAsEvidence) {
      return a.wouldCountAsEvidence ? -1 : 1;
    }
    return a.gradedAt - b.gradedAt;
  });

  const limit = opts.limit ?? ordered.length;
  const shown = ordered.slice(0, Math.max(0, limit));
  const hidden = ordered.length - shown.length;
  const evidence = rows.filter((r) => r.wouldCountAsEvidence).length;

  const lines = shown.map((r) => {
    const when = new Date(r.gradedAt).toISOString().replace(".000Z", "Z");
    // In words, not by colour or position alone — a reviewer piping this to a
    // file must still be able to tell the two apart.
    const mark = r.wouldCountAsEvidence
      ? "would become evidence"
      : "withheld            ";
    // `recipe` is optional. No placeholder that reads like a name: attributing
    // an errand to something that did not file it is worse than saying nothing.
    const who = r.recipe ? ` recipe=${r.recipe}` : "";
    return `  ${when}  ${mark}  ${r.disposition.padEnd(9)} ${r.reason.padEnd(18)} ${r.ref}${who}`;
  });

  return [
    `[butler-shadow] ${rows.length} graded row(s); ${evidence} would become evidence.`,
    "",
    ...lines,
    ...(hidden > 0
      ? [
          "",
          `  ${hidden} more row(s) not shown — raise --rows to see them. A sample`,
          "  that looks representative because it was truncated is not one.",
        ]
      : []),
    "",
    "  These rows are OPERATOR DATA, not a diagnostic blob: they name real",
    "  installed recipes and carry external record ids. Quote a measurement if",
    "  you need to; never paste the rows into an issue, a PR or a fixture.",
  ].join("\n");
}

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

  // Split the `unknown` bucket by what it actually means. "Still in flight" and
  // "could not be observed" are both withheld by the fold, and they call for
  // opposite responses — wait, versus go and fix the observation path. Reporting
  // one number for both leaves an operator unable to tell a healthy young ledger
  // from a channel that is seeing nothing.
  const unobserved = UNOBSERVED_REASONS.reduce(
    (n, r) => n + (s.byReason[r] ?? 0),
    0,
  );
  const inFlight = s.unknown - unobserved;

  const reasonLines = SHADOW_REASONS.filter((r) => (s.byReason[r] ?? 0) > 0)
    .sort((a, b) => (s.byReason[b] ?? 0) - (s.byReason[a] ?? 0))
    .map((r) => `    ${r.padEnd(18)}${s.byReason[r]} (${pct(s.byReason[r])})`);

  const unattributed =
    s.total - SHADOW_REASONS.reduce((n, r) => n + (s.byReason[r] ?? 0), 0);

  return [
    `[butler-shadow] ${s.total} graded row(s):`,
    `  confirmed  ${s.confirmed} (${pct(s.confirmed)})`,
    `  junk       ${s.junk} (${pct(s.junk)})`,
    `  unknown    ${s.unknown} (${pct(s.unknown)}) — withheld by the fold`,
    ...(s.unknown > 0
      ? [
          `    of which ${inFlight} still in flight, ${unobserved} could not be observed`,
        ]
      : []),
    "",
    "  by reason",
    ...(reasonLines.length > 0 ? reasonLines : ["    (none recorded)"]),
    ...(unattributed > 0
      ? [`    (${unattributed} row(s) carry an unrecognised reason)`]
      : []),
    "",
    `  ${s.wouldCount} row(s) (${pct(s.wouldCount)}) would have become evidence.`,
    "",
    ...(unobserved > 0
      ? [
          `  ${unobserved} row(s) were never observed at all. That is a broken or`,
          "  unauthorised observation path, not a verdict about the errand — fix it",
          "  before reading anything into the proportions above.",
          "",
        ]
      : []),
    "  These rows moved nothing. Before promoting, check a sample against the",
    "  real errands they describe — a disposition that reads plausibly in",
    "  aggregate can still be wrong on every individual row.",
  ].join("\n");
}
