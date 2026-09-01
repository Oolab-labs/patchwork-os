/**
 * What Butler Home must KNOW, independent of how it is drawn.
 *
 * Pure. No fetch, no React, no clock read of its own — `mapButlerHome` takes
 * what five endpoints returned and produces one state. That separation is the
 * point: today `page.tsx` fetches five surfaces and interprets them inside the
 * component, so a redesign would carry that interpretation into prettier
 * components rather than leaving it behind.
 *
 * ## A failed source must never become a successful empty one
 *
 * The rule this module exists to enforce. An unreachable endpoint rendering as
 * `[]` is absence collapsing into a value, and it reads as reassurance: "Butler
 * knows nothing about you" and "I could not ask" are opposite facts, and only
 * one of them should let a reader relax.
 *
 * `page.tsx` already learned this the hard way — twice. The dashboard proxy
 * answers a dead bridge with a 502 whose BODY is valid JSON, so a `.json()`
 * parse succeeded and shape guards fell through to `[]`; and the bridge answers
 * 501 for a permission store it cannot read, which must not read as "you have
 * granted nothing". Both lessons are carried here rather than re-learned.
 *
 * ## Partial availability is representable, because today it is not
 *
 * The page loads all five with `Promise.all`, so ONE failure discards four
 * healthy sources and the whole screen becomes a single error. That is the
 * safe direction to fail, but it is still a collapse: five independent
 * availabilities reduced to one boolean. Every source here carries its own
 * `SourceState`, so a reader can be told what is known AND what could not be
 * checked, at the same time.
 *
 * ## It decides no policy
 *
 * Trust tiers, what counts as established, what a permission authorises — all
 * of that belongs to the runtime. This layer counts, groups and phrases. Where
 * it cannot answer, it says so.
 */

// ── What the endpoints return ────────────────────────────────────────────────

export interface ButlerFact {
  seq: number;
  subject: string;
  predicate: string;
  object: string;
  recordedAt: number;
  trust: number;
  provenance: {
    /** `user_chat` · `user_confirmed` · `recipe_agent` · `connector` · `import`. */
    channel: string;
    /** Connector slug when `channel === "connector"`. */
    source?: string;
    /** The channel's trust ceiling AS STORED, not recomputed. */
    tier: number;
    validated: boolean;
  };
}

export interface StandingPermission {
  id: string;
  grantedAt: number;
  /** Who granted it, or null on a grant made before attribution existed. */
  grantedBy: string | null;
  scope: { domains: string[] };
  ceiling?: { magnitudeBand?: string; perDay?: number };
  expiresAt?: number;
  revokedAt?: number;
  note?: string;
  active: boolean;
}

export interface PermissionExercise {
  permissionId: string;
  at: number;
  toolName: string;
  classKey: string;
  workerId?: string;
  recipeName?: string;
}

export interface PendingApproval {
  callId: string;
  toolName: string;
  tier: "low" | "medium" | "high";
  requestedAt: number;
  summary?: string;
}

// ── How a source is known ────────────────────────────────────────────────────

/**
 * One source's outcome. There is no third arm and no bare value.
 *
 * `unavailable` carries the REASON and no value, so a renderer physically
 * cannot show an empty list where a failure belongs.
 */
export type SourceState<T> =
  | { state: "read"; value: T }
  | { state: "unavailable"; reason: string };

export function isRead<T>(
  s: SourceState<T>,
): s is { state: "read"; value: T } {
  return s.state === "read";
}

/** The five surfaces, each with its own outcome. */
export interface ButlerSources {
  facts: SourceState<ButlerFact[]>;
  quarantine: SourceState<ButlerFact[]>;
  permissions: SourceState<StandingPermission[]>;
  exercises: SourceState<PermissionExercise[]>;
  approvals: SourceState<PendingApproval[]>;
}

// ── The state Home renders ───────────────────────────────────────────────────

