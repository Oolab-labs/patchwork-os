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
import { buildWorkerAutonomyGate } from "../recipeOrchestration.js";

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
});
