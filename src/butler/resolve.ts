/**
 * Turn an append-only fact log into "what Butler currently believes".
 *
 * PURE. No I/O, no clock of its own, no model call. That last one is the whole
 * point: on the FactConsolidation benchmark — where the tie-break rule is
 * stated IN THE PROMPT — systems that delegate consolidation to the model score
 * 7–18%, while splitting it into "model finds candidates, code picks the
 * winner" reaches 82–93% (arXiv 2606.01435). Retrieval is the fuzzy half;
 * deciding which of two contradictory rows wins is arithmetic, and arithmetic
 * belongs in code.
 *
 * Precedence for one (subject, predicate), in order:
 *   0. drop erased rows                  — content removed under GDPR Art. 17
 *   1. drop rows not valid at `now`      — expired or not yet in force
 *   2. drop rows below `minTrust`        — the poisoning floor
 *   3. drop rows retracted by a tombstone
 *   4. highest `trust` wins              — a user statement beats an inference
 *   5. then highest `seq` wins           — later beats earlier
 *
 * Trust outranks recency deliberately. If a low-tier channel could win merely
 * by being newer, an attacker would only need to be last, and volume alone
 * would defeat the tier ceiling.
 */

import type { ButlerFact } from "./types.js";

export interface ResolveOpts {
  /** Wall clock for the validity window. Required — never defaulted to
   *  Date.now() inside a pure function. */
  now: number;
  /** Floor on `fact.trust`. Defaults to 0 (keep everything). */
  minTrust?: number;
  /** Restrict to one owner. `undefined` means "no filter"; pass `null`
   *  explicitly to select unattributed rows. */
  ownerId?: string | null;
}

/** `${subject}\u0000${predicate}` — NUL cannot occur in either field. */
export function factKey(subject: string, predicate: string): string {
  return `${subject}\u0000${predicate}`;
}

function validAt(f: ButlerFact, now: number): boolean {
  if (f.validFrom > now) return false;
  if (f.validUntil !== undefined && f.validUntil <= now) return false;
  return true;
}

/**
 * Current beliefs, one row per (subject, predicate), ordered by subject then
 * predicate so output is stable for snapshotting and diffing.
 */
export function resolveFacts(
  facts: readonly ButlerFact[],
  opts: ResolveOpts,
): ButlerFact[] {
  const minTrust = opts.minTrust ?? 0;
  const ownerFiltered =
    "ownerId" in opts
      ? facts.filter((f) => f.ownerId === opts.ownerId)
      : facts.slice();

  // Tombstones first: a retraction must be able to kill a row that outranks it
  // on trust, otherwise a user could never withdraw something they had said
  // with full confidence.
  const retracted = new Set<number>();
  for (const f of ownerFiltered) {
    if (f.retracts !== undefined) retracted.add(f.retracts);
  }

  const best = new Map<string, ButlerFact>();
  for (const f of ownerFiltered) {
    if (f.retracts !== undefined) continue; // tombstones are not beliefs
    // An erased row has had its subject/predicate/object blanked (GDPR
    // Art. 17). It must be dropped BEFORE the key is computed, or every
    // erased row in the store would collide on the single key ""\0"" and the
    // most recent one would resolve as an empty-string belief.
    if (f.erased) continue;
    if (retracted.has(f.seq)) continue;
    if (!validAt(f, opts.now)) continue;
    if (f.trust < minTrust) continue;

    const k = factKey(f.subject, f.predicate);
    const cur = best.get(k);
    if (cur === undefined || wins(f, cur)) best.set(k, f);
  }

  return Array.from(best.values()).sort(
    (a, b) =>
      a.subject.localeCompare(b.subject) ||
      a.predicate.localeCompare(b.predicate),
  );
}

/** Does `a` beat `b` for the same (subject, predicate)? */
function wins(a: ButlerFact, b: ButlerFact): boolean {
  if (a.trust !== b.trust) return a.trust > b.trust;
  return a.seq > b.seq;
}

/** The single current value, or undefined if nothing is believed. */
export function resolveOne(
  facts: readonly ButlerFact[],
  subject: string,
  predicate: string,
  opts: ResolveOpts,
): ButlerFact | undefined {
  const k = factKey(subject, predicate);
  return resolveFacts(facts, opts).find(
    (f) => factKey(f.subject, f.predicate) === k,
  );
}
