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
  | "auth_failure"
  | "rate_limited"
  | "network_error"
  | "missing_connector"
  | "run_level"
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
  auth_failure: "auth failure",
  rate_limited: "rate limited",
  network_error: "network error",
  missing_connector: "missing connector",
  run_level: "run-level halt",
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
  auth_failure:
    "Connector token expired or scopes insufficient. Reconnect from /connections.",
  rate_limited:
    "External service rate-limited the request. Back off the cron cadence or wait and retry.",
  network_error:
    "Transport-level failure (DNS, refused, timeout). Check connectivity to the upstream service.",
  missing_connector:
    "Recipe references a connector that isn't configured. Install/connect from /connections.",
  run_level:
    "Whole-recipe failure (no step ran). Check the recipe for circular deps / parse errors.",
  unknown: "Uncategorised halt. Open the run trace for the raw error.",
};
