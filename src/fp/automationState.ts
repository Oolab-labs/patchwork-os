/**
 * Pure value type + transition functions for AutomationHooks state.
 *
 * The mutable fields of AutomationHooks that govern cooldowns, active-task
 * tracking, and per-runner test outcomes are extracted here as an immutable
 * record.  AutomationHooks holds a single `private state: AutomationState`
 * and delegates the pure logic to these functions.
 *
 * All functions are pure (no side-effects, no I/O, no mutation of the input
 * state).  They return new AutomationState values.
 */

export interface AutomationState {
  /** Last trigger time (ms since epoch) per trigger key. */
  readonly lastTrigger: ReadonlyMap<string, number>;
  /**
   * Active task IDs per hook key.
   * Key: a hook-specific string (e.g. "diagnostics:/path/to/file",
   * "gitCommit", "save:/path/to/file").
   * Value: the Claude task ID that was spawned for this key.
   */
  readonly activeTasks: ReadonlyMap<string, string>;
  /**
   * Previous error counts per file (used by onDiagnosticsError /
   * onDiagnosticsCleared to detect transitions).
   */
  readonly prevDiagnosticErrors: ReadonlyMap<string, number>;
  /**
   * Last test outcome per runner (used by onTestPassAfterFailure to detect
   * fail→pass transitions).
   */
  readonly lastTestOutcomeByRunner: ReadonlyMap<string, "pass" | "fail">;
  /**
   * Rolling window of task enqueue timestamps (ms since epoch).
   * Used for maxTasksPerHour rate-limiting.
   */
  readonly taskTimestamps: readonly number[];
  /**
   * Per-content-signature dedup timestamps (keyed: `dedup:${hookKey}:${sig}`).
   * Bounded at 5_000 entries — same eviction as lastTrigger.
   */
  readonly deduplicationWindow: ReadonlyMap<string, number>;
  /**
   * Pending retry records for WithRetry nodes.
   * Key = `${hookType}:${primaryValue}`.
   */
  readonly pendingRetries: ReadonlyMap<
    string,
    { attempt: number; nextRetryAt: number; taskId: string }
  >;
  /**
   * Cached diagnostics per file for evaluateWhen condition checks.
   */
  readonly latestDiagnosticsByFile: ReadonlyMap<
    string,
    { severity: number; count: number }
  >;
  /**
   * Last known test runner outcome (pass/fail) for evaluateWhen checks.
   */
  readonly lastTestRunnerStatusByRunner: ReadonlyMap<string, "pass" | "fail">;
}

export const EMPTY_AUTOMATION_STATE: AutomationState = {
  lastTrigger: new Map(),
  activeTasks: new Map(),
  prevDiagnosticErrors: new Map(),
  lastTestOutcomeByRunner: new Map(),
  taskTimestamps: [],
  deduplicationWindow: new Map(),
  pendingRetries: new Map(),
  latestDiagnosticsByFile: new Map(),
  lastTestRunnerStatusByRunner: new Map(),
};

// ── Cooldown helpers ──────────────────────────────────────────────────────────

/**
 * Returns true if `key` is still within its cooldown window.
 * Pure — does not mutate `state`.
 */
export function isOnCooldown(
  state: AutomationState,
  key: string,
  now: number,
  cooldownMs: number,
): boolean {
  const last = state.lastTrigger.get(key);
  if (last === undefined) return false;
  return now - last < cooldownMs;
}

// ── Trigger recording ─────────────────────────────────────────────────────────

/**
 * Return a new AutomationState where `key` has been marked as triggered at
 * `now` and the associated `taskId` recorded as the active task for `key`.
 *
 * The `taskTimestamps` array is grown by one entry (capped at 10 000 entries
 * matching the cap in AutomationHooks).
 */
