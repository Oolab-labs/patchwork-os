import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { RiskTier } from "./riskTier.js";

/**
 * ApprovalQueue — tiny in-memory registry of pending high-risk tool calls
 * awaiting human approve/reject from the dashboard. Replaces no existing
 * mechanism; bridge tool dispatch does not currently gate on risk tier. This
 * is the landing pad for that future wiring.
 *
 * Design:
 *  - Each pending call gets a UUID callId
 *  - Dashboard GET /approvals lists them; POST /approve/:callId or /reject/:callId resolves
 *  - TTL prevents zombie entries if the dashboard never responds
 */

export interface RiskSignal {
  kind: "destructive_flag" | "domain_reputation" | "path_escape" | "chaining";
  label: string;
  severity: "low" | "medium" | "high";
}

export interface PendingApproval {
  callId: string;
  toolName: string;
  params: Record<string, unknown>;
  tier: RiskTier;
  requestedAt: number;
  sessionId?: string;
  summary?: string;
  riskSignals?: RiskSignal[];
  /** 256-bit hex token for phone-path approve/reject. Only present when push is configured. */
  approvalToken?: string;
}

export type ApprovalDecision = "approved" | "rejected" | "expired";

interface Entry extends PendingApproval {
  resolve: (d: ApprovalDecision) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class ApprovalQueue {
  private readonly entries = new Map<string, Entry>();
  private readonly ttlMs: number;

  constructor(opts: { ttlMs?: number } = {}) {
    this.ttlMs = opts.ttlMs ?? 5 * 60_000;
  }

  request(
    input: Omit<PendingApproval, "callId" | "requestedAt">,
    opts: { withToken?: boolean } = {},
  ): {
    callId: string;
    approvalToken?: string;
    promise: Promise<ApprovalDecision>;
  } {
    const callId = randomUUID();
    const requestedAt = Date.now();
    const approvalToken = opts.withToken
      ? randomBytes(32).toString("hex")
      : undefined;
    let resolveFn!: (d: ApprovalDecision) => void;
    const promise = new Promise<ApprovalDecision>((res) => {
      resolveFn = res;
    });
    const timer = setTimeout(() => {
      const entry = this.entries.get(callId);
      if (!entry) return;
      this.entries.delete(callId);
      entry.resolve("expired");
    }, this.ttlMs);
    if (typeof timer === "object" && "unref" in timer) timer.unref();

    this.entries.set(callId, {
      callId,
      requestedAt,
      resolve: resolveFn,
      timer,
      approvalToken,
      ...input,
    });
    return { callId, approvalToken, promise };
  }

  /**
   * Validate a phone-path approval token for the given callId.
   * Tokens are single-use: deleted from the entry after first check regardless of outcome.
   * Returns true only if the token matches. Uses timing-safe comparison.
   */
  validateToken(callId: string, token: string): boolean {
    const entry = this.entries.get(callId);
    if (!entry?.approvalToken) return false;
    const expected = Buffer.from(entry.approvalToken, "utf8");
    const provided = Buffer.from(token, "utf8");
    // Clear token immediately — single-use regardless of outcome
    entry.approvalToken = undefined;
    if (expected.length !== provided.length) return false;
    return timingSafeEqual(expected, provided);
  }

  approve(callId: string): boolean {
    return this.resolveEntry(callId, "approved");
  }

  reject(callId: string): boolean {
    return this.resolveEntry(callId, "rejected");
  }

  list(): PendingApproval[] {
    return [...this.entries.values()].map((e) => ({
      callId: e.callId,
      toolName: e.toolName,
      params: e.params,
      tier: e.tier,
      requestedAt: e.requestedAt,
      sessionId: e.sessionId,
      summary: e.summary,
      riskSignals: e.riskSignals,
      // approvalToken intentionally omitted from list — never expose to untrusted callers
    }));
  }

  size(): number {
    return this.entries.size;
  }

  /** Clear all pending entries (test hook, also on bridge shutdown). */
  clear(): void {
    for (const entry of this.entries.values()) {
      clearTimeout(entry.timer);
      entry.resolve("expired");
    }
    this.entries.clear();
  }

  private resolveEntry(callId: string, decision: ApprovalDecision): boolean {
    const entry = this.entries.get(callId);
    if (!entry) return false;
    clearTimeout(entry.timer);
    this.entries.delete(callId);
    entry.resolve(decision);
    return true;
  }
}

/** Process-wide singleton — dashboard + bridge share one queue. */
let singleton: ApprovalQueue | undefined;
export function getApprovalQueue(): ApprovalQueue {
  if (!singleton) singleton = new ApprovalQueue();
  return singleton;
}

/** Test hook only. */
export function resetApprovalQueueForTests(): void {
  singleton?.clear();
  singleton = undefined;
}
