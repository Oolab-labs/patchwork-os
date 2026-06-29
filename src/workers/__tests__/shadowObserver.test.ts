import { describe, expect, it } from "vitest";
import type { GraduationConfig } from "../graduation.js";
import { type RunRecord, WorkerShadowObserver } from "../shadowObserver.js";
import { parseWorker } from "../worker.js";

const CFG: GraduationConfig = {
  dwellMs: 1000,
  demoteCooldownMs: 5000,
  minEvidenceForGraduation: 5,
};

const release = parseWorker({
  id: "release-notes-worker",
  name: "Release Worker",
  recipe: "release-notes",
  owns: ["fs-write", "vcs-read"],
});

function editRun(at: number, steps: number): RunRecord {
  return {
    recipeName: "release-notes",
    at,
    steps: Array.from({ length: steps }, () => ({
      tool: "editText",
      status: "ok" as const,
    })),
  };
}

function climb(obs: WorkerShadowObserver) {
  obs.ingestRun(editRun(0, 60)); // build posterior (no climb at t=0)
  for (const at of [1000, 2000, 3000, 4000]) obs.ingestRun(editRun(at, 1));
}

describe("WorkerShadowObserver", () => {
  it("feeds attributed recipe-run outcomes into the worker's dial", () => {
    const obs = new WorkerShadowObserver([release], { cfg: CFG });
    climb(obs);
    const r = obs.report()[0]!;
    const fsWrite = r.board.find(
      (b) => b.classKey === "fs-write:reversible:medium",
    );
    expect(fsWrite?.level).toBe(4);
    expect(r.events.some((e) => e.type === "promote")).toBe(true);
  });

  it("ignores runs whose recipe maps to no worker", () => {
    const obs = new WorkerShadowObserver([release], { cfg: CFG });
    obs.ingestRun({
      recipeName: "some-other-recipe",
      at: 0,
      steps: [{ tool: "editText", status: "ok" }],
    });
    expect(obs.report()[0]!.board).toHaveLength(0);
  });

  it("compares ramp recommendation against the live gate decision", () => {
    const obs = new WorkerShadowObserver([release], { cfg: CFG });
    climb(obs); // fs-write earned L4 → ramp would bypass editText
    // gate DENIED an editText the ramp would now auto-run → divergence
    obs.ingestDecision({
      toolName: "editText",
      decision: "deny",
      at: 5000,
      recipeName: "test-recipe",
    });
    // gate ALLOWED an editText the ramp would also auto-run → agreement
    obs.ingestDecision({
      toolName: "editText",
      decision: "allow",
      at: 6000,
      recipeName: "test-recipe",
    });
    const r = obs.report()[0]!;
    expect(r.compared).toBe(2);
    expect(r.agreed).toBe(1);
    expect(r.divergences).toHaveLength(1);
    expect(r.divergences[0]!.ramp).toBe("bypass");
    expect(r.divergences[0]!.gate).toBe("deny");
  });

  it("skips decisions for tools no single worker owns (ambiguous attribution)", () => {
    const obs = new WorkerShadowObserver([release], { cfg: CFG });
    // slackPostMessage is messaging — release doesn't own it
    obs.ingestDecision({
      toolName: "slackPostMessage",
      decision: "deny",
      at: 0,
      recipeName: "test-recipe",
    });
    expect(obs.report()[0]!.compared).toBe(0);
  });

  it("skips decisions without recipeName (plain Claude-session MCP approvals)", () => {
    // Decisions without recipeName are Claude-session tool calls, not worker-gate
    // decisions. Including them inflates divergences with calls the worker gate
    // never saw (e.g. this Claude Code session approving github.create_issue
    // directly via its own general approvalGate).
    const obs = new WorkerShadowObserver([release], { cfg: CFG });
    climb(obs); // fs-write earned L4
    // No recipeName → should be skipped entirely
    obs.ingestDecision({ toolName: "editText", decision: "deny", at: 5000 });
    expect(obs.report()[0]!.compared).toBe(0);
  });

  it("counts a genuine tool error as evidence but NOT a human rejection (L2)", () => {
    // a real failure is evidence (shows up on the dial)
    const real = new WorkerShadowObserver([release], { cfg: CFG });
    real.ingestRun({
      recipeName: "release-notes",
      at: 0,
      steps: [
        {
          tool: "editText",
          status: "error",
          haltReason: 'Tool "editText" threw: boom',
        },
      ],
    });
    expect(
      real.report()[0]!.board.some((b) => b.classKey.startsWith("fs-write")),
    ).toBe(true);

    // a human reject/expire/cancel is a control decision, not a worker failure
    const rejected = new WorkerShadowObserver([release], { cfg: CFG });
    rejected.ingestRun({
      recipeName: "release-notes",
      at: 0,
      steps: [
        {
          tool: "editText",
          status: "error",
          haltReason: "Step rejected by approval gate — approval_rejected.",
        },
      ],
    });
    expect(
      rejected
        .report()[0]!
        .board.some((b) => b.classKey.startsWith("fs-write")),
    ).toBe(false); // skipped → no evidence → no demotion
  });

  it("flags board rows for classes the worker performs but does NOT own (L3)", () => {
    const obs = new WorkerShadowObserver([release], { cfg: CFG });
    // gitPush is vcs-remote — release owns fs-write + vcs-read, NOT vcs-remote
    obs.ingestRun({
      recipeName: "release-notes",
      at: 0,
      steps: [{ tool: "gitPush", status: "ok" }],
    });
    const row = obs
      .report()[0]!
      .board.find((b) => b.classKey.startsWith("vcs-remote"));
    expect(row).toBeDefined();
    expect(row!.owned).toBe(false);
  });
});
