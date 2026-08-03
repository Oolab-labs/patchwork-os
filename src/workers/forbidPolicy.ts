/**
 * Forbidden actions — the third terminal state, as a policy predicate.
 *
 * [ADR-0017](../../docs/adr/0017-decision-record-actor-and-forbid.md) decided
 * that `forbid` is evaluated **before** the trust maths, not derived from ramp
 * topology. This module is that evaluation. It is pure: rules in, verdict out,
 * no I/O and no dependency on the gate.
 *
 * ## What "forbidden" means, precisely
 *
 * Not "not yet trusted enough" — that is what gating is for, and gating is
 * escapable by earning trust or by a human approving. Forbidden means **no
 * level of earned trust and no human approval unlocks this**. It must hold at
 * L4 with an autonomy ceiling of 4, and it must hold against an operator who
 * clicks Approve.
 *
 * That is why it cannot live in `reachableLevels()`: an empty reachable set
 * says "cannot climb the ramp", which is a statement about autonomy, not about
 * the action. A forbidden action is one the workspace has decided never
 * happens, however it is proposed.
 *
 * ## The failure direction is the opposite of the roster's
 *
 * `identity/roster.ts` fails SOFT — a malformed `members.json` degrades to a
 * single implicit owner, because the safe default for "who are you on your own
 * machine" is the status quo ante.
 *
 * A deny-list is the reverse. Silently dropping a malformed forbid rule fails
 * **open**: the action the operator meant to ban becomes merely gated, and a
 * human can then approve it. So `parseForbidRules` returns what it could not
 * parse alongside what it could, and the caller is expected to treat a
 * non-empty `invalid` as a configuration error worth shouting about — not as
 * "loaded fine, minus a couple". A partially-loaded deny list is a deny list
 * that does not say what its author thinks it says.
 *
 * This module deliberately does not decide what to do about that, because the
 * right answer differs by deployment: refusing to start is correct for a hosted
 * workspace and hostile on a laptop.
 */

import type { ActionClass } from "./actionClass.js";

export interface ForbidRule {
  /**
   * What it matches. Same pattern language as `WorkerManifest.owns`, so an
   * operator learns one syntax:
   *   - a domain           — `vcs-remote`
   *   - an exact class key — `fs-write:irreversible:high`
   *   - a prefix           — `vcs-remote` also matches `vcs-remote:*`
   */
  match: string;
  /**
   * Why this is forbidden, in the operator's own words. Required: a refusal
   * with no reason is unusable in a receipt, and "denied by policy" tells a
   * person nothing about which policy or why.
   */
  reason: string;
}

export interface ForbidVerdict {
  forbidden: boolean;
  /** The rule's reason, when forbidden. */
  reason?: string;
  /** The `match` pattern that fired, so an operator can find the rule. */
  matchedBy?: string;
}

const NOT_FORBIDDEN: ForbidVerdict = { forbidden: false };

/** Does `pattern` match this action class? Mirrors `ownsAction`. */
function matches(pattern: string, ac: ActionClass): boolean {
  return (
    pattern === ac.domain ||
    pattern === ac.key ||
    ac.key.startsWith(`${pattern}:`)
  );
}

/**
 * Is this action forbidden outright?
 *
 * An empty rule set forbids nothing, so a workspace that has configured no
 * policy behaves exactly as it did before this existed. Forbidding is entirely
 * opt-in.
 *
 * First match wins, and rules are evaluated in order — so the reason an
 * operator sees is the first rule they wrote that covers the action, which is
 * the one they are most likely to recognise.
 */
export function isForbidden(
  ac: ActionClass,
  rules: readonly ForbidRule[],
): ForbidVerdict {
  for (const rule of rules) {
    if (matches(rule.match, ac)) {
      return { forbidden: true, reason: rule.reason, matchedBy: rule.match };
    }
  }
  return NOT_FORBIDDEN;
}

export interface ParsedForbidRules {
  rules: ForbidRule[];
  /**
   * Entries that could not be parsed, by index. A non-empty array means the
   * deny list is incomplete — see the module note: this fails OPEN, so the
   * caller must surface it rather than proceed quietly.
   */
  invalid: number[];
}

/** Validate one untrusted rule. Both fields are required and non-empty. */
export function parseForbidRule(input: unknown): ForbidRule | null {
  if (!input || typeof input !== "object") return null;
  const o = input as Record<string, unknown>;
  const match = typeof o.match === "string" ? o.match.trim() : "";
  const reason = typeof o.reason === "string" ? o.reason.trim() : "";
  if (!match || !reason) return null;
  return { match, reason };
}

/**
 * Validate a list of untrusted rules, keeping the good and reporting the bad.
 *
 * Does not throw and does not silently drop: see the module note on why a
 * deny-list's failure direction is the opposite of the roster's.
 */
export function parseForbidRules(input: unknown): ParsedForbidRules {
  if (!Array.isArray(input)) return { rules: [], invalid: [] };
  const rules: ForbidRule[] = [];
  const invalid: number[] = [];
  for (let i = 0; i < input.length; i++) {
    const r = parseForbidRule(input[i]);
    if (r) rules.push(r);
    else invalid.push(i);
  }
  return { rules, invalid };
}

/**
 * One-line summary for a startup log. Loud about invalid entries, because a
 * partially-loaded deny list is the failure this module most wants surfaced.
 */
export function describeForbidRules(parsed: ParsedForbidRules): string {
  const base =
    parsed.rules.length === 0
      ? "no forbidden-action rules configured"
      : `${parsed.rules.length} forbidden-action rule${parsed.rules.length === 1 ? "" : "s"} loaded`;
  if (parsed.invalid.length === 0) return base;
  return `${base} — WARNING: ${parsed.invalid.length} rule${
    parsed.invalid.length === 1 ? "" : "s"
  } at position ${parsed.invalid.join(", ")} could NOT be parsed and are NOT in force (a rule needs both \`match\` and \`reason\`)`;
}
