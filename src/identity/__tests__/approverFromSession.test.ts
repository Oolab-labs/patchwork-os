/**
 * Attributing an approval to a real person — ADR-0020 Phase A.
 *
 * The rule under test is one-directional and unforgiving: a verified v2
 * session naming an active member yields that member, and EVERY other input
 * yields `undefined`. There is no input for which this resolver may invent a
 * subject, so most of these cases exist to pin the absence rather than the
 * presence.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createApproverResolver } from "../approverFromSession.js";
import { signSession } from "../dashboardSession.js";
import type { Roster } from "../roster.js";
import { implicitOwner } from "../roster.js";

const SECRET = "d".repeat(48);

function rosterOf(...members: Roster["members"]): Roster {
  return { members, implicit: false, unreadable: false, dropped: [] };
}

const ada: Roster["members"][number] = {
  id: "ada",
  displayName: "Ada L",
  kind: "human",
  roles: ["approver"],
  active: true,
};

beforeEach(() => {
  process.env.DASHBOARD_SESSION_SECRET = SECRET;
});
afterEach(() => {
  delete process.env.DASHBOARD_SESSION_SECRET;
});

describe("createApproverResolver", () => {
  it("names the member carried by a verified v2 session", async () => {
    const resolve = createApproverResolver({ rosterFor: () => rosterOf(ada) });
    const actor = await resolve(await signSession({ memberId: "ada" }));
    expect(actor).toEqual({ id: "ada", kind: "human", displayName: "Ada L" });
  });

  it("is undefined for a v1 session — valid, but nobody was identified", async () => {
    const resolve = createApproverResolver({ rosterFor: () => rosterOf(ada) });
    // The session is REAL. It just came from the shared password, so there is
    // no person in it. This is the branch a `?? implicitOwner()` would ruin.
    expect(await resolve(await signSession())).toBeUndefined();
  });

  it("is undefined for a forged cookie", async () => {
    const resolve = createApproverResolver({ rosterFor: () => rosterOf(ada) });
    expect(
      await resolve("v2.ada.99999999999999.notasignature"),
    ).toBeUndefined();
  });

  it("is undefined when a DIFFERENT secret signed the cookie", async () => {
    const cookie = await signSession({ memberId: "ada" });
    process.env.DASHBOARD_SESSION_SECRET = "e".repeat(48);
    const resolve = createApproverResolver({ rosterFor: () => rosterOf(ada) });
    // The whole security argument: the dashboard cannot name a person to the
    // bridge without holding the same signing secret. Possession of the shared
    // bridge token is NOT sufficient.
    expect(await resolve(cookie)).toBeUndefined();
  });

  it("is undefined with no secret configured at all", async () => {
    const cookie = await signSession({ memberId: "ada" });
    delete process.env.DASHBOARD_SESSION_SECRET;
    const resolve = createApproverResolver({ rosterFor: () => rosterOf(ada) });
    // The default state of every unchanged install.
    expect(await resolve(cookie)).toBeUndefined();
  });

  it("is undefined for an expired session", async () => {
    const resolve = createApproverResolver({ rosterFor: () => rosterOf(ada) });
    const cookie = await signSession({
      memberId: "ada",
      expiresAt: Date.now() - 1,
    });
    expect(await resolve(cookie)).toBeUndefined();
  });

  it("is undefined for a member who is no longer on the roster", async () => {
    const cookie = await signSession({ memberId: "ada" });
    const resolve = createApproverResolver({ rosterFor: () => rosterOf() });
    expect(await resolve(cookie)).toBeUndefined();
  });

  it("is undefined for a DEACTIVATED member", async () => {
    const cookie = await signSession({ memberId: "ada" });
    const resolve = createApproverResolver({
      rosterFor: () => rosterOf({ ...ada, active: false }),
    });
    // Deactivated members keep their history and may do nothing — including
    // approve. A live cookie must not outlive the deactivation.
    expect(await resolve(cookie)).toBeUndefined();
  });

  it("is undefined against an IMPLICIT roster, even for the owner's own id", async () => {
    const owner = implicitOwner();
    const cookie = await signSession({ memberId: owner.id });
    const resolve = createApproverResolver({
      rosterFor: () => ({
        members: [owner],
        implicit: true,
        unreadable: false,
        dropped: [],
      }),
    });
    // No members.json exists, so this "member" was synthesised as a degraded
    // default rather than configured by anyone. Attributing to them would be
    // defaulting an actor, which is the one thing forbidden throughout.
    expect(await resolve(cookie)).toBeUndefined();
  });

  it("is undefined, never thrown, when the roster read explodes", async () => {
    const resolve = createApproverResolver({
      rosterFor: () => {
        throw new Error("disk on fire");
      },
    });
    const cookie = await signSession({ memberId: "ada" });
    // Attribution must never be able to fail an approval.
    await expect(resolve(cookie)).resolves.toBeUndefined();
  });

  it("is undefined with no cookie at all", async () => {
    const resolve = createApproverResolver({ rosterFor: () => rosterOf(ada) });
    expect(await resolve(undefined)).toBeUndefined();
  });
});
