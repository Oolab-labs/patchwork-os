/**
 * A roster we could not read is not a one-person workspace.
 *
 * `loadRoster` collapses five different situations into one answer — a single
 * implicit OWNER, which `principalCan` grants every capability:
 *
 *   1. no `members.json`            — a genuine one-person workspace
 *   2. `members.json` is not JSON
 *   3. it is JSON of the wrong shape
 *   4. it is the right shape but every entry is malformed
 *   5. it is an empty list
 *
 * Only (1) means "nobody has ever made a membership decision here". The rest
 * mean "a membership decision exists and we could not read it", and answering
 * those with an omnipotent owner turns file corruption into privilege
 * escalation: delete or break the file, become the owner.
 *
 * This is harmless today only because nothing consults the roster to permit an
 * action (verified: zero production call sites for `principalCan` /
 * `canApproveAction` / `capabilitiesFor` outside `src/identity/`). It stops
 * being harmless the moment the first one exists, which is exactly when nobody
 * will be looking at this file. So the distinction is drawn now, while the
 * change cannot break anything.
 *
 * Fail-soft for the absent file is KEPT — see the module docstring: the free
 * product is one person on one machine and must not grow a login screen.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  describeRoster,
  loadRoster,
  principalCan,
  resolvePrincipal,
} from "../roster.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "roster-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const rosterAt = (contents?: string) => {
  const p = join(dir, "members.json");
  if (contents !== undefined) writeFileSync(p, contents, "utf8");
  return loadRoster(p);
};

describe("a roster file that exists but cannot be read", () => {
  const unreadable: ReadonlyArray<[string, string]> = [
    ["not JSON at all", "{ this is not json"],
    ["JSON of the wrong shape", '{"nope": true}'],
    ["a bare JSON scalar", '"members"'],
    ["every entry malformed", '[{"no":"id"},{"also":"broken"}]'],
    ["an empty list", "[]"],
  ];

  for (const [label, contents] of unreadable) {
    it(`${label} — is reported unreadable, not implicit`, () => {
      const r = rosterAt(contents);
      expect(r.unreadable).toBe(true);
      expect(r.implicit).toBe(false);
    });

    it(`${label} — grants an unidentified request NOTHING`, () => {
      const r = rosterAt(contents);
      const principal = resolvePrincipal(r);
      expect(principal).toBeNull();
      // The capability that matters: an approval is the one place segregation
      // of duties is modelled, so it is the one an escalation would target.
      expect(principalCan(principal, "action.approve")).toBe(false);
      expect(principalCan(principal, "workspace.read")).toBe(false);
    });
  }
});

describe("a roster file that is simply absent", () => {
  it("still means one implicit owner — the free product must not grow a login", () => {
    const r = rosterAt();
    expect(r.implicit).toBe(true);
    expect(r.unreadable).toBe(false);
    const principal = resolvePrincipal(r);
    expect(principal).not.toBeNull();
    expect(principalCan(principal, "action.approve")).toBe(true);
  });
});

describe("a roster that reads fine", () => {
  it("is neither implicit nor unreadable, and drops only what it must", () => {
    const r = rosterAt(
      JSON.stringify([
        { id: "a", displayName: "A", roles: ["owner"], active: true },
        { broken: true },
      ]),
    );
    expect(r.implicit).toBe(false);
    expect(r.unreadable).toBe(false);
    expect(r.members).toHaveLength(1);
    expect(r.dropped).toEqual([1]);
  });

  it("does not hand an unidentified request a member", () => {
    const r = rosterAt(
      JSON.stringify([
        { id: "a", displayName: "A", roles: ["owner"], active: true },
      ]),
    );
    // A real roster has never answered an anonymous request, and must not
    // start: `implicit` is false, so there is nobody to default to.
    expect(resolvePrincipal(r)).toBeNull();
  });
});

describe("what the operator is told at startup", () => {
  it("names the unreadable file, and does not read as an empty workspace", () => {
    const line = describeRoster(rosterAt('[{"no":"id"}]'));
    // The failure this guards: without its own branch, the generic path
    // reports "roster loaded: 0 people" — which an operator reads as "nobody
    // has signed up yet", not "your file is broken".
    expect(line).not.toMatch(/roster loaded/);
    expect(line).toMatch(/could not be read/);
    expect(line).toMatch(/position 0/);
    // It must not claim the single-owner default, which is a different state.
    expect(line).toMatch(/NOT/);
  });

  it("still describes an absent file as the single implicit owner", () => {
    expect(describeRoster(rosterAt())).toMatch(/single implicit owner/);
  });
});
