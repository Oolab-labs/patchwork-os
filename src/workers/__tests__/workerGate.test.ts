import { describe, expect, it } from "vitest";
import { classifyActionClass } from "../actionClass.js";
import type { GraduationConfig } from "../graduation.js";
import { parseWorker } from "../worker.js";
import { decideWorkerAction, flowsUngated } from "../workerGate.js";
import { WorkerLevelStore } from "../workerLevelStore.js";

const CFG: GraduationConfig = {
  dwellMs: 1000,
  demoteCooldownMs: 5000,
  minEvidenceForGraduation: 5,
};

/** Build a store where `workerId` has earned L4 on `toolName`. */
function storeWithL4(workerId: string, toolName: string): WorkerLevelStore {
  const store = new WorkerLevelStore();
  for (let i = 0; i < 80; i++)
    store.apply(workerId, { toolName, good: true, at: 0 }, { cfg: CFG });
  // dwell-separated outcomes so graduation can climb rung by rung to L4
  for (const at of [1000, 2000, 3000, 4000, 5000, 6000, 7000, 8000])
    store.apply(workerId, { toolName, good: true, at }, { cfg: CFG });
  return store;
}

describe("flowsUngated", () => {
  it("is true for reversible classes (any blast) and false otherwise", () => {
    expect(flowsUngated(classifyActionClass("getGitStatus"))).toBe(true); // low
    expect(flowsUngated(classifyActionClass("editText"))).toBe(true); // medium
    expect(flowsUngated(classifyActionClass("gitPush"))).toBe(false); // compensable
    expect(flowsUngated(classifyActionClass("slackPostMessage"))).toBe(false); // irreversible
  });
});

describe("decideWorkerAction", () => {
  it("lets a REVERSIBLE action flow un-gated even unearned and unowned", () => {
    const w = parseWorker({ id: "w", name: "W", owns: ["fs-write"] });
    const d = decideWorkerAction(w, "getGitStatus", {}, new WorkerLevelStore());
    expect(d.action).toBe("allow");
    expect(d.reason).toContain("reversible");
  });

  it("lets the worker's own REVERSIBLE core action flow before earning L4", () => {
    // the release-notes case: writing the CHANGELOG (fs-write, reversible,
    // medium blast) must NOT halt for weeks while trust accrues.
    const w = parseWorker({ id: "w", name: "W", owns: ["fs-write"] });
    const d = decideWorkerAction(w, "editText", {}, new WorkerLevelStore());
    expect(d.action).toBe("allow");
    expect(d.effectiveLevel).toBe(0);
  });

  it("GATES a compensable/irreversible action the worker has not earned", () => {
    const w = parseWorker({ id: "w", name: "W", owns: ["vcs-remote"] });
    const d = decideWorkerAction(w, "gitPush", {}, new WorkerLevelStore());
    expect(d.action).toBe("gate");
    expect(d.owned).toBe(true);
    expect(d.effectiveLevel).toBe(0);
    expect(d.reason).toContain("unearned");
  });

  it("ALLOWS a risky action once the worker has earned L4 on it", () => {
    const w = parseWorker({ id: "w", name: "W", owns: ["vcs-remote"] });
    const d = decideWorkerAction(w, "gitPush", {}, storeWithL4("w", "gitPush"));
    expect(d.earnedLevel).toBe(4);
    expect(d.effectiveLevel).toBe(4);
    expect(d.action).toBe("allow");
    expect(d.reason).toContain("earned autonomy");
  });

  it("autonomyCeiling caps a risky class below L4 → still gated despite earning L4", () => {
    const w = parseWorker({
      id: "w",
      name: "W",
      owns: ["vcs-remote"],
      autonomyCeiling: 2,
    });
    const d = decideWorkerAction(w, "gitPush", {}, storeWithL4("w", "gitPush"));
    expect(d.earnedLevel).toBe(4);
    expect(d.effectiveLevel).toBe(2);
    expect(d.action).toBe("gate");
    expect(d.reason).toContain("autonomy ceiling");
  });

  it("ALLOWS an agent (reasoning) step — never gates it forever (M3)", () => {
    // "agent" classifies as other:irreversible, owned by no worker → without
    // the special-case it would gate on every run and stall the worker. The
    // downstream tool steps still gate on their own class.
    const w = parseWorker({ id: "w", name: "W", owns: ["fs-write"] });
    const d = decideWorkerAction(w, "agent", undefined, new WorkerLevelStore());
    expect(d.action).toBe("allow");
    expect(d.reason).toContain("agent");
  });

  it("GATES a risky action outside the worker's owned domain", () => {
    const w = parseWorker({ id: "w", name: "W", owns: ["fs-write"] });
    // worker has L4 on gitPush in the store, but does not OWN vcs-remote
    const d = decideWorkerAction(w, "gitPush", {}, storeWithL4("w", "gitPush"));
    expect(d.owned).toBe(false);
    expect(d.effectiveLevel).toBe(0);
    expect(d.action).toBe("gate");
    expect(d.reason).toContain("outside");
  });
});
