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
    obs.ingestDecision({ toolName: "editText", decision: "deny", at: 5000 });
    // gate ALLOWED an editText the ramp would also auto-run → agreement
    obs.ingestDecision({ toolName: "editText", decision: "allow", at: 6000 });
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
    });
    expect(obs.report()[0]!.compared).toBe(0);
  });
});
