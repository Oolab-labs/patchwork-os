/**
 * Butler's durable model of the user.
 *
 * Separate from `decision_traces.jsonl` on purpose: that log rotates by size
 * and SILENTLY DROPS THE OLDEST ROWS (`decisionTraceLog.ts` — correct for an
 * ops log, catastrophic for "I'm allergic to shellfish"). A belief store must
 * never quietly forget.
 *
 * Three design rules carry the whole thing:
 *
 * 1. APPEND-ONLY, never rewritten. Supersession and retraction are recorded as
 *    new rows and applied at READ time. Continuously rewriting stored memories
 *    with a model corrupts them (arXiv 2605.12978), and an append-only log is
 *    also the only shape that can answer "what did Butler believe last Tuesday".
 *
 * 2. RESOLUTION IS A PURE FUNCTION, never a model call. On the FactConsolidation
 *    benchmark — where the tie-break rule is spelled out in the prompt —
 *    LLM-resolved systems score 7–18% while splitting it into "model finds
 *    candidates, code picks the winner" reaches 82–93% (arXiv 2606.01435). See
 *    `resolve.ts`.
 *
 * 3. TRUST = min(provenance, content). An attacker confined to a low-tier
 *    channel cannot move a belief no matter how authoritatively it is phrased
 *    (arXiv 2606.22030). Connector-derived text sits below every write
 *    threshold by construction — see `PROVENANCE_TIER`.
 */

/** Where a claim came from. Ordered loosely by how much the user authored it. */
export type ProvenanceChannel =
  | "user_chat" // the user typed it at Butler
  | "user_confirmed" // the user affirmed a proposal (a positive act)
  | "recipe_agent" // an agent step inside a recipe the user authored
  | "connector" // text pulled from email / chat / calendar / issues
  | "import"; // restored from an export

/**
 * Channel → trust ceiling. HARD-CODED, deliberately not configurable from a
 * recipe or a manifest: the whole defence is that a channel cannot promote
 * itself. A recipe that could raise `connector` to 1.0 would hand the attacker
 * the pen.
 *
 * `connector` sits at 0.3 — below every write threshold — because any text
 * Butler READS is attacker-controlled by definition. Anyone who can email the
 * user can put words in it. This is OWASP ASI06 (memory poisoning), whose
 * defining property is temporal decoupling: planted now, acted on weeks later,
 * invisible in testing.
 */
export const PROVENANCE_TIER: Record<ProvenanceChannel, number> = {
  user_chat: 1.0,
  user_confirmed: 1.0,
  recipe_agent: 0.6, // may reinforce an existing belief, may not originate one
  connector: 0.3, // may never, on its own, establish anything
  import: 0.3, // never upgraded on the way in
};

/** Minimum trust to establish a NEW belief that nothing else asserts. */
export const ORIGINATE_THRESHOLD = 0.6;

/** Minimum trust to write a standing instruction ("always CC my accountant").
 *  Only the user. A connector proposing one is the archetypal ASI06 attack. */
export const STANDING_THRESHOLD = 1.0;

export interface FactProvenance {
  channel: ProvenanceChannel;
  /** Connector slug when `channel === "connector"` (e.g. "gmail"). */
  source?: string;
  /** Message id / run seq / trace seq — the receipt for this claim. */
  sourceRef?: string;
  /** Trust ceiling of the channel. Stored, not recomputed, so a later change
   *  to PROVENANCE_TIER cannot retroactively rewrite what a past row was
   *  trusted at. */
  tier: number;
  /** Did a human affirm this specific row. Never set by a recipe. */
  validated: boolean;
}

export interface ButlerFact {
  /** Monotonic per store. The deterministic tie-break in `resolve.ts`. */
  seq: number;
  /**
   * Whose fact this is. NEVER defaulted to the implicit owner: an
   * unauthenticated principal writes `null`, which means "unattributed".
   * Writing a real person's name onto an unevidenced claim is worse than an
   * absent one, and per-member auth does not exist yet (ADR-0020).
   */
  ownerId: string | null;
  /** What the fact is about: "user" | "household.spouse" | "car.volvo". */
  subject: string;
  /** Which attribute: "diet.avoid" | "timezone" | "prefers.meeting_length". */
  predicate: string;
  /** The value. Empty string is legal (an explicit "none"); use a retraction
   *  row to say "this no longer holds". */
  object: string;

  // ── bitemporal ────────────────────────────────────────────────────────────
  /** When we recorded it (transaction time). */
  recordedAt: number;
  /** When it started being true in the world (valid time). Defaults to
   *  recordedAt — most claims are asserted about the present. */
  validFrom: number;
  /** When it stopped being true. Set by a retraction ROW, never by mutating
   *  this one. */
  validUntil?: number;

  provenance: FactProvenance;
  /** Confidence from the claim's own wording ("maybe" lowers, "confirmed"
   *  raises). Defaults to 1 — an unhedged statement. */
  contentConfidence: number;
  /** min(provenance.tier, contentConfidence), precomputed so retrieval never
   *  has to recompute a security-relevant number. */
  trust: number;

  /** seq of the row this replaces, when known. Advisory: `resolve.ts` does not
   *  depend on it, so a missing link degrades to normal recency ordering. */
  supersedes?: number;
  /** Set on a tombstone row: the seq being retracted. */
  retracts?: number;
}

/** Field caps. A belief is a sentence, not a transcript. */
export const MAX_SUBJECT_CHARS = 128;
export const MAX_PREDICATE_CHARS = 128;
export const MAX_OBJECT_CHARS = 512;
