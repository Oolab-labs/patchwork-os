/**
 * Worker-autonomy gate at the orchestration layer (review #1027 M1 + M3 + M4).
 *
 * buildWorkerAutonomyGate is the seam that carries the headline invariants:
 *   - FLOOR composition (never-widen): a worker `allow` decision DEFERS to the
 *     tier fn, so it can only ADD gating, never drop tier-policy protection.
 *   - agent steps are not gated forever (M3).
 *   - fail-closed: a gated risky step resolves false on reject / cancel / expire
 *     and true only on an explicit approve (M4).
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getApprovalQueue,
  resetApprovalQueueForTests,
} from "../approvalQueue.js";
import { FLAG_WORKER_AUTONOMY, setFlag } from "../featureFlags.js";
import {
  buildWorkerAgentDisallowedTools,
  buildWorkerAutonomyGate,
} from "../recipeOrchestration.js";
import { RecipeRunLog } from "../runLog.js";
import type { RecordGateDecisionInput } from "../workerGateDecisionLog.js";

/** Seed durable, dwell-separated successes so the worker earns autonomy on
 *  `tool`'s class (ancient timestamps → durable under durable-outcome labels). */
function seedEarned(dir: string, recipeName: string, tool: string, n = 18) {
  const log = new RecipeRunLog({ dir });
  const SEVEN_HOURS = 7 * 3600 * 1000;
  for (let i = 0; i < n; i++) {
    log.appendDirect({
      taskId: `seed-${i}`,
      recipeName,
      trigger: "recipe",
      status: "done",
      createdAt: i * SEVEN_HOURS,
      doneAt: i * SEVEN_HOURS,
      durationMs: 1,
      stepResults: Array.from({ length: 5 }, (_, k) => ({
        id: `s${i}-${k}`,
        tool,
        status: "ok" as const,
        durationMs: 1,
      })),
    });
  }
}

const WORKER_YAML = `id: test-worker
name: Test Worker
recipe: test-recipe
owns:
  - fs-write
  - vcs-remote
autonomyCeiling: 4
`;

const tick = () => new Promise((r) => setImmediate(r));

function firstCallId(): string {
  const [pend] = getApprovalQueue().list();
  if (!pend) throw new Error("expected one pending approval");
  return pend.callId;
}

