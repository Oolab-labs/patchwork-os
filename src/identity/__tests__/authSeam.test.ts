/**
 * ADR-0020 Phase A — the auth seam and local scrypt credentials.
 *
 * The property that matters more than any other here: **an unauthenticated
 * caller resolves to `UNATTRIBUTED`, never to the implicit owner.**
 *
 * The roster fails SOFT — a missing `members.json` yields one implicit owner
 * so a single-user machine keeps working. That is right for "who may act on
 * your own machine" and catastrophic for "who did this": defaulting an actor
 * to the implicit owner writes a claim about a real person into an audit
 * record on no evidence. An absent actor already means "nobody recorded this"
 * and is never backfilled; a defaulted one is indistinguishable from a
 * recorded one, and is a lie the record cannot walk back.
 */

import { describe, expect, it } from "vitest";

import {
  type AuthProvider,
  actorSnapshot,
  LocalPasswordProvider,
  resolveActor,
  UNATTRIBUTED,
} from "../authSeam.js";
import {
  hashPassword,
  isCredentialRecord,
  verifyPassword,
} from "../credentials.js";
import type { Member } from "../members.js";
import type { Roster } from "../roster.js";

const alice: Member = {
  id: "m-alice",
  displayName: "Alice",
  kind: "human",
  roles: ["approver"],
  active: true,
};
const retired: Member = {
  id: "m-retired",
  displayName: "Retired",
  kind: "human",
  roles: ["approver"],
  active: false,
};

const roster: Roster = {
  members: [alice, retired],
  implicit: false,
} as Roster;

/** A roster in its fail-soft state: one implicit owner, nothing configured. */
const implicitRoster: Roster = {
  members: [
    {
      id: "local-owner",
      displayName: "Local owner",
      kind: "human",
      roles: ["owner"],
      active: true,
    },
  ],
  implicit: true,
} as Roster;

describe("scrypt credentials", () => {
  it("verifies a correct password and rejects a wrong one", async () => {
    const rec = await hashPassword("correct horse battery staple");
    expect(isCredentialRecord(rec)).toBe(true);
    await expect(
      verifyPassword("correct horse battery staple", rec),
    ).resolves.toBe(true);
    // Control: without this the first assertion holds for a verifier that
    // returns true unconditionally.
    await expect(verifyPassword("wrong", rec)).resolves.toBe(false);
  });

  it("salts each hash, so identical passwords differ on disk", async () => {
    const a = await hashPassword("same");
    const b = await hashPassword("same");
    expect(a).not.toBe(b);
    await expect(verifyPassword("same", a)).resolves.toBe(true);
    await expect(verifyPassword("same", b)).resolves.toBe(true);
  });

  it("stores its parameters, so cost can be raised without invalidating", async () => {
    const rec = await hashPassword("pw", { N: 16384, r: 8, p: 1 });
    expect(rec.startsWith("scrypt$16384$8$1$")).toBe(true);
    // Verified using the record's own parameters, not the current default.
    await expect(verifyPassword("pw", rec)).resolves.toBe(true);
  });

  it("a malformed record reads as a wrong password, never as a pass", async () => {
    for (const bad of [
      "",
      "nonsense",
      "scrypt$32768$8$1$onlyfourparts",
      "bcrypt$32768$8$1$AAAA$AAAA",
      "scrypt$32768$8$1$$",
    ]) {
      await expect(verifyPassword("pw", bad)).resolves.toBe(false);
      expect(isCredentialRecord(bad)).toBe(false);
    }
  });

  it("refuses absurd parameters from a record", async () => {
    // Anyone who can write members.json could otherwise make one verification
    // consume unbounded CPU and memory — a denial of service authored in a
    // config file.
    expect(
      isCredentialRecord(`scrypt$1073741824$8$1$AAAA$${"A".repeat(88)}`),
    ).toBe(false);
    expect(
      isCredentialRecord(`scrypt$32768$999$1$AAAA$${"A".repeat(88)}`),
    ).toBe(false);
  });
});

