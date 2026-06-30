import { describe, expect, it } from "vitest";
import { classifyActionClass } from "../actionClass.js";
import {
  type ClassTrustState,
  type GraduationConfig,
  type GraduationEvent,
  graduate,
  initialState,
  type Outcome,
} from "../graduation.js";
import { DEFAULT_PRIOR } from "../trustLevel.js";

const CFG: GraduationConfig = {
  dwellMs: 1000,
  demoteCooldownMs: 5000,
  minEvidenceForGraduation: 5,
};

function runSeq(
  start: ClassTrustState,
  outcomes: Outcome[],
  cfg = CFG,
): { state: ClassTrustState; events: GraduationEvent[] } {
  let state = start;
  const events: GraduationEvent[] = [];
  for (const o of outcomes) {
    const r = graduate(state, o, cfg);
    state = r.state;
    if (r.event) events.push(r.event);
  }
  return { state, events };
}

function goods(tool: string, n: number, at: number): Outcome[] {
  return Array.from({ length: n }, () => ({ toolName: tool, good: true, at }));
}

const EDIT = "editText"; // fs-write:reversible:medium → reachable [0..4]
const SHELL = "runCommand"; // shell:irreversible:high → reachable [0,1,4]

describe("graduation — dwell gating", () => {
  it("a burst of successes at one instant never promotes (no time elapsed)", () => {
    const key = classifyActionClass(EDIT).key;
    const { state, events } = runSeq(
      initialState(key, DEFAULT_PRIOR),
      goods(EDIT, 30, 0),
    );
    expect(state.level).toBe(0);
    expect(events).toHaveLength(0);
    expect(state.observations).toBe(30);
  });
});

describe("graduation — gradual climb", () => {
  it("climbs one rung per dwell period up to L4 on a reversible class", () => {
    const key = classifyActionClass(EDIT).key;
    // build a tight, high posterior at t=0 (no promotions yet)...
    let { state } = runSeq(
      initialState(key, DEFAULT_PRIOR),
      goods(EDIT, 60, 0),
    );
    // ...then one success per dwell period — each unlocks one climb
    const climbs: Outcome[] = [1000, 2000, 3000, 4000].map((at) => ({
      toolName: EDIT,
      good: true,
      at,
    }));
    const r = runSeq(state, climbs);
    state = r.state;
    expect(r.events.map((e) => `${e.from}->${e.to}`)).toEqual([
      "0->1",
      "1->2",
      "2->3",
      "3->4",
    ]);
    expect(state.level).toBe(4);
  });
});

describe("graduation — instant demote", () => {
  it("demotes immediately mid-dwell (asymmetry: down ignores dwell)", () => {
    const key = classifyActionClass(EDIT).key;
    let { state } = runSeq(
      initialState(key, DEFAULT_PRIOR),
      goods(EDIT, 60, 0),
    );
    ({ state } = runSeq(
      state,
      [1000, 2000, 3000, 4000].map((at) => ({
        toolName: EDIT,
        good: true,
        at,
      })),
    ));
    expect(state.level).toBe(4);

    // a failure at t=4100 — inside the dwell window — must demote instantly
    const dem = graduate(state, { toolName: EDIT, good: false, at: 4100 }, CFG);
    expect(dem.event?.type).toBe("demote");
    expect(dem.event!.to).toBeLessThan(4);
    expect(dem.event!.at).toBe(4100);
    expect(dem.state.demoteUntil).toBe(4100 + CFG.demoteCooldownMs);
  });
});

describe("graduation — demote cooldown", () => {
  it("freezes promotions until the cooldown elapses, even when evidence supports a climb", () => {
    const key = classifyActionClass(EDIT).key;
    // posterior strongly supports L4, but the worker was just demoted to L1 and
    // is inside its cooldown window — a fast re-grind must NOT buy trust back.
    const earned = runSeq(
      initialState(key, DEFAULT_PRIOR),
      goods(EDIT, 60, 0),
    ).state;
    const inCooldown: ClassTrustState = {
      ...earned,
      level: 1,
      lastChangeAt: 0,
      demoteUntil: 9100,
    };
    const blocked = graduate(
      inCooldown,
      { toolName: EDIT, good: true, at: 5000 },
      CFG,
    );
    expect(blocked.event).toBeUndefined();
    expect(blocked.state.level).toBe(1);

    const after = graduate(
      blocked.state,
      { toolName: EDIT, good: true, at: 10000 },
      CFG,
    );
    expect(after.event?.type).toBe("promote");
  });
});

describe("graduation — config tightening does not retroactively demote", () => {
  it("a class earned under a loose floor is NOT demoted when the floor is raised", () => {
    const key = classifyActionClass(EDIT).key;
    // Climb to L4 under the loose test config (minEvidenceForGraduation=5).
    let { state } = runSeq(
      initialState(key, DEFAULT_PRIOR),
      goods(EDIT, 60, 0),
    );
    ({ state } = runSeq(
      state,
      [1000, 2000, 3000, 4000].map((at) => ({
        toolName: EDIT,
        good: true,
        at,
      })),
    ));
    expect(state.level).toBe(4);
    // The threshold it graduated under is recorded on the state.
    expect(state.minEvidenceAtLastPromotion).toBe(5);

    // Operator RAISES minEvidenceForGraduation far above the accrued evidence.
    // The novel-class floor is a COLD-START gate — raising it must not claw back
    // an already-earned level. One more clean outcome must NOT demote.
    const tightened: GraduationConfig = {
      ...CFG,
      minEvidenceForGraduation: 1000,
    };
    const after = graduate(
      state,
      { toolName: EDIT, good: true, at: 5000 },
      tightened,
    );
    expect(after.event?.type).not.toBe("demote");
    expect(after.state.level).toBe(4);
  });

  it("a cold-start class still faces the CURRENT (raised) floor", () => {
    // A class that has NOT cleared L1 uses the live config, so raising the floor
    // correctly slows a fresh climb (no retroactive protection for cold-start).
    const key = classifyActionClass(EDIT).key;
    const tightened: GraduationConfig = {
      ...CFG,
      minEvidenceForGraduation: 1000,
    };
    const { state } = runSeq(
      initialState(key, DEFAULT_PRIOR),
      goods(EDIT, 60, 0),
      tightened,
    );
    const climb = runSeq(
      state,
      [1000, 2000].map((at) => ({ toolName: EDIT, good: true, at })),
      tightened,
    );
    // floor (evidence ~62 < 1000) caps at L1 — no promotion past L1.
    expect(climb.state.level).toBeLessThanOrEqual(1);
  });
});

describe("graduation — irreversible class jumps L1→L4", () => {
  it("never visits L2/L3 for an irreversible class", () => {
    const key = classifyActionClass(SHELL).key;
    let { state } = runSeq(
      initialState(key, DEFAULT_PRIOR),
      goods(SHELL, 150, 0),
    );
    const r = runSeq(
      state,
      [1000, 2000].map((at) => ({ toolName: SHELL, good: true, at })),
    );
    state = r.state;
    const hops = r.events.map((e) => `${e.from}->${e.to}`);
    expect(hops).toEqual(["0->1", "1->4"]);
    expect(hops.some((h) => h.includes("2") || h.includes("3"))).toBe(false);
    expect(state.level).toBe(4);
  });
});
