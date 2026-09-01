import { describe, expect, it } from "vitest";
import {
  type ButlerFact,
  type ButlerSources,
  type PendingApproval,
  type PermissionExercise,
  type SourceState,
  type StandingPermission,
  mapButlerHome,
} from "../homeState";

/**
 * The acceptance contract for the Butler view-model: five distinctions that
 * must survive the fold.
 *
 *   needs you · caught up · CANNOT TELL
 *   established memory · low-trust observation
 *   active permission · no permission · permission state UNAVAILABLE
 *   did something without asking · merely has permission to
 *   approval pending · approval source UNAVAILABLE
 *
 * Each of the three emphasised ones is a state that an ordinary implementation
 * turns into an empty collection, and an empty collection reads as reassurance.
 * `page.tsx` has already been caught by that twice — a 502 whose body parsed as
 * JSON, and a 501 for an unreadable permission store — so these are regressions
 * waiting to happen rather than hypotheticals.
 */

/**
 * A fact as the store actually writes one.
 *
 * `trust` is a FRACTION on 0..1, not a tier index — `user_chat` sits at 1.0 and
 * `connector` at 0.3, strictly below the 0.6 origination threshold. An earlier
 * draft of this fixture used `trust: 3`, a value the store cannot produce, and
 * a fixture carrying an impossible value teaches every later test built on it
 * the wrong shape.
 */
const fact = (seq: number, at: number): ButlerFact => ({
  seq,
  subject: "user",
  predicate: "tasks.default_list",
  object: "personal",
  recordedAt: at,
  trust: 1,
  provenance: { channel: "user_chat", tier: 1, validated: true },
});

/** What quarantine holds: connector-derived, capped below origination. */
const observed = (seq: number, at: number): ButlerFact => ({
  ...fact(seq, at),
  trust: 0.3,
  provenance: { channel: "connector", source: "gmail", tier: 0.3, validated: false },
});

const permission = (id: string, active: boolean): StandingPermission => ({
  id,
  grantedAt: 1_000,
  scope: { domains: ["task"] },
  active,
  ...(active ? {} : { revokedAt: 2_000 }),
});

const exercise = (at: number): PermissionExercise => ({
  permissionId: "perm-1",
  at,
  toolName: "todoist.create_task",
  classKey: "task:compensable:low",
});

const approval = (callId: string): PendingApproval => ({
  callId,
  toolName: "todoist.create_task",
  tier: "low",
  requestedAt: 5_000,
  summary: "Add an item to your list",
});

const read = <T>(value: T): SourceState<T> => ({ state: "read", value });
const down = <T>(reason: string): SourceState<T> => ({
  state: "unavailable",
  reason,
});

/** All five healthy and empty — the genuine all-clear. */
function allClear(): ButlerSources {
  return {
    facts: read([]),
    quarantine: read([]),
    permissions: read([]),
    exercises: read([]),
    approvals: read([]),
  };
}

describe("needs you · caught up · cannot tell", () => {
  it("says caught up only when the approvals source was actually read", () => {
    expect(mapButlerHome(allClear()).status).toEqual({ kind: "caught-up" });
  });

  it("counts what needs you", () => {
    const s = mapButlerHome({
      ...allClear(),
      approvals: read([approval("a"), approval("b")]),
    });
    expect(s.status).toEqual({ kind: "needs-you", count: 2 });
  });

  it("cannot tell — even when the other four sources are healthy", () => {
    // The dangerous case, and the reason status is not a boolean. Four healthy
    // sources cannot see a pending decision, so "everything is caught up" would
    // be confidently wrong about the only question the headline answers.
    const s = mapButlerHome({
      facts: read([fact(1, 10)]),
      quarantine: read([]),
      permissions: read([permission("p", true)]),
      exercises: read([exercise(20)]),
      approvals: down("I cannot check that on this bridge."),
    });
    expect(s.status.kind).toBe("cannot-tell");
    expect(s.status).toMatchObject({
      reason: "I cannot check that on this bridge.",
    });
    expect(JSON.stringify(s.status)).not.toContain("caught-up");
  });

  it("never reports zero pending when approvals could not be read", () => {
    const s = mapButlerHome({ ...allClear(), approvals: down("502") });
    expect(s.attention.state).toBe("unavailable");
    expect(JSON.stringify(s.attention)).not.toMatch(/"value":\s*\[\]/);
  });
});

describe("established memory vs low-trust observation", () => {
  it("counts them separately, never as one total", () => {
    const s = mapButlerHome({
      ...allClear(),
      facts: read([fact(1, 10), fact(2, 20)]),
      quarantine: read([observed(3, 30)]),
    });
    expect(s.memory.established).toEqual({ state: "read", value: 2 });
    expect(s.memory.awaitingConfirmation).toEqual({ state: "read", value: 1 });
  });

  it("keeps one available when the other is not", () => {
    // Merging them would need both; carrying them separately means a reader
    // still learns what IS known.
    const s = mapButlerHome({
      ...allClear(),
      facts: read([fact(1, 10)]),
      quarantine: down("quarantine unreadable"),
    });
    expect(s.memory.established).toEqual({ state: "read", value: 1 });
    expect(s.memory.awaitingConfirmation.state).toBe("unavailable");
  });
});

