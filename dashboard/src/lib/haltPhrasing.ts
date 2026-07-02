/**
 * Owner-level phrasing for halt categories — the plain sentence a
 * non-technical operator reads in the recipe "Needs you" band, plus a
 * semantic hint for the one fix button.
 *
 * Sits BESIDE `HALT_CATEGORY_HINT` (haltCategory.ts), which is the
 * engineer-level text kept for the expert/details view. Same category
 * union, different audience: HINT tells a developer how to debug;
 * this tells the owner what happened and what to press.
 *
 * The `fix` action is a semantic enum, not a URL — the page decides how to
 * wire each one (a link to /connections, opening the budget details, etc.)
 * so this module stays free of routing concerns and easy to unit-test.
 */

import type { HaltCategory } from "./haltCategory";

export type HaltFixAction =
  | "reconnect"
  | "connect"
  | "raise-budget"
  | "release-kill-switch"
  | "approve"
  | "open-trace"
  | "wait"
  | "none";

export interface OwnerHaltPhrase {
  /** One plain sentence, no jargon. `{service}` already substituted. */
  sentence: string;
  /** What the single fix button should do, or "none"/"wait" when there's nothing to press. */
  fix: HaltFixAction;
  /** Suggested button label for the fix, when there is one. */
  fixLabel?: string;
}

const SERVICE_FALLBACK = "the service it needs";

/**
 * Plain owner-facing phrasing for a halt.
 * @param category  the categorised halt
 * @param service   the connector/service name when known (e.g. "GitHub")
 */
export function ownerHaltPhrase(
  category: HaltCategory,
  service?: string,
): OwnerHaltPhrase {
  const svc = service && service.trim() ? service.trim() : SERVICE_FALLBACK;
  switch (category) {
    case "auth_failure":
      return {
        sentence: `It can't sign in to ${svc} anymore.`,
        fix: "reconnect",
        fixLabel: "Reconnect",
      };
    case "missing_connector":
      return {
        sentence: `It needs ${svc} connected before it can run.`,
        fix: "connect",
        fixLabel: "Connect",
      };
    case "rate_limited":
      return {
        sentence: `${service && service.trim() ? svc : "The service"} asked it to slow down — it'll try again on its own soon.`,
        fix: "wait",
      };
    case "network_error":
      return {
        sentence: `It couldn't reach ${svc}. This is usually temporary.`,
        fix: "wait",
      };
    case "budget_exceeded":
      return {
        sentence: "It hit its spending limit for this run.",
        fix: "raise-budget",
        fixLabel: "Raise limit",
      };
    case "kill_switch":
      return {
        sentence: "It's paused by the safety switch — nothing can make changes right now.",
        fix: "release-kill-switch",
        fixLabel: "Turn safety switch off",
      };
    case "approval_rejected":
      return {
        sentence: "You turned down its last request, so it stopped.",
        fix: "none",
      };
    case "step_timeout":
      return {
        sentence: "One step took too long and was stopped.",
        fix: "open-trace",
        fixLabel: "See what happened",
      };
    case "expect_failed":
      return {
        sentence: "It checked its own work and something didn't look right, so it stopped.",
        fix: "open-trace",
        fixLabel: "See what happened",
      };
    case "agent_silent_fail":
    case "agent_narration_only":
    case "agent_threw":
      return {
        sentence: "Claude didn't finish this step cleanly, so it stopped.",
        fix: "open-trace",
        fixLabel: "See what happened",
      };
    case "tool_threw":
    case "tool_error":
      return {
        sentence: "One of its tools ran into an error and it stopped.",
        fix: "open-trace",
        fixLabel: "See what happened",
      };
    case "run_level":
      return {
        sentence: "It couldn't start — something in its setup needs fixing.",
        fix: "open-trace",
        fixLabel: "See what happened",
      };
    case "unknown":
      return {
        sentence: "It stopped for a reason we couldn't label.",
        fix: "open-trace",
        fixLabel: "See what happened",
      };
  }
}
