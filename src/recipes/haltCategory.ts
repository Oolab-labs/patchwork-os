/**
 * Halt-category derivation.
 *
 * PR1c of the Val-inspired plan. PR1 attached a `haltReason` sentence to
 * every error-status StepResult; this module categorises those sentences
 * into a small bounded enum so the dashboard / metrics layer can count
 * them over time. Foundation for "is the haltReason work actually
 * surfacing useful signal, or is everything landing in `unknown`?"
 *
 * The mapping is intentionally pattern-based against the 5 phrases
 * emitted by yamlRunner.ts. Keep this file and those phrases in sync.
 * When a new error site is added, add a category here AND a test.
 */

export type HaltCategory =
  | "agent_silent_fail"
  | "agent_narration_only"
  | "agent_threw"
  | "tool_threw"
  | "tool_error"
  /** Whole-recipe failure (e.g. circular dependencies) — has no step row. */
  | "run_level"
  | "unknown";

export function categoriseHaltReason(reason: string | undefined): HaltCategory {
  if (!reason) return "unknown";
  // Order matters: more specific phrases (silent-fail, narration) must
  // match before the general "Agent step ... threw" / "Tool ... threw"
  // patterns. The phrases below mirror yamlRunner.ts:558-606,677-684,693-708.
  if (/silent-fail/i.test(reason)) return "agent_silent_fail";
  if (/narration|whitespace|no content/i.test(reason))
    return "agent_narration_only";
  if (/^Agent step .* threw/i.test(reason)) return "agent_threw";
  if (/^Tool .* threw/i.test(reason)) return "tool_threw";
  if (/^Tool .* reported an error/i.test(reason)) return "tool_error";
  return "unknown";
}

export interface HaltSummary {
  /** Total error-status step results scanned. */
  total: number;
  /** Per-category counts; categories with zero hits are omitted. */
  byCategory: Partial<Record<HaltCategory, number>>;
  /** Most recent 5 halt reasons (verbatim) for surfacing in the UI. */
  recent: Array<{ reason: string; category: HaltCategory; runSeq: number }>;
}

interface HaltSummaryInputRun {
  seq: number;
  /** Top-level run status — `run_level` halts are runs with status === "error" but no error stepResults (e.g. circular-dep failure before any step ran). */
  status?: "running" | "done" | "error" | "cancelled" | "interrupted";
  /** Top-level errorMessage — surfaced as a `run_level` halt when no per-step halts cover it. */
  errorMessage?: string;
  stepResults?: Array<{
    status: "ok" | "skipped" | "error";
    haltReason?: string;
  }>;
}

/**
 * Aggregate halt categories across a set of runs. Runs are expected to be
 * sorted newest-first so `recent` reflects the most recent halts.
 *
 * A run contributes:
 * - one entry per error-status stepResult that has a `haltReason`
 * - plus one `run_level` entry if `status === "error"` and there were no
 *   per-step halts that already explained it (avoids double-counting).
 */
export function summariseHalts(runs: HaltSummaryInputRun[]): HaltSummary {
  const byCategory: Partial<Record<HaltCategory, number>> = {};
  const recent: HaltSummary["recent"] = [];
  let total = 0;
  for (const run of runs) {
    let stepHaltsForRun = 0;
    for (const step of run.stepResults ?? []) {
      if (step.status !== "error" || !step.haltReason) continue;
      stepHaltsForRun++;
      total++;
      const cat = categoriseHaltReason(step.haltReason);
      byCategory[cat] = (byCategory[cat] ?? 0) + 1;
      if (recent.length < 5) {
        recent.push({
          reason: step.haltReason,
          category: cat,
          runSeq: run.seq,
        });
      }
    }
    if (stepHaltsForRun === 0 && run.status === "error" && run.errorMessage) {
      total++;
      byCategory.run_level = (byCategory.run_level ?? 0) + 1;
      if (recent.length < 5) {
        recent.push({
          reason: run.errorMessage,
          category: "run_level",
          runSeq: run.seq,
        });
      }
    }
  }
  return { total, byCategory, recent };
}

/**
 * Derive a one-sentence haltReason from a step's error-status + raw error
 * string. Used by `chainedRunner` to mirror the convention emitted by
 * `yamlRunner`. Returns `undefined` for non-error rows or missing error.
 *
 * Pattern-matches the same phrases `categoriseHaltReason` knows about,
 * so chained-run haltReasons categorise into the same buckets.
 */
export function deriveHaltReasonFromError(opts: {
  stepId: string;
  toolName?: string;
  isAgent?: boolean;
  status: "ok" | "skipped" | "error";
  error?: string;
}): string | undefined {
  if (opts.status !== "error" || !opts.error) return undefined;
  if (/silent-fail/i.test(opts.error)) {
    return `Step "${opts.stepId}" returned no usable output (silent-fail).`;
  }
  if (/narration|whitespace|no content/i.test(opts.error)) {
    return `Step "${opts.stepId}" returned only narration or whitespace — no content.`;
  }
  if (opts.isAgent) {
    return `Agent step "${opts.stepId}" threw before completing: ${opts.error}`;
  }
  return `Tool "${opts.toolName ?? "?"}" in step "${opts.stepId}" reported an error: ${opts.error}`;
}
