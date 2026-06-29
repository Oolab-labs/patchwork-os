/**
 * Worker-autonomy SMOKE — end-to-end "does the machine work?" integration.
 *
 * Drives the REAL `triage-failing-tests-autofile` recipe through the REAL flat
 * (yaml) runner + the REAL worker-autonomy gate (`buildWorkerAutonomyGate`) +
 * the REAL `RecipeRunLog` + the REAL trust replay (`loadWorkerTrustForRecipe` /
 * `getWorkerShadowData`). Only the two EXTERNAL effects are stubbed:
 *   1. the Claude subprocess  — `claudeCodeFn` returns a canned triage note;
 *   2. the GitHub API         — the `createIssue` connector is mocked (no real
 *                                issue is filed).
 *
 * This mirrors how `recipeOrchestration.fireYamlRecipe` builds `runnerDeps`
 * (src/recipeOrchestration.ts ~1050-1135): `requireApprovalFn` =
 * `buildWorkerAutonomyGate(name, tierFn)`, `gateAutomatedRuns: true`, a real
 * `RecipeRunLog`, the `worker.autonomy` flag ON, and a real (auto-approving)
 * `ApprovalQueue` singleton.
 *
 * Asserts the four links of the chain the live dogfood depends on:
 *   A. the `github.create_issue` step GATES (compensable + unearned L4) while
 *      the reversible steps (git.log_since / agent / file.write) flow un-gated;
 *   B. on approval the gated step EXECUTES (connector called, step `success`);
 *   C. the run is PERSISTED to `runs.jsonl`;
 *   D. the trust replay ATTRIBUTES that run to the test-guardian worker and
 *      records evidence on the `issue` action-class (the dial moves).
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parse as parseYaml } from "yaml";

// --- stub the GitHub connector (external effect #2) -------------------------
// `github.create_issue` does `await import("../../connectors/github.js")` and
// calls `createIssue`. Intercept the module so no real `gh`/API call happens.
const createIssueMock = vi.fn(
  async (opts: { repo: string; title: string }) => ({
    number: 4242,
    url: `https://github.com/${opts.repo}/issues/4242`,
    title: opts.title,
  }),
);
vi.mock("../../connectors/github.js", () => ({
  createIssue: (...args: unknown[]) =>
    (createIssueMock as (...a: unknown[]) => unknown)(...args),
}));

import {
  getApprovalQueue,
  resetApprovalQueueForTests,
} from "../../approvalQueue.js";
import { FLAG_WORKER_AUTONOMY, setFlag } from "../../featureFlags.js";
import { buildWorkerAutonomyGate } from "../../recipeOrchestration.js";
import { RecipeRunLog } from "../../runLog.js";
import {
  getWorkerShadowData,
  loadWorkerTrustForRecipe,
} from "../../workers/runWorkerShadow.js";
import {
  type RunnerDeps,
  runYamlRecipe,
  type YamlRecipe,
} from "../yamlRunner.js";

const RECIPE_NAME = "triage-failing-tests-autofile";
const WORKER_ID = "test-guardian-worker";

// Drive the REAL shipped artifacts off disk (repoRoot/templates/…) rather than
// hand-rolled copies, so the smoke can never drift from what the operator
// actually flips in production (review #smoke-review F4).
const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
const RECIPE_YAML = readFileSync(
  path.join(REPO_ROOT, "templates/recipes/triage-failing-tests-autofile.yaml"),
  "utf-8",
);
// The real test-guardian manifest ships pointed at the draft-to-file base
// recipe; flip its `recipe:` to the autofile variant — exactly "switch #2" in
// docs/runbooks/worker-autonomy-dogfood.md. Everything else (owns / ceiling /
// competence prior) is the genuine manifest.
const WORKER_MANIFEST = readFileSync(
  path.join(REPO_ROOT, "templates/workers/test-guardian.worker.yaml"),
  "utf-8",
).replace(
  /^recipe:\s*triage-failing-tests\s*$/m,
  "recipe: triage-failing-tests-autofile",
);

let tmpHome: string;
let patchworkDir: string;
let workersDir: string;
let realHome: string | undefined;
let realUserProfile: string | undefined;

beforeEach(() => {
  tmpHome = mkdtempSync(path.join(os.tmpdir(), "worker-smoke-home-"));
  patchworkDir = path.join(tmpHome, ".patchwork");
  workersDir = path.join(patchworkDir, "workers");
  mkdirSync(path.join(patchworkDir, "inbox"), { recursive: true });
  mkdirSync(workersDir, { recursive: true });
  writeFileSync(
    path.join(workersDir, "test-guardian.worker.yaml"),
    WORKER_MANIFEST,
  );
  // resolveRecipePath expands `~/` via os.homedir() — which reads $HOME on
  // POSIX and %USERPROFILE% on Windows — so override BOTH to land the recipe's
  // `~/.patchwork/inbox/…` write in the temp home on every platform.
  realHome = process.env.HOME;
  realUserProfile = process.env.USERPROFILE;
  process.env.HOME = tmpHome;
  process.env.USERPROFILE = tmpHome;
  setFlag(FLAG_WORKER_AUTONOMY, true, false);
  resetApprovalQueueForTests();
  createIssueMock.mockClear();
});

afterEach(() => {
  setFlag(FLAG_WORKER_AUTONOMY, false, false);
  resetApprovalQueueForTests();
  if (realHome === undefined) delete process.env.HOME;
  else process.env.HOME = realHome;
  if (realUserProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = realUserProfile;
  // Best-effort: a lingering file handle can make rmSync throw EBUSY on Windows;
  // a leaked temp dir must not fail the test.
  try {
    rmSync(tmpHome, { recursive: true, force: true });
  } catch {
    /* ignore — OS will reap the temp dir */
  }
});

