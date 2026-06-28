import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RecipeRunLog } from "../../runLog.js";
import {
  getWorkerShadowData,
  loadWorkerTrustForRecipe,
} from "../runWorkerShadow.js";
import { decideWorkerAction } from "../workerGate.js";

const WORKERS_DIR = path.join(process.cwd(), "templates", "workers");

describe("getWorkerShadowData", () => {
  let emptyDir: string;
  beforeEach(() => {
    emptyDir = mkdtempSync(path.join(os.tmpdir(), "pw-shadow-data-"));
  });
  afterEach(() => {
    rmSync(emptyDir, { recursive: true, force: true });
  });

  it("returns a structured per-worker report (empty logs → empty dials)", () => {
    const data = getWorkerShadowData({
      workersDir: WORKERS_DIR,
      patchworkDir: emptyDir, // no runs.jsonl
      ideDir: emptyDir, // no activity-*.jsonl
    });
    expect(data.workers.length).toBeGreaterThanOrEqual(3);
    expect(data.workers[0]).toHaveProperty("workerId");
    expect(data.workers[0]).toHaveProperty("board");
    expect(data.workers[0]).toHaveProperty("autonomyCeiling");
    expect(data.runsScanned).toBe(0);
    expect(data.decisionsScanned).toBe(0);
  });

  it("returns no workers when the workers dir is absent", () => {
    const data = getWorkerShadowData({
      workersDir: path.join(emptyDir, "nope"),
      patchworkDir: emptyDir,
      ideDir: emptyDir,
    });
    expect(data.workers).toEqual([]);
  });
});

describe("loadWorkerTrustForRecipe (live-gate entry)", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), "pw-worker-trust-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns null when no worker owns the recipe", () => {
    const trust = loadWorkerTrustForRecipe("some-random-recipe", {
      workersDir: WORKERS_DIR,
      patchworkDir: dir,
    });
    expect(trust).toBeNull();
  });

  it("resolves the owning worker with an empty store when there are no runs", () => {
    const trust = loadWorkerTrustForRecipe("release-notes", {
      workersDir: WORKERS_DIR,
      patchworkDir: dir, // no runs.jsonl
    });
    expect(trust).not.toBeNull();
    expect(trust?.worker.id).toBe("release-notes-worker");
    expect(trust?.store.board("release-notes-worker")).toEqual([]);
    // a reversible action still flows even on an empty store
    const d = decideWorkerAction(trust!.worker, "editText", {}, trust!.store);
    expect(d.action).toBe("allow");
  });

  it("replays the run log into the store (same source as the dial)", () => {
    const log = new RecipeRunLog({ dir });
    log.appendDirect({
      taskId: "t1",
      recipeName: "release-notes",
      trigger: "recipe",
      status: "done",
      createdAt: 0,
      doneAt: 1,
      durationMs: 1,
      stepResults: [
        { id: "s1", tool: "editText", status: "ok", durationMs: 1 },
        { id: "s2", tool: "getGitStatus", status: "ok", durationMs: 1 },
      ],
    });
    const trust = loadWorkerTrustForRecipe("release-notes", {
      workersDir: WORKERS_DIR,
      patchworkDir: dir,
    });
    expect(trust).not.toBeNull();
    // the seeded successes are now evidence on the worker's dial
    const board = trust?.store.board("release-notes-worker") ?? [];
    expect(board.length).toBeGreaterThan(0);
    expect(board.some((b) => b.classKey.startsWith("fs-write"))).toBe(true);
  });

  it("a risky class can graduate to earned L4 via ascending replay (M2)", () => {
    // test-guardian owns `issue` (compensable, ceiling 4); githubCreateIssue is
    // an issue-domain step. Seed many dwell-separated clean runs. With the
    // ascending-order fix the dwell/hysteresis logic promotes the class to L4,
    // so the live gate ALLOWS it. (Pre-fix the replay was newest-first → dwell
    // never held → the class would gate forever.)
    const log = new RecipeRunLog({ dir });
    const SEVEN_HOURS = 7 * 3600 * 1000; // > the 6h default dwell window
    for (let i = 0; i < 18; i++) {
      log.appendDirect({
        taskId: `t${i}`,
        recipeName: "triage-failing-tests",
        trigger: "recipe",
        status: "done",
        createdAt: i * SEVEN_HOURS,
        doneAt: i * SEVEN_HOURS,
        durationMs: 1,
        stepResults: Array.from({ length: 5 }, (_, k) => ({
          id: `s${i}-${k}`,
          tool: "githubCreateIssue",
          status: "ok" as const,
          durationMs: 1,
        })),
      });
    }
    const trust = loadWorkerTrustForRecipe("triage-failing-tests", {
      workersDir: WORKERS_DIR,
      patchworkDir: dir,
    });
    expect(trust).not.toBeNull();
    const d = decideWorkerAction(
      trust!.worker,
      "githubCreateIssue",
      {},
      trust!.store,
    );
    expect(d.owned).toBe(true);
    expect(d.earnedLevel).toBe(4);
    expect(d.action).toBe("allow");
  });
});
