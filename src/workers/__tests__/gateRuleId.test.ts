/**
 * WHICH RULE decided this — a stable id per terminal branch of the gate.
 *
 * `reason` is prose and is expected to be reworded; a receipt, an operator
 * filter and any later grouping need a key that survives rewording. These
 * tests pin one id per branch and, more importantly, pin the SET: the
 * exhaustiveness map below is typed `Record<GateRuleId, ...>`, so adding a
 * member to the union is a compile error until it is listed here, and then a
 * test failure until a case actually produces it.
 *
 * Without that, a new branch silently inherits no id (or a neighbour's) and the
 * ledger's rule column quietly stops meaning what it says — the same class of
 * drift the `rv` protocol exists to prevent, one field over.
 */

import { describe, expect, it } from "vitest";
import type { GraduationConfig } from "../graduation.js";
import { parseWorker } from "../worker.js";
import { decideWorkerAction, type GateRuleId } from "../workerGate.js";
import { WorkerLevelStore } from "../workerLevelStore.js";

const CFG: GraduationConfig = {
  dwellMs: 1000,
  demoteCooldownMs: 5000,
  minEvidenceForGraduation: 5,
};

function storeWithL4(workerId: string, toolName: string): WorkerLevelStore {
  const store = new WorkerLevelStore();
  for (let i = 0; i < 80; i++)
    store.apply(workerId, { toolName, good: true, at: 0 }, { cfg: CFG });
  for (const at of [1000, 2000, 3000, 4000, 5000, 6000, 7000, 8000])
    store.apply(workerId, { toolName, good: true, at }, { cfg: CFG });
  return store;
}

function storeWithL2(workerId: string, toolName: string): WorkerLevelStore {
  const store = new WorkerLevelStore();
  for (let i = 0; i < 10; i++)
    store.apply(workerId, { toolName, good: true, at: 0 }, { cfg: CFG });
  store.apply(workerId, { toolName, good: true, at: 1000 }, { cfg: CFG });
  store.apply(workerId, { toolName, good: true, at: 2000 }, { cfg: CFG });
  return store;
}

/** Every id the union declares, and how to make the gate emit it. */
const CASES: Record<GateRuleId, () => GateRuleId> = {
  "forbid.workspace-policy": () =>
    decideWorkerAction(
      parseWorker({ id: "w", name: "W", owns: ["fs-write"] }),
      "editText",
      {},
      new WorkerLevelStore(),
      { forbidRules: [{ match: "fs-write", reason: "read-only workspace" }] },
    ).ruleId,

  "allow.agent-step": () =>
    decideWorkerAction(
      parseWorker({ id: "w", name: "W", owns: ["fs-write"] }),
      "agent",
      {},
      new WorkerLevelStore(),
    ).ruleId,

  "allow.reversible": () =>
    decideWorkerAction(
      parseWorker({ id: "w", name: "W", owns: ["fs-write"] }),
      "getGitStatus",
      {},
      new WorkerLevelStore(),
    ).ruleId,

  "allow.earned-compensable": () =>
    decideWorkerAction(
      parseWorker({ id: "w", name: "W", owns: ["vcs-push"] }),
      "gitPush",
      {},
      storeWithL2("w", "gitPush"),
    ).ruleId,

  "allow.earned-autonomous": () =>
    decideWorkerAction(
      parseWorker({ id: "w", name: "W", owns: ["messaging"] }),
      "slackPostMessage",
      {},
      storeWithL4("w", "slackPostMessage"),
    ).ruleId,

  // Earned L4 AND a permissive ceiling, throttled only by the live situation —
  // so the id must attribute it to context-risk and not to stale trust.
  "gate.context-risk-throttle": () =>
    decideWorkerAction(
      parseWorker({ id: "w", name: "W", owns: ["messaging"] }),
      "slackPostMessage",
      {},
      storeWithL4("w", "slackPostMessage"),
      { contextRisk: { score: 1, reasons: ["huge uncommitted diff"] } },
    ).ruleId,

  "gate.unowned-class": () =>
    decideWorkerAction(
      parseWorker({ id: "w", name: "W", owns: ["fs-write"] }),
      "gitPush",
      {},
      new WorkerLevelStore(),
    ).ruleId,

  "gate.ceiling-below-threshold": () =>
    decideWorkerAction(
      parseWorker({
        id: "w",
        name: "W",
        owns: ["messaging"],
        autonomyCeiling: 1,
      }),
      "slackPostMessage",
      {},
      storeWithL4("w", "slackPostMessage"),
    ).ruleId,

  "gate.unearned-trust": () =>
    decideWorkerAction(
      parseWorker({ id: "w", name: "W", owns: ["vcs-push"] }),
      "gitPush",
      {},
      new WorkerLevelStore(),
    ).ruleId,
};

describe("every gate branch names its rule", () => {
  for (const [expected, run] of Object.entries(CASES) as Array<
    [GateRuleId, () => GateRuleId]
  >) {
    it(`emits ${expected}`, () => {
      expect(run()).toBe(expected);
    });
  }

  it("emits a DISTINCT id per branch — no two branches share one", () => {
    const emitted = Object.values(CASES).map((run) => run());
    expect(new Set(emitted).size).toBe(emitted.length);
  });

  it("covers every id the union declares", () => {
    // `CASES` is typed Record<GateRuleId, …>, so this asserts the runtime set
    // matches the type. A member added to the union without a case here fails
    // to compile; one added to both without a branch that produces it fails
    // the per-case test above.
    const declared = Object.keys(CASES) as GateRuleId[];
    const produced = new Set(declared.map((k) => CASES[k]()));
    for (const id of declared) expect(produced.has(id)).toBe(true);
  });
});

describe("ruleId is separate from reason, deliberately", () => {
  it("carries prose AND a key, and the key is not the prose", () => {
    const d = decideWorkerAction(
      parseWorker({ id: "w", name: "W", owns: ["vcs-push"] }),
      "gitPush",
      {},
      new WorkerLevelStore(),
    );
    expect(d.ruleId).toBe("gate.unearned-trust");
    expect(d.reason).toContain("unearned");
    expect(d.reason).not.toBe(d.ruleId);
  });
});
