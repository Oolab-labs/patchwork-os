import { type ActionClass, classifyActionClass } from "./actionClass.js";
import type { TrustLevel } from "./trustLevel.js";
import { ownsAction, type WorkerManifest } from "./worker.js";
import type { WorkerLevelStore } from "./workerLevelStore.js";

/**
 * The LIVE worker-autonomy decision (worker-ramp-v0, phase 2). Unlike
 * `shadowGate.recommend` — which reports queue/bypass purely for the dial — this
 * is what the approval gate ACTS on when the `worker.autonomy` flag is enabled.
 *
 * The rule is reversibility-scoped, deliberately. Pure "gate everything the
 * worker hasn't earned L4 on" is correct-but-unusable: a brand-new worker would
 * halt on EVERY action for the weeks it takes to accumulate evidence (the
 * evidence-latency reality). Reversibility is the ramp's primary axis, so it is
 * the gate's too:
 *
 *   - REVERSIBLE actions flow un-gated regardless of earned level. They are
 *     undoable (transactions + WriteEffectLedger, git reset/reflog, re-runnable
 *     CI) so the cost of being wrong is bounded — undo it. Blast tier still
 *     drives the FAILURE WEIGHT, so a big reversible mistake demotes the worker
 *     hard; it just isn't pre-gated. This is the routine work (read, local
 *     commit, ledgered file write) a new worker should simply do.
 *   - COMPENSABLE / IRREVERSIBLE actions (lossy or no undo — remote push, PR,
 *     merge, outbound message, http POST, shell, delete) are gated for human
 *     approval until the worker has EARNED (ceiling-capped) L4 trust on that
 *     exact action-class. This is the "stop and ask before the dangerous thing"
 *     behaviour of a trustworthy new employee.
 *
 * The decision NEVER widens access on its own: when the flag is off the gate
 * path this feeds is not engaged at all, and even on, a "gate" result only ever
 * routes an action to the EXISTING human-approval queue (fail-closed) — it never
 * auto-approves anything that would otherwise have been queued by tier policy.
 */

export type WorkerGateAction = "allow" | "gate";

export interface WorkerGateDecision {
  action: WorkerGateAction;
  classKey: string;
  domain: string;
  owned: boolean;
  blastTier: ActionClass["blastTier"];
  reversibility: ActionClass["reversibility"];
  /** Trust actually earned on this class (for logging / the dial). */
  earnedLevel: TrustLevel;
  autonomyCeiling: TrustLevel;
  /** What the gate operates at: min(earned, ceiling), 0 if not owned. */
  effectiveLevel: TrustLevel;
  reason: string;
}

const AUTONOMOUS_LEVEL = 4 as const;

/**
 * Undoable → flows un-gated even when unearned. Only reversible actions are
 * exempt from the trust requirement; compensable / irreversible ones (lossy or
 * no undo) wait for earned L4. Reversibility is the ramp's primary axis.
 */
export function flowsUngated(ac: ActionClass): boolean {
  return ac.reversibility === "reversible";
}

export function decideWorkerAction(
  worker: WorkerManifest,
  toolName: string,
  params: Record<string, unknown> | undefined,
  store: WorkerLevelStore,
): WorkerGateDecision {
  const ac = classifyActionClass(toolName, params);
  const owned = ownsAction(worker, ac);
  const earnedLevel = (store.getState(worker.id, ac.key)?.level ??
    0) as TrustLevel;

  let effectiveLevel: TrustLevel = owned ? earnedLevel : 0;
  if (effectiveLevel > worker.autonomyCeiling)
    effectiveLevel = worker.autonomyCeiling;

  const base = {
    classKey: ac.key,
    domain: ac.domain,
    owned,
    blastTier: ac.blastTier,
    reversibility: ac.reversibility,
    earnedLevel,
    autonomyCeiling: worker.autonomyCeiling,
    effectiveLevel,
  } as const;

  // Reversible: flows freely. The routine work a new worker should just do.
  if (flowsUngated(ac)) {
    return {
      ...base,
      action: "allow",
      reason: `reversible (${ac.blastTier} blast) — undoable, flows un-gated`,
    };
  }

  // Compensable / irreversible: autonomous only once EARNED (ceiling-capped) L4.
  if (effectiveLevel >= AUTONOMOUS_LEVEL) {
    return {
      ...base,
      action: "allow",
      reason: `earned autonomy (L4) on a ${ac.reversibility} class`,
    };
  }

  let reason: string;
  if (!owned) {
    reason = `${ac.reversibility} action outside the worker's owned domain — gated`;
  } else if (worker.autonomyCeiling < AUTONOMOUS_LEVEL) {
    reason = `${ac.reversibility} class capped by autonomy ceiling (L${worker.autonomyCeiling}) — always gated`;
  } else {
    reason = `${ac.reversibility} + unearned (effective L${effectiveLevel} < L4) — gated for approval`;
  }
  return { ...base, action: "gate", reason };
}
