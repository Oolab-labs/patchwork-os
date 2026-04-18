/**
 * Shared type definitions for the activity log.
 *
 * Extracted into a standalone file (no imports) to break the circular
 * dependency that would arise if server.ts imported from activityLog.ts
 * directly. Both server.ts and activityLog.ts import from here instead.
 */

export interface ActivityEntry {
  id: number;
  timestamp: string;
  tool: string;
  durationMs: number;
  status: "success" | "error";
  errorMessage?: string;
  sessionId?: string;
}

export interface LifecycleEntry {
  id: number;
  timestamp: string;
  event: string;
  metadata?: Record<string, unknown>;
}

export type TimelineEntry =
  | ({ kind: "tool" } & ActivityEntry)
  | ({ kind: "lifecycle" } & LifecycleEntry);

export type ActivityListener = (
  kind: string,
  entry: ActivityEntry | LifecycleEntry,
) => void;
