/**
 * Butler errand outcome grader — "did the operator keep it?"
 *
 * A Butler errand's artifact is usually a task in a tracker, not a GitHub
 * issue, so `classifyIssueDisposition` (outcomeStore.ts) does not apply. This
 * is its sibling for artifacts whose only honest signal is what the operator
 * subsequently did with the thing.
 *
 * ## The model
 *
 *   completed        → confirmed   the operator acted on it. Real positive.
 *   deleted          → junk        the operator threw it away. Real negative.
 *   open + stale     → junk        left untouched past the staleness horizon.
 *   open + recent    → WITHHELD    no signal yet. Not evidence in EITHER
 *                                  direction.
 *
 * ## Why "open + recent" must withhold rather than pass
 *
 * This is the single load-bearing rule, and it is the one a reasonable person
 * gets wrong. An errand that nobody has deleted looks like a success and is
 * not one: the operator may simply not have looked. Folding it as good is
 * trust-by-neglect, the exact defect closed three times already in this
 * subsystem (#1064, #1318/#1319, #1320, #1322) — each time by making absence
 * of a negative stop counting as a positive.
 *
 * So the grader has no "default to good" branch at all. Every path that is not
 * a POSITIVE ACT by the operator returns `unknown`, which the fold withholds.
 *
 * ## Why stale → junk rather than unknown
 *
 * Asymmetric on purpose. `unknown` is the right answer while the operator
 * might still act; it is the wrong answer once enough time has passed that
 * not-acting IS the answer. Leaving it `unknown` forever would let a worker
 * that files things nobody ever touches sit permanently un-judged instead of
 * accumulating the negative it has earned. The horizon is explicit and long
 * (default 14 days) precisely because it converts silence into a negative.
 *
 * ## No model in the loop
 *
 * Pure function of observed state and two timestamps. A prior LLM judge in
 * this repo flipped verdicts between runs on identical inputs, which makes the
 * trust ledger unreproducible — and a trust ledger you cannot replay is not
 * evidence, it is an opinion with a timestamp.
 */

import type { OutcomeDisposition } from "../workers/outcomeStore.js";

/** Default staleness horizon: 14 days. */
export const DEFAULT_STALE_AFTER_MS = 14 * 24 * 60 * 60 * 1000;

/**
 * What we observed about the errand's artifact.
 *
 * Every field is optional because observation is best-effort — a connector may
 * not report deletion at all. Absent fields must never be read as a positive:
 * see `gradeErrandOutcome`'s ordering.
 */
export interface ObservedErrandArtifact {
  /** The operator marked it done. A positive act. */
  completed?: boolean;
  /**
   * The artifact is gone. A positive act in the other direction.
   *
   * Distinct from "we could not find it": a lookup failure must be reported as
   * `undefined`, never as `deleted: true`. A transient API error that reads as
   * deletion would manufacture a negative against a worker that did nothing
   * wrong.
   */
  deleted?: boolean;
  /** When the errand created the artifact. */
  createdAt?: number;
  /**
   * Was the artifact's CURRENT state actually looked up?
   *
   * This exists because `stale-unactioned → junk` is only sound when a
   * completion COULD have been seen. The rule converts silence into a
   * negative, and silence is only evidence if somebody was listening.
   *
   * An ingester that derives artifacts from the local run log knows when each
   * one was created and nothing whatever about what the operator later did
   * with it. Feeding those to the grader without this flag would mark every
   * errand older than the horizon `junk` — not because the operator ignored
   * it, but because nobody ever asked. That is the trust-by-neglect defect
   * (#1064, #1318/#1319, #1320, #1322) with its sign flipped: instead of
   * flattering a worker for unexamined actions it slanders one, which is
   * worse, because the worker cannot appeal a verdict nobody looked at.
   *
   * Absent or false ⇒ the staleness branch is skipped entirely and the result
   * is `unknown` / `not-observed`. Only an observation channel that could
   * have reported `completed: true` may set this.
   */
  stateObserved?: boolean;
}

export interface GradeOptions {
  /** Clock. Injected so grading is reproducible in replay. */
  now: number;
  /** How long "open" stays `unknown` before becoming `junk`. */
  staleAfterMs?: number;
}

export interface GradedOutcome {
  disposition: OutcomeDisposition;
  /**
   * Why, in a form a human can check against the row. Stored alongside the
   * disposition — a verdict whose reasoning is not recorded cannot be audited,
   * only believed.
   */
  reason:
    | "completed"
    | "deleted"
    | "stale-unactioned"
    | "open-recent"
    | "not-observed";
}

/**
 * Grade one observed artifact.
 *
 * Ordering is deliberate: the two POSITIVE ACTS are tested first, then
 * staleness, and everything remaining falls to `unknown`. There is no branch
 * that reaches `confirmed` without `completed === true`.
 */
export function gradeErrandOutcome(
  observed: ObservedErrandArtifact,
  opts: GradeOptions,
): GradedOutcome {
  // Deleted is checked BEFORE completed. A tracker can report both when an
  // operator completes and then clears a task, and "they threw it away" is the
  // more conservative reading of a contradictory pair — it lowers trust rather
  // than raising it on ambiguous evidence.
  if (observed.deleted === true) {
    return { disposition: "junk", reason: "deleted" };
  }
  if (observed.completed === true) {
    return { disposition: "confirmed", reason: "completed" };
  }

  // Not completed, not deleted. Everything from here is an ABSENCE, and no
  // absence may produce `confirmed`.
  if (observed.createdAt === undefined) {
    // We cannot even tell how long it has been open, so we cannot tell whether
    // silence has become meaningful. Withhold.
    return { disposition: "unknown", reason: "not-observed" };
  }

  if (observed.stateObserved !== true) {
    // We know when it was created but never checked what became of it. Age
    // alone cannot distinguish "the operator ignored it" from "nobody looked",
    // and only the first is evidence. See `stateObserved`.
    return { disposition: "unknown", reason: "not-observed" };
  }

  const staleAfter = opts.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
  const age = opts.now - observed.createdAt;
  if (age >= staleAfter) {
    return { disposition: "junk", reason: "stale-unactioned" };
  }
  return { disposition: "unknown", reason: "open-recent" };
}
