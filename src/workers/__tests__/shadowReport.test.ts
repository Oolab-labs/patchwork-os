import path from "node:path";
import { describe, expect, it } from "vitest";
import type { GraduationConfig } from "../graduation.js";
import type { DecisionRecord, RunRecord } from "../shadowObserver.js";
import { buildShadowReport, formatShadowReport } from "../shadowReport.js";
import { parseWorker } from "../worker.js";
import { loadWorkersFromDir } from "../workerLoader.js";

const CFG: GraduationConfig = {
  dwellMs: 1000,
  demoteCooldownMs: 5000,
  minEvidenceForGraduation: 5,
};

const release = parseWorker({
  id: "release-notes-worker",
  name: "Release Worker",
  recipe: "release-notes",
  owns: ["fs-write"],
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

describe("loadWorkersFromDir", () => {
  it("loads the shipped dogfood worker manifests", () => {
    const dir = path.join(process.cwd(), "templates", "workers");
    const workers = loadWorkersFromDir(dir);
    expect(workers.map((w) => w.id)).toContain("release-notes-worker");
    expect(workers.length).toBeGreaterThanOrEqual(3);
  });

  it("returns [] for a missing directory (fail-soft)", () => {
    expect(loadWorkersFromDir(path.join(process.cwd(), "no-such-dir"))).toEqual(
      [],
    );
  });
});

describe("buildShadowReport", () => {
  it("interleaves runs + decisions by time and reports dial + comparison", () => {
    const runs: RunRecord[] = [
      editRun(0, 60),
      editRun(1000, 1),
      editRun(2000, 1),
      editRun(3000, 1),
      editRun(4000, 1),
    ];
    const decisions: DecisionRecord[] = [
      { toolName: "editText", decision: "deny", at: 5000 },
    ];
    const [r] = buildShadowReport([release], runs, decisions, CFG);
    expect(
      r!.board.find((b) => b.classKey === "fs-write:reversible:medium")?.level,
    ).toBe(4);
    expect(r!.compared).toBe(1);
    expect(r!.divergences).toHaveLength(1);
    expect(r!.divergences[0]!.ramp).toBe("bypass");
  });
});

describe("formatShadowReport", () => {
  it("renders the dial, the ceiling, and divergences", () => {
    const reports = buildShadowReport(
      [release],
      [
        editRun(0, 60),
        editRun(1000, 1),
        editRun(2000, 1),
        editRun(3000, 1),
        editRun(4000, 1),
      ],
      [{ toolName: "editText", decision: "deny", at: 5000 }],
      CFG,
    );
    const text = formatShadowReport(reports);
    expect(text).toContain("SHADOW");
    expect(text).toContain("Release Worker");
    expect(text).toContain("fs-write:reversible:medium");
    expect(text).toContain("ramp vs gate");
    expect(text).toContain("⚠");
  });

  it("shows an honest empty state when a worker has no activity", () => {
    const text = formatShadowReport(buildShadowReport([release], [], [], CFG));
    expect(text).toContain("no attributed activity yet");
  });

  it("annotates a NOT-OWNED class the worker performed (L3)", () => {
    // release owns fs-write only; a gitPush (vcs-remote) it performs is shown
    // but flagged because the live gate floors it to L0.
    const reports = buildShadowReport(
      [release],
      [
        {
          recipeName: "release-notes",
          at: 0,
          steps: [{ tool: "gitPush", status: "ok" }],
        },
      ],
      [],
      CFG,
    );
    const text = formatShadowReport(reports);
    expect(text).toContain("vcs-remote");
    expect(text).toContain("NOT OWNED");
  });
});
