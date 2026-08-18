/**
 * Privacy shadow ledger (ADR-0021).
 *
 * Answers "how often would the policy I am considering have stopped something?"
 * WITHOUT enforcing it — the only part of the information-boundary design that
 * produces evidence an operator can act on before adopting anything.
 *
 * ## Why this is observed live and not replayed
 *
 * `workers shadow` and the Butler outcome grader both replay `runs.jsonl`,
 * and the obvious move was to copy them. It does not work here: a run-log
 * `agent` step persists only
 *
 *     durationMs, error, haltCategory, haltReason, id,
 *     inputTokens, judgeVerdict, outputTokens, status, tool
 *
 * — no `data_policy`, no driver, no destination. Those two replay a log that
 * contains their inputs; this one's inputs are never written down. A replay
 * tool would have to invent the classification and the destination, and a
 * privacy report built on invented inputs is worse than no report, because it
 * reads as measurement.
 *
 * So observation happens at the decision point, and this file is only the
 * ledger and its summariser.
 *
 * ## What is deliberately not here
 *
 * No payload field, for the same reason `boundary_receipts.jsonl` has none: a
 * privacy audit log containing the prompts would be the largest unclassified
 * copy of exactly the material the boundary exists to protect. Only declared
 * metadata — classification, category NAMES, destination, decision, reason.
 *
 * Separate file from `boundary_receipts.jsonl`, and nothing in the live system
 * reads it. A shadow row is a hypothetical about a policy that is not in force;
 * mixing it into the receipts would put unenforced decisions into the evidence
 * trail that is supposed to record what actually happened.
 */
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { patchworkPath } from "../patchworkHome.js";
import type { BoundaryDecision, Classification } from "./dataPolicy.js";

export const SHADOW_LOG_BASENAME = "privacy_shadow.jsonl";

/** Clip so a runaway reason cannot bloat the ledger. */
const MAX_REASON = 500;

/**
 * The path the boundary DOES observe. Recorded on every row rather than
 * assumed by the reader, so a future second observed path is a data change
 * and not a silent redefinition of what the denominator counted.
 */
export const OBSERVED_PATH = "recipe agent steps";

/**
 * Paths that reach a model WITHOUT passing the decision point.
 *
 * This is not a caveat, it is part of the result. A crossing count computed
 * over a partial surface reads as "your policy is fine" when it partly means
 * "we did not look there" — and `agent` steps are ~3% of logged step volume,
 * so the unobserved remainder is the larger part of the system.
 *
 * Kept in step with `src/__tests__/boundaryScope.test.ts`, which pins the
 * orchestrator gap to the code.
 */
export const UNOBSERVED_PATHS = [
  "orchestrator task dispatch (runClaudeTask, automation hooks) — ADR-0021 scope, #1397",
] as const;

export interface PrivacyShadowRow {
  at: number;
  decision: BoundaryDecision;
  classification: Classification;
  /** Category NAMES only — never their contents. */
  categories?: string[];
  destinationId: string;
  destinationType: "local" | "remote";
  redactCategories?: string[];
  reason: string;
  recipeName?: string;
  stepId?: string;
  /**
   * Whether an ENFORCING policy was also in force for this dispatch.
   *
   * A shadow row on a machine that already enforces means something different
   * from one on a machine that does not, and the summary must not merge them:
   * the first is "my live policy and my candidate policy disagree", the second
   * is "here is what a policy would have done".
   */
  enforcing: boolean;
}

export interface ShadowLogOptions {
  /** Defaults to `${PATCHWORK_HOME}`. */
  dir?: string;
  now?: () => number;
}

export function shadowLogPath(dir?: string): string {
  return dir
    ? path.join(dir, SHADOW_LOG_BASENAME)
    : patchworkPath(SHADOW_LOG_BASENAME);
}

/**
 * Append one observation. NEVER throws.
 *
 * This runs inside the enforcement chokepoint, so a failure here must be
 * incapable of disturbing a dispatch. An unwritable shadow ledger is a lost
 * measurement; a shadow ledger that can abort a step is a privacy feature that
 * breaks the system it observes.
 */
export function recordPrivacyShadow(
  row: Omit<PrivacyShadowRow, "at">,
  opts: ShadowLogOptions = {},
): void {
  try {
    const file = shadowLogPath(opts.dir);
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const full: PrivacyShadowRow = {
      at: (opts.now ?? Date.now)(),
      ...row,
      reason: row.reason.slice(0, MAX_REASON),
    };
    appendFileSync(file, `${JSON.stringify(full)}\n`);
  } catch {
    // Observation only — never disturb the dispatch being observed.
  }
}