/**
 * The headline.
 *
 * `cannot-tell` is NOT a worse `caught-up`. "Nothing is waiting for you" and
 * "I could not find out whether anything is waiting for you" differ by exactly
 * the thing a reader uses the page to decide, so they are separate arms and the
 * second carries its reason.
 */
export type ButlerStatus =
  | { kind: "needs-you"; count: number }
  | { kind: "caught-up" }
  | { kind: "cannot-tell"; reason: string };

export interface AttentionItem {
  callId: string;
  toolName: string;
  tier: "low" | "medium" | "high";
  requestedAt: number;
  summary?: string;
}

/**
 * An activity claim, limited to what these five sources can actually support.
 *
 * Deliberately NOT a generic event feed. Of the five surfaces only permission
 * exercises record Butler DOING something, and only facts and quarantine record
 * it coming to know something. Nothing here records a completed errand, a
 * refusal, or an approval that was granted and then acted on — so Home cannot
 * honestly render "checked your errands, nothing needed changing" today, however
 * much a timeline design wants that row.
 *
 * Inventing it is the failure this type exists to prevent: a sentence the data
 * cannot support is indistinguishable, to a reader, from one it can.
 */
export type ActivityClaim =
  /** From a permission exercise: Butler acted under standing permission. */
  | {
      kind: "acted-without-asking";
      at: number;
      toolName: string;
      permissionId: string;
    }
  /** From an established fact: Butler came to know something. */
  | { kind: "learned"; at: number; factSeq: number }
  /** From quarantine: Butler noticed something and has NOT used it. */
  | { kind: "noticed-not-used"; at: number; factSeq: number };

export interface MemorySummary {
  /** Beliefs Butler may act on. */
  established: SourceState<number>;
  /**
   * Low-trust observations held back from belief.
   *
   * Separate from `established` because the store separates them: connector-
   * derived material is capped below the threshold at which Butler may
   * originate a belief. One combined "things Butler knows" count would merge
   * two populations and erase a real safety boundary.
   */
  awaitingConfirmation: SourceState<number>;
}

export interface PermissionSummary {
  /**
   * Standing permissions currently in force.
   *
   * `unavailable` is a THIRD state, not a zero. The bridge answers 501 when it
   * cannot read the permission store, and "I cannot check what you have
   * allowed" must never render as "you have allowed nothing" — the reassuring
   * reading is the dangerous one here.
   */
  active: SourceState<number>;
  /**
   * Times Butler acted under a standing permission — ALL TIME, not a window.
   *
   * Not `recentExercises`: `/butler/permissions/exercises` returns the whole
   * log, and a name promising recency would have a renderer write "3 recent
   * actions" over a count spanning months. The endpoint would have to grow a
   * window before that sentence became true.
   *
   * Distinct from `active` on purpose: holding a permission and having acted on
   * it are different facts, and only the second is something Butler did.
   */
  actionsWithoutAsking: SourceState<number>;
}

export interface ButlerHomeState {
  status: ButlerStatus;
  attention: SourceState<AttentionItem[]>;
  activity: SourceState<ActivityClaim[]>;
  memory: MemorySummary;
  permissions: PermissionSummary;
  /**
   * Every source that could not be read, carried WHOLE.
   *
   * Never truncated and never summarised to a count: the reason a thing cannot
   * be shown is the most load-bearing prose on the page. Present even when the
   * other four sources are healthy — partial knowledge is the common case and
   * must not silently present as complete.
   */
  unavailable: { source: keyof ButlerSources; reason: string }[];
}

// ── The mapping ──────────────────────────────────────────────────────────────

/** Count a read source, or carry its unavailability forward untouched. */
function countOf<T>(s: SourceState<T[]>): SourceState<number> {
  return s.state === "read"
    ? { state: "read", value: s.value.length }
    : { state: "unavailable", reason: s.reason };
}

