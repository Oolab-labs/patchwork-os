/**
 * Maps a raw activity-feed event to one of four severity levels for the
 * Terminal deck's "tail" pane (and its CSS: `td-lvl-<level>`).
 *
 * Prior bug: the level was derived by regex-matching the *event name*
 * only ("recipe_step_done" contains "done" -> classified `done` even when
 * the step actually errored, because the step's `metadata.status` /
 * `haltReason` were never consulted). That made a tail full of failed
 * steps render as if everything succeeded — "a tail that is all one
 * color". Fixed by checking `metadata.status`/`haltReason` first for
 * recipe lifecycle events, and only falling back to the event-name regex
 * for events that don't carry a status.
 */

export interface ActivityLevelInput {
  kind?: string;
  event?: string;
  status?: string;
  metadata?: Record<string, unknown>;
}

export type ActivityLevel = "done" | "halt" | "note" | "tool";

function metaStatus(e: ActivityLevelInput): string | undefined {
  const s = e.metadata?.status;
  return typeof s === "string" ? s : undefined;
}

function hasHaltReason(e: ActivityLevelInput): boolean {
  return typeof e.metadata?.haltReason === "string" && e.metadata.haltReason.length > 0;
}

export function eventLevel(e: ActivityLevelInput): ActivityLevel {
  if (e.kind === "tool") {
    return e.status === "error" ? "halt" : "tool";
  }
  if (e.kind === "lifecycle") {
    const status = metaStatus(e);
    if (status === "error" || hasHaltReason(e)) return "halt";
    if (status === "ok" || status === "done" || status === "skipped") return "done";

    // No status metadata on this lifecycle event (e.g. recipe_started,
    // approval_rejected, crash_detected) — fall back to the event name.
    // Gate/approval outcomes are checked first: an approval_rejected is a
    // deliberation outcome (amber, like NOTE/GATE), not a system halt
    // (red) — only real crashes/uncaught failures get "halt" here.
    if (typeof e.event === "string") {
      if (/gate|approval|settings|telemetry/i.test(e.event)) return "note";
      if (/halt|error|fail|crash/i.test(e.event)) return "halt";
      if (/done|success|complete/i.test(e.event)) return "done";
    }
    return "note";
  }
  return "note";
}