export function recordTrigger(
  state: AutomationState,
  key: string,
  taskId: string,
  now: number,
): AutomationState {
  const MAX_TASK_TIMESTAMPS = 10_000;
  const newLastTrigger = new Map(state.lastTrigger);
  newLastTrigger.set(key, now);

  const newActiveTasks = new Map(state.activeTasks);
  newActiveTasks.set(key, taskId);

  const rawTimestamps = [...state.taskTimestamps, now];
  const newTaskTimestamps =
    rawTimestamps.length > MAX_TASK_TIMESTAMPS
      ? rawTimestamps.slice(rawTimestamps.length - MAX_TASK_TIMESTAMPS)
      : rawTimestamps;

  return {
    ...state,
    lastTrigger: newLastTrigger,
    activeTasks: newActiveTasks,
    taskTimestamps: newTaskTimestamps,
  };
}

// ── Active-task helpers ───────────────────────────────────────────────────────

/**
 * Returns true if there is currently an active task for `key`.
 * Pure — does not mutate `state`.
 */
export function isTaskActive(state: AutomationState, key: string): boolean {
  return state.activeTasks.has(key);
}

/**
 * Return a new AutomationState where the active task for `key` has been
 * cleared (e.g. after the task completes or is cancelled).
 */
export function clearActiveTask(
  state: AutomationState,
  key: string,
): AutomationState {
  const newActiveTasks = new Map(state.activeTasks);
  newActiveTasks.delete(key);
  return { ...state, activeTasks: newActiveTasks };
}

// ── Diagnostic error count helpers ────────────────────────────────────────────

/**
 * Return a new AutomationState with the previous error count for `file`
 * updated to `count`.
 */
export function setPrevDiagnosticErrors(
  state: AutomationState,
  file: string,
  count: number,
): AutomationState {
  const newMap = new Map(state.prevDiagnosticErrors);
  newMap.set(file, count);
  return { ...state, prevDiagnosticErrors: newMap };
}

// ── Test-outcome helpers ──────────────────────────────────────────────────────

/**
 * Return a new AutomationState with the last test outcome for `runner`
 * updated to `outcome`.
 */
export function setLastTestOutcome(
  state: AutomationState,
  runner: string,
  outcome: "pass" | "fail",
): AutomationState {
  const newMap = new Map(state.lastTestOutcomeByRunner);
  newMap.set(runner, outcome);
  return { ...state, lastTestOutcomeByRunner: newMap };
}

// ── Rate-limit helper ─────────────────────────────────────────────────────────

/**
 * Count tasks enqueued within the last hour.
 * Pure — does not mutate `state`.
 */
export function tasksInLastHour(state: AutomationState, now: number): number {
  const cutoff = now - 3_600_000;
  return state.taskTimestamps.filter((t) => t > cutoff).length;
}

// ── Deduplication helpers ─────────────────────────────────────────────────────

const DEDUP_MAX_SIZE = 5_000;

/**
 * Record a dedup timestamp for `key` at `now`.
 * Evicts oldest entry when size exceeds DEDUP_MAX_SIZE.
 */
export function recordDedup(
  state: AutomationState,
  key: string,
  now: number,
): AutomationState {
  const newMap = new Map(state.deduplicationWindow);
  newMap.set(key, now);
  if (newMap.size > DEDUP_MAX_SIZE) {
    // Evict oldest by insertion order (Map preserves insertion order)
    const firstKey = newMap.keys().next().value as string;
    newMap.delete(firstKey);
  }
  return { ...state, deduplicationWindow: newMap };
}

/**
 * Returns true if `key` was recorded within `cooldownMs` of `now`.
 * Pure — does not mutate `state`.
 */
export function isDeduped(
  state: AutomationState,
  key: string,
  now: number,
  cooldownMs: number,
): boolean {
  const last = state.deduplicationWindow.get(key);
  if (last === undefined) return false;
  return now - last < cooldownMs;
}

// ── Pending retry helpers ─────────────────────────────────────────────────────

/**
 * Record or update a pending retry for `key`.
 */
