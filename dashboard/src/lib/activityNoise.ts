// Lifecycle event names that dominate the activity log but aren't
// actionable for the user — bridge connect/disconnect churn and the
// short reconnect grace window. Three pages render activity feeds and
// each had its own copy; consolidate so the next consumer doesn't get
// a different list.
//
//   - /dashboard/activity        — filters these out from the default tab
//   - /dashboard/                 — overview Activity Thread filters them out
//   - /dashboard/sessions/[id]    — keeps them, but renders dimmed (isNoise flag)
export const ACTIVITY_NOISE_EVENTS: ReadonlySet<string> = new Set([
  "claude_connected",
  "claude_disconnected",
  "extension_connected",
  "extension_disconnected",
  "grace_started",
  "grace_expired",
]);

export function isNoiseEvent(e: { kind?: string; event?: string }): boolean {
  return e.kind === "lifecycle" && ACTIVITY_NOISE_EVENTS.has(e.event ?? "");
}