export interface PrivacyShadowSummary {
  /** The denominator. Every observed dispatch, INCLUDING allowed ones. */
  observed: number;
  /** Non-ALLOW observations — what a candidate policy would have acted on. */
  crossings: number;
  byDecision: Record<string, number>;
  /** Destination id → count, for "where would it have gone". */
  byDestination: Record<string, number>;
  earliest?: number;
  latest?: number;
  /** How many observations happened while a live policy was also enforcing. */
  enforcingObservations: number;
  observedPath: string;
  unobservedPaths: readonly string[];
}

export interface SummariseOptions extends ShadowLogOptions {
  /** Only count rows at or after this timestamp. */
  since?: number;
}

export function summarisePrivacyShadow(
  opts: SummariseOptions = {},
): PrivacyShadowSummary {
  const summary: PrivacyShadowSummary = {
    observed: 0,
    crossings: 0,
    byDecision: {},
    byDestination: {},
    enforcingObservations: 0,
    observedPath: OBSERVED_PATH,
    unobservedPaths: UNOBSERVED_PATHS,
  };
  let text: string;
  try {
    text = readFileSync(shadowLogPath(opts.dir), "utf-8");
  } catch {
    // No ledger yet. Reported as observed=0, which the formatter renders as
    // "nothing observed" rather than "no crossings" — see formatPrivacyShadow.
    return summary;
  }
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    let row: PrivacyShadowRow;
    try {
      row = JSON.parse(t) as PrivacyShadowRow;
    } catch {
      continue;
    }
    if (typeof row.at !== "number" || typeof row.decision !== "string")
      continue;
    if (opts.since !== undefined && row.at < opts.since) continue;
    summary.observed += 1;
    if (row.decision !== "ALLOW") summary.crossings += 1;
    if (row.enforcing) summary.enforcingObservations += 1;
    summary.byDecision[row.decision] =
      (summary.byDecision[row.decision] ?? 0) + 1;
    if (row.destinationId) {
      summary.byDestination[row.destinationId] =
        (summary.byDestination[row.destinationId] ?? 0) + 1;
    }
    if (summary.earliest === undefined || row.at < summary.earliest) {
      summary.earliest = row.at;
    }
    if (summary.latest === undefined || row.at > summary.latest) {
      summary.latest = row.at;
    }
  }
  return summary;
}

/**
 * Render coverage FIRST, and never a bare crossing count.
 *
 * "3 crossings last week" invites exactly one reading — that the other
 * dispatches were fine — and on this surface that reading is wrong twice over:
 * `agent` steps are a small minority of step volume, and orchestrator dispatch
 * is not observed at all. The denominator and the blind spots are therefore
 * part of the finding, not a footnote under it.
 */
export function formatPrivacyShadow(s: PrivacyShadowSummary): string {
  const L: string[] = [];
  L.push("[privacy-shadow] coverage");
  L.push(`  observed:   ${s.observed} dispatch(es) on ${s.observedPath}`);
  for (const p of s.unobservedPaths) L.push(`  NOT observed: ${p}`);

  if (s.observed === 0) {
    // Deliberately NOT "0 crossings" — that asserts a clean result from an
    // empty ledger. Nothing was measured, which is a different statement.
    L.push("");
    L.push("  Nothing has been observed yet, so there is no result to report.");
    L.push(
      "  Configure `privacy.shadow.destinations` and run a recipe with an",
    );
    L.push("  agent step; every dispatch is then recorded, allowed or not.");
    return L.join("\n");
  }

  const span =
    s.earliest !== undefined && s.latest !== undefined
      ? `${new Date(s.earliest).toISOString()} → ${new Date(s.latest).toISOString()}`
      : "(unknown)";
  L.push(`  window:     ${span}`);
  if (s.enforcingObservations > 0) {
    L.push(
      `  note:       ${s.enforcingObservations} observed while a live policy was ALSO enforcing`,
    );
  }
  L.push("");
  const pct = ((s.crossings / s.observed) * 100).toFixed(1);
  L.push(
    `[privacy-shadow] ${s.crossings} of ${s.observed} observed dispatch(es) (${pct}%) would have been stopped or altered`,
  );
  for (const [d, n] of Object.entries(s.byDecision).sort(
    (a, b) => b[1] - a[1],
  )) {
    L.push(`  ${d.padEnd(18)} ${n}`);
  }
  if (Object.keys(s.byDestination).length > 0) {
    L.push("");
    L.push("  destinations:");
    for (const [d, n] of Object.entries(s.byDestination).sort(
      (a, b) => b[1] - a[1],
    )) {
      L.push(`    ${d.padEnd(16)} ${n}`);
    }
  }
  L.push("");
  L.push(
    "  Shadow only — nothing was blocked, and no live policy changed. These are",
  );
  L.push(
    "  hypotheticals about the candidate policy in `privacy.shadow`, over the",
  );
  L.push("  observed path only.");
  return L.join("\n");
}
