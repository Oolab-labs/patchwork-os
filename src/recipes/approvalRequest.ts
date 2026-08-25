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

/** Every approval gate: the tier gate, the worker-autonomy gate, and any test double. */
export type ApprovalFn = (input: ApprovalRequestInput) => Promise<boolean>;
