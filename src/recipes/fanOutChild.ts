/**
 * fanOutChild — what a `fan_out` step actually does, for the gates that decide
 * whether it may.
 *
 * `fan_out` dispatches its child tool once per item through `executeTool`
 * directly, never through `executeStep`. Every step-level gate that keyed on
 * the step's own tool id therefore saw `fan_out` — registered `isWrite: false`
 * with no declared tier, so "medium" — and never the tool it runs. Under
 * approvalGate "high" a high-tier write wrapped in `fan_out` reached no human,
 * while the same write as a direct step queued; the worker gate classified it
 * as a medium read; and `patchwork.policy.yml` was checked against `fan_out`
 * rather than the child's own params.
 *
 * The rule this module encodes: a gate classifies a `fan_out` step as its
 * CHILD tool. What is HASHED for approval identity stays the dispatched call
 * (`fan_out` + its params) — that is what `executeStep` re-verifies at
 * dispatch, and one approval covers the whole batch it names.
 *
 * `do.agent` children are out of scope here: they run through the injected
 * agent executor, which has its own boundary checks.
 */

import type { Reversibility } from "../workers/actionClass.js";
import { ROLLBACK_BACKED_TOOLS } from "./fileWriteRollbackability.js";

export const FAN_OUT_TOOL_ID = "fan_out";

/**
 * The tool a `fan_out` step dispatches per item, or `undefined` when the step
 * is not a tool fan_out. `fan_out` itself rejects a missing, templated-empty
 * or nested child before the loop, so a string here is the id that runs.
 */
export function fanOutChildToolId(step: unknown): string | undefined {
  if (!step || typeof step !== "object") return undefined;
  const s = step as Record<string, unknown>;
  if (s.tool !== FAN_OUT_TOOL_ID) return undefined;
  const d = s.do;
  if (!d || typeof d !== "object" || Array.isArray(d)) return undefined;
  const t = (d as Record<string, unknown>).tool;
  return typeof t === "string" && t.length > 0 ? t : undefined;
}

/**
 * Reversibility ceiling for a fan_out child. A rollback-backed file write is
 * reversible only with a rollback confirmed for ITS path at decision time; a
 * fan_out's per-item paths are not assessed then, so the batch is treated as
 * unconfirmed — `irreversible`, exactly as an unconfirmed direct write is.
 * Any other child keeps its own classification.
 */
export function fanOutChildReversibilityCeiling(
  childToolId: string,
): Reversibility | undefined {
  return ROLLBACK_BACKED_TOOLS.has(childToolId) ? "irreversible" : undefined;
}

/** Approval summary naming the child and, when known, how many times it runs. */
export function fanOutApprovalSummary(
  childToolId: string,
  params: Record<string, unknown> | undefined,
): string {
  const items = params?.items;
  let count: number | undefined;
  if (Array.isArray(items)) count = items.length;
  else if (typeof items === "string") {
    try {
      const parsed = JSON.parse(items);
      if (Array.isArray(parsed)) count = parsed.length;
    } catch {
      // unparseable — fan_out itself will refuse it; no count to show
    }
  }
  return count === undefined
    ? `fan_out → tool ${childToolId} (once per item)`
    : `fan_out → tool ${childToolId} × ${count}`;
}