describe("an unauthenticated caller is never a person", () => {
  it("resolves to UNATTRIBUTED with no providers", async () => {
    const p = await resolveActor({}, roster, []);
    expect(p.kind).toBe(UNATTRIBUTED);
  });

  it("resolves to UNATTRIBUTED even against a fail-soft implicit-owner roster", async () => {
    // THE test. The roster hands out an owner by design; the seam must not
    // pass it off as the actor.
    const p = await resolveActor({}, implicitRoster, []);
    expect(p.kind).toBe(UNATTRIBUTED);
    expect(actorSnapshot(p)).toBeUndefined();
  });

  it("a wrong password is UNATTRIBUTED, not the owner", async () => {
    const rec = await hashPassword("right");
    const provider = new LocalPasswordProvider(() => rec);
    const p = await resolveActor(
      { memberId: "m-alice", password: "wrong" },
      roster,
      [provider],
    );
    expect(p.kind).toBe(UNATTRIBUTED);
  });

  it("a deactivated member cannot authenticate", async () => {
    const rec = await hashPassword("pw");
    const provider = new LocalPasswordProvider(() => rec);
    const p = await resolveActor(
      { memberId: "m-retired", password: "pw" },
      roster,
      [provider],
    );
    // They keep their record and history and may do nothing — including this.
    expect(p.kind).toBe(UNATTRIBUTED);
  });

  it("an unknown member id is UNATTRIBUTED", async () => {
    const rec = await hashPassword("pw");
    const provider = new LocalPasswordProvider(() => rec);
    const p = await resolveActor(
      { memberId: "nobody", password: "pw" },
      roster,
      [provider],
    );
    expect(p.kind).toBe(UNATTRIBUTED);
  });

  it("the module never falls back to the implicit owner (source)", async () => {
    // Structural. A `?? implicitOwner()` added later would satisfy every
    // behavioural test above that does not specifically look for it.
    const { readFileSync } = await import("node:fs");
    const path = await import("node:path");
    const src = readFileSync(
      path.resolve(import.meta.dirname, "..", "authSeam.ts"),
      "utf-8",
    );
    const body = src.slice(src.indexOf("*/") + 2);
    expect(body).not.toMatch(/implicitOwner/);
    expect(body).not.toMatch(/IMPLICIT_OWNER_ID/);
  });
});

describe("a correct credential authenticates", () => {
  it("returns the member and a usable actor snapshot (control)", async () => {
    // Without this, every UNATTRIBUTED assertion above is satisfied by a seam
    // that authenticates nobody at all.
    const rec = await hashPassword("pw");
    const provider = new LocalPasswordProvider((id) =>
      id === "m-alice" ? rec : undefined,
    );
    const p = await resolveActor(
      { memberId: "m-alice", password: "pw" },
      roster,
      [provider],
    );
    expect(p.kind).toBe("member");
    expect(actorSnapshot(p)).toEqual({
      id: "m-alice",
      kind: "human",
      displayName: "Alice",
    });
  });

  it("the snapshot is a copy, so a later rename cannot rewrite history", async () => {
    const rec = await hashPassword("pw");
    const mutable: Member = { ...alice };
    const p = await resolveActor(
      { memberId: "m-alice", password: "pw" },
      { members: [mutable], implicit: false } as Roster,
      [new LocalPasswordProvider(() => rec)],
    );
    const snap = actorSnapshot(p);
    mutable.displayName = "Renamed";
    expect(snap?.displayName).toBe("Alice");
  });
});

describe("provider chaining", () => {
  it("null means 'not my business' and lets the next provider try", async () => {
    const rec = await hashPassword("pw");
    const abstain: AuthProvider = {
      name: "abstain",
      authenticate: async () => null,
    };
    const p = await resolveActor(
      { memberId: "m-alice", password: "pw" },
      roster,
      [abstain, new LocalPasswordProvider(() => rec)],
    );
    expect(p.kind).toBe("member");
  });

  it("UNATTRIBUTED stops the chain — a failure is not an abstention", async () => {
    // Otherwise a wrong password against one provider would fall through to
    // the next, and a chain would be strictly easier to pass than any single
    // provider in it.
    const rec = await hashPassword("right");
    const alwaysYes: AuthProvider = {
      name: "always-yes",
      authenticate: async () => ({ kind: "member", member: alice, via: "x" }),
    };
    const p = await resolveActor(
      { memberId: "m-alice", password: "wrong" },
      roster,
      [new LocalPasswordProvider(() => rec), alwaysYes],
    );
    expect(p.kind).toBe(UNATTRIBUTED);
  });
});
