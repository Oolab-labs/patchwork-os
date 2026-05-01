import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
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
  /**
   * Stable key derived from `(sessionId, toolName, params)`. Multiple `request()`
   * calls with the same key share the entry's promise instead of creating a
   * new one each time. Without this, a buggy/malicious agent firing the same
   * approval call N times spawns N queue entries and N push notifications.
   */
  inflightKey: string;
  /** Promise resolvers attached to the same dedup key after the first call. */
  pendingPromises: Array<(d: ApprovalDecision) => void>;
}

/**
 * Stable canonical JSON used to compute the `inflightKey`. Sorts object
 * keys at every level so logically-identical params with different key
 * order hash the same. Returns "[uncloneable]" if input contains circular
 * references — those won't dedup, but the queue still works.
 */
function canonicalJson(value: unknown): string {
  const seen = new WeakSet<object>();
  const stringify = (v: unknown): unknown => {
    if (v === null || typeof v !== "object") return v;
    if (seen.has(v as object)) return "[circular]";
    seen.add(v as object);
    if (Array.isArray(v)) return v.map(stringify);
    const obj = v as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(obj).sort()) out[k] = stringify(obj[k]);
    return out;
  };
  try {
    return JSON.stringify(stringify(value));
  } catch {
    return "[uncloneable]";
  }
}

export class ApprovalQueue {
  private readonly entries = new Map<string, Entry>();
  /** inflightKey → callId, for dedup lookup on `request()`. */
  private readonly inflight = new Map<string, string>();
  private readonly ttlMs: number;
  private readonly listeners = new Set<() => void>();

  constructor(opts: { ttlMs?: number } = {}) {
    this.ttlMs = opts.ttlMs ?? 5 * 60_000;
  }

  /** Subscribe to queue changes (enqueue + resolve). Returns unsubscribe fn. */
  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private notify(): void {
    for (const fn of this.listeners) {
      try {
        fn();
      } catch {
        /* ignore listener errors */
      }
    }
  }

  request(
    input: Omit<PendingApproval, "callId" | "requestedAt">,
    opts: { withToken?: boolean } = {},
  ): {
    callId: string;
    approvalToken?: string;
    promise: Promise<ApprovalDecision>;
  } {
    // Dedup: if an identical (sessionId, toolName, params) request is already
    // queued, return its existing promise instead of allocating a fresh
    // callId + push notification. Prevents a buggy/malicious agent that
    // spams the same call N times from generating N prompts.
    const inflightKey = createHash("sha256")
      .update(input.sessionId ?? "")
      .update("\0")
      .update(input.toolName)
      .update("\0")
      .update(canonicalJson(input.params))
      .digest("hex");
    const existingCallId = this.inflight.get(inflightKey);
    if (existingCallId) {
      const existing = this.entries.get(existingCallId);
      if (existing) {
        const promise = new Promise<ApprovalDecision>((res) => {
          existing.pendingPromises.push(res);
        });
        return {
          callId: existing.callId,
          approvalToken: existing.approvalToken,
          promise,
        };
      }
      // Stale inflight entry pointing at a callId that no longer exists —
      // fall through and create a fresh request.
      this.inflight.delete(inflightKey);
    }

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
      this.inflight.delete(entry.inflightKey);
      entry.resolve("expired");
      for (const r of entry.pendingPromises) r("expired");
      this.notify();
    }, this.ttlMs);
    if (typeof timer === "object" && "unref" in timer) timer.unref();

    this.entries.set(callId, {
      callId,
      requestedAt,
      resolve: resolveFn,
      timer,
      approvalToken,
      inflightKey,
      pendingPromises: [],
      ...input,
    });
    this.inflight.set(inflightKey, callId);
    this.notify();
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
      // Wake up any duplicate callers who joined this entry via dedup —
      // their promises would otherwise hang forever after shutdown /
      // resetApprovalQueueForTests.
      for (const r of entry.pendingPromises) r("expired");
    }
    this.entries.clear();
    // Drain dedup map. Stale entries are self-healing on the next request,
    // but leaving them around leaks memory across shutdown cycles and is
    // the wrong invariant for `clear()`.
    this.inflight.clear();
  }

  private resolveEntry(callId: string, decision: ApprovalDecision): boolean {
    const entry = this.entries.get(callId);
    if (!entry) return false;
    clearTimeout(entry.timer);
    this.entries.delete(callId);
    this.inflight.delete(entry.inflightKey);
    entry.resolve(decision);
    // Wake up any duplicate callers who joined this entry via dedup.
    for (const r of entry.pendingPromises) r(decision);
    this.notify();
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
