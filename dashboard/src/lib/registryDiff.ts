/**
 * registryDiff — compute what each step added/modified/removed from the
 * output registry. Driven entirely by VD-2's `registrySnapshot` capture
 * on each step.
 *
 * Outputs a small diff struct the dashboard renders in the hover panel.
 * Pure function, no I/O, no React — testable in isolation.
 */

export interface StepWithSnapshot {
  id: string;
  registrySnapshot?: Record<string, unknown>;
}

export interface RegistryDiff {
  added: Record<string, unknown>;
  modified: Array<{ key: string; before: unknown; after: unknown }>;
  removed: string[];
}

const EMPTY: RegistryDiff = { added: {}, modified: [], removed: [] };

/**
 * Diff between two snapshots. `prev` may be undefined (first step or
 * pre-VD-2 row) — every key in `current` becomes "added".
 */
export function diffSnapshots(
  prev: Record<string, unknown> | undefined,
  current: Record<string, unknown> | undefined,
): RegistryDiff {
  if (!current) return EMPTY;
  const prevKeys = new Set(prev ? Object.keys(prev) : []);
  const curKeys = new Set(Object.keys(current));

  const added: Record<string, unknown> = {};
  const modified: Array<{ key: string; before: unknown; after: unknown }> = [];
  const removed: string[] = [];

  for (const k of curKeys) {
    if (!prevKeys.has(k)) {
      added[k] = current[k];
    } else if (!deepEqual(prev?.[k], current[k])) {
      modified.push({ key: k, before: prev?.[k], after: current[k] });
    }
  }
  for (const k of prevKeys) {
    if (!curKeys.has(k)) removed.push(k);
  }

  return { added, modified, removed };
}

/**
 * Compute the diff for the step at `index` in completion order. Pulls
 * the previous step's snapshot from the array — if no prior step has a
 * snapshot, treat as initial state (everything in this step's snapshot
 * is "added").
 *
 * Returns null if the step has no `registrySnapshot` (pre-VD-2 row, or
 * runner without capture). Caller renders an "unavailable" state.
 */
export function diffForStep(
  steps: StepWithSnapshot[],
  index: number,
): RegistryDiff | null {
  const step = steps[index];
  if (!step?.registrySnapshot) return null;

  // Walk back to find the most recent prior step with a snapshot —
  // skipped/error steps may have no snapshot, so we don't blindly use
  // index - 1.
  let prev: Record<string, unknown> | undefined;
  for (let i = index - 1; i >= 0; i--) {
    const s = steps[i];
    if (s?.registrySnapshot) {
      prev = s.registrySnapshot;
      break;
    }
  }
  return diffSnapshots(prev, step.registrySnapshot);
}

/**
 * Total change count — drives the empty-state in the hover panel. A
 * "trivial" diff (just this step's own key in `added`) still counts as
 * a change so the panel renders. True empty (skipped step, no captures)
 * → 0.
 */
export function changeCount(diff: RegistryDiff): number {
  return Object.keys(diff.added).length + diff.modified.length + diff.removed.length;
}

// ── deep-equal (sufficient for JSON-like structures) ──────────────────

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return false;
  if (typeof a !== "object") return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!deepEqual(a[i], b[i])) return false;
    }
    return true;
  }
  const ao = a as Record<string, unknown>;
  const bo = b as Record<string, unknown>;
  const aKeys = Object.keys(ao);
  const bKeys = Object.keys(bo);
  if (aKeys.length !== bKeys.length) return false;
  for (const k of aKeys) {
    if (!Object.hasOwn(bo, k)) return false;
    if (!deepEqual(ao[k], bo[k])) return false;
  }
  return true;
}
