import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RecipeRunLog } from "../../runLog.js";
import { OutcomeStore } from "../outcomeStore.js";
import {
  computePendingConfirmations,
  formatPendingConfirmations,
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

  it("retains a buried worker run on the dial behind >100 unrelated runs", () => {
    // Dial-path twin of the live-gate regression: getWorkerShadowData must
    // filter runs by the loaded workers' recipes, not read the global last-100.
    const log = new RecipeRunLog({ dir: emptyDir });
    log.appendDirect({
      taskId: "rel",
      recipeName: "release-notes",
      trigger: "recipe",
      status: "done",
      createdAt: 0,
      doneAt: 1,
      durationMs: 1,
      stepResults: [
        { id: "s1", tool: "editText", status: "ok", durationMs: 1 },
      ],
    });
    for (let i = 0; i < 150; i++) {
      log.appendDirect({
        taskId: `noise-${i}`,
        recipeName: "some-unrelated-recipe",
        trigger: "recipe",
        status: "done",
        createdAt: 10 + i,
        doneAt: 11 + i,
        durationMs: 1,
        stepResults: [
          { id: `n${i}`, tool: "editText", status: "ok", durationMs: 1 },
        ],
      });
    }
    const data = getWorkerShadowData({
      workersDir: WORKERS_DIR,
      patchworkDir: emptyDir,
      ideDir: emptyDir,
    });
    const rel = data.workers.find((w) => w.workerId === "release-notes-worker");
    expect(rel?.board.length).toBeGreaterThan(0);
  });

  it("does NOT double-count evidence when two workers share a recipe (dedup)", () => {
    // Two manifests declaring the same recipe → recipeNames has a duplicate. An
    // un-deduped flatMap would query that recipe twice and ingest every run
    // twice, doubling the dial's evidence (a dial-vs-gate divergence). readRuns
    // dedups, so the owning (first-match) worker counts each run exactly once.
    const wdir = path.join(emptyDir, "dup-workers");
    mkdirSync(wdir, { recursive: true });
    const mk = (id: string) =>
      `id: ${id}\nname: ${id}\nrecipe: dup-recipe\nowns:\n  - fs-write\nautonomyCeiling: 4\n`;
    writeFileSync(path.join(wdir, "a.worker.yaml"), mk("worker-a"));
    writeFileSync(path.join(wdir, "b.worker.yaml"), mk("worker-b"));

    const log = new RecipeRunLog({ dir: emptyDir });
    log.appendDirect({
      taskId: "r1",
      recipeName: "dup-recipe",
      trigger: "recipe",
      status: "done",
      createdAt: 0,
      doneAt: 1,
      durationMs: 1,
      stepResults: [
        { id: "s1", tool: "editText", status: "ok", durationMs: 1 },
      ],
    });

    const data = getWorkerShadowData({
      workersDir: wdir,
      patchworkDir: emptyDir,
      ideDir: emptyDir,
    });
    // exactly ONE observation on the first-match worker's fs-write class, not 2.
    const owner = data.workers.find((w) => w.board.length > 0);
    const fsWrite = owner?.board.find((b) => b.classKey.startsWith("fs-write"));
    expect(fsWrite?.observations).toBe(1);
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

  it("retains a worker's evidence behind >500 unrelated runs (ring not just window)", () => {
    // Stronger than the 150-run case: the in-memory ring defaults to 500, so a
    // worker run buried behind >500 unrelated runs would be evicted from the ring
    // entirely (the per-recipe filter runs AFTER ring eviction). readRuns sizes
    // the ring to the full disk retention, so the worker run survives.
    const log = new RecipeRunLog({ dir });
    log.appendDirect({
      taskId: "worker-run",
      recipeName: "release-notes",
      trigger: "recipe",
      status: "done",
      createdAt: 0,
      doneAt: 1,
      durationMs: 1,
      stepResults: [
        { id: "s1", tool: "editText", status: "ok", durationMs: 1 },
      ],
    });
    for (let i = 0; i < 600; i++) {
      log.appendDirect({
        taskId: `noise-${i}`,
        recipeName: "some-unrelated-recipe",
        trigger: "recipe",
        status: "done",
        createdAt: 10 + i,
        doneAt: 11 + i,
        durationMs: 1,
        stepResults: [
          { id: `n${i}`, tool: "editText", status: "ok", durationMs: 1 },
        ],
      });
    }
    const trust = loadWorkerTrustForRecipe("release-notes", {
      workersDir: WORKERS_DIR,
      patchworkDir: dir,
    });
    expect(
      (trust?.store.board("release-notes-worker") ?? []).length,
    ).toBeGreaterThan(0);
  });

  it("retains a worker's evidence behind >100 newer unrelated runs (window eviction)", () => {
    // Regression: readRuns used query({}) (default limit 100). A low-frequency
    // worker's run buried behind >100 newer UNRELATED recipe runs aged out of
    // the window → the live gate saw zero evidence and silently floored the
    // worker to L0. This is exactly why test-guardian showed an empty dial
    // despite a real, correctly-executed run.
    const log = new RecipeRunLog({ dir });
    // One real worker run with a clean owned step (oldest by `at`).
    log.appendDirect({
      taskId: "worker-run",
      recipeName: "release-notes",
      trigger: "recipe",
      status: "done",
      createdAt: 0,
      doneAt: 1,
      durationMs: 1,
      stepResults: [
        { id: "s1", tool: "editText", status: "ok", durationMs: 1 },
      ],
    });
    // 150 unrelated (non-worker) runs AFTER it — these flood the default
    // 100-run query window and would evict the single worker run.
    for (let i = 0; i < 150; i++) {
      log.appendDirect({
        taskId: `noise-${i}`,
        recipeName: "some-unrelated-recipe",
        trigger: "recipe",
        status: "done",
        createdAt: 10 + i,
        doneAt: 11 + i,
        durationMs: 1,
        stepResults: [
          { id: `n${i}`, tool: "editText", status: "ok", durationMs: 1 },
        ],
      });
    }
    const trust = loadWorkerTrustForRecipe("release-notes", {
      workersDir: WORKERS_DIR,
      patchworkDir: dir,
    });
    expect(trust).not.toBeNull();
    // The worker's run must still be visible despite the newer noise.
    const board = trust?.store.board("release-notes-worker") ?? [];
    expect(board.length).toBeGreaterThan(0);
  });

  it("a risky class can graduate to earned L4 via ascending replay (M2)", () => {
    // test-guardian owns `issue` (compensable); githubCreateIssue is an
    // issue-domain step. Seed many dwell-separated clean runs. With the
    // ascending-order fix the dwell/hysteresis logic promotes the EARNED level
    // to L4 regardless of the gate's verdict. (Pre-fix the replay was
    // newest-first → dwell never held → the class would never earn L4.)
    // The worker's autonomyCeiling is capped at 1 (below the compensable
    // auto-allow threshold of L2) until the outcome-verification signal has a
    // real-world track record — so despite earning L4, the live gate still
    // gates the action rather than auto-allowing it.
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
    // Ceiling (1) < compensable threshold (2) → capped despite earned L4.
    expect(d.effectiveLevel).toBe(1);
    expect(d.action).toBe("gate");
  });

  it("dependency-upkeep's PR-opening stays gated at earned L4 (ceiling cap neutralises the PR trust-by-neglect leak)", () => {
    // dependency-upkeep owns `vcs-remote` (githubCreatePR, compensable). Its
    // ceiling is capped at 1 because there is no PR-outcome grader yet, so a bump
    // PR nobody reviews would otherwise fold good:true and graduate the class to
    // auto-open PRs (the trust-by-neglect leak, on the PR path). Seed enough
    // dwell-separated clean PR opens to earn L4, then prove the gate STILL gates.
    const log = new RecipeRunLog({ dir });
    const SEVEN_HOURS = 7 * 3600 * 1000; // > the 6h default dwell window
    for (let i = 0; i < 18; i++) {
      log.appendDirect({
        taskId: `dep${i}`,
        recipeName: "dependency-bump",
        trigger: "recipe",
        status: "done",
        createdAt: i * SEVEN_HOURS,
        doneAt: i * SEVEN_HOURS,
        durationMs: 1,
        stepResults: Array.from({ length: 5 }, (_, k) => ({
          id: `d${i}-${k}`,
          tool: "githubCreatePR",
          status: "ok" as const,
          durationMs: 1,
        })),
      });
    }
    const trust = loadWorkerTrustForRecipe("dependency-bump", {
      workersDir: WORKERS_DIR,
      patchworkDir: dir,
    });
    expect(trust).not.toBeNull();
    const d = decideWorkerAction(
      trust!.worker,
      "githubCreatePR",
      {},
      trust!.store,
    );
    expect(d.owned).toBe(true);
    expect(d.earnedLevel).toBe(4);
    // Ceiling (1) < compensable threshold (2) → capped despite earned L4.
    expect(d.effectiveLevel).toBe(1);
    expect(d.action).toBe("gate");
  });
});

describe("computePendingConfirmations (the confirm queue)", () => {
  let dir: string;
  let workersDir: string;
  const URL = "https://github.com/o/r/issues/42";

  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), "pw-pending-"));
    workersDir = path.join(dir, "workers");
    mkdirSync(workersDir, { recursive: true });
    writeFileSync(
      path.join(workersDir, "filer.worker.yaml"),
      "id: filer\nname: Filer\nrecipe: file-issues\nowns:\n  - issue\nautonomyCeiling: 4\n",
    );
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  function seedFiling(url: string, at = 0): void {
    new RecipeRunLog({ dir }).appendDirect({
      taskId: `run-${at}`,
      recipeName: "file-issues",
      trigger: "recipe",
      status: "done",
      createdAt: at,
      doneAt: at,
      durationMs: 1,
      stepResults: [
        {
          id: "s1",
          tool: "githubCreateIssue",
          status: "ok",
          durationMs: 1,
          output: { url },
        },
      ],
    });
  }

  it("lists a filing with no disposition as pending", () => {
    seedFiling(URL);
    const pending = computePendingConfirmations({
      workersDir,
      patchworkDir: dir,
    });
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({
      issueUrl: URL,
      recipeName: "file-issues",
      workerId: "filer",
    });
    expect(pending[0]?.classKey.startsWith("issue")).toBe(true);
  });

  it("excludes a filing once it has a disposition (confirmed or junk)", () => {
    seedFiling(URL);
    new OutcomeStore(dir).upsert({
      issueUrl: URL,
      disposition: "confirmed",
      checkedAt: 1,
    });
    const pending = computePendingConfirmations({
      workersDir,
      patchworkDir: dir,
    });
    expect(pending).toHaveLength(0);
  });

  it("dedupes by URL — a re-filed URL appears once, newest filing wins", () => {
    seedFiling(URL, 0);
    seedFiling(URL, 5000);
    const pending = computePendingConfirmations({
      workersDir,
      patchworkDir: dir,
    });
    expect(pending).toHaveLength(1);
    expect(pending[0]?.filedAt).toBe(5000);
  });

  it("ignores reversible steps + filing steps with no captured url", () => {
    new RecipeRunLog({ dir }).appendDirect({
      taskId: "mixed",
      recipeName: "file-issues",
      trigger: "recipe",
      status: "done",
      createdAt: 0,
      doneAt: 0,
      durationMs: 1,
      stepResults: [
        // reversible tool (fs-write) — never needs confirmation
        {
          id: "r1",
          tool: "editText",
          status: "ok",
          durationMs: 1,
          output: { url: "https://x/reversible" },
        },
        // non-reversible filing but no captured url
        { id: "r2", tool: "githubCreateIssue", status: "ok", durationMs: 1 },
      ],
    });
    const pending = computePendingConfirmations({
      workersDir,
      patchworkDir: dir,
    });
    expect(pending).toHaveLength(0);
  });

  it("formats the queue with the exact confirm command (and an empty-state)", () => {
    expect(formatPendingConfirmations([])).toMatch(/No filings awaiting/);
    seedFiling(URL);
    const out = formatPendingConfirmations(
      computePendingConfirmations({ workersDir, patchworkDir: dir }),
    );
    expect(out).toContain(URL);
    expect(out).toContain(`patchwork outcomes confirm ${URL}`);
    expect(out).toContain("--recipe file-issues");
  });
});
