import { describe, expect, it } from "vitest";
import type { GraduationConfig } from "../graduation.js";
import { recommend } from "../shadowGate.js";
import { parseWorker } from "../worker.js";
import { WorkerLevelStore } from "../workerLevelStore.js";

const CFG: GraduationConfig = {
  dwellMs: 1000,
  demoteCooldownMs: 5000,
  minEvidenceForGraduation: 5,
};

/** Build a store where `workerId` has earned L4 on `toolName`. */
function storeWithL4(workerId: string, toolName: string): WorkerLevelStore {
  const store = new WorkerLevelStore();
  for (let i = 0; i < 60; i++)
    store.apply(workerId, { toolName, good: true, at: 0 }, { cfg: CFG });
  for (const at of [1000, 2000, 3000, 4000])
    store.apply(workerId, { toolName, good: true, at }, { cfg: CFG });
  return store;
}

/** Build a store where `workerId` has earned L2 on `toolName`. */
function storeWithL2(workerId: string, toolName: string): WorkerLevelStore {
  const store = new WorkerLevelStore();
  for (let i = 0; i < 10; i++)
    store.apply(workerId, { toolName, good: true, at: 0 }, { cfg: CFG });
  store.apply(workerId, { toolName, good: true, at: 1000 }, { cfg: CFG });
  store.apply(workerId, { toolName, good: true, at: 2000 }, { cfg: CFG });
  return store;
}

describe("shadowGate.recommend — reversible short-circuit", () => {
  it("bypasses reversible action regardless of earned level (no trust required)", () => {
    const w = parseWorker({ id: "w", name: "W", owns: ["fs-write"] });
    const d = recommend(w, "editText", {}, new WorkerLevelStore());
    expect(d.decision).toBe("bypass");
    expect(d.reason).toContain("reversible");
  });

  it("bypasses reversible even when autonomyCeiling=0", () => {
    const w = parseWorker({
      id: "w",
      name: "W",
      owns: ["fs-write"],
      autonomyCeiling: 0,
    });
    const d = recommend(w, "editText", {}, new WorkerLevelStore());
    expect(d.decision).toBe("bypass");
  });

  it("bypasses reversible even when action is outside worker's domain", () => {
    // getGitStatus is vcs-read (reversible) — not in owns; still flows un-gated
    const w = parseWorker({ id: "w", name: "W", owns: ["fs-write"] });
    const d = recommend(w, "getGitStatus", {}, new WorkerLevelStore());
    expect(d.decision).toBe("bypass");
  });
});

describe("shadowGate.recommend — compensable at L2", () => {
  it("bypasses compensable when worker has earned L2 (threshold met)", () => {
    const w = parseWorker({ id: "w", name: "W", owns: ["vcs-push"] });
    const d = recommend(w, "gitPush", {}, storeWithL2("w", "gitPush"));
    expect(d.earnedLevel).toBeGreaterThanOrEqual(2);
    expect(d.decision).toBe("bypass");
    expect(d.reason).toContain("autonomous");
  });

  it("queues compensable at effective L1 (below L2 threshold)", () => {
    const w = parseWorker({ id: "w", name: "W", owns: ["vcs-push"] });
    const store = new WorkerLevelStore();
    store.apply("w", { toolName: "gitPush", good: true, at: 0 }, { cfg: CFG });
    const d = recommend(w, "gitPush", {}, store);
    expect(d.earnedLevel).toBeLessThan(2);
    expect(d.decision).toBe("queue");
    expect(d.reason).toContain("below-autonomy");
  });

  it("queues compensable when ceiling=1 even at earned L4", () => {
    const w = parseWorker({
      id: "w",
      name: "W",
      owns: ["vcs-push"],
      autonomyCeiling: 1,
    });
    const d = recommend(w, "gitPush", {}, storeWithL4("w", "gitPush"));
    expect(d.earnedLevel).toBe(4);
    expect(d.effectiveLevel).toBe(1);
    expect(d.decision).toBe("queue");
    expect(d.reason).toContain("capped-by-autonomy-ceiling");
  });

  it("bypasses compensable when ceiling=2 and earned L4 (effectiveLevel meets threshold)", () => {
    const w = parseWorker({
      id: "w",
      name: "W",
      owns: ["vcs-remote"],
      autonomyCeiling: 2,
    });
    const d = recommend(
      w,
      "githubCreatePR",
      {},
      storeWithL4("w", "githubCreatePR"),
    );
    expect(d.earnedLevel).toBe(4);
    expect(d.effectiveLevel).toBe(2);
    expect(d.decision).toBe("bypass");
  });
});

describe("shadowGate.recommend — irreversible", () => {
  it("queues an unearned irreversible action (outside domain)", () => {
    const w = parseWorker({ id: "w", name: "W", owns: ["fs-write"] });
    const d = recommend(
      w,
      "slackPostMessage",
      {},
      storeWithL4("w", "editText"),
    );
    expect(d.owned).toBe(false);
    expect(d.effectiveLevel).toBe(0);
    expect(d.decision).toBe("queue");
    expect(d.reason).toBe("outside-worker-domain");
  });

  it("bypasses irreversible only at earned L4", () => {
    const w = parseWorker({ id: "w", name: "W", owns: ["shell"] });
    const d = recommend(
      w,
      "runInTerminal",
      {},
      storeWithL4("w", "runInTerminal"),
    );
    expect(d.earnedLevel).toBe(4);
    expect(d.decision).toBe("bypass");
  });

  it("queues irreversible below L4 (no mid-ramp unlock for irreversible)", () => {
    // Irreversible reachable levels are [0,1,4] — even with enough evidence to
    // reach a "would-be L2/L3" LCB, the ramp clamps to L1 until L4 is cleared.
    const w = parseWorker({ id: "w", name: "W", owns: ["shell"] });
    // 30 successes put LCB in the L2/L3 range for a compensable class;
    // irreversible clamping means earnedLevel stays at L1 here.
    const store = new WorkerLevelStore();
    for (let i = 0; i < 30; i++)
      store.apply(
        "w",
        { toolName: "runInTerminal", good: true, at: 0 },
        { cfg: CFG },
      );
    for (const at of [1000, 2000, 3000, 4000])
      store.apply(
        "w",
        { toolName: "runInTerminal", good: true, at },
        { cfg: CFG },
      );
    const d = recommend(w, "runInTerminal", {}, store);
    expect(d.earnedLevel).toBeLessThan(4);
    expect(d.decision).toBe("queue");
  });
});
