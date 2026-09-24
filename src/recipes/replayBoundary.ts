/**
 * replayBoundary — the one rule a mocked replay must never break.
 *
 * Missing replay evidence REDUCES what can be replayed; it never increases
 * permission to execute. A replay is driven entirely by captured step
 * outputs. When a step has no usable capture, the only correct outcome is
 * to STOP with a reason that names the step — never to fill the gap by
 * running the tool or agent for real.
 *
 * This module is deliberately tiny and dependency-free: it is imported by
 * both runners (`yamlRunner.ts`, `chainedRunner.ts`) and by the replay
 * entrypoint (`replayRun.ts`), and `replayRun.ts` already imports the
 * runners, so the error type cannot live in any of them without a cycle.
 *
 * Enforced in three layers, outermost first:
 *   1. `replayRun.ts` preflight — refuses before a run is started when any
 *      step lacks a usable capture. Explanatory: lists every such step.
 *   2. Each runner's step loop — under `replayOnly`, a step whose id is not
 *      in `mockedOutputs` fails with this error instead of dispatching.
 *   3. `executeStep` / `buildAgentExecutorDeps` in `yamlRunner.ts` — the
 *      dispatch seam BOTH runners converge on. Under `replayOnly` they throw
 *      before any tool or agent is invoked. This is the layer that holds
 *      when 1 and 2 miss a case (a compound step, a nested recipe, a new
 *      dispatch path added later): a replay's `StepDeps` are structurally
 *      unable to reach a live tool.
 */

/** Stable code carried by `ReplayIncompleteError.code` and error strings. */
export const REPLAY_REFUSED_UNMOCKED_STEP = "replay_refused_unmocked_step";

/**
 * Human-readable refusal, always prefixed by the stable code so HTTP and
 * CLI callers can branch on `startsWith`.
 */
export function replayRefusalMessage(
  stepIds: readonly string[],
  detail?: string,
): string {
  const list = stepIds.length > 0 ? stepIds.join(", ") : "(unknown step)";
  const suffix = detail ? ` (${detail})` : "";
  return `${REPLAY_REFUSED_UNMOCKED_STEP}: mocked replay cannot execute step(s) without a usable captured output — ${list}${suffix}. Replay is evidence-only; nothing was dispatched.`;
}

/** Typed refusal thrown at the dispatch seam under `replayOnly`. */
export class ReplayIncompleteError extends Error {
  readonly code = REPLAY_REFUSED_UNMOCKED_STEP;
  readonly stepIds: readonly string[];
  constructor(stepIds: readonly string[], detail?: string) {
    super(replayRefusalMessage(stepIds, detail));
    this.name = "ReplayIncompleteError";
    this.stepIds = stepIds;
  }
}

/** True when an error string / message came from this boundary. */
export function isReplayRefusal(err: unknown): boolean {
  if (err instanceof ReplayIncompleteError) return true;
  const msg =
    typeof err === "string"
      ? err
      : err instanceof Error
        ? err.message
        : undefined;
  return msg !== undefined && msg.startsWith(REPLAY_REFUSED_UNMOCKED_STEP);
}
