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
  kind:
    | "destructive_flag"
    | "domain_reputation"
    | "path_escape"
    | "chaining"
    | "destructive_command"
    | "data_exfiltration";
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
  /**
   * Phase 0β provenance — recipe run that originated this approval.
   * Populated when the bridge can correlate the approval call to a
   * recipe-step context (the `personalSignals` pipeline already
   * sources from `recipe_run_log`, but that's read-only signal data;
   * these two fields surface the link itself on the wire so the
   * dashboard approval detail page can render an "originating run"
   * chip without re-deriving it from filenames or sessionId.
   *
   * TODO(phase-0β-pop): population is deferred — the immediate goal
   * is unblocking the dashboard schema. Computing the link without a
   * deeper refactor requires sessionId→runSeq mapping that today
   * lives behind `personalSignals.source: "recipe_run_log"`. Wiring
   * that explicitly into `handleApprovalRequest` is the follow-up.
   */
  runSeq?: number;
  recipeName?: string;
}

/**
 * Approval-decision discriminant.
 *
 * - `approved` / `rejected` — explicit human decision via /approve, /reject,
 *   or the phone-path approval token.
 * - `expired` — TTL fired without any decision (5-min window by default).
 * - `cancelled` — the originating client (recipe runner, agent task)
 *   abandoned the request before any decision was reached. Distinguishing
 *   this from `expired` matters for audit / phone UX: a `cancelled`
 *   decision should NOT count as a real approval/denial in the decision
 *   trace, and the phone-side notification can clear its prompt instead
 *   of leaving a stale "tap to approve" card. Audit 2026-05-17.
 */
export type ApprovalDecision =
  | "approved"
  | "rejected"
  | "expired"
  | "cancelled";

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
/**
 * Per-caller AbortSignal wiring for dedup-joined callers.
 *
 * When a fresh `request()` is deduped onto an existing entry, the
 * caller's signal must NOT cancel the underlying queue entry — that
 * would penalise the original caller (and any other dedup-joined
 * callers) for one abandonment. Instead, fire just this caller's
 * promise resolver with "cancelled", leaving the entry pending for
 * everyone else.
 *
 * Implementation: stash a per-caller resolver, splice it out of the
 * entry's `pendingPromises` list on abort.
 */
function wireAbortSignalForCaller(
  signal: AbortSignal | undefined,
  callerPromise: Promise<ApprovalDecision>,
  entry: Entry,
): void {
  if (!signal) return;
  // The resolver is the most-recently-pushed promise on the entry —
  // we just pushed it above. Stash a reference for cancellation.
  const resolver = entry.pendingPromises[entry.pendingPromises.length - 1];
  if (!resolver) return;
  const onAbort = () => {
    const idx = entry.pendingPromises.indexOf(resolver);
    if (idx >= 0) entry.pendingPromises.splice(idx, 1);
    resolver("cancelled");
  };
  if (signal.aborted) {
    Promise.resolve().then(onAbort);
  } else {
    signal.addEventListener("abort", onAbort, { once: true });
  }
  // Silence "unused" — the promise reference is held for type clarity.
  void callerPromise;
}

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
    opts: { withToken?: boolean; signal?: AbortSignal } = {},
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
        // Dedup-joined callers register their own AbortSignal so abandoning
        // one caller's recipe doesn't cancel the others' parallel runs.
        // Resolving with "cancelled" wakes only the abandoning caller's
        // promise — the entry stays alive for the original caller.
        // See `wireAbortSignalForCaller` for the semantic.
        wireAbortSignalForCaller(opts.signal, promise, existing);
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

    // Wire the originating caller's AbortSignal — when fired, the
    // whole entry transitions to "cancelled" (cleared from queue,
    // promise + all dedup-joined promises resolve). Audit 2026-05-17:
    // recipe cancellation used to leave the entry pending for the full
    // TTL, with the phone-side card still live and tap-decisions
    // recorded in the decision trace despite no tool execution.
    if (opts.signal) {
      const onAbort = () => {
        this.cancel(callId);
      };
      if (opts.signal.aborted) {
        // Already aborted before request returned — resolve synchronously.
        // Use a microtask so the caller's `promise` is observable first.
        Promise.resolve().then(onAbort);
      } else {
        opts.signal.addEventListener("abort", onAbort, { once: true });
      }
    }

    return { callId, approvalToken, promise };
  }

  /**
   * Cancel a pending approval entry. Resolves the originating caller's
   * promise + every dedup-joined caller's promise with `"cancelled"`.
   * Removes the entry from the queue (frees the inflight slot) and
   * records the outcome in `recentlyDecided` so the HTTP layer can
   * surface "already_decided" if a stale phone-tap arrives later.
   *
   * Returns `true` when an entry was found and cancelled, `false` when
   * the callId is unknown (idempotent — safe to call multiple times).
   */
  cancel(callId: string): boolean {
    return this.resolveEntry(callId, "cancelled");
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

  /**
   * Cancel every still-pending entry, resolving each with "cancelled".
   * Used when the operator downgrades the approval gate to "off" so
   * phone approvers don't see "Approve" buttons whose token is now
   * meaningless (the originating tool dispatch already short-circuited
   * to bypass on the new gate). Returns the number of entries that
   * were cancelled.
   */
  cancelAll(): number {
    let n = 0;
    for (const id of this.entries.keys()) {
      if (this.resolveEntry(id, "cancelled")) n++;
    }
    return n;
  }

  list(): PendingApproval[] {
    const result: PendingApproval[] = [];
    for (const e of this.entries.values()) {
      result.push({
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
      });
    }
    return result;
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