describe("buildWorkerAutonomyGate", () => {
  let dir: string;
  let opts: { workersDir: string; patchworkDir: string };

  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), "pw-wgate-"));
    const workersDir = path.join(dir, "workers");
    mkdirSync(workersDir, { recursive: true });
    writeFileSync(path.join(workersDir, "test.worker.yaml"), WORKER_YAML);
    opts = { workersDir, patchworkDir: dir }; // empty patchworkDir → unearned
    setFlag(FLAG_WORKER_AUTONOMY, true, false);
    resetApprovalQueueForTests();
  });

  afterEach(() => {
    setFlag(FLAG_WORKER_AUTONOMY, false, false);
    resetApprovalQueueForTests();
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns null when the flag is off", async () => {
    setFlag(FLAG_WORKER_AUTONOMY, false, false);
    const g = await buildWorkerAutonomyGate("test-recipe", undefined, opts);
    expect(g).toBeNull();
  });

  it("returns null when no worker owns the recipe", async () => {
    const g = await buildWorkerAutonomyGate("unknown-recipe", undefined, opts);
    expect(g).toBeNull();
  });

  it("FLOOR: a reversible step defers to the tier fn — never widens (M1)", async () => {
    // tier fn would have queued/rejected this step; the worker gate must NOT
    // auto-allow it just because it is reversible.
    const tierFn = vi.fn(async () => false);
    const g = await buildWorkerAutonomyGate("test-recipe", tierFn, opts);
    const r = await g!({ toolId: "editText", tier: "high", params: {} });
    expect(tierFn).toHaveBeenCalledTimes(1);
    expect(r).toBe(false); // tier protection retained
  });

  it("FLOOR: a reversible step is allowed when the tier fn allows", async () => {
    const tierFn = vi.fn(async () => true);
    const g = await buildWorkerAutonomyGate("test-recipe", tierFn, opts);
    const r = await g!({ toolId: "editText", tier: "low", params: {} });
    expect(tierFn).toHaveBeenCalledTimes(1);
    expect(r).toBe(true);
  });

  it("agent steps defer to the tier fn, never gate forever (M3)", async () => {
    const tierFn = vi.fn(async () => true);
    const g = await buildWorkerAutonomyGate("test-recipe", tierFn, opts);
    const r = await g!({ toolId: "agent", tier: "medium", params: {} });
    expect(tierFn).toHaveBeenCalledTimes(1);
    expect(r).toBe(true);
  });

  it("a reversible step flows when there is no tier fn (approvalGate off)", async () => {
    const g = await buildWorkerAutonomyGate("test-recipe", undefined, opts);
    const r = await g!({ toolId: "editText", tier: "low", params: {} });
    expect(r).toBe(true);
  });

  it("fail-closed: a risky unearned step queues and REJECT → false (M4)", async () => {
    const g = await buildWorkerAutonomyGate("test-recipe", undefined, opts);
    const p = g!({ toolId: "gitPush", tier: "high", params: {} });
    await tick();
    expect(getApprovalQueue().list()).toHaveLength(1);
    getApprovalQueue().reject(firstCallId());
    expect(await p).toBe(false);
  });

  it("fail-closed: a risky unearned step CANCEL → false (M4)", async () => {
    const g = await buildWorkerAutonomyGate("test-recipe", undefined, opts);
    const p = g!({ toolId: "gitPush", tier: "high", params: {} });
    await tick();
    getApprovalQueue().cancel(firstCallId());
    expect(await p).toBe(false);
  });

  it("fail-closed: a risky unearned step EXPIRE → false (M4)", async () => {
    const g = await buildWorkerAutonomyGate("test-recipe", undefined, opts);
    const p = g!({ toolId: "gitPush", tier: "high", params: {} });
    await tick();
    getApprovalQueue().clear(); // resolves pending as "expired"
    expect(await p).toBe(false);
  });

  it("a risky unearned step APPROVE → true (M4)", async () => {
    const g = await buildWorkerAutonomyGate("test-recipe", undefined, opts);
    const p = g!({ toolId: "gitPush", tier: "high", params: {} });
    await tick();
    getApprovalQueue().approve(firstCallId());
    expect(await p).toBe(true);
  });

  it("aborting the run signal resolves a gated step false, not a TTL hang (L1)", async () => {
    const g = await buildWorkerAutonomyGate("test-recipe", undefined, opts);
    const ac = new AbortController();
    const p = g!({
      toolId: "gitPush",
      tier: "high",
      params: {},
      signal: ac.signal,
    });
    await tick();
    expect(getApprovalQueue().list()).toHaveLength(1);
    ac.abort(); // run cancelled → pending approval resolves "cancelled"
    expect(await p).toBe(false);
  });

  it("context-risk DE-RATES an EARNED action (live wiring, descending only)", async () => {
    seedEarned(dir, "test-recipe", "githubCreatePR"); // worker earns vcs-remote

    // Baseline: earned + clean context → the action flows.
    const clean = await buildWorkerAutonomyGate(
      "test-recipe",
      undefined,
      opts,
      {
        contextRiskProvider: async () => undefined,
      },
    );
    expect(
      await clean!({ toolId: "githubCreatePR", tier: "high", params: {} }),
    ).toBe(true);

    // Dangerous live context → the SAME earned action is throttled to a gate
    // (queues for approval). Proves the resolved contextRisk reaches the decision.
    const risky = await buildWorkerAutonomyGate(
      "test-recipe",
      undefined,
      opts,
      {
        contextRiskProvider: async () => ({
          score: 0.9,
          reasons: ["huge uncommitted diff"],
        }),
      },
    );
    const p = risky!({ toolId: "githubCreatePR", tier: "high", params: {} });
    await tick();
    expect(getApprovalQueue().list()).toHaveLength(1);
    getApprovalQueue().reject(firstCallId());
    expect(await p).toBe(false);
  });

  it("a failing context-risk provider is fail-soft (no de-rate, no crash)", async () => {
    seedEarned(dir, "test-recipe", "githubCreatePR");
    const gate = await buildWorkerAutonomyGate("test-recipe", undefined, opts, {
      contextRiskProvider: async () => {
        throw new Error("git blew up");
      },
    });
    // provider threw → contextRisk undefined → earned action still flows.
    expect(
      await gate!({ toolId: "githubCreatePR", tier: "high", params: {} }),
    ).toBe(true);
  });

  it("records a Decision Record on BOTH the gate and allow paths", async () => {
    const records: RecordGateDecisionInput[] = [];
    const gate = await buildWorkerAutonomyGate("test-recipe", undefined, opts, {
      recordGateDecision: (r) => records.push(r),
    });
    // GATE path: unowned risky gitPush (worker owns vcs-remote, not vcs-push).
    const p = gate!({ toolId: "gitPush", tier: "high", params: {} });
    await tick();
    getApprovalQueue().reject(firstCallId());
    await p;
    // ALLOW path: reversible editText flows.
    expect(await gate!({ toolId: "editText", tier: "low", params: {} })).toBe(
      true,
    );

    const gated = records.find((r) => r.toolName === "gitPush");
    const allowed = records.find((r) => r.toolName === "editText");
    expect(gated?.action).toBe("gate"); // autonomous gate is recorded
    expect(allowed?.action).toBe("allow"); // and the allow leaves a trail too
    // the record carries the decision INPUTS, not just a verdict
    expect(gated?.classKey).toContain("vcs-push");
    expect(gated?.owned).toBe(false);
    expect(gated?.gatePolicyVersion).toBe("worker-ramp-v0");
    expect(allowed?.reversibility).toBe("reversible");
  });

  it("a throwing recordGateDecision never blocks the gate (fail-soft)", async () => {
    const gate = await buildWorkerAutonomyGate("test-recipe", undefined, opts, {
      recordGateDecision: () => {
        throw new Error("disk full");
      },
    });
    // logging blew up, but the reversible action still flows.
    expect(await gate!({ toolId: "editText", tier: "low", params: {} })).toBe(
      true,
    );
  });
});