describe("active permission · none · state unavailable", () => {
  it("counts only permissions still in force", () => {
    const s = mapButlerHome({
      ...allClear(),
      permissions: read([permission("a", true), permission("b", false)]),
    });
    expect(s.permissions.active).toEqual({ state: "read", value: 1 });
  });

  it("distinguishes none from cannot-check", () => {
    // The bridge answers 501 for a permission store it cannot read, and that
    // must never render as "you have allowed nothing" — here the reassuring
    // reading is the dangerous one.
    const none = mapButlerHome(allClear()).permissions.active;
    const unknown = mapButlerHome({
      ...allClear(),
      permissions: down("I cannot check that on this bridge."),
    }).permissions.active;

    expect(none).toEqual({ state: "read", value: 0 });
    expect(unknown.state).toBe("unavailable");
    expect(none).not.toEqual(unknown);
  });
});

describe("did something without asking vs merely has permission to", () => {
  it("holding a permission produces no activity claim on its own", () => {
    const s = mapButlerHome({
      ...allClear(),
      permissions: read([permission("p", true)]),
    });
    expect(s.permissions.active).toEqual({ state: "read", value: 1 });
    expect(s.activity).toEqual({ state: "read", value: [] });
  });

  it("only an exercise says Butler acted", () => {
    const s = mapButlerHome({
      ...allClear(),
      permissions: read([permission("p", true)]),
      exercises: read([exercise(99)]),
    });
    if (s.activity.state !== "read") throw new Error("expected read");
    expect(s.activity.value).toEqual([
      {
        kind: "acted-without-asking",
        at: 99,
        toolName: "todoist.create_task",
        permissionId: "perm-1",
      },
    ]);
  });

  it("counts the two independently", () => {
    // One permission used four times is one permission and four actions.
    const s = mapButlerHome({
      ...allClear(),
      permissions: read([permission("p", true)]),
      exercises: read([exercise(1), exercise(2), exercise(3), exercise(4)]),
    });
    expect(s.permissions.active).toEqual({ state: "read", value: 1 });
    expect(s.permissions.actionsWithoutAsking).toEqual({ state: "read", value: 4 });
  });
});

describe("activity claims only what these sources support", () => {
  it("orders newest first across claim kinds", () => {
    const s = mapButlerHome({
      ...allClear(),
      facts: read([fact(1, 100)]),
      quarantine: read([observed(2, 300)]),
      exercises: read([exercise(200)]),
    });
    if (s.activity.state !== "read") throw new Error("expected read");
    expect(s.activity.value.map((c) => c.at)).toEqual([300, 200, 100]);
    expect(s.activity.value.map((c) => c.kind)).toEqual([
      "noticed-not-used",
      "acted-without-asking",
      "learned",
    ]);
  });

  it("invents no claim these five sources cannot support", () => {
    // No source records a completed errand, a refusal, or an approval that was
    // granted and then acted on. A timeline design wanting "checked your
    // errands — nothing needed changing" does not create the evidence for it.
    const s = mapButlerHome({
      ...allClear(),
      facts: read([fact(1, 10)]),
      exercises: read([exercise(20)]),
    });
    if (s.activity.state !== "read") throw new Error("expected read");
    const kinds = new Set(s.activity.value.map((c) => c.kind));
    for (const invented of ["completed", "refused", "approved", "checked"]) {
      expect([...kinds].join(" ")).not.toContain(invented);
    }
  });

  it("a partial timeline is unavailable, not a shorter timeline", () => {
    // "Some of what happened" cannot be rendered honestly as "what happened".
    const s = mapButlerHome({
      ...allClear(),
      facts: read([fact(1, 10)]),
      exercises: down("exercises unreadable"),
    });
    expect(s.activity.state).toBe("unavailable");
  });
});

describe("a failed source never becomes a successful empty one", () => {
  it("reports every unavailable source, whole, even with four healthy", () => {
    const s = mapButlerHome({
      facts: read([fact(1, 10)]),
      quarantine: read([]),
      permissions: down("permissions: 501"),
      exercises: read([]),
      approvals: read([]),
    });
    expect(s.unavailable).toEqual([
      { source: "permissions", reason: "permissions: 501" },
    ]);
    // The healthy four still answer.
    expect(s.memory.established).toEqual({ state: "read", value: 1 });
  });

  it("carries the reason verbatim rather than a generic failure", () => {
    const reason =
      "I cannot check that on this bridge, so I cannot say what you have allowed.";
    const s = mapButlerHome({ ...allClear(), permissions: down(reason) });
    expect(s.unavailable[0]?.reason).toBe(reason);
  });

  it("all five down is not an all-clear", () => {
    const s = mapButlerHome({
      facts: down("a"),
      quarantine: down("b"),
      permissions: down("c"),
      exercises: down("d"),
      approvals: down("e"),
    });
    expect(s.status.kind).toBe("cannot-tell");
    expect(s.unavailable).toHaveLength(5);
    // Not one field anywhere reports a confident zero.
    expect(JSON.stringify(s)).not.toMatch(/"value":\s*0/);
    expect(JSON.stringify(s)).not.toMatch(/"value":\s*\[\]/);
  });

  it("the genuine all-clear and the total blackout do not agree anywhere", () => {
    // The single assertion this whole module exists to satisfy.
    const clear = mapButlerHome(allClear());
    const blackout = mapButlerHome({
      facts: down("a"),
      quarantine: down("b"),
      permissions: down("c"),
      exercises: down("d"),
      approvals: down("e"),
    });
    expect(clear).not.toEqual(blackout);
    expect(clear.status).not.toEqual(blackout.status);
    expect(clear.memory).not.toEqual(blackout.memory);
    expect(clear.permissions).not.toEqual(blackout.permissions);
    expect(clear.activity).not.toEqual(blackout.activity);
    expect(clear.attention).not.toEqual(blackout.attention);
  });
});
