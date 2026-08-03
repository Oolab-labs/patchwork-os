/**
 * Prospective gate evaluation (GAP-2 / ADR-0017).
 *
 * The load-bearing test is the last one: preview and enforcement must agree for
 * every candidate. A boundary screen that disagrees with the gate is worse than
 * no screen — it tells an operator they are protected when they are not.
 */
import { describe, expect, it } from "vitest";

import type { GraduationConfig } from "../graduation.js";
import {
  boundarySize,
  type CandidateAction,
  previewActions,
} from "../previewActions.js";
import { parseWorker } from "../worker.js";
import { decideWorkerAction, gateOutcomeFor } from "../workerGate.js";
import { WorkerLevelStore } from "../workerLevelStore.js";

const CFG: GraduationConfig = {
  dwellMs: 100,
  demoteCooldownMs: 100,
};

const worker = () =>
  parseWorker({ id: "w", name: "W", owns: ["fs-write", "vcs-push"] });

const CANDIDATES: CandidateAction[] = [
  { toolName: "getGitStatus", label: "Read the repository status" },
  { toolName: "editText", label: "Edit a tracked file" },
  { toolName: "gitPush", label: "Push to the remote" },
];

describe("previewActions", () => {
  it("buckets candidates into the three columns", () => {
    const b = previewActions(worker(), CANDIDATES, new WorkerLevelStore());
    expect(boundarySize(b)).toBe(3);
    // Reversible reads and writes flow; an unearned push is gated.
    expect(b.mayDoNow.map((a) => a.toolName)).toContain("getGitStatus");
    expect(b.mayDoNow.map((a) => a.toolName)).toContain("editText");
    expect(b.needsApproval.map((a) => a.toolName)).toContain("gitPush");
    expect(b.notPermitted).toHaveLength(0);
  });

  it("puts a forbidden action in the third column, whatever its reversibility", () => {
    const b = previewActions(worker(), CANDIDATES, new WorkerLevelStore(), {
      forbidRules: [{ match: "fs-write", reason: "read-only workspace" }],
    });
    expect(b.notPermitted.map((a) => a.toolName)).toEqual(["editText"]);
    expect(b.notPermitted[0]?.reason).toContain("read-only workspace");
    expect(b.mayDoNow.map((a) => a.toolName)).not.toContain("editText");
  });

  it("carries the gate's own reason into the column", () => {
    // The screen shows why, in the words the gate used — not a re-description.
    const b = previewActions(worker(), CANDIDATES, new WorkerLevelStore());
    expect(b.mayDoNow[0]?.reason).toContain("reversible");
  });

  it("uses the label for people and keeps the tool name for machines", () => {
    const b = previewActions(
      worker(),
      [{ toolName: "getGitStatus", label: "Read the repository status" }],
      new WorkerLevelStore(),
    );
    expect(b.mayDoNow[0]?.label).toBe("Read the repository status");
    expect(b.mayDoNow[0]?.toolName).toBe("getGitStatus");
  });

  it("falls back to the tool name when no label is given", () => {
    const b = previewActions(
      worker(),
      [{ toolName: "getGitStatus" }],
      new WorkerLevelStore(),
    );
    expect(b.mayDoNow[0]?.label).toBe("getGitStatus");
  });

  it("preserves candidate order within a column", () => {
    const b = previewActions(
      worker(),
      [
        { toolName: "getGitStatus", label: "first" },
        { toolName: "editText", label: "second" },
      ],
      new WorkerLevelStore(),
    );
    expect(b.mayDoNow.map((a) => a.label)).toEqual(["first", "second"]);
  });

  it("handles an empty candidate list", () => {
    const b = previewActions(worker(), [], new WorkerLevelStore());
    expect(boundarySize(b)).toBe(0);
  });

  it("reflects earned trust — a push moves column once the worker earns it", () => {
    const w = worker();
    const store = new WorkerLevelStore();
    for (let i = 0; i < 80; i++)
      store.apply(
        w.id,
        { toolName: "gitPush", good: true, at: 0 },
        { cfg: CFG },
      );
    for (const at of [1000, 2000, 3000, 4000, 5000, 6000, 7000, 8000])
      store.apply(w.id, { toolName: "gitPush", good: true, at }, { cfg: CFG });

    const b = previewActions(w, CANDIDATES, store);
    expect(b.mayDoNow.map((a) => a.toolName)).toContain("gitPush");
    expect(b.needsApproval.map((a) => a.toolName)).not.toContain("gitPush");
  });

  it("does not mutate the trust store — a preview is not a decision", () => {
    const w = worker();
    const store = new WorkerLevelStore();
    previewActions(w, CANDIDATES, store);
    expect(store.toJSONL()).toBe(new WorkerLevelStore().toJSONL());
  });

  // ── the property the whole module exists for ──────────────────────────────

  it("AGREES WITH THE GATE for every candidate, in every configuration", () => {
    // A boundary screen that disagrees with enforcement is worse than none:
    // it tells an operator they are protected when they are not. This asserts
    // the two cannot diverge, by construction and in fact.
    const w = worker();
    const store = new WorkerLevelStore();
    const configs = [
      {},
      { forbidRules: [{ match: "fs-write", reason: "no writes" }] },
      { forbidRules: [{ match: "vcs-push", reason: "no pushes" }] },
      { forbidRules: [{ match: "nothing-matches-this", reason: "inert" }] },
    ];

    for (const opts of configs) {
      const b = previewActions(w, CANDIDATES, store, opts);
      for (const c of CANDIDATES) {
        const live = decideWorkerAction(w, c.toolName, c.params, store, opts);
        const expectedColumn =
          gateOutcomeFor(live.action) === "flow"
            ? b.mayDoNow
            : gateOutcomeFor(live.action) === "queue"
              ? b.needsApproval
              : b.notPermitted;
        expect(expectedColumn.map((a) => a.toolName)).toContain(c.toolName);
      }
    }
  });
});
