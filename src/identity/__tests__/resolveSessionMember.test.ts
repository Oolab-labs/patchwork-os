import { describe, expect, it } from "vitest";
import type { Member } from "../members.js";
import { type Roster, resolveSessionMember } from "../roster.js";

const ada: Member = {
  id: "ada",
  displayName: "Ada",
  kind: "human",
  roles: ["operator"],
  active: true,
};

function roster(
  members: Member[],
  flags: Partial<Pick<Roster, "implicit" | "unreadable">> = {},
): Roster {
  return {
    members,
    implicit: false,
    unreadable: false,
    dropped: [],
    ...flags,
  };
}

/**
 * The ONE rule for "may this session's member act?" — shared by the bridge's
 * approver attribution and the dashboard's session gate. Two copies of this
 * rule would be two places for "deactivated" to mean different things.
 */
describe("resolveSessionMember", () => {
  it("returns the member when present and active", () => {
    expect(resolveSessionMember(roster([ada]), "ada")).toEqual(ada);
  });

  it("returns null for a deactivated member", () => {
    expect(
      resolveSessionMember(roster([{ ...ada, active: false }]), "ada"),
    ).toBeNull();
  });

  it("returns null for an id not on the roster", () => {
    expect(resolveSessionMember(roster([ada]), "bob")).toBeNull();
  });

  it("returns null against an IMPLICIT roster, even for the implicit owner id", () => {
    // A cookie naming a member cannot be honoured against a roster that was
    // synthesised rather than read.
    const implicit = roster(
      [
        {
          id: "local-owner",
          displayName: "Workspace owner",
          kind: "human",
          roles: ["owner"],
          active: true,
        },
      ],
      { implicit: true },
    );
    expect(resolveSessionMember(implicit, "local-owner")).toBeNull();
  });

  it("returns null against an UNREADABLE roster", () => {
    expect(
      resolveSessionMember(roster([], { unreadable: true }), "ada"),
    ).toBeNull();
  });
});
