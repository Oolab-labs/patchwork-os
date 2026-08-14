import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import type { ApprovalDecision, PendingApproval } from "./approvalQueue.js";
import { withFileLockSync } from "./fileLockSync.js";
import type { Logger } from "./logger.js";
import { patchworkHome } from "./patchworkHome.js";

/**
 * Durable event log backing `ApprovalQueue` (ADR-0018: "persist the request,
 * not the await"). Two append-only event kinds:
 *
 *  - `request` — written when a call is enqueued. Everything an auditor or a
 *    human reviewing the queue needs to know about what was asked.
 *  - `decision` — written when a call resolves (approved/rejected/expired/
 *    cancelled), whatever produced that resolution.
 *
 * On restart, replaying the log tells you which requests never got a
 * matching decision — those are the ones to restore as pending. This is an
 * append-only event source, not a mutable store: no row is ever rewritten,
 * so there is no compaction/tombstone problem to solve (the ADR calls that
 * out as the reason a naive "current state" JSONL wouldn't work here).
 *
 * Deliberately NOT a live-tailed multi-reader log like
 * `WorkerGateDecisionLog` — this is read once at process startup to
 * reconstruct pending state, not polled continuously, so there is no
 * tail-on-read offset tracking to maintain.
 */

export interface ApprovalRequestEvent {
  kind: "request";
  callId: string;
  toolName: string;
  params: Record<string, unknown>;
  tier: string;
  requestedAt: number;
  expiresAt: number | null;
  sessionId?: string;
  summary?: string;
  recipeName?: string;
  runSeq?: number;
}

export interface ApprovalDecisionEvent {
  kind: "decision";
  callId: string;
  decision: ApprovalDecision;
  decidedAt: number;
}

export type ApprovalLogEvent = ApprovalRequestEvent | ApprovalDecisionEvent;

/**
 * The directory that holds `approval_log.jsonl`. Honors `PATCHWORK_HOME`, the
 * same override every sibling durable log (`resolveOutcomeLogDir`,
 * `WorkerGateDecisionLog`) respects, so the write path (the live queue) and
 * any future read path (dashboard restore inspection, CLI) always resolve to
 * the same file.
 */
export function resolveApprovalLogDir(override?: string): string {
  return (
    // `patchworkHome()` rather than reading the env var here: it `resolve()`s a
    // RELATIVE override, so the path cannot re-point when the process changes
    // directory. This process has a CwdChanged hook, so that is live, not
    // theoretical — and an audit log that moves mid-session is the worst case.
    override ?? patchworkHome()
  );
}

const MAX_PARAMS_BYTES = 8 * 1024;

/**
 * Redact/truncate a request's params before they hit disk. Approval params
 * can carry secrets (a connector token in a tool call's arguments) — the
 * queue holds them in memory for live dispatch, but a durable log is a
 * different exposure: it outlives the process and gets read by `cat`,
 * `grep`, backups. Truncate rather than reject so an oversized/odd payload
 * never blocks a real approval from being durably recorded.
 */
function safeParams(params: Record<string, unknown>): Record<string, unknown> {
  try {
    const json = JSON.stringify(params);
    if (Buffer.byteLength(json, "utf8") <= MAX_PARAMS_BYTES) return params;
    return { truncated: true, preview: json.slice(0, MAX_PARAMS_BYTES) };
  } catch {
    return { unserializable: true };
  }
}

export class ApprovalPersistence {
  private readonly file: string;
  private readonly logger?: Logger;

  constructor(opts: { dir: string; logger?: Logger }) {
    this.file = path.join(opts.dir, "approval_log.jsonl");
    this.logger = opts.logger;
  }

  /**
   * Append a request event. Fail-soft: a logging failure must never block a
   * live approval (the same rule the gate-decision log follows) — errors are
   * swallowed after a best-effort log line.
   */
  recordRequest(entry: PendingApproval): void {
    const event: ApprovalRequestEvent = {
      kind: "request",
      callId: entry.callId,
      toolName: entry.toolName,
      params: safeParams(entry.params),
      tier: entry.tier,
      requestedAt: entry.requestedAt,
      expiresAt: entry.expiresAt,
      ...(entry.sessionId !== undefined && { sessionId: entry.sessionId }),
      ...(entry.summary !== undefined && { summary: entry.summary }),
      ...(entry.recipeName !== undefined && { recipeName: entry.recipeName }),
      ...(entry.runSeq !== undefined && { runSeq: entry.runSeq }),
    };
    this.append(event);
  }

  /** Append a decision event. Fail-soft, same rationale as `recordRequest`. */
  recordDecision(
    callId: string,
    decision: ApprovalDecision,
    decidedAt: number,
  ): void {
    const event: ApprovalDecisionEvent = {
      kind: "decision",
      callId,
      decision,
      decidedAt,
    };
    this.append(event);
  }

  private append(event: ApprovalLogEvent): void {
    try {
      mkdirSync(path.dirname(this.file), { recursive: true });
      withFileLockSync(this.file, () => {
        appendFileSync(this.file, `${JSON.stringify(event)}\n`, "utf8");
      });
    } catch (err) {
      this.logger?.warn?.(
        `[approvalPersistence] failed to write ${event.kind} event for ${event.callId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * Replay the full log and return every request that never got a matching
   * decision — the set to restore as pending on the next `ApprovalQueue`
   * construction. Malformed lines are skipped (torn-row guard: a process
   * killed mid-`appendFileSync` can leave a partial trailing line on some
   * filesystems) rather than aborting the whole restore.
   *
   * Fail-soft: an unreadable/missing file returns an empty list — restoring
   * nothing is the safe default (matches today's behaviour, where nothing
   * survives a restart at all).
   */
  loadUnresolvedRequests(): ApprovalRequestEvent[] {
    if (!existsSync(this.file)) return [];
    let text: string;
    try {
      text = readFileSync(this.file, "utf8");
    } catch (err) {
      this.logger?.warn?.(
        `[approvalPersistence] failed to read log for restore: ${err instanceof Error ? err.message : String(err)}`,
      );
      return [];
    }
    const requests = new Map<string, ApprovalRequestEvent>();
    const decided = new Set<string>();
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      let event: ApprovalLogEvent;
      try {
        event = JSON.parse(line);
      } catch {
        continue; // torn/partial row — skip, don't abort the whole replay
      }
      if (event.kind === "request") {
        requests.set(event.callId, event);
      } else if (event.kind === "decision") {
        decided.add(event.callId);
      }
    }
    const unresolved: ApprovalRequestEvent[] = [];
    for (const [callId, req] of requests) {
      if (!decided.has(callId)) unresolved.push(req);
    }
    return unresolved;
  }
}
