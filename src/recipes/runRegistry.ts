/**
 * In-flight recipe-run registry — enables cancelling a running recipe by seq.
 *
 * A run registers an AbortController when it starts (keyed by its RunLog seq)
 * and unregisters when it finishes. `POST /runs/:seq/cancel` looks the seq up
 * and aborts the controller; the runner threads `controller.signal` into its
 * step loop (cancel between steps) and into `executeAgent` (abort the in-flight
 * LLM call). Cancellation is cooperative: a step already mid-execution finishes
 * unless its executor honors the signal (agents do; most tools don't yet).
 *
 * Module-global by design, one registry per process. A RunLog seq is unique
 * within a process but NOT across the bridges that share one run log, so
 * entries also carry the run's `taskId`, and a cancel can be pinned to it.
 */

interface ActiveRun {
  controller: AbortController;
  /** The run's `taskId` — its real identity. `seq` is only unique per process. */
  taskId?: string;
}

const activeRuns = new Map<number, ActiveRun>();

/**
 * Register a starting run. Returns the AbortController whose `.signal` the
 * runner threads through execution. If a controller already exists for `seq`
 * (should not happen within one process — its RunLog counter only rises),
 * the stale one is aborted first so it can never leak.
 */
export function registerRun(seq: number, taskId?: string): AbortController {
  const existing = activeRuns.get(seq);
  if (existing && !existing.controller.signal.aborted) {
    existing.controller.abort();
  }
  const controller = new AbortController();
  activeRuns.set(seq, { controller, ...(taskId !== undefined && { taskId }) });
  return controller;
}

export type CancelOutcome = "cancelled" | "not_found" | "task_mismatch";

/**
 * Cancel a running recipe by seq, optionally pinned to its `taskId`.
 *
 * `seq` is NOT unique across bridges sharing one run log, so a caller that
 * knows which run it means passes `taskId`: the run registered here under
 * that seq is aborted only when it IS that run (`task_mismatch` otherwise).
 * `not_found` when nothing is registered under the seq in this process.
 */
export function cancelRunChecked(
  seq: number,
  opts: { taskId?: string; reason?: string } = {},
): CancelOutcome {
  const entry = activeRuns.get(seq);
  if (!entry) return "not_found";
  if (opts.taskId !== undefined && entry.taskId !== opts.taskId) {
    return "task_mismatch";
  }
  if (!entry.controller.signal.aborted) {
    entry.controller.abort(opts.reason ?? "run cancelled by user");
  }
  return "cancelled";
}

/**
 * Cancel a running recipe by seq. Returns true if a live run was found and
 * aborted, false if the seq is unknown (already finished, never existed, or
 * ran on a different process). `reason` is surfaced via `signal.reason`.
 */
export function cancelRun(
  seq: number,
  reason = "run cancelled by user",
): boolean {
  return cancelRunChecked(seq, { reason }) === "cancelled";
}

/**
 * Remove a run from the registry. Call in a `finally` when the run ends.
 * With `taskId`, removes the entry only if it is still that run's.
 */
export function unregisterRun(seq: number, taskId?: string): void {
  const entry = activeRuns.get(seq);
  if (!entry) return;
  if (taskId !== undefined && entry.taskId !== taskId) return;
  activeRuns.delete(seq);
}

/** True if a run with this seq is currently registered (in flight). */
export function isRunActive(seq: number): boolean {
  return activeRuns.has(seq);
}

/** Number of in-flight registered runs (observability / tests). */
export function activeRunCount(): number {
  return activeRuns.size;
}