function makeDeps(
  runLog: RecipeRunLog,
  requireApprovalFn: RunnerDeps["requireApprovalFn"],
): RunnerDeps {
  return {
    now: () => new Date("2026-06-29T09:00:00Z"),
    workdir: tmpHome,
    logDir: patchworkDir,
    runLog,
    requireApprovalFn,
    gateAutomatedRuns: true,
    claudeCodeFn: async () =>
      "Triage: foo.test.ts failed; suspect commit abc123.",
    readFile: () => {
      throw new Error("nf");
    },
    writeFile: (p: string, content: string) => {
      mkdirSync(path.dirname(p), { recursive: true });
      writeFileSync(p, content);
    },
    appendFile: () => {},
    mkdir: (p: string) => {
      mkdirSync(p, { recursive: true });
    },
    gitLogSince: () => "abc123 fix something",
    gitStaleBranches: () => "",
    getDiagnostics: () => "",
  };
}

describe("worker-autonomy smoke (triage-failing-tests-autofile, flag ON)", () => {
  it("gates the issue write, executes on approval, logs the run, and accrues evidence", async () => {
    // --- pre-run: the gate sees a COLD worker (no prior runs) --------------
    const preTrust = loadWorkerTrustForRecipe(RECIPE_NAME, {
      workersDir,
      patchworkDir,
    });
    expect(preTrust, "worker owns the autofile recipe").not.toBeNull();
    expect(preTrust?.worker.id).toBe(WORKER_ID);
    // Make the cold precondition EXPLICIT (review #smoke-review F2): the issue
    // class is unearned (no board row / L0) before the run, so the gate has a
    // reason to gate it. A leaked runs.jsonl pre-earning L4 would surface here.
    expect(
      preTrust?.store
        .board(WORKER_ID)
        .find((r) => r.classKey.includes("issue")),
      "issue class is cold (no prior evidence) before the run",
    ).toBeUndefined();

    // --- the real worker-autonomy gate (mirrors fireYamlRecipe wiring) -----
    // tierApprovalFn omitted (approvalGate off) → a worker `allow` means flow.
    const gate = await buildWorkerAutonomyGate(RECIPE_NAME, undefined, {
      workersDir,
      patchworkDir,
    });
    expect(
      gate,
      "flag ON + worker owns recipe → a gate fn is returned",
    ).not.toBeNull();

    // --- auto-approving ApprovalQueue: approve every queued call ----------
    // Records which toolIds were actually QUEUED (i.e. gated). Reversible
    // steps never reach the queue.
    const queuedTools = new Set<string>();
    const queue = getApprovalQueue();
    const unsub = queue.subscribe(() => {
      for (const pending of queue.list()) {
        queuedTools.add(pending.toolName);
        queue.approve(pending.callId);
      }
    });

    const runLog = new RecipeRunLog({ dir: patchworkDir });
    const recipe = parseYaml(RECIPE_YAML) as unknown as YamlRecipe;

    const result = await runYamlRecipe(
      recipe,
      makeDeps(runLog, gate ?? undefined),
      {
        repo: "patchwork/os",
        runner: "vitest",
        failed: "1",
        total: "42",
        failures: "foo.test.ts > does the thing",
        // Override the runner's auto-seeded `{{time}}` (HH:MM) — the recipe's
        // file.write target `…/test-triage-{{date}}-{{time}}.md` would otherwise
        // contain a `:`, which is a legal filename on POSIX but ILLEGAL on
        // Windows (writeFileSync → EINVAL), halting the run on windows-latest CI.
        time: "0900",
      },
    );
    unsub();

    // --- A. only the compensable github.create_issue step was GATED --------
    expect(
      [...queuedTools],
      "exactly the issue write is gated; reversible steps flow",
    ).toEqual(["github.create_issue"]);

    // --- B. the gated step EXECUTED once approved --------------------------
    expect(createIssueMock).toHaveBeenCalledTimes(1);
    expect(createIssueMock).toHaveBeenCalledWith(
      expect.objectContaining({ repo: "patchwork/os" }),
    );
    const issueStep = result.stepResults.find(
      (s) => s.tool === "github.create_issue",
    );
    expect(issueStep?.status).toBe("ok");
    // All four steps ran and EVERY one succeeded — assert the positive `ok`
    // status, not merely the absence of `error`, so a silently skipped/halted
    // reversible step (e.g. the file.write triage note) can't pass unnoticed
    // (review #smoke-review F5).
    expect(result.stepsRun).toBe(4);
    expect(result.stepResults.map((s) => s.status)).toEqual([
      "ok",
      "ok",
      "ok",
      "ok",
    ]);

    // The reversible file.write actually landed the triage note UNDER the temp
    // home — proves step C's side-effect ran AND that `~/` expanded to tmpHome
    // (hermeticity guard; review #smoke-review F3). If HOME expansion ever
    // broke, this fails loudly instead of polluting the real ~/.patchwork.
    const inboxDir = path.join(patchworkDir, "inbox");
    const notes = readdirSync(inboxDir).filter((f) =>
      f.startsWith("test-triage-"),
    );
    expect(notes.length, "triage note written to the temp inbox").toBe(1);
    expect(existsSync(path.join(inboxDir, notes[0] as string))).toBe(true);

    // --- C. the run is PERSISTED to runs.jsonl ----------------------------
    const runs = runLog.query({});
    const run = runs.find((r) => r.recipeName === RECIPE_NAME);
    expect(run, "run persisted to runs.jsonl").toBeDefined();
    expect(
      run?.stepResults?.some(
        (s) => s.tool === "github.create_issue" && s.status === "ok",
      ),
    ).toBe(true);

    // --- D. trust replay ATTRIBUTES the run + records issue-class evidence -
    const postTrust = loadWorkerTrustForRecipe(RECIPE_NAME, {
      workersDir,
      patchworkDir,
    });
    const board = postTrust?.store.board(WORKER_ID) ?? [];
    const issueRow = board.find((r) => r.classKey.includes("issue"));
    expect(
      issueRow,
      "issue action-class has evidence on the dial",
    ).toBeDefined();
    expect(issueRow?.observations ?? 0).toBeGreaterThanOrEqual(1);

    const shadow = getWorkerShadowData({
      workersDir,
      patchworkDir,
      ideDir: tmpHome,
    });
    expect(shadow.runsScanned).toBeGreaterThanOrEqual(1);
    expect(shadow.workers.some((w) => w.workerId === WORKER_ID)).toBe(true);
  });
});
