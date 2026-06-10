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
 * Module-global by design: there is one bridge process per workspace and runs
 * are identified by a process-unique RunLog seq.
 */

const activeRuns = new Map<number, AbortController>();

/**
 * Register a starting run. Returns the AbortController whose `.signal` the
 * runner threads through execution. If a controller already exists for `seq`
 * (should not happen — seqs are unique), the stale one is aborted first so it
 * can never leak.
 */
export function registerRun(seq: number): AbortController {
  const existing = activeRuns.get(seq);
  if (existing && !existing.signal.aborted) existing.abort();
  const controller = new AbortController();
  activeRuns.set(seq, controller);
  return controller;
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
  const controller = activeRuns.get(seq);
  if (!controller) return false;
  if (!controller.signal.aborted) controller.abort(reason);
  return true;
}

/** Remove a run from the registry. Call in a `finally` when the run ends. */
export function unregisterRun(seq: number): void {
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
