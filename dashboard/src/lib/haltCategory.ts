/**
 * Halt-category types + display maps, shared across the dashboard
 * (the /runs list, the run-detail step rows, and the recipe doctor
 * panel). Mirrors the bridge's `src/recipes/haltCategory.ts` — keep the
 * union and wording in sync. The bridge owns the canonical hint text;
 * this is the dashboard-side copy (the dashboard can't import from the
 * bridge package).
 */

export type HaltCategory =
  | "agent_silent_fail"
  | "agent_narration_only"
  | "agent_threw"
  | "tool_threw"
  | "tool_error"
  | "kill_switch"
  | "budget_exceeded"
  | "expect_failed"
  | "step_timeout"
  | "judge_revisions_exhausted"
  | "auth_failure"
  | "rate_limited"
  | "network_error"
  | "missing_connector"
  | "approval_rejected"
  /** The approval TTL fired with nobody having answered — NOT a rejection. */
  | "approval_expired"
  /** The run was cancelled while a step waited for approval. */
  | "approval_cancelled"
  | "run_level"
  | "contract_failed"
  | "unsupported_step"
  | "unknown";

export interface HaltSummary {
  total: number;
  byCategory: Partial<Record<HaltCategory, number>>;
  recent: Array<{ reason: string; category: HaltCategory; runSeq: number }>;
}

export const HALT_CATEGORY_LABEL: Record<HaltCategory, string> = {
  agent_silent_fail: "agent silent-fail",
  agent_narration_only: "agent narration-only",
  agent_threw: "agent threw",
  tool_threw: "tool threw",
  tool_error: "tool error",
  kill_switch: "kill-switch blocked",
  budget_exceeded: "budget exceeded",
  expect_failed: "expect failed",
  step_timeout: "step timeout",
  judge_revisions_exhausted: "judge revisions exhausted",
  auth_failure: "auth failure",
  rate_limited: "rate limited",
  network_error: "network error",
  missing_connector: "missing connector",
  approval_rejected: "approval rejected",
  approval_expired: "approval expired",
  approval_cancelled: "approval cancelled",
  run_level: "run-level halt",
  contract_failed: "completion contract failed",
  unsupported_step: "unsupported step form",
  unknown: "uncategorised",
};

// One-line actionable hint per category — the categoriser knows the
// cause, this map tells the user the fix.
export const HALT_CATEGORY_HINT: Record<HaltCategory, string> = {
  agent_silent_fail:
    "Agent finished without producing usable output. Inspect prompt + check the trace.",
  agent_narration_only:
    "Agent narrated but didn't produce structured output — tighten the prompt or add an into: target.",
  agent_threw: "Agent step threw before completing. Open the run trace.",
  tool_threw:
    "Tool threw an unhandled exception. Check the inner error in the trace.",
  tool_error:
    "Tool returned an error response. Check the inner error in the trace.",
  kill_switch:
    "Write blocked by the kill-switch. Run `patchwork kill-switch release` to re-enable.",
  budget_exceeded:
    "Run exceeded its tokensMax budget. Raise tokensMax in the recipe or shrink prompts.",
  expect_failed:
    "A step's expect: assertion didn't match. Inspect the assertion + actual output.",
  step_timeout:
    "Step exceeded its timeout_ms. Bump the timeout or speed up the step.",
  judge_revisions_exhausted:
    "The judge→refine loop used its max_revisions budget and the judge still asked for changes. Raise max_revisions, refine the prompt, or set on_exhausted: proceed.",
  auth_failure:
    "Connector token expired or scopes insufficient. Reconnect from /connections.",
  rate_limited:
    "External service rate-limited the request. Back off the cron cadence or wait and retry.",
  network_error:
    "Transport-level failure (DNS, refused, timeout). Check connectivity to the upstream service.",
  missing_connector:
    "Recipe references a connector that isn't configured. Install/connect from /connections.",
  approval_rejected:
    "A step was rejected at the approval gate. Approve it from the dashboard, or set requireApproval: false on the recipe.",
  approval_expired:
    "A step waited for approval and nobody answered before the timeout. Not a rejection \u2014 no one saw it. An unattended run needs someone watching, requireApproval: false, or a longer approval timeout.",
  approval_cancelled:
    "The run was cancelled while a step waited for approval. Nothing was decided about the step \u2014 re-run it.",
  run_level:
    "Whole-recipe failure (no step ran). Check the recipe for circular deps / parse errors.",
  contract_failed:
    "The run finished its steps but broke its run-level expect: postcondition — it completed without delivering what it promised. Compare the assertion with the run output.",
  unsupported_step:
    "The step uses a form this recipe type can't run (parallel / each / recipe / chain / branch on a non-chained recipe). Use the fan_out tool step (it loops a tool or an agent sub-step), or set trigger.type: chained.",
  unknown: "Uncategorised halt. Open the run trace for the raw error.",
};
