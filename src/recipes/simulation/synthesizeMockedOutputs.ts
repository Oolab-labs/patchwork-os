/**
 * What-If Preview (P2) — synthesize a `mockedOutputs` map from run history.
 *
 * For a chained recipe with prior runs, walk the most recent N runs (newest
 * first) and, for each step id, take the MOST RECENT non-truncated,
 * non-skipped, defined `output`. The result is the `mockedOutputs` map the
 * mocked sandbox feeds into the chained runner so downstream templates and
 * `when:` conditions resolve against real historical values.
 *
 * Pure except for the single `runLog.query(...)` read. The skip rules mirror
 * `buildMockedOutputs` (replayRun.ts): skip `status:"skipped"`, skip
 * `output === undefined`, skip the `{"[truncated]": true}` capture envelope.
 */

import type { RecipeRunLog } from "../../runLog.js";

const DEFAULT_MAX_RUNS = 20;

/** True when `out` is the VD-2 truncation envelope (`{"[truncated]": true}`). */
function isTruncated(out: unknown): boolean {
  return (
    out !== null &&
    typeof out === "object" &&
    (out as Record<string, unknown>)["[truncated]"] === true
  );
}

export interface SynthesizedMockedOutputs {
  /** stepId → most-recent usable historical output. */
  outputs: Map<string, unknown>;
  /** Step ids that received a real historical value. */
  historyStepIds: Set<string>;
  /** Number of prior runs actually sampled. */
  sampleRuns: number;
}

/**
 * Build a history-backed `mockedOutputs` map for `recipeName`.
 *
 * `runLog.query` returns newest-first, so the FIRST usable output we see for a
 * given step id is the most recent — we never overwrite it with an older run.
 */
export function synthesizeMockedOutputs(
  recipeName: string,
  runLog: RecipeRunLog,
  opts: { maxRuns?: number } = {},
): SynthesizedMockedOutputs {
  const maxRuns = opts.maxRuns ?? DEFAULT_MAX_RUNS;
  const runs = runLog.query({ recipe: recipeName, limit: maxRuns });

  const outputs = new Map<string, unknown>();
  const historyStepIds = new Set<string>();

  // runs are newest-first; first usable value per id wins (most recent).
  for (const run of runs) {
    for (const step of run.stepResults ?? []) {
      if (historyStepIds.has(step.id)) continue;
      if (step.status === "skipped") continue;
      const out = step.output;
      if (out === undefined) continue;
      if (isTruncated(out)) continue;
      outputs.set(step.id, out);
      historyStepIds.add(step.id);
    }
  }

  return { outputs, historyStepIds, sampleRuns: runs.length };
}