describe("buildWorkerAgentDisallowedTools (agent-step bypass)", () => {
  let dir: string;
  let opts: { workersDir: string; patchworkDir: string };

  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), "pw-wagent-"));
    const workersDir = path.join(dir, "workers");
    mkdirSync(workersDir, { recursive: true });
    writeFileSync(path.join(workersDir, "test.worker.yaml"), WORKER_YAML);
    opts = { workersDir, patchworkDir: dir }; // empty patchworkDir → unearned
    setFlag(FLAG_WORKER_AUTONOMY, true, false);
  });

  afterEach(() => {
    setFlag(FLAG_WORKER_AUTONOMY, false, false);
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns null when the flag is off", async () => {
    setFlag(FLAG_WORKER_AUTONOMY, false, false);
    expect(
      await buildWorkerAgentDisallowedTools("test-recipe", opts),
    ).toBeNull();
  });

  it("returns null when no worker owns the recipe", async () => {
    expect(
      await buildWorkerAgentDisallowedTools("unknown-recipe", opts),
    ).toBeNull();
  });

  it("blocks risky-unearned tools (both forms) but not reversible ones", async () => {
    const list = await buildWorkerAgentDisallowedTools("test-recipe", opts);
    expect(list).not.toBeNull();
    expect(list).toContain("gitPush");
    expect(list).toContain("mcp__patchwork__gitPush");
    expect(list).toContain("Bash");
    // reversible tools the agent legitimately needs stay callable
    expect(list).not.toContain("editText");
    expect(list).not.toContain("getGitStatus");
  });
});
