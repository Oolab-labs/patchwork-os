/**
 * Decision-time rollbackability for rollback-backed file steps (INV-1).
 *
 * `fs-write` is reversible only when a rollback log can actually restore the
 * prior state. This resolves the step's target exactly as the tool will
 * (`jailedPath`) and asks the SAME inspection the pre-image capture uses
 * (`assessRollbackability`), so the gate and the undo share one definition.
 *
 * Runners call this BEFORE the authority decision, pass the resulting ceiling
 * to the worker gate and the governed profile, and re-check it immediately
 * before execution: if it got worse, the decision was made on facts that no
 * longer hold, so the step is refused rather than silently downgraded.
 *
 * Known limit: there is still a window between the pre-execution re-check and
 * the write. Nothing here claims atomicity against a hostile local process
 * racing that window.
 */
import type { Reversibility } from "../workers/actionClass.js";
import {
  assessRollbackability,
  type FileRollbackLog,
  type Rollbackability,
  rollbackabilityWorsened,
} from "./fileRollback.js";
import { jailedPath } from "./tools/file.js";

/** Tools whose undo is the file-rollback log. */
export const ROLLBACK_BACKED_TOOLS: ReadonlySet<string> = new Set([
  "file.write",
  "file.append",
]);

/**
 * `undefined` for any tool that is not a rollback-backed file write. A path the
 * jail rejects reports `uncertain` — the tool itself will refuse it, and a
 * target we cannot resolve is not one we can claim to undo.
 */
export function stepRollbackability(
  toolId: string,
  params: Record<string, unknown> | undefined,
  deps: { workdir: string; fileRollbackLog?: FileRollbackLog },
): Rollbackability | undefined {
  if (!ROLLBACK_BACKED_TOOLS.has(toolId)) return undefined;
  let abs: string;
  try {
    abs = jailedPath(String(params?.path ?? ""), deps.workdir, true);
  } catch {
    return "uncertain";
  }
  return assessRollbackability(abs, deps.fileRollbackLog);
}

/** Only a confirmed rollback keeps the domain's `reversible`. */
export function reversibilityCeilingFor(
  r: Rollbackability | undefined,
): Reversibility | undefined {
  return r === undefined || r === "confirmed" ? undefined : "irreversible";
}

/**
 * Throws `rollback_capability_worsened` when the step's rollbackability is now
 * worse than the value the authority decision was made on.
 */
export function assertRollbackNotWorsened(
  toolId: string,
  params: Record<string, unknown> | undefined,
  deps: { workdir: string; fileRollbackLog?: FileRollbackLog },
  atDecision: Rollbackability | undefined,
): void {
  if (atDecision === undefined) return;
  const now = stepRollbackability(toolId, params, deps);
  if (now !== undefined && rollbackabilityWorsened(atDecision, now)) {
    throw new Error(
      `rollback_capability_worsened: ${toolId} was authorised as ${atDecision} rollback but is now ${now}; no action taken — a new decision is required`,
    );
  }
}

/**
 * What `patchwork policy explain` must assume: an explanation is not a run, so
 * no rollback log exists for it — the same state every automated run is in.
 * Explaining a rollback-backed write as `reversible` here would print ALLOW for
 * a step the runner gates, i.e. an explanation that disagrees with enforcement.
 */
export function explainRollbackability(
  toolId: string,
): Rollbackability | undefined {
  return ROLLBACK_BACKED_TOOLS.has(toolId) ? "unavailable" : undefined;
}