export function recordPendingRetry(
  state: AutomationState,
  key: string,
  attempt: number,
  nextRetryAt: number,
  taskId: string,
): AutomationState {
  const newMap = new Map(state.pendingRetries);
  newMap.set(key, { attempt, nextRetryAt, taskId });
  return { ...state, pendingRetries: newMap };
}

/**
 * Remove the pending retry record for `key`.
 */
export function clearPendingRetry(
  state: AutomationState,
  key: string,
): AutomationState {
  const newMap = new Map(state.pendingRetries);
  newMap.delete(key);
  return { ...state, pendingRetries: newMap };
}

// ── Diagnostics-by-file helpers ───────────────────────────────────────────────

const DIAGNOSTICS_FILE_MAX_SIZE = 5_000;

/**
 * Update the cached diagnostics for `file`.
 * Bounded at 5000 files — FIFO eviction.
 */
export function setLatestDiagnostics(
  state: AutomationState,
  file: string,
  severity: number,
  count: number,
): AutomationState {
  const newMap = new Map(state.latestDiagnosticsByFile);
  newMap.set(file, { severity, count });
  if (newMap.size > DIAGNOSTICS_FILE_MAX_SIZE) {
    const firstKey = newMap.keys().next().value as string;
    newMap.delete(firstKey);
  }
  return { ...state, latestDiagnosticsByFile: newMap };
}

// ── Merge helper (for Parallel node) ──────────────────────────────────────────

/**
 * Merge two AutomationStates produced by parallel branches that share the same
 * initial state. For each map, keeps the max timestamp / last value per key.
 * taskTimestamps are unioned. Used by the Parallel interpreter case so both
 * branches' cooldown / trigger records are preserved.
 */
export function mergeAutomationStates(
  a: AutomationState,
  b: AutomationState,
): AutomationState {
  const maxNumMap = (
    x: ReadonlyMap<string, number>,
    y: ReadonlyMap<string, number>,
  ): Map<string, number> => {
    const out = new Map(x);
    for (const [k, v] of y) {
      const prev = out.get(k);
      out.set(k, prev === undefined ? v : Math.max(prev, v));
    }
    return out;
  };
  const unionMap = <V>(
    x: ReadonlyMap<string, V>,
    y: ReadonlyMap<string, V>,
  ): Map<string, V> => {
    const out = new Map(x);
    for (const [k, v] of y) out.set(k, v);
    return out;
  };
  return {
    lastTrigger: maxNumMap(a.lastTrigger, b.lastTrigger),
    activeTasks: unionMap(a.activeTasks, b.activeTasks),
    prevDiagnosticErrors: unionMap(
      a.prevDiagnosticErrors,
      b.prevDiagnosticErrors,
    ),
    lastTestOutcomeByRunner: unionMap(
      a.lastTestOutcomeByRunner,
      b.lastTestOutcomeByRunner,
    ),
    taskTimestamps: [...a.taskTimestamps, ...b.taskTimestamps].slice(-10_000),
    deduplicationWindow: maxNumMap(
      a.deduplicationWindow,
      b.deduplicationWindow,
    ),
    pendingRetries: unionMap(a.pendingRetries, b.pendingRetries),
    latestDiagnosticsByFile: unionMap(
      a.latestDiagnosticsByFile,
      b.latestDiagnosticsByFile,
    ),
    lastTestRunnerStatusByRunner: unionMap(
      a.lastTestRunnerStatusByRunner,
      b.lastTestRunnerStatusByRunner,
    ),
  };
}

// ── Test runner status helpers ────────────────────────────────────────────────

/**
 * Update the last known test runner outcome for `runner`.
 */
export function setTestRunnerStatus(
  state: AutomationState,
  runner: string,
  outcome: "pass" | "fail",
): AutomationState {
  const newMap = new Map(state.lastTestRunnerStatusByRunner);
  newMap.set(runner, outcome);
  return { ...state, lastTestRunnerStatusByRunner: newMap };
}
