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
  /**
   * Passive risk personalization signals (`src/approvalSignals.ts`).
   * Distinct from `riskSignals`: those describe call CONTENT (rm -rf,
   * non-HTTPS URL); these describe the user's RELATIONSHIP to the tool
   * (prior approvals, prior rejections, first-time use). Both should
   * reach the dashboard approval modal. Omitted when no signals fire
   * to keep the lifecycle/wire payload small.
   */
  personalSignals?: import("./approvalSignals.js").PersonalSignal[];
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
  /**
   * Failed-attempt counter for the phone-path approval token. Defends
   * against brute-force without letting wrong-token POSTs invalidate the
   * legitimate approver's token (the prior "clear on first check regardless"
   * design was a DoS: any unauthenticated POST with a syntactically-valid
   * callId — e.g. one disclosed via a webhook target or `/approvals`
   * leak — could permanently lock out the rightful approver).
   *
   * Token is cleared only on successful match. After
   * `MAX_TOKEN_FAILURES` mismatches, the entry's token is treated as
   * expired (no further validation succeeds for this callId).
   */
  tokenFailures: number;
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
  /**
   * callId → its decision + timestamp, kept for RECENTLY_DECIDED_TTL_MS
   * after resolveEntry runs. Lets a concurrent counter-decision (e.g.
   * dashboard denies while phone approves in the same window) be told
   * "already decided as X" rather than an indistinguishable 404.
   */
  private readonly recentlyDecided = new Map<
    string,
    { decision: ApprovalDecision; at: number }
  >();
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
      tokenFailures: 0,
      ...input,
    });
    this.inflight.set(inflightKey, callId);
    this.notify();
    return { callId, approvalToken, promise };
  }

  /**
   * Hard cap on failed validateToken attempts per callId. Once exceeded,
   * the token is treated as expired.
   *
   * The cap is **memory/CPU theatre, not a brute-force defense** — token
   * entropy is 256 bits, so even at 200 req/s × 5-min TTL = 60 000
   * attempts vs 2^256 keyspace is astronomically below the keyspace. The
   * earlier 5-attempt cap was found by audit to enable a *new* DoS:
   * an attacker who burned 4 failures on a leaked callId locked the
   * legitimate approver out after one typo. Same scenario applied to
   * dedup-reused entries (an agent re-requesting the same
   * `(sessionId, toolName, params)` inherited the entry's accumulated
   * `tokenFailures`).
   *
   * Bumping the cap to 1000 leaves the legitimate approver with ample
   * retry budget while still bounding memory/CPU on a sustained
   * misbehaving client. The HTTP-level rate limit on `/approve` /
   * `/reject` is where real spray defense should live; track in a
   * follow-up.
   */
  private static readonly MAX_TOKEN_FAILURES = 1000;

  /**
   * Validate a phone-path approval token for the given callId.
   *
   * On a successful match, the token is cleared (single-use against
   * approver-side replay). On a mismatch, the token is preserved so a
   * subsequent legitimate POST still works.
   *
   * Uses timing-safe comparison.
   */
  validateToken(callId: string, token: string): boolean {
    const entry = this.entries.get(callId);
    if (!entry?.approvalToken) return false;
    if (entry.tokenFailures >= ApprovalQueue.MAX_TOKEN_FAILURES) {
      // Locked out — treat as expired without leaking timing on the compare.
      return false;
    }
    const expected = Buffer.from(entry.approvalToken, "utf8");
    const provided = Buffer.from(token, "utf8");
    let matched = false;
    if (expected.length === provided.length) {
      matched = timingSafeEqual(expected, provided);
    }
    if (matched) {
      // Single-use — clear only on success so the legitimate approver
      // cannot be locked out by a garbage-token spray.
      entry.approvalToken = undefined;
      return true;
    }
    entry.tokenFailures++;
    return false;
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
      personalSignals: e.personalSignals,
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
    this.recentlyDecided.clear();
  }

  private resolveEntry(callId: string, decision: ApprovalDecision): boolean {
    const entry = this.entries.get(callId);
    if (!entry) return false;
    clearTimeout(entry.timer);
    this.entries.delete(callId);
    this.inflight.delete(entry.inflightKey);
    // Record the decision in the short-lived `recentlyDecided` map so a
    // concurrent counter-decision (dashboard denies while phone approves
    // in the same window) can be told "already decided as X" instead of
    // an indistinguishable 404 "unknown callId". Audit 2026-05-17.
    this.recentlyDecided.set(callId, { decision, at: Date.now() });
    this.pruneRecentlyDecided();
    entry.resolve(decision);
    // Wake up any duplicate callers who joined this entry via dedup.
    for (const r of entry.pendingPromises) r(decision);
    this.notify();
    return true;
  }

  /**
   * Lookup the decision for a `callId` that has already been resolved.
   * Returns `null` when the callId was never seen, or when its decision
   * is older than `RECENTLY_DECIDED_TTL_MS` (then it falls back to the
   * historical "unknown callId" behaviour).
   *
   * Caller (`approvalHttp`) uses this to upgrade a 404 into a 409
   * `already_decided` response so the losing UI can converge.
   */
  getRecentDecision(callId: string): ApprovalDecision | null {
    this.pruneRecentlyDecided();
    const entry = this.recentlyDecided.get(callId);
    return entry ? entry.decision : null;
  }

  private pruneRecentlyDecided(): void {
    const cutoff = Date.now() - RECENTLY_DECIDED_TTL_MS;
    for (const [k, v] of this.recentlyDecided) {
      if (v.at < cutoff) this.recentlyDecided.delete(k);
    }
  }
}

/**
 * How long after resolve() the queue remembers a callId → decision
 * mapping. Long enough that a concurrent counter-decision in the same
 * second sees the right "already decided" response; short enough that
 * the map can't grow unbounded under load (entries also get pruned at
 * every read).
 */
const RECENTLY_DECIDED_TTL_MS = 60_000;

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
