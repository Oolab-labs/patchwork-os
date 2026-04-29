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

/**
 * Step shape needed for the replay pre-flight (BUG-3 fix). Mirrors
 * what `buildMockedOutputs` looks at on the bridge side.
 */
export interface StepForReplayPreflight {
  id: string;
  status: "ok" | "skipped" | "error" | "running";
  tool?: string;
  output?: unknown;
}

/**
 * Pre-flight a mocked replay: classify each step into "mocked" (will
 * return its captured output) vs "unmocked" (will fall through to REAL
 * execution because we have no usable capture). Mirrors `buildMockedOutputs`
 * in `src/recipes/replayRun.ts` so the dashboard can show the user
 * up-front what side effects to expect, instead of warning after the
 * fact (BUG-3 from the post-merge dogfood).
 */
export interface ReplayPreflight {
  mocked: string[];
  unmocked: Array<{ id: string; tool?: string; reason: "no-capture" | "truncated" }>;
}

export function previewMockedReplay(
  steps: StepForReplayPreflight[],
): ReplayPreflight {
  const mocked: string[] = [];
  const unmocked: ReplayPreflight["unmocked"] = [];
  for (const s of steps) {
    if (s.status === "skipped") continue; // skipped steps aren't replayed
    if (s.output === undefined) {
      unmocked.push({
        id: s.id,
        ...(s.tool !== undefined && { tool: s.tool }),
        reason: "no-capture",
      });
      continue;
    }
    if (isTruncatedSnapshot(s.output)) {
      unmocked.push({
        id: s.id,
        ...(s.tool !== undefined && { tool: s.tool }),
        reason: "truncated",
      });
      continue;
    }
    mocked.push(s.id);
  }
  return { mocked, unmocked };
}

export interface RegistryDiff {
  added: Record<string, unknown>;
  modified: Array<{ key: string; before: unknown; after: unknown }>;
  removed: string[];
}

const EMPTY: RegistryDiff = { added: {}, modified: [], removed: [] };

/**
 * True if a snapshot value is the truncation envelope produced by
 * `captureForRunlog` for >8 KB payloads (`{[truncated]:true,bytes,preview}`).
 * When EITHER side of a diff is the envelope, a key-by-key comparison
 * produces meaningless noise (`bytes 15084 → 16215`), so callers should
 * short-circuit to a "truncated" empty state instead.
 */
export function isTruncatedSnapshot(value: unknown): boolean {
  return (
    value !== null &&
    typeof value === "object" &&
    (value as Record<string, unknown>)["[truncated]"] === true
  );
}

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
 * Result of `diffForStep`. Discriminated so the UI can render a distinct
 * empty-state for truncated snapshots vs missing capture.
 */
export type StepDiffResult =
  | { kind: "diff"; diff: RegistryDiff }
  | { kind: "truncated" }
  | { kind: "unavailable" };

/**
 * Compute the diff for the step at `index` in completion order. Pulls
 * the previous step's snapshot from the array — if no prior step has a
 * snapshot, treat as initial state (everything in this step's snapshot
 * is "added").
 *
 * Returns:
 *  - `{kind:"unavailable"}` — step has no `registrySnapshot` (pre-VD-2
 *    row, or runner without capture).
 *  - `{kind:"truncated"}` — either snapshot is the >8 KB truncation
 *    envelope; key-by-key diff would be meaningless.
 *  - `{kind:"diff",diff}` — usable diff.
 */
export function diffForStep(
  steps: StepWithSnapshot[],
  index: number,
): StepDiffResult {
  const step = steps[index];
  if (!step?.registrySnapshot) return { kind: "unavailable" };

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

  if (
    isTruncatedSnapshot(step.registrySnapshot) ||
    (prev !== undefined && isTruncatedSnapshot(prev))
  ) {
    return { kind: "truncated" };
  }

  return { kind: "diff", diff: diffSnapshots(prev, step.registrySnapshot) };
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
