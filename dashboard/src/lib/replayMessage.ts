/**
 * Words for a replay the bridge did not complete (`POST /runs/:seq/replay`
 * returning non-2xx or `ok: false`).
 *
 * Two different 409s carry `unmockedSteps` (src/recipes/replayBoundary.ts):
 *   - no `newSeq`: the preflight refused BEFORE any run started — nothing
 *     was run at all.
 *   - `newSeq` present: a run WAS started, earlier steps replayed from their
 *     captured output, and the runner stopped at the named step(s). Saying
 *     "Nothing was run" there is false — a replay run exists and is linked.
 * In both cases nothing was dispatched: replay is evidence-only.
 */
export interface ReplayResponseBody {
  ok?: boolean;
  newSeq?: number;
  unmockedSteps?: string[];
  error?: string;
}

export function replayFailureMessage(
  status: number,
  data: ReplayResponseBody,
): string {
  const steps = data.unmockedSteps ?? [];
  if (steps.length > 0) {
    const list = steps.join(", ");
    const noun = steps.length === 1 ? "step" : "steps";
    if (data.newSeq !== undefined) {
      return `Replay stopped at ${noun} ${list} — no usable captured output. Earlier steps replayed from captured output; nothing was sent out. See run #${data.newSeq}.`;
    }
    return `Replay refused — ${steps.length} ${noun} ${steps.length === 1 ? "has" : "have"} no usable captured output (${list}). Nothing was run.`;
  }
  return data.error ?? `HTTP ${status}`;
}
