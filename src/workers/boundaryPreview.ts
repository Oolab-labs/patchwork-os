/**
 * The control boundary for a live worker — composition, not policy.
 *
 * `previewActions` answers "what would the gate say about these candidates?"
 * given a worker and its trust store. This resolves those two from a recipe
 * name, so a caller with nothing but "release-notes" can render the boundary.
 *
 * It reuses `loadWorkerTrustForRecipe` — the same resolution the live gate
 * performs in `buildWorkerAutonomyGate`. That matters for the same reason
 * `previewActions` reuses `decideWorkerAction`: if the preview resolved trust
 * its own way, it could show a boundary computed from a different worker
 * manifest or a staler store than the one enforcement will use, and be
 * confidently wrong. Every layer of this screen has to be a view of the gate.
 *
 * Returns null when no worker owns the recipe — the honest answer, and
 * distinguishable from "a worker that may do nothing", which is an empty
 * boundary rather than a missing one.
 */

import { FLAG_WORKER_AUTONOMY, isEnabled } from "../featureFlags.js";
import { type ForbidRule, parseForbidRules } from "./forbidPolicy.js";
import {
  type ActionBoundary,
  type CandidateAction,
  defaultCandidatesFor,
  previewActions,
} from "./previewActions.js";
import type { RunWorkerShadowOpts } from "./runWorkerShadow.js";
import { loadWorkerTrustForRecipe } from "./runWorkerShadow.js";

export interface WorkerBoundary {
  workerId: string;
  workerName: string;
  recipeName: string;
  boundary: ActionBoundary;
  /**
   * False when the worker-autonomy flag is off. The boundary is still computed
   * and still correct as a statement of policy — but nothing is enforcing it,
   * and a screen that does not say so would imply protection that is not
   * running. The caller must surface this.
   */
  enforced: boolean;
}

export interface BoundaryPreviewOpts {
  /** Caller-supplied candidates. Omitted ⇒ derived from the worker's `owns`. */
  candidates?: readonly CandidateAction[];
  forbidRules?: readonly ForbidRule[];
  trustOpts?: RunWorkerShadowOpts;
}

/**
 * Compute the control boundary for whichever worker owns `recipeName`.
 *
 * Read-only: resolves trust, evaluates hypotheticals, writes nothing. No
 * approval is enqueued and no decision is recorded — see `previewActions`.
 */
export function boundaryForRecipe(
  recipeName: string,
  opts: BoundaryPreviewOpts = {},
): WorkerBoundary | null {
  const trust = loadWorkerTrustForRecipe(recipeName, opts.trustOpts);
  if (!trust) return null;

  const { worker, store } = trust;
  const candidates = opts.candidates ?? defaultCandidatesFor(worker);

  // Rules come from the caller when supplied, else from the worker's own
  // `forbids:`. Without this fallback the manifest field would be inert and
  // the "not permitted" column could never be non-empty in the running
  // product — the policy existed but had no configuration surface.
  const forbidRules =
    opts.forbidRules ?? parseForbidRules(worker.forbids).rules;

  return {
    workerId: worker.id,
    workerName: worker.name,
    recipeName,
    boundary: previewActions(worker, candidates, store, {
      ...(forbidRules.length > 0 ? { forbidRules } : {}),
    }),
    // Deliberately reported rather than used to suppress the result. An
    // operator asking "what may this worker do?" while the flag is off should
    // get the answer AND be told it is not being enforced — hiding the boundary
    // would leave them with no information at all, which is worse.
    enforced: isEnabled(FLAG_WORKER_AUTONOMY),
  };
}
