/**
 * Information boundary — declared labels and the boundary decision (ADR-0021,
 * Phases 1 and 2).
 *
 * The invariant this exists to hold:
 *
 *   > No model-bound context leaves Patchwork without passing the
 *   > information-boundary decision point.
 *
 * Two properties are deliberate and load-bearing.
 *
 * **Declared, never detected.** A step says what it carries; a destination says
 * what it may receive. Nothing is inferred. ADR-0021 rules detection out on the
 * grounds that a detector which IS the boundary fails silently on everything it
 * does not recognise, and its recall is unknowable. A detector may later suggest
 * a classification; policy still decides.
 *
 * **Pure.** The decision is a function of (declared policy, destination policy)
 * and nothing else — no clock, no filesystem, no model. That is what makes it
 * testable without a model in the loop, and what stops the boundary being
 * enforced by the thing it constrains.
 */

/**
 * Sensitivity ladder, ordered. The order is the whole comparison: a destination
 * cleared for `internal` is cleared for `public`, never the reverse.
 */
export const CLASSIFICATIONS = [
  "public",
  "internal",
  "personal",
  "confidential",
  "restricted",
] as const;

export type Classification = (typeof CLASSIFICATIONS)[number];

/**
 * Default for a step that declares nothing.
 *
 * `internal` rather than `restricted`, deliberately. Every existing recipe
 * declares nothing, so a strict default would refuse the entire installed base
 * on upgrade to solve a problem those installs do not have — and a boundary
 * that breaks everything on day one gets switched off, which protects nobody.
 * Same fail-soft reasoning as the identity roster's implicit owner.
 */
export const DEFAULT_CLASSIFICATION: Classification = "internal";

export function classificationRank(c: Classification): number {
  return CLASSIFICATIONS.indexOf(c);
}

/** What a step declares it is carrying. */
export interface DataPolicy {
  classification: Classification;
  /** Free-form tags (e.g. "financial"). Used for redaction, not for ranking. */
  categories?: string[];
}

/** What a destination declares it may receive. */
export interface Destination {
  id: string;
  /** `local` never leaves the machine; `remote` crosses a network boundary. */
  type: "local" | "remote";
  /** Classifications this destination is cleared for. */
  classifications: Classification[];
  /**
   * Categories this destination must never receive even when it is cleared for
   * the classification. Redaction removes them; if they cannot be removed the
   * decision escalates rather than silently sending them.
   */
  forbiddenCategories?: string[];
  /**
   * Whether a human may authorise an otherwise-refused send. Absent means no:
   * the refusal stands, which keeps DENY meaningful as "no approval unlocks
   * this" exactly as the autonomy gate's `forbid` does.
   */
  approvable?: boolean;
}

/**
 * The five outcomes.
 *
 * `LOCAL_ONLY` is distinct from `DENY` on purpose: it means the data may be
 * processed, just not here. It is a routing instruction, and the caller is
 * expected to retry against a local destination rather than fail the step.
 */
export type BoundaryDecision =
  | "ALLOW"
  | "ALLOW_REDACTED"
  | "LOCAL_ONLY"
  | "REQUIRE_APPROVAL"
  | "DENY";

export interface BoundaryOutcome {
  decision: BoundaryDecision;
  /** One sentence, safe to show a human. Never contains the payload. */
  reason: string;
  /** Categories that must be removed before dispatch (ALLOW_REDACTED only). */
  redactCategories?: string[];
}

/**
 * Decide whether `policy` may be sent to `destination`.
 *
 * The rule table, in evaluation order:
 *
 *   1. destination not cleared for the classification
 *        → LOCAL_ONLY if a local destination could take it, else
 *          REQUIRE_APPROVAL if the destination is approvable, else DENY
 *   2. cleared, but carries a forbidden category
 *        → ALLOW_REDACTED (the category is removable)
 *   3. otherwise → ALLOW
 *
 * Rule 1 runs FIRST and is not reachable past. A destination cannot become
 * cleared by redacting a category, because the classification is a property of
 * the step as a whole — dropping a tag does not declassify what remains.
 */
export function decideBoundary(
  policy: DataPolicy,
  destination: Destination,
  opts: { localDestinationAccepts?: boolean } = {},
): BoundaryOutcome {
  const cleared = destination.classifications.includes(policy.classification);

  if (!cleared) {
    if (destination.type === "remote" && opts.localDestinationAccepts) {
      return {
        decision: "LOCAL_ONLY",
        reason: `"${policy.classification}" may not leave the machine; a local destination accepts it`,
      };
    }
    if (destination.approvable) {
      return {
        decision: "REQUIRE_APPROVAL",
        reason: `"${destination.id}" is not cleared for "${policy.classification}"; a human may authorise this send`,
      };
    }
    return {
      decision: "DENY",
      reason: `"${destination.id}" is not cleared for "${policy.classification}" and no approval can unlock it`,
    };
  }

  const forbidden = destination.forbiddenCategories ?? [];
  const carried = policy.categories ?? [];
  const hits = carried.filter((c) => forbidden.includes(c));
  if (hits.length > 0) {
    return {
      decision: "ALLOW_REDACTED",
      reason: `"${destination.id}" is cleared for "${policy.classification}" but must not receive: ${hits.join(", ")}`,
      redactCategories: hits,
    };
  }

  return {
    decision: "ALLOW",
    reason: `"${destination.id}" is cleared for "${policy.classification}"`,
  };
}

/**
 * Parse a step's declared `data_policy`, falling back to the default.
 *
 * An UNRECOGNISED classification is not silently defaulted — it returns null so
 * the caller can fail closed. Defaulting a typo to `internal` would let
 * `classification: confidentail` sail through as ordinary internal data, which
 * is precisely the failure a declared-labels scheme cannot afford: the operator
 * believes they labelled it and the system believes they did not.
 */
export function parseDataPolicy(raw: unknown): DataPolicy | null {
  if (raw === undefined || raw === null) {
    return { classification: DEFAULT_CLASSIFICATION };
  }
  if (typeof raw !== "object") return null;
  const obj = raw as { classification?: unknown; categories?: unknown };
  const c = obj.classification;
  let classification: Classification;
  if (c === undefined) {
    classification = DEFAULT_CLASSIFICATION;
  } else if (
    typeof c === "string" &&
    (CLASSIFICATIONS as readonly string[]).includes(c)
  ) {
    classification = c as Classification;
  } else {
    return null;
  }
  const categories = Array.isArray(obj.categories)
    ? obj.categories.filter((x): x is string => typeof x === "string")
    : undefined;
  return categories ? { classification, categories } : { classification };
}

/**
 * NEVER-WIDEN composition, mirroring the autonomy gate's rule.
 *
 * A later stage may restrict further; it may never restore what an earlier one
 * removed. Applied by taking the MORE restrictive of two decisions, so ordering
 * the stages wrongly cannot loosen the result.
 */
const RESTRICTIVENESS: Record<BoundaryDecision, number> = {
  ALLOW: 0,
  ALLOW_REDACTED: 1,
  LOCAL_ONLY: 2,
  REQUIRE_APPROVAL: 3,
  DENY: 4,
};

export function narrowest(
  a: BoundaryOutcome,
  b: BoundaryOutcome,
): BoundaryOutcome {
  return RESTRICTIVENESS[b.decision] > RESTRICTIVENESS[a.decision] ? b : a;
}
