/**
 * Pure, page-agnostic helpers for computing per-recipe run-health metrics
 * (success rate, average duration) from a list of run records.
 *
 * Extracted from page-local closures in `recipes/page.tsx` (gallery grid,
 * `allRunsMap` bucketing) and `recipes/[...name]/page.tsx` (Dossier page,
 * single-recipe `runs` list) — both computed the identical settled/success/
 * duration logic independently. This module is the single source of truth;
 * behavior is byte-identical to both prior implementations.
 *
 * Also backs the terminal-deck's 2:fleet pane (app/page.tsx), which needs
 * the same per-recipe health computation without page component state.
 */

/** Minimal shape needed to compute run-health metrics. Both dashboard
 *  `RunRecord` types (gallery + dossier) satisfy this structurally. */
export interface RunHealthRecord {
  status: string;
  durationMs?: number;
}

const IN_FLIGHT_STATUSES = new Set(["running", "queued", "pending"]);
const SUCCESS_STATUSES = new Set(["done", "success"]);

/**
 * Success percentage (0-100) across "settled" runs (excludes running /
 * queued / pending). Returns null when there are no runs, or no settled
 * runs, to distinguish "no data" from "0% success".
 */
export function computeSuccessPct(runs: RunHealthRecord[] | undefined): number | null {
  if (!runs || runs.length === 0) return null;
  const settled = runs.filter((r) => !IN_FLIGHT_STATUSES.has(r.status));
  if (settled.length === 0) return null;
  const ok = settled.filter((r) => SUCCESS_STATUSES.has(r.status)).length;
  return (ok / settled.length) * 100;
}

/**
 * Average duration in ms across runs with a positive `durationMs`.
 * Returns undefined when there are no runs, or none have a valid duration.
 */
export function computeAvgDuration(runs: RunHealthRecord[] | undefined): number | undefined {
  if (!runs || runs.length === 0) return undefined;
  const ds = runs
    .map((r) => r.durationMs)
    .filter((d): d is number => typeof d === "number" && d > 0);
  if (ds.length === 0) return undefined;
  return ds.reduce((s, d) => s + d, 0) / ds.length;
}
