/**
 * The workspace roster — who exists, read from disk.
 *
 * Third and last leaf of the identity model (`roles.ts` → `members.ts` → here).
 * This one owns I/O and nothing else: reading `members.json`, dropping entries
 * it cannot parse, and answering "who is this?" for a request.
 *
 * ## The degraded default matters more than the file
 *
 * Patchwork's free product is one person on one machine, and it must not grow a
 * login screen. So a workspace with no roster on disk is not an empty workspace
 * — it is a workspace with exactly one implicit owner. `resolvePrincipal` then
 * returns that owner for any authenticated request, which is byte-identical to
 * today's behaviour (a single bearer token that may do everything) while giving
 * every record something real to name.
 *
 * That is deliberate: one identity model, degraded locally, rather than two
 * models that drift. The alternative — identities only in the hosted product —
 * means the local build never exercises the code that the paid build depends
 * on, and the two diverge permanently.
 *
 * ## What this does not do yet
 *
 * Nothing here is wired into request handling, and no persisted record carries
 * an actor yet — that is the next step, and the wire-format decision it depends
 * on is [ADR-0017](../../docs/adr/0017-decision-record-actor-and-forbid.md).
 * Credentials are also out of scope by design: the recommendation is to
 * delegate sign-in to an existing provider rather than own password reset for a
 * two-person company, so this module knows about *members*, never secrets.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { type Member, memberCan, parseMember } from "./members.js";
import type { Capability } from "./roles.js";

/** Id given to the implicit owner of a workspace that has no roster file. */
export const IMPLICIT_OWNER_ID = "local-owner";

export interface Roster {
  members: Member[];
  /**
   * True when there is no roster on disk and `members` is the single implicit
   * owner. Callers use this to tell "one-person workspace" apart from "a
   * roster that happens to have one entry" — the second is a real membership
   * decision, the first is the absence of one.
   */
  implicit: boolean;
  /** Entries that failed to parse, by index, so the operator can be told. */
  dropped: number[];
}

/** The one member a workspace has before anybody configures membership. */
export function implicitOwner(): Member {
  return {
    id: IMPLICIT_OWNER_ID,
    displayName: "Workspace owner",
    kind: "human",
    roles: ["owner"],
    active: true,
  };
}

function implicitRoster(): Roster {
  return { members: [implicitOwner()], implicit: true, dropped: [] };
}

/** Default location: `~/.patchwork/members.json`, honouring `PATCHWORK_HOME`. */
export function defaultRosterPath(): string {
  const home = process.env.PATCHWORK_HOME?.trim();
  return join(
    home && home !== "" ? home : join(homedir(), ".patchwork"),
    "members.json",
  );
}

/**
 * Read the roster.
 *
 * Fail-soft throughout — a missing file, unreadable file, malformed JSON, or a
 * file whose entries are all invalid all yield the implicit single-owner
 * roster. A workspace that cannot read its membership must still function as
 * the one-person workspace it was before membership existed; locking the owner
 * out of their own machine over a JSON typo would be a worse failure than any
 * this is guarding against.
 *
 * Note this is the opposite of the fail-CLOSED stance the approval gate takes
 * (ADR-0016), and deliberately so: that gate decides whether an action happens,
 * where the safe default is "no". This decides who you are on your own machine,
 * where the safe default is the status quo ante.
 */
export function loadRoster(path = defaultRosterPath()): Roster {
  if (!existsSync(path)) return implicitRoster();

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return implicitRoster();
  }

  const raw = Array.isArray(parsed)
    ? parsed
    : Array.isArray((parsed as { members?: unknown })?.members)
      ? (parsed as { members: unknown[] }).members
      : null;
  if (!raw) return implicitRoster();

  const members: Member[] = [];
  const dropped: number[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < raw.length; i++) {
    const m = parseMember(raw[i]);
    // A duplicate id would make attribution ambiguous — the whole point of the
    // record is that an id identifies one party — so the later entry loses.
    if (!m || seen.has(m.id)) {
      dropped.push(i);
      continue;
    }
    seen.add(m.id);
    members.push(m);
  }

  if (members.length === 0) return implicitRoster();
  return { members, implicit: false, dropped };
}

/** Look a member up by id. */
export function findMember(roster: Roster, id: string): Member | null {
  return roster.members.find((m) => m.id === id) ?? null;
}

/**
 * Which member a request is acting as.
 *
 * `memberId` is whatever the transport managed to establish — today nothing, so
 * every caller passes `undefined` and gets the implicit owner, preserving
 * current behaviour exactly. Once a request can carry an identity, this is the
 * single place that answers the question.
 *
 * Returns null when a member id IS supplied but names nobody, or names someone
 * deactivated. Falling back to the owner in that case would silently promote an
 * unknown caller to full authority, which is the failure mode this whole model
 * exists to remove.
 */
export function resolvePrincipal(
  roster: Roster,
  memberId?: string,
): Member | null {
  if (memberId === undefined) {
    return roster.implicit ? (roster.members[0] ?? null) : null;
  }
  const m = findMember(roster, memberId);
  if (!m || !m.active) return null;
  return m;
}

/** Convenience: may the resolved principal do `capability`? */
export function principalCan(
  principal: Member | null,
  capability: Capability,
): boolean {
  return principal !== null && memberCan(principal, capability);
}
