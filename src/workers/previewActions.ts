/**
 * Prospective gate evaluation — "what could this worker do here?"
 *
 * The gate answers one question at a time, retrospectively: a tool call arrives
 * and `decideWorkerAction` allows, gates or forbids it. That is the right shape
 * for enforcement and the wrong shape for showing somebody the boundary, which
 * has to be answerable *before* anything is attempted.
 *
 * This module asks the same question ahead of time, for a set of candidate
 * actions, and buckets the answers into the three columns an operator reads:
 * **may do now / needs approval / not permitted**.
 *
 * ## It must reuse the gate, not re-implement it
 *
 * The single property that makes this worth building: `previewActions` calls
 * `decideWorkerAction` — the exact function enforcement uses. It contains no
 * policy of its own, no parallel thresholds and no second copy of the
 * reversibility rules.
 *
 * A preview with its own logic would be worse than no preview. It would drift,
 * and the failure is silent and in the dangerous direction: a screen that says
 * "not permitted" while the gate would in fact allow the action tells an
 * operator they are protected when they are not. Trust in the boundary screen
 * IS the product claim, so the screen has to be a view of the gate rather than
 * a description of it.
 *
 * This is cheap precisely because `decideWorkerAction` is pure over
 * `(worker, toolName, params, store, opts)` — no I/O, no side effects, so
 * evaluating a hypothetical costs the same as evaluating a real call.
 *
 * ## What it deliberately does not do
 *
 * No side effects, and no approval-queue interaction: previewing an action must
 * never enqueue one, or opening a screen would spam a human with requests
 * nobody made. It also does not persist a decision record — a hypothetical is
 * not a decision, and writing one would pollute the audit trail with things
 * that never happened.
 */

import type { StandingPermission } from "../butler/standingPermission.js";
import { classifyActionClass, knownActionTools } from "./actionClass.js";
import type { ForbidRule } from "./forbidPolicy.js";
import { ownsAction, type WorkerManifest } from "./worker.js";
import { decideWorkerAction, resolveGateOutcome } from "./workerGate.js";
import type { WorkerLevelStore } from "./workerLevelStore.js";

/** An action to ask about. `label` is what a person should see. */
export interface CandidateAction {
  toolName: string;
  params?: Record<string, unknown>;
  /** Human phrasing, e.g. "Publish the release to npm". Defaults to toolName. */
  label?: string;
}

/** One evaluated candidate. */
export interface PreviewedAction {
  label: string;
  toolName: string;
  /** `${domain}:${reversibility}:${blastTier}` — the trust unit. */
  classKey: string;
  /** Why it landed in this column, in the gate's own words. */
  reason: string;
}

export interface ActionBoundary {
  /** Flows without asking anyone. */
  mayDoNow: PreviewedAction[];
  /** A named person must say yes first. */
  needsApproval: PreviewedAction[];
  /** Refused outright — no approval unlocks these. */
  notPermitted: PreviewedAction[];
}

export interface PreviewOpts {
  forbidRules?: readonly ForbidRule[];
  /** Situational risk, folded in exactly as the live gate folds it in. */
  contextRisk?: import("./contextRisk.js").ContextRisk;
  /** Standing permissions in force, folded in exactly as the live gate folds
   *  them in. Absent ⇒ identical to the pre-permission preview. */
  standingPermissions?: readonly StandingPermission[];
  /** Clock for expiry/revocation. Defaults to `Date.now()`. */
  now?: number;
  /** Exercises today per grant, for `ceiling.perDay`. */
  usageToday?: (permissionId: string) => number;
}

/**
 * Bucket candidate actions into the three columns.
 *
 * Order within each column is the order the candidates were supplied, so a
 * caller controls presentation without this module knowing anything about
 * presentation.
 */
export function previewActions(
  worker: WorkerManifest,
  candidates: readonly CandidateAction[],
  store: WorkerLevelStore,
  opts: PreviewOpts = {},
): ActionBoundary {
  const boundary: ActionBoundary = {
    mayDoNow: [],
    needsApproval: [],
    notPermitted: [],
  };

  for (const c of candidates) {
    const decision = decideWorkerAction(worker, c.toolName, c.params, store, {
      ...(opts.contextRisk ? { contextRisk: opts.contextRisk } : {}),
      ...(opts.forbidRules ? { forbidRules: opts.forbidRules } : {}),
    });

    const entry: PreviewedAction = {
      label: c.label ?? c.toolName,
      toolName: c.toolName,
      classKey: decision.classKey,
      reason: decision.reason,
    };

    // Route through the SAME resolver the enforcement path uses — including
    // standing permissions — so a column can never disagree with what would
    // actually happen. A grant that lets an action flow MUST move it out of
    // "needs approval" here, or the screen tells an operator a person will be
    // asked when nobody will be.
    const resolved = resolveGateOutcome(
      decision,
      opts.standingPermissions
        ? {
            permissions: opts.standingPermissions,
            now: opts.now ?? Date.now(),
            ...(opts.usageToday && { usageToday: opts.usageToday }),
          }
        : undefined,
    );
    // Say WHY in the permission's words when one answered. "Earned autonomy on
    // a compensable class" and "you said not to ask about these" are different
    // facts about the boundary and a reader needs to tell them apart.
    if (resolved.standingPermissionReason)
      entry.reason = resolved.standingPermissionReason;

    switch (resolved.outcome) {
      case "flow":
        boundary.mayDoNow.push(entry);
        break;
      case "queue":
        boundary.needsApproval.push(entry);
        break;
      default:
        // `refuse` — forbidden, or an action this build does not understand.
        // Both belong in the column that says nobody can wave it through.
        boundary.notPermitted.push(entry);
        break;
    }
  }

  return boundary;
}

/** Total candidates evaluated — for a "N actions considered" caption. */
export function boundarySize(b: ActionBoundary): number {
  return b.mayDoNow.length + b.needsApproval.length + b.notPermitted.length;
}

/**
 * The default candidate set for a worker: every action-class tool it owns.
 *
 * A boundary screen needs something to evaluate. Making the caller always
 * supply that list would mean the generic product has no default view, and the
 * only way to see a worker's boundary would be to hand-write its actions —
 * which is fine for a scripted walkthrough and useless for an operator asking
 * "what can this thing actually do?".
 *
 * So the default is derived from the worker's own manifest: the tools the
 * classifier knows (`knownActionTools`), filtered to the classes this worker
 * `owns`. That is the honest answer to the question, because a worker's `owns`
 * IS the declaration of what it is for.
 *
 * Deliberately NOT the whole tool registry. Showing every tool in the product
 * would bury the handful that matter under a hundred rows the worker will never
 * touch, and every one of them would land in "needs approval" — a screen that
 * is technically true and tells an operator nothing.
 *
 * Callers with a specific set in mind (a case, a scripted scenario) pass their
 * own candidates to `previewActions` instead. This is the default, not the
 * only, list.
 */
export function defaultCandidatesFor(
  worker: WorkerManifest,
): CandidateAction[] {
  return knownActionTools()
    .filter((toolName) => ownsAction(worker, classifyActionClass(toolName)))
    .sort()
    .map((toolName) => ({ toolName }));
}
