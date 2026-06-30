import { describe, expect, it } from "vitest";
import { classifyActionClass } from "../actionClass.js";
import { contextRiskCeiling } from "../contextRisk.js";
import type { GraduationConfig } from "../graduation.js";
import { parseWorker } from "../worker.js";
import {
  decideWorkerAction,
  disallowedToolsForAgentStep,
  flowsUngated,
  mergeAgentDisallowedTools,
} from "../workerGate.js";
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

/**
 * Build a store where `workerId` has earned exactly L2 on `toolName`.
 * ~10 bulk successes puts LCB ~0.80 (above L2 threshold 0.70, below L3 0.85).
 * Two dwell-separated outcomes climb the ramp L0→L1→L2.
 */
function storeWithL2(workerId: string, toolName: string): WorkerLevelStore {
  const store = new WorkerLevelStore();
  for (let i = 0; i < 10; i++)
    store.apply(workerId, { toolName, good: true, at: 0 }, { cfg: CFG });
  store.apply(workerId, { toolName, good: true, at: 1000 }, { cfg: CFG });
  store.apply(workerId, { toolName, good: true, at: 2000 }, { cfg: CFG });
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
    const w = parseWorker({ id: "w", name: "W", owns: ["vcs-push"] });
    const d = decideWorkerAction(w, "gitPush", {}, new WorkerLevelStore());
    expect(d.action).toBe("gate");
    expect(d.owned).toBe(true);
    expect(d.effectiveLevel).toBe(0);
    expect(d.reason).toContain("unearned");
  });

  it("ALLOWS a risky action once the worker has earned L4 on it", () => {
    const w = parseWorker({ id: "w", name: "W", owns: ["vcs-push"] });
    const d = decideWorkerAction(w, "gitPush", {}, storeWithL4("w", "gitPush"));
    expect(d.earnedLevel).toBe(4);
    expect(d.effectiveLevel).toBe(4);
    expect(d.action).toBe("allow");
    expect(d.reason).toContain("earned autonomy");
  });

  it("autonomyCeiling=1 blocks compensable even at earned L4 (ceiling below L2 threshold)", () => {
    const w = parseWorker({
      id: "w",
      name: "W",
      owns: ["vcs-push"],
      autonomyCeiling: 1,
    });
    const d = decideWorkerAction(w, "gitPush", {}, storeWithL4("w", "gitPush"));
    expect(d.earnedLevel).toBe(4);
    expect(d.effectiveLevel).toBe(1);
    expect(d.action).toBe("gate");
    expect(d.reason).toContain("autonomy ceiling");
  });

  it("autonomyCeiling=2 allows compensable at L2 (ceiling meets threshold)", () => {
    const w = parseWorker({
      id: "w",
      name: "W",
      owns: ["vcs-push"],
      autonomyCeiling: 2,
    });
    const d = decideWorkerAction(w, "gitPush", {}, storeWithL4("w", "gitPush"));
    expect(d.earnedLevel).toBe(4);
    expect(d.effectiveLevel).toBe(2);
    expect(d.action).toBe("allow");
    expect(d.reason).toContain("L2+");
  });

  it("ALLOWS compensable once worker naturally earns L2 (no ceiling override)", () => {
    const w = parseWorker({ id: "w", name: "W", owns: ["vcs-push"] });
    const store = storeWithL2("w", "gitPush");
    const d = decideWorkerAction(w, "gitPush", {}, store);
    // Pin the exact earned rung (the helper is built to land at L2) so a
    // graduation-curve regression that over- or under-shoots is caught.
    expect(d.earnedLevel).toBe(2);
    expect(d.action).toBe("allow");
    expect(d.reason).toContain("L2+");
  });

  it("GATES compensable at effective L1 (earnedLevel < 2)", () => {
    // Worker owns vcs-remote but has almost no evidence → L0/L1 → still gated.
    const w = parseWorker({ id: "w", name: "W", owns: ["vcs-push"] });
    const store = new WorkerLevelStore();
    store.apply("w", { toolName: "gitPush", good: true, at: 0 }, { cfg: CFG });
    const d = decideWorkerAction(w, "gitPush", {}, store);
    expect(d.earnedLevel).toBeLessThan(2);
    expect(d.action).toBe("gate");
    expect(d.reason).toContain("unearned");
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

describe("contextRiskCeiling", () => {
  it("descends with risk; clean/unknown → no de-rate (L4)", () => {
    expect(contextRiskCeiling(0)).toBe(4);
    expect(contextRiskCeiling(0.1)).toBe(4);
    expect(contextRiskCeiling(0.3)).toBe(2);
    expect(contextRiskCeiling(0.5)).toBe(1);
    expect(contextRiskCeiling(0.8)).toBe(0);
    expect(contextRiskCeiling(1)).toBe(0);
    expect(contextRiskCeiling(Number.NaN)).toBe(4); // unmeasured → no de-rate
    expect(contextRiskCeiling(-1)).toBe(4);
  });
});

describe("decideWorkerAction — context-risk descending clamp (keystone seam)", () => {
  it("is a no-op when no contextRisk is supplied (backward-compatible)", () => {
    const w = parseWorker({ id: "w", name: "W", owns: ["vcs-push"] });
    const d = decideWorkerAction(w, "gitPush", {}, storeWithL4("w", "gitPush"));
    expect(d.action).toBe("allow");
    expect(d.contextCeiling).toBeUndefined();
  });

  it("throttles an EARNED risky action down to gate under dangerous context", () => {
    // earned L4 on gitPush, but the live situation is dangerous (score 0.9 →
    // ceiling L0). The compensable action that would auto-allow at L2 is gated.
    const w = parseWorker({ id: "w", name: "W", owns: ["vcs-push"] });
    const d = decideWorkerAction(
      w,
      "gitPush",
      {},
      storeWithL4("w", "gitPush"),
      {
        contextRisk: { score: 0.9, reasons: ["CI red", "diff 1.2k lines"] },
      },
    );
    expect(d.earnedLevel).toBe(4);
    expect(d.contextCeiling).toBe(0);
    expect(d.effectiveLevel).toBe(0);
    expect(d.action).toBe("gate");
    expect(d.reason).toContain("context-risk");
    expect(d.reason).toContain("CI red");
  });

  it("does NOT throttle when the context is clean (earned autonomy preserved)", () => {
    const w = parseWorker({ id: "w", name: "W", owns: ["vcs-push"] });
    const d = decideWorkerAction(
      w,
      "gitPush",
      {},
      storeWithL4("w", "gitPush"),
      {
        contextRisk: { score: 0.0 },
      },
    );
    expect(d.contextCeiling).toBe(4);
    expect(d.effectiveLevel).toBe(4);
    expect(d.action).toBe("allow");
  });

  it("never WIDENS: context-risk can't lift an unearned action to allow", () => {
    // unearned compensable + clean context → still gated (clamp only lowers).
    const w = parseWorker({ id: "w", name: "W", owns: ["vcs-push"] });
    const d = decideWorkerAction(w, "gitPush", {}, new WorkerLevelStore(), {
      contextRisk: { score: 0 },
    });
    expect(d.action).toBe("gate");
  });

  it("reversible actions still flow un-gated regardless of context-risk", () => {
    // reversible = undoable; context-risk lowers the level but the reversible
    // path is exempt from the level requirement by design.
    const w = parseWorker({ id: "w", name: "W", owns: ["fs-write"] });
    const d = decideWorkerAction(w, "editText", {}, new WorkerLevelStore(), {
      contextRisk: { score: 0.95 },
    });
    expect(d.action).toBe("allow");
  });
});

describe("disallowedToolsForAgentStep (agent-bypass sandbox)", () => {
  it("blocks risky tools the worker can't run autonomously, not reversible ones", () => {
    const w = parseWorker({ id: "w", name: "W", owns: ["fs-write"] });
    const blocked = disallowedToolsForAgentStep(w, new WorkerLevelStore());
    // risky (compensable/irreversible) tools the worker can't do → blocked,
    // in BOTH the bare form (native CC tools) and the bridge MCP form so a
    // claude -p `--disallowed-tools` actually denies the MCP call.
    expect(blocked).toContain("gitPush");
    expect(blocked).toContain("mcp__patchwork__gitPush");
    expect(blocked).toContain("githubMergePR");
    expect(blocked).toContain("slackPostMessage");
    expect(blocked).toContain("runCommand");
    // native CC shell tool is blocked too (the primary agent side-effect vector)
    expect(blocked).toContain("Bash");
    // reversible tools flow un-gated → NEVER blocked (the agent needs them)
    expect(blocked).not.toContain("getGitStatus");
    expect(blocked).not.toContain("editText");
    expect(blocked).not.toContain("mcp__patchwork__editText");
    // the reasoning step itself is never self-blocked
    expect(blocked).not.toContain("agent");
    // recipe-DSL ids (with a ".") are never emitted — the subprocess can't call
    // them; only their camelCase MCP twin is.
    expect(blocked.some((t) => t.includes("."))).toBe(false);
    // Harmless read/nav tools classify as other:irreversible:low — they must NOT
    // be over-blocked, or the agent loses the tools it needs to investigate.
    for (const read of [
      "getDiagnostics",
      "searchWorkspace",
      "goToDefinition",
      "getHover",
    ]) {
      expect(blocked).not.toContain(read);
    }
  });

  it("does NOT block a risky tool the worker has EARNED autonomy on", () => {
    // owns vcs-push + earned L4 on gitPush → the agent may use it.
    const w = parseWorker({ id: "w", name: "W", owns: ["vcs-push"] });
    const blocked = disallowedToolsForAgentStep(w, storeWithL4("w", "gitPush"));
    expect(blocked).not.toContain("gitPush");
    // a DIFFERENT risky class it has not earned is still blocked.
    expect(blocked).toContain("githubMergePR");
  });

  it("a lowered autonomy ceiling blocks even an earned risky tool", () => {
    // earned L4 on gitPush but ceiling L1 → effective L1 < L2 → gated → blocked.
    const w = parseWorker({
      id: "w",
      name: "W",
      owns: ["vcs-push"],
      autonomyCeiling: 1,
    });
    const blocked = disallowedToolsForAgentStep(w, storeWithL4("w", "gitPush"));
    expect(blocked).toContain("gitPush");
  });
});

describe("mergeAgentDisallowedTools", () => {
  it("unions + dedups + sorts when a worker list is present", () => {
    expect(mergeAgentDisallowedTools(["b", "a"], ["a", "c"])).toEqual([
      "a",
      "b",
      "c",
    ]);
    expect(mergeAgentDisallowedTools(undefined, ["c", "a", "a"])).toEqual([
      "a",
      "c",
    ]);
  });

  it("returns undefined when both empty", () => {
    expect(mergeAgentDisallowedTools(undefined, undefined)).toBeUndefined();
    expect(mergeAgentDisallowedTools([], [])).toBeUndefined();
  });

  it("preserves the step's list VERBATIM when there is no worker list (non-worker byte-identical)", () => {
    // order + duplicates retained — argv must match pre-flip behaviour exactly.
    expect(mergeAgentDisallowedTools(["b", "a", "b"], undefined)).toEqual([
      "b",
      "a",
      "b",
    ]);
    expect(mergeAgentDisallowedTools(["b", "a"], [])).toEqual(["b", "a"]);
  });
});
