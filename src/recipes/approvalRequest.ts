/**
 * The input every approval gate receives, in ONE place.
 *
 * This shape was declared three times, structurally identically:
 * `recipeOrchestration.ts`'s `ApprovalFn`, and inline inside each runner's
 * `requireApprovalFn` option (`yamlRunner.ts`, `chainedRunner.ts`). Three copies
 * of a contract is not a duplication smell here — it is how a field gets added
 * to one path and silently missed on the other, which is precisely the failure
 * mode `runTaskId` exists to prevent.
 *
 * `runTaskId` is REQUIRED, deliberately. It is the join key between a gate
 * decision and the run that produced it, and an optional key is one that
 * eventually is not passed. Making it required means adding a new approval call
 * site is a compile error until that site says which run it belongs to.
 */

import type { RiskTier } from "../riskTier.js";

export interface ApprovalRequestInput {
  toolId: string;
  tier: RiskTier;
  summary?: string;
  params?: Record<string, unknown>;
  /**
   * The run's identity, verbatim as written to `runs.jsonl` / `run_steps.jsonl`
   * — `taskId`, never `seq`.
   *
   * `seq` is a per-INSTANCE counter over a file shared by several writers, and
   * it collides: measured 255 distinct values across 272 rows of the live gate
   * ledger. A join on it silently becomes many-to-one. `taskId` is derived from
   * the recipe name and its start time and does not have that property.
   */
  runTaskId: string;
  /**
   * The run's AbortSignal — when it fires, a pending approval resolves
   * "cancelled" so a cancelled run halts promptly instead of waiting out the
   * full approval TTL (L1).
   */
  signal?: AbortSignal;
}

/**
 * Why a gate did not let a step through.
 *
 * These are `ApprovalDecision` (approvalQueue.ts) minus `"approved"`, and the
 * queue has always distinguished them — a rejection is a person deciding, an
 * expiry is a TTL firing with nobody there, a cancellation is the run itself
 * going away. `ApprovalFn` returned a bare `boolean`, so all three arrived at
 * the runner as one and were reported with a sentence that names a human
 * decision. Measured before this was widened: 49 approved / 7 rejected / 27
 * expired / 23 cancelled in the durable approval log, so most non-approvals
 * were never rejections.
 */
export type ApprovalRefusal = "rejected" | "expired" | "cancelled";

export interface ApprovalVerdict {
  approved: boolean;
  /**
   * OMITTED when the gate does not know which refusal this was — absence, not
   * a defaulted `"rejected"`. A gate that cannot say must not have a claim
   * about a person invented for it; the runner keeps emitting the sentence it
   * always did for that case.
   */
  refusal?: ApprovalRefusal;
}

/**
 * Every approval gate: the tier gate, the worker-autonomy gate, and any test
 * double. A bare `boolean` is still valid and still means exactly what it did
 * — widening the return type rather than replacing it is what keeps every
 * existing gate and double honest instead of forcing each to assert a refusal
 * it does not know.
 */
export type ApprovalFn = (
  input: ApprovalRequestInput,
) => Promise<boolean | ApprovalVerdict>;

/** Normalise either accepted form to the object form. */
export function normaliseApprovalVerdict(
  result: boolean | ApprovalVerdict,
): ApprovalVerdict {
  return typeof result === "boolean" ? { approved: result } : result;
}
