/**
 * GET /sessions/:id detail payload builder.
 *
 * Audit 2026-06-08 HIGH (server-1): `sessionDetailFn` was declared in server.ts
 * but never wired in bridge.ts, so the endpoint 404'd forever and the dashboard
 * session-detail page was permanently blank. The logic lives here (pure, no I/O)
 * so it is unit-testable; bridge.ts wires a thin closure that supplies the live
 * session map, activity log, and approval queue.
 */

import type { SessionSummary } from "./server.js";

/** Minimal shape of an active session needed to build the summary. */
export interface SessionDetailSession {
  id: string;
  connectedAt: number;
  openedFiles: { readonly size: number };
  remoteAddr?: string;
}

/** Minimal activity-log surface used here (subset of ActivityLog). */
export interface SessionDetailActivityLog {
  querySessionLifecycle(
    sessionId: string,
    limit?: number,
  ): Array<{ event: string }>;
  querySessionTools(sessionId: string, limit?: number): unknown[];
}

export interface SessionDetailResult {
  summary: SessionSummary | null;
  lifecycle: Record<string, unknown>[];
  tools: Record<string, unknown>[];
  decisions: Record<string, unknown>[];
  approvals: Record<string, unknown>[];
}

/**
 * Build the detail payload for one session. `id` is the 8-char prefix the
 * dashboard navigates with (sessionsFn emits `s.id.slice(0,8)`) or a full id.
 *
 * Returns `summary: null` for an unknown/disconnected session — the route turns
 * that into a 404 (sessionsFn only lists active sessions, so that's the miss).
 */
export function buildSessionDetail(
  id: string,
  sessions: Iterable<SessionDetailSession>,
  activityLog: SessionDetailActivityLog | undefined,
  pendingApprovals: ReadonlyArray<{ sessionId?: string }>,
): SessionDetailResult {
  let session: SessionDetailSession | undefined;
  for (const s of sessions) {
    if (s.id === id || s.id.slice(0, 8) === id) {
      session = s;
      break;
    }
  }
  if (!session) {
    return {
      summary: null,
      lifecycle: [],
      tools: [],
      decisions: [],
      approvals: [],
    };
  }

  const fullId = session.id;
  const shortId = fullId.slice(0, 8);
  // Approval-queue sessionIds are full ids; match by the same 8-char prefix
  // sessionsFn uses so the count is consistent with the list view.
  const approvals = pendingApprovals.filter(
    (a) => a.sessionId && a.sessionId.slice(0, 8) === shortId,
  );
  const summary: SessionSummary = {
    id: shortId,
    connectedAt: new Date(session.connectedAt).toISOString(),
    openedFileCount: session.openedFiles.size,
    pendingApprovals: approvals.length,
    ...(session.remoteAddr ? { remoteAddr: session.remoteAddr } : {}),
  };

  const lifecycle = activityLog?.querySessionLifecycle(fullId) ?? [];
  const tools = activityLog?.querySessionTools(fullId) ?? [];
  // approval_decision rows are lifecycle entries; surface them separately so
  // the page's "decisions" section doesn't re-filter.
  const decisions = lifecycle.filter((e) => e.event === "approval_decision");

  return {
    summary,
    lifecycle: lifecycle as unknown as Record<string, unknown>[],
    tools: tools as unknown as Record<string, unknown>[],
    decisions: decisions as unknown as Record<string, unknown>[],
    approvals: approvals as unknown as Record<string, unknown>[],
  };
}
