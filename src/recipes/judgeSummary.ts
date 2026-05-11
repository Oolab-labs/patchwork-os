/**
 * Judge-verdict aggregation — PR3b.
 *
 * Parallel to haltCategory.summariseHalts: walks a window of runs and
 * counts judge-step verdicts (`approve` / `request_changes` /
 * `unparseable`). Surfaces through:
 *
 *  - `/metrics` as `bridge_recipe_judgments{verdict="..."}` gauge
 *  - (later) dashboard panel + session-start digest in PR3c
 *
 * Augment-only invariant (see judgeVerdict.ts): a `request_changes`
 * verdict never appears as a HaltCategory and never causes
 * `status: "error"`. This module is the *separate* channel that makes
 * cold-eyes review visible without re-introducing gate semantics.
 */
import type { JudgeVerdict, JudgeVerdictKind } from "./judgeVerdict.js";

export interface JudgeSummary {
  /** Total step results scanned that carry a `judgeVerdict`. */
  total: number;
  /** Per-verdict counts; verdicts with zero hits are omitted. */
  byVerdict: Partial<Record<JudgeVerdictKind, number>>;
  /** Most recent 5 verdicts (with first reason) for UI surfacing. */
  recent: Array<{
    verdict: JudgeVerdictKind;
    firstReason?: string;
    runSeq: number;
    stepId: string;
  }>;
}

interface JudgeSummaryInputRun {
  seq: number;
  stepResults?: Array<{
    id: string;
    judgeVerdict?: JudgeVerdict;
  }>;
}

/**
 * Aggregate judge verdicts across a set of runs. Runs are expected to
 * be sorted newest-first so `recent` reflects the most recent
 * verdicts.
 */
export function summariseJudgments(runs: JudgeSummaryInputRun[]): JudgeSummary {
  const byVerdict: Partial<Record<JudgeVerdictKind, number>> = {};
  const recent: JudgeSummary["recent"] = [];
  let total = 0;
  for (const run of runs) {
    for (const step of run.stepResults ?? []) {
      const v = step.judgeVerdict;
      if (!v) continue;
      total++;
      byVerdict[v.verdict] = (byVerdict[v.verdict] ?? 0) + 1;
      if (recent.length < 5) {
        recent.push({
          verdict: v.verdict,
          ...(v.reasons[0] !== undefined && { firstReason: v.reasons[0] }),
          runSeq: run.seq,
          stepId: step.id,
        });
      }
    }
  }
  return { total, byVerdict, recent };
}

/**
 * Format a `JudgeSummary` as Prometheus text-exposition lines for the
 * `bridge_recipe_judgments{verdict="..."} N` gauge. Returns an empty
 * array when the summary is empty (no HELP/TYPE block so Prom scrapers
 * don't see an orphan declaration).
 */
export function judgeSummaryToPrometheus(summary: JudgeSummary): string[] {
  if (summary.total === 0) return [];
  const lines: string[] = [
    "# HELP bridge_recipe_judgments Recipe judge-step verdicts in the in-memory run-log window, by verdict",
    "# TYPE bridge_recipe_judgments gauge",
  ];
  for (const [verdict, count] of Object.entries(summary.byVerdict)) {
    lines.push(`bridge_recipe_judgments{verdict="${verdict}"} ${count}`);
  }
  return lines;
}
