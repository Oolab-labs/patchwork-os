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

/** Build a store where `workerId` has earned L4 on editText (fs-write). */
function storeWithL4(workerId: string): WorkerLevelStore {
  const store = new WorkerLevelStore();
  for (let i = 0; i < 60; i++)
    store.apply(
      workerId,
      { toolName: "editText", good: true, at: 0 },
      { cfg: CFG },
    );
  for (const at of [1000, 2000, 3000, 4000])
    store.apply(
      workerId,
      { toolName: "editText", good: true, at },
      { cfg: CFG },
    );
  return store;
}

describe("shadowGate.recommend", () => {
  it("bypasses an owned class the worker has earned L4 on", () => {
    const w = parseWorker({ id: "release-bot", name: "R", owns: ["fs-write"] });
    const d = recommend(w, "editText", {}, storeWithL4("release-bot"));
    expect(d.earnedLevel).toBe(4);
    expect(d.effectiveLevel).toBe(4);
    expect(d.decision).toBe("bypass");
  });

  it("autonomyCeiling caps the effective level below earned → still queues", () => {
    // a Legal-sector-style worker pinned at L2 regardless of track record
    const w = parseWorker({
      id: "release-bot",
      name: "R",
      owns: ["fs-write"],
      autonomyCeiling: 2,
    });
    const d = recommend(w, "editText", {}, storeWithL4("release-bot"));
    expect(d.earnedLevel).toBe(4);
    expect(d.effectiveLevel).toBe(2);
    expect(d.decision).toBe("queue");
    expect(d.reason).toContain("capped-by-autonomy-ceiling");
  });

  it("floors to L0 and queues for an action outside the worker's domain", () => {
    const w = parseWorker({ id: "release-bot", name: "R", owns: ["fs-write"] });
    // worker has L4 on fs-write but slackPostMessage is messaging — not owned
    const d = recommend(w, "slackPostMessage", {}, storeWithL4("release-bot"));
    expect(d.owned).toBe(false);
    expect(d.effectiveLevel).toBe(0);
    expect(d.decision).toBe("queue");
    expect(d.reason).toBe("outside-worker-domain");
  });

  it("queues an owned class with no track record (cold start)", () => {
    const w = parseWorker({ id: "fresh", name: "F", owns: ["fs-write"] });
    const d = recommend(w, "editText", {}, new WorkerLevelStore());
    expect(d.earnedLevel).toBe(0);
    expect(d.decision).toBe("queue");
  });
});
