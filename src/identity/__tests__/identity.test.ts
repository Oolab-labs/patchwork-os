/**
 * Identity model — roles, members, segregation of duties, roster loading.
 *
 * The load-bearing tests here are the segregation-of-duties block: that rule is
 * the reason the whole model exists, and it is unanswerable while every request
 * resolves to one shared bearer token.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  canApproveAction,
  describeRefusal,
  type Member,
  memberCan,
  parseMember,
} from "../members.js";
import { capabilitiesFor, isRole, ROLES, roleGrants } from "../roles.js";
import {
  defaultRosterPath,
  describeRoster,
  findMember,
  IMPLICIT_OWNER_ID,
  implicitOwner,
  loadRoster,
  principalCan,
  resolvePrincipal,
} from "../roster.js";

function member(over: Partial<Member> = {}): Member {
  return {
    id: "anna",
    displayName: "Anna Reyes",
    kind: "human",
    roles: ["approver"],
    active: true,
    ...over,
  };
}

// ── roles ────────────────────────────────────────────────────────────────────

describe("roles", () => {
  it("owner holds every capability", () => {
    const caps = capabilitiesFor(["owner"]);
    expect(caps.has("systems.manage")).toBe(true);
    expect(caps.has("action.approve")).toBe(true);
    expect(caps.has("policy.manage")).toBe(true);
  });

  it("names no commercial capability", () => {
    // A gate, not a note. `billing.manage` was declared here with no
    // implementing code and no enforcement point; a plan or an invoice is a
    // property of an organisation, which ADR-0019 scopes to the control plane,
    // not to this single-tenant runtime. The failure mode is quiet — such a
    // capability reads to a reviewer as a control that exists — so the tree is
    // asserted rather than the habit trusted.
    const commercial = /billing|invoice|plan|price|pricing|tier|subscription/i;
    const offenders = [...capabilitiesFor(["owner"])].filter((c) =>
      commercial.test(c),
    );
    expect(offenders).toEqual([]);
  });

  it("auditor can read and can change nothing", () => {
    // The entire value of the role: cheap to hand a security reviewer, and only
    // worth anything if it is provably incapable of changing something.
    const caps = capabilitiesFor(["auditor"]);
    expect([...caps].sort()).toEqual(["evidence.read", "workspace.read"]);
  });

  it("admin does not get action.approve", () => {
    // Administering a workspace and approving work inside it are different
    // authorities. Someone needing both is given both roles, visibly.
    expect(roleGrants(["admin"], "policy.manage")).toBe(true);
    expect(roleGrants(["admin"], "members.manage")).toBe(true);
    expect(roleGrants(["admin"], "action.approve")).toBe(false);
  });

  it("operator may propose but not approve", () => {
    expect(roleGrants(["operator"], "action.propose")).toBe(true);
    expect(roleGrants(["operator"], "action.approve")).toBe(false);
  });

  it("worker may run and propose, and never approves or reads the audit record", () => {
    const caps = capabilitiesFor(["worker"]);
    expect(caps.has("work.run")).toBe(true);
    expect(caps.has("action.propose")).toBe(true);
    expect(caps.has("action.approve")).toBe(false);
    expect(caps.has("evidence.read")).toBe(false);
  });

  it("roles compose — a member may hold several", () => {
    const caps = capabilitiesFor(["admin", "approver"]);
    expect(caps.has("members.manage")).toBe(true);
    expect(caps.has("action.approve")).toBe(true);
  });

  it("isRole rejects anything not in the list", () => {
    expect(ROLES.every(isRole)).toBe(true);
    expect(isRole("superuser")).toBe(false);
    expect(isRole(null)).toBe(false);
    expect(isRole("")).toBe(false);
  });
});

// ── segregation of duties ────────────────────────────────────────────────────

describe("segregation of duties", () => {
  it("an approver may approve someone else's action", () => {
    expect(canApproveAction(member(), "tom")).toEqual({ allowed: true });
  });

  it("refuses self-approval", () => {
    const anna = member();
    expect(canApproveAction(anna, "anna")).toEqual({
      allowed: false,
      refusal: "self_approval",
    });
  });

  it("refuses self-approval even for an owner", () => {
    // The check must run BEFORE the capability check. An owner holds
    // action.approve, so testing capability first reports this as allowed —
    // which is the exact hole the rule exists to close.
    const owner = member({ id: "marc", roles: ["owner"] });
    expect(canApproveAction(owner, "marc")).toEqual({
      allowed: false,
      refusal: "self_approval",
    });
  });

  it("refuses a member with no approving role", () => {
    const tom = member({ id: "tom", roles: ["operator"] });
    expect(canApproveAction(tom, "anna")).toEqual({
      allowed: false,
      refusal: "not_an_approver",
    });
  });

  it("refuses a deactivated member before anything else", () => {
    const gone = member({ active: false });
    expect(canApproveAction(gone, "tom")).toEqual({
      allowed: false,
      refusal: "inactive",
    });
  });

  it("a worker never approves, whatever roles it is given", () => {
    // Belt and braces: the worker role lacks action.approve, and requireHuman
    // refuses regardless of role in case someone grants a worker approver.
    const bot = member({
      id: "release-guardian",
      kind: "worker",
      roles: ["approver"],
    });
    expect(canApproveAction(bot, "tom", { requireHuman: true })).toEqual({
      allowed: false,
      refusal: "worker_cannot_approve_this",
    });
    expect(canApproveAction(bot, "tom")).toEqual({ allowed: true });
  });

  it("falls back to capability alone when the preparer is unknown", () => {
    // Not an endorsement of unknown preparers — it is the honest behaviour
    // until every action records who prepared it.
    expect(canApproveAction(member(), undefined)).toEqual({ allowed: true });
    const tom = member({ id: "tom", roles: ["operator"] });
    expect(canApproveAction(tom, undefined).allowed).toBe(false);
  });

  it("every refusal has a human-readable description", () => {
    for (const r of [
      "self_approval",
      "not_an_approver",
      "inactive",
      "worker_cannot_approve_this",
    ] as const) {
      expect(describeRefusal(r)).toMatch(/[a-z]/);
    }
  });
});

// ── members ──────────────────────────────────────────────────────────────────

describe("memberCan", () => {
  it("a deactivated member may do nothing, whatever their roles", () => {
    expect(
      memberCan(member({ roles: ["owner"], active: false }), "workspace.read"),
    ).toBe(false);
  });
});

describe("parseMember", () => {
  it("parses a well-formed entry", () => {
    expect(
      parseMember({ id: "tom", displayName: "Tom Beck", roles: ["operator"] }),
    ).toEqual({
      id: "tom",
      displayName: "Tom Beck",
      kind: "human",
      roles: ["operator"],
      active: true,
    });
  });

  it("rejects an entry with no id", () => {
    expect(parseMember({ roles: ["operator"] })).toBeNull();
    expect(parseMember({ id: "   ", roles: ["operator"] })).toBeNull();
  });

  it("rejects an entry whose roles are all unrecognised", () => {
    // Otherwise the member silently exists and can do nothing, which reads as
    // a lockout rather than the configuration error it is.
    expect(parseMember({ id: "x", roles: ["superuser"] })).toBeNull();
    expect(parseMember({ id: "x", roles: [] })).toBeNull();
  });

  it("keeps recognised roles and drops the rest", () => {
    expect(
      parseMember({ id: "x", roles: ["operator", "wizard"] })?.roles,
    ).toEqual(["operator"]);
  });

  it("deduplicates roles", () => {
    expect(
      parseMember({ id: "x", roles: ["operator", "operator"] })?.roles,
    ).toEqual(["operator"]);
  });

  it("falls back to the id for a missing display name", () => {
    expect(parseMember({ id: "tom", roles: ["operator"] })?.displayName).toBe(
      "tom",
    );
  });

  it("treats a missing active field as active", () => {
    // A roster written before the field existed must keep working.
    expect(parseMember({ id: "x", roles: ["operator"] })?.active).toBe(true);
    expect(
      parseMember({ id: "x", roles: ["operator"], active: false })?.active,
    ).toBe(false);
  });

  it("rejects non-objects", () => {
    expect(parseMember(null)).toBeNull();
    expect(parseMember("tom")).toBeNull();
    expect(parseMember(42)).toBeNull();
  });
});

// ── roster ───────────────────────────────────────────────────────────────────

describe("loadRoster", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "roster-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const at = () => join(dir, "members.json");

  it("a workspace with no roster file has exactly one implicit owner", () => {
    const r = loadRoster(at());
    expect(r.implicit).toBe(true);
    expect(r.members).toEqual([implicitOwner()]);
  });

  it("malformed JSON is UNREADABLE, not the implicit owner", () => {
    // Changed deliberately. This test previously asserted `implicit === true`,
    // on the reasoning that deciding "who you are on your own machine" should
    // fail soft — the opposite stance to the approval gate's fail-closed
    // (ADR-0016). The fail-soft stance is right and is kept for an ABSENT file.
    //
    // It is wrong here: this file EXISTS, so a membership decision was made,
    // and answering "I could not read it" with an owner who holds every
    // capability makes corrupting the file a way to become the owner. Nothing
    // consults the roster to permit an action yet, so the distinction costs
    // nothing to draw now and would be a live escalation to discover later.
    writeFileSync(at(), "{ not json");
    const r = loadRoster(at());
    expect(r.unreadable).toBe(true);
    expect(r.implicit).toBe(false);
    expect(r.members).toEqual([]);
  });

  it("accepts both a bare array and a { members } wrapper", () => {
    writeFileSync(at(), JSON.stringify([{ id: "tom", roles: ["operator"] }]));
    expect(loadRoster(at()).members).toHaveLength(1);
    writeFileSync(
      at(),
      JSON.stringify({ members: [{ id: "tom", roles: ["operator"] }] }),
    );
    expect(loadRoster(at()).members).toHaveLength(1);
  });

  it("drops unparseable entries and reports their positions", () => {
    writeFileSync(
      at(),
      JSON.stringify([
        { id: "anna", roles: ["approver"] },
        { roles: ["operator"] },
        { id: "tom", roles: ["operator"] },
      ]),
    );
    const r = loadRoster(at());
    expect(r.members.map((m) => m.id)).toEqual(["anna", "tom"]);
    expect(r.dropped).toEqual([1]);
  });

  it("drops a duplicate id — attribution must never be ambiguous", () => {
    writeFileSync(
      at(),
      JSON.stringify([
        { id: "anna", roles: ["approver"] },
        { id: "anna", roles: ["owner"] },
      ]),
    );
    const r = loadRoster(at());
    expect(r.members).toHaveLength(1);
    expect(r.members[0]?.roles).toEqual(["approver"]);
    expect(r.dropped).toEqual([1]);
  });

  it("a roster whose entries are all invalid is UNREADABLE, not implicit", () => {
    // Same reversal, same reason as the malformed-JSON case above: the
    // operator listed members and we understood none of them, which is not the
    // same fact as "this is a one-person machine". The rejected positions are
    // carried through so the report can say which.
    writeFileSync(at(), JSON.stringify([{ nope: true }]));
    const r = loadRoster(at());
    expect(r.unreadable).toBe(true);
    expect(r.implicit).toBe(false);
    expect(r.dropped).toEqual([0]);
  });

  it("a real one-entry roster is not implicit", () => {
    // "One-person workspace" and "a membership decision that produced one
    // member" are different facts and must stay distinguishable.
    writeFileSync(at(), JSON.stringify([{ id: "marc", roles: ["owner"] }]));
    const r = loadRoster(at());
    expect(r.implicit).toBe(false);
    expect(r.members[0]?.id).toBe("marc");
  });
});

describe("defaultRosterPath", () => {
  const prev = process.env.PATCHWORK_HOME;
  afterEach(() => {
    if (prev === undefined) delete process.env.PATCHWORK_HOME;
    else process.env.PATCHWORK_HOME = prev;
  });

  it("honours PATCHWORK_HOME", () => {
    const home = join(tmpdir(), "pw-home-test");
    process.env.PATCHWORK_HOME = home;
    expect(defaultRosterPath()).toBe(join(home, "members.json"));
  });

  it("ignores an empty PATCHWORK_HOME", () => {
    process.env.PATCHWORK_HOME = "   ";
    expect(
      defaultRosterPath().endsWith(join(".patchwork", "members.json")),
    ).toBe(true);
  });
});

describe("resolvePrincipal", () => {
  const explicit = {
    members: [
      {
        id: "anna",
        displayName: "Anna",
        kind: "human",
        roles: ["approver"],
        active: true,
      },
      {
        id: "gone",
        displayName: "Gone",
        kind: "human",
        roles: ["operator"],
        active: false,
      },
    ] as Member[],
    implicit: false,
    unreadable: false,
    dropped: [],
  };

  it("returns the implicit owner when no identity is supplied", () => {
    // Today's behaviour, preserved exactly: one authenticated caller who may
    // do everything — but now with a name a record can hold.
    const p = resolvePrincipal(loadRoster("/nonexistent/members.json"));
    expect(p?.id).toBe(IMPLICIT_OWNER_ID);
    expect(principalCan(p, "policy.manage")).toBe(true);
  });

  it("refuses an anonymous caller once a real roster exists", () => {
    expect(resolvePrincipal(explicit)).toBeNull();
  });

  it("resolves a known member", () => {
    expect(resolvePrincipal(explicit, "anna")?.displayName).toBe("Anna");
  });

  it("returns null for an unknown id rather than falling back to the owner", () => {
    // Falling back would silently promote an unknown caller to full authority.
    expect(resolvePrincipal(explicit, "mallory")).toBeNull();
  });

  it("returns null for a deactivated member", () => {
    expect(resolvePrincipal(explicit, "gone")).toBeNull();
  });

  it("principalCan is false for a null principal", () => {
    expect(principalCan(null, "workspace.read")).toBe(false);
  });
});

describe("findMember", () => {
  it("finds by id and returns null when absent", () => {
    const r = {
      members: [member()],
      implicit: false,
      unreadable: false,
      dropped: [],
    };
    expect(findMember(r, "anna")?.id).toBe("anna");
    expect(findMember(r, "nobody")).toBeNull();
  });
});

describe("describeRoster", () => {
  it("says so plainly when there is no roster file", () => {
    expect(
      describeRoster({
        members: [implicitOwner()],
        implicit: true,
        unreadable: false,
        dropped: [],
      }),
    ).toContain("single implicit owner");
  });

  it("counts people and workers separately", () => {
    const r = {
      members: [
        member({ id: "a" }),
        member({ id: "b" }),
        member({
          id: "bot",
          kind: "worker" as const,
          roles: ["worker" as const],
        }),
      ],
      implicit: false,
      unreadable: false,
      dropped: [],
    };
    expect(describeRoster(r)).toBe("roster loaded: 2 people, 1 worker");
  });

  it("omits workers when there are none, and singularises", () => {
    const r = {
      members: [member()],
      implicit: false,
      unreadable: false,
      dropped: [],
    };
    expect(describeRoster(r)).toBe("roster loaded: 1 person");
  });

  it("shouts about rejected entries and names their positions", () => {
    // Without this, a typo silently removes a member — they never appear and
    // nothing errors, which is the worst failure for a file deciding who may
    // approve things.
    const r = {
      members: [member()],
      implicit: false,
      unreadable: false,
      dropped: [1, 3],
    };
    const out = describeRoster(r);
    expect(out).toContain("REJECTED");
    expect(out).toContain("1, 3");
  });
});