/**
 * Is this fact an established belief, or an observation held back from one?
 *
 * The threshold is the RUNTIME's, and this module does not own it. Quarantine
 * is a separate endpoint precisely so the caller does not have to decide: what
 * `/butler/facts` returns is established, what `/butler/quarantine` returns is
 * not. Re-deriving that from `trust` here would create a second opinion about a
 * safety boundary, which is how two notions of the same rule drift.
 */

/**
 * Fold the five surfaces into one Home state.
 *
 * Every uncertainty in, survives out. There is no path by which an
 * `unavailable` source becomes an empty collection.
 */
export function mapButlerHome(sources: ButlerSources): ButlerHomeState {
  const unavailable: ButlerHomeState["unavailable"] = [];
  for (const key of [
    "facts",
    "quarantine",
    "permissions",
    "exercises",
    "approvals",
  ] as const) {
    const s = sources[key];
    if (s.state === "unavailable") {
      unavailable.push({ source: key, reason: s.reason });
    }
  }

  // Status answers one question — does anything need you? — and only the
  // approvals surface can answer it. If that source failed, the honest answer
  // is that we cannot tell, EVEN IF the other four are healthy: a page saying
  // "everything is caught up" on four sources that cannot see a pending
  // decision is confidently wrong about the only thing it was asked.
  const status: ButlerStatus =
    sources.approvals.state === "unavailable"
      ? { kind: "cannot-tell", reason: sources.approvals.reason }
      : sources.approvals.value.length > 0
        ? { kind: "needs-you", count: sources.approvals.value.length }
        : { kind: "caught-up" };

  const attention: SourceState<AttentionItem[]> =
    sources.approvals.state === "read"
      ? {
          state: "read",
          value: sources.approvals.value.map((a) => ({
            callId: a.callId,
            toolName: a.toolName,
            tier: a.tier,
            requestedAt: a.requestedAt,
            ...(a.summary === undefined ? {} : { summary: a.summary }),
          })),
        }
      : { state: "unavailable", reason: sources.approvals.reason };

  // Activity is assembled only from claims these sources can support, and is
  // itself a SourceState: a partial timeline presented as a whole one is a
  // quieter version of the same lie. If any contributing source failed, the
  // list is not "what happened" — it is "some of what happened", and there is
  // no honest way to render that as a complete history.
  const contributors = [
    sources.exercises,
    sources.facts,
    sources.quarantine,
  ] as const;
  const firstFailed = contributors.find((s) => s.state === "unavailable");

  let activity: SourceState<ActivityClaim[]>;
  if (firstFailed && firstFailed.state === "unavailable") {
    activity = { state: "unavailable", reason: firstFailed.reason };
  } else {
    const claims: ActivityClaim[] = [];
    if (sources.exercises.state === "read") {
      for (const e of sources.exercises.value) {
        claims.push({
          kind: "acted-without-asking",
          at: e.at,
          toolName: e.toolName,
          permissionId: e.permissionId,
        });
      }
    }
    if (sources.facts.state === "read") {
      for (const f of sources.facts.value) {
        claims.push({ kind: "learned", at: f.recordedAt, factSeq: f.seq });
      }
    }
    if (sources.quarantine.state === "read") {
      for (const f of sources.quarantine.value) {
        claims.push({
          kind: "noticed-not-used",
          at: f.recordedAt,
          factSeq: f.seq,
        });
      }
    }
    claims.sort((a, b) => b.at - a.at);
    activity = { state: "read", value: claims };
  }

  return {
    status,
    attention,
    activity,
    memory: {
      established: countOf(sources.facts),
      awaitingConfirmation: countOf(sources.quarantine),
    },
    permissions: {
      // Only permissions still in force. A revoked or expired grant is history,
      // and counting it would overstate what Butler may currently do.
      active:
        sources.permissions.state === "read"
          ? {
              state: "read",
              value: sources.permissions.value.filter((p) => p.active).length,
            }
          : { state: "unavailable", reason: sources.permissions.reason },
      actionsWithoutAsking: countOf(sources.exercises),
    },
    unavailable,
  };
}
