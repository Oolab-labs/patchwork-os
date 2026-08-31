/**
 * The information boundary's public surface, for a consumer outside this
 * package.
 *
 * ## Why this is a second barrel and not more of `./gate`
 *
 * They answer different questions and must stay separable. The autonomy gate
 * answers *what may this worker DO*; the information boundary answers *what may
 * this destination RECEIVE*. A consumer that conflated them would show a
 * refusal under the wrong heading, and the two refusals have opposite remedies:
 * a gated action waits for a person, a `LOCAL_ONLY` dispatch waits for a
 * different destination.
 *
 * ## Same reason as `./gate`, applied to a second engine
 *
 * `decideBoundary` is a pure function of (declared classification, destination
 * policy) with no model in the loop — deliberately, so it is replayable and
 * testable, and so the boundary is not enforced by the thing it constrains.
 * That makes it exactly the kind of decision an external console should CALL
 * rather than reconstruct.
 *
 * Reconstructing it is the alternative, and it is worse than it looks. The
 * residue in `boundary_receipts.jsonl` records what was decided, not the rule
 * that decided it, so a console deriving the boundary from receipts would be
 * inferring policy from outcomes — and would quietly disagree the moment a
 * destination's clearances changed, in the direction that shows a refusal
 * where there is now an allow.
 *
 * ## This is a re-export, and it must stay one
 *
 * Every binding below is the identity of the symbol it names. Nothing wraps,
 * adapts or defaults. `privacySubpathExport.test.ts` asserts reference identity
 * against the source modules and fails if that changes — the same guard, for
 * the same reason, as the gate barrel.
 *
 * ## Scope: the decision, not the ledger
 *
 * Exported: how data is CLASSIFIED, which destination a dispatch RESOLVES to,
 * what the boundary DECIDES, and how to describe a destination to a human. Not
 * exported: `BoundaryReceiptLog` or anything else that writes. A consumer of
 * this surface asks questions; the runtime remains the only thing that records.
 */

// ── What the data is, and what a destination may receive ─────────────────────

export {
  type BoundaryDecision,
  type BoundaryOutcome,
  CLASSIFICATIONS,
  type Classification,
  classificationRank,
  type DataPolicy,
  DEFAULT_CLASSIFICATION,
  type Destination,
  decideBoundary,
  narrowest,
  parseDataPolicy,
} from "./privacy/dataPolicy.js";

// ── Which destination a dispatch actually resolves to ────────────────────────
//
// `resolveDestination` returns `localDestinationAccepts` alongside the
// destination, and BOTH must be passed to `decideBoundary`. Dropping the second
// is not a cosmetic omission: it turns `LOCAL_ONLY` ("a local destination
// accepts this — set `driver: local`") into `DENY` ("no approval can unlock
// it"). Nothing leaks either way, which is why that defect survives review; it
// is wrong in the SENTENCE, telling an operator their situation is unfixable
// while a registered local destination would take the data.

export {
  type DestinationConfig,
  isLocalFamilyDriver,
  type ParsedRegistry,
  type PrivacyConfig,
  parseRegistry,
  type ResolveDestinationOptions,
  type ResolvedDestination,
  resolveDestination,
} from "./privacy/destinationRegistry.js";

// ── Saying what a destination is, to a person ────────────────────────────────
//
// The disclosure states only what is true by construction: whether the prompt
// leaves the machine, over the network, to the named destination. It carries no
// retention period, deletion promise or training claim, because such a claim
// rots without a code change and a claim the code cannot keep is worse than
// none — it is believed. Provider behaviour belongs in an operator `note`, and
// an undated or stale note is reported as undated or stale.

export {
  ALL_CLASSIFICATIONS,
  type DescribedDestination,
  type DescribeOptions,
  type DestinationNote,
  describeDestinations,
  disclosureFor,
  noteIsStale,
} from "./privacy/describeDestinations.js";
