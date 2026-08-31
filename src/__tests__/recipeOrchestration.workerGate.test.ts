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
import { OutcomeStore } from "../workers/outcomeStore.js";

/**
 * A stand-in run id for gate inputs. `runTaskId` is required on
 * `ApprovalRequestInput` so that a new approval call site cannot forget the
 * join key onto its run; a test that only exercises the decision still has to
 * name one.
 */
/**
 * The gate returns `boolean | ApprovalVerdict`. A bare `false` used to be the
 * ONLY thing it could say, which is why the three tests below — REJECT, CANCEL
 * and EXPIRE — all asserted the identical value while being named for three
 * different events. They now pin the refusal each one actually produces.
 */
async function verdictOf(
  p: Promise<boolean | { approved: boolean; refusal?: string }>,
) {
  const r = await p;
  return typeof r === "boolean" ? { approved: r } : r;
}

const TEST_RUN = "yaml:test-recipe:1756000000000";

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
        // Identifiable since #1322 — a non-reversible success that cannot be
        // referred to is WITHHELD, so a url-less seed earns nothing and every
        // "earned action" test below would silently be testing an UNEARNED
        // worker instead.
        output: { url: `https://github.com/o/r/pull/${tool}-${i}-${k}` },
      })),
    });
  }
  // ...and confirmed, as an operator would: earning now requires a human
  // disposition, not merely a step that did not error.
  const store = new OutcomeStore(dir);
  for (let i = 0; i < n; i++) {
    for (let k = 0; k < 5; k++) {
      store.upsert({
        issueUrl: `https://github.com/o/r/pull/${tool}-${i}-${k}`,
        disposition: "confirmed",
        checkedAt: 1,
        origin: "manual",
      });
    }
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
    const r = await g!({
      runTaskId: TEST_RUN,
      toolId: "editText",
      tier: "high",
      params: {},
    });
    expect(tierFn).toHaveBeenCalledTimes(1);
    expect(r).toBe(false); // tier protection retained
  });

  it("FLOOR: a reversible step is allowed when the tier fn allows", async () => {
    const tierFn = vi.fn(async () => true);
    const g = await buildWorkerAutonomyGate("test-recipe", tierFn, opts);
    const r = await g!({
      runTaskId: TEST_RUN,
      toolId: "editText",
      tier: "low",
      params: {},
    });
    expect(tierFn).toHaveBeenCalledTimes(1);
    expect(r).toBe(true);
  });

  it("agent steps defer to the tier fn, never gate forever (M3)", async () => {
    const tierFn = vi.fn(async () => true);
    const g = await buildWorkerAutonomyGate("test-recipe", tierFn, opts);
    const r = await g!({
      runTaskId: TEST_RUN,
      toolId: "agent",
      tier: "medium",
      params: {},
    });
    expect(tierFn).toHaveBeenCalledTimes(1);
    expect(r).toBe(true);
  });

  it("a reversible step flows when there is no tier fn (approvalGate off)", async () => {
    const g = await buildWorkerAutonomyGate("test-recipe", undefined, opts);
    const r = await g!({
      runTaskId: TEST_RUN,
      toolId: "editText",
      tier: "low",
      params: {},
    });
    expect(r).toBe(true);
  });

  it("fail-closed: a risky unearned step queues and REJECT → false (M4)", async () => {
    const g = await buildWorkerAutonomyGate("test-recipe", undefined, opts);
    const p = g!({
      runTaskId: TEST_RUN,
      toolId: "gitPush",
      tier: "high",
      params: {},
    });
    await tick();
    expect(getApprovalQueue().list()).toHaveLength(1);
    getApprovalQueue().reject(firstCallId());
    const v = await verdictOf(p);
    expect(v.approved).toBe(false);
    expect(v.refusal).toBe("rejected");
  });

  it("fail-closed: a risky unearned step CANCEL → false (M4)", async () => {
    const g = await buildWorkerAutonomyGate("test-recipe", undefined, opts);
    const p = g!({
      runTaskId: TEST_RUN,
      toolId: "gitPush",
      tier: "high",
      params: {},
    });
    await tick();
    getApprovalQueue().cancel(firstCallId());
    const v = await verdictOf(p);
    expect(v.approved).toBe(false);
    // NOT "rejected": nobody decided anything about this step.
    expect(v.refusal).toBe("cancelled");
  });

  it("fail-closed: a risky unearned step EXPIRE → false (M4)", async () => {
    const g = await buildWorkerAutonomyGate("test-recipe", undefined, opts);
    const p = g!({
      runTaskId: TEST_RUN,
      toolId: "gitPush",
      tier: "high",
      params: {},
    });
    await tick();
    getApprovalQueue().clear(); // resolves pending as "expired"
    const v = await verdictOf(p);
    expect(v.approved).toBe(false);
    // NOT "rejected": the TTL fired and no human ever saw it.
    expect(v.refusal).toBe("expired");
  });

  it("a risky unearned step APPROVE → true (M4)", async () => {
    const g = await buildWorkerAutonomyGate("test-recipe", undefined, opts);
    const p = g!({
      runTaskId: TEST_RUN,
      toolId: "gitPush",
      tier: "high",
      params: {},
    });
    await tick();
    getApprovalQueue().approve(firstCallId());
    expect((await verdictOf(p)).approved).toBe(true);
  });

  it("aborting the run signal resolves a gated step false, not a TTL hang (L1)", async () => {
    const g = await buildWorkerAutonomyGate("test-recipe", undefined, opts);
    const ac = new AbortController();
    const p = g!({
      runTaskId: TEST_RUN,
      toolId: "gitPush",
      tier: "high",
      params: {},
      signal: ac.signal,
    });
    await tick();
    expect(getApprovalQueue().list()).toHaveLength(1);
    ac.abort(); // run cancelled → pending approval resolves "cancelled"
    const v = await verdictOf(p);
    expect(v.approved).toBe(false);
    expect(v.refusal).toBe("cancelled");
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
      await clean!({
        runTaskId: TEST_RUN,
        toolId: "githubCreatePR",
        tier: "high",
        params: {},
      }),
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
    const p = risky!({
      runTaskId: TEST_RUN,
      toolId: "githubCreatePR",
      tier: "high",
      params: {},
    });
    await tick();
    expect(getApprovalQueue().list()).toHaveLength(1);
    getApprovalQueue().reject(firstCallId());
    expect((await verdictOf(p)).approved).toBe(false);
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
      await gate!({
        runTaskId: TEST_RUN,
        toolId: "githubCreatePR",
        tier: "high",
        params: {},
      }),
    ).toBe(true);
  });

  it("records a Decision Record on BOTH the gate and allow paths", async () => {
    const records: RecordGateDecisionInput[] = [];
    const gate = await buildWorkerAutonomyGate("test-recipe", undefined, opts, {
      recordGateDecision: (r) => records.push(r),
    });
    // GATE path: unowned risky gitPush (worker owns vcs-remote, not vcs-push).
    const p = gate!({
      runTaskId: TEST_RUN,
      toolId: "gitPush",
      tier: "high",
      params: {},
    });
    await tick();
    getApprovalQueue().reject(firstCallId());
    await p;
    // ALLOW path: reversible editText flows.
    expect(
      await gate!({
        runTaskId: TEST_RUN,
        toolId: "editText",
        tier: "low",
        params: {},
      }),
    ).toBe(true);

    const gated = records.find((r) => r.toolName === "gitPush");
    const allowed = records.find((r) => r.toolName === "editText");
    expect(gated?.action).toBe("gate"); // autonomous gate is recorded
    expect(allowed?.action).toBe("allow"); // and the allow leaves a trail too
    // the record carries the decision INPUTS, not just a verdict
    expect(gated?.classKey).toContain("vcs-push");
    expect(gated?.owned).toBe(false);
    // Hardcoded on purpose: this pins the persisted wire value so a policy
    // bump is a deliberate act rather than a silent one. Moved v0 → v1 with
    // the `forbid` terminal state (ADR-0017), which is both an enum widening
    // and a real policy change — the two things that earn a bump.
    expect(gated?.gatePolicyVersion).toBe("worker-ramp-v2");
    expect(allowed?.reversibility).toBe("reversible");

    // An autonomous ALLOW is attributed to the worker — it is the party that
    // acted, and nobody else was involved.
    expect(allowed?.actor).toEqual(
      expect.objectContaining({ id: expect.any(String), kind: "worker" }),
    );
    // A GATED decision is deliberately NOT attributed. The approving human is
    // unknown at this point and cannot be known until the approval path carries
    // an identity, so naming anyone here would be a lie. Absence means "nobody
    // recorded this" (ADR-0017), which must stay distinguishable from a
    // synthesized "unknown".
    expect(gated?.actor).toBeUndefined();
  });

  /**
   * Standing permissions at the ENFORCEMENT layer. The unit tests prove the
   * matcher and the preview agree; these prove the thing that actually runs
   * does the same, and that using a grant leaves a receipt.
   *
   * `StandingPermissionStore` resolves through `patchworkPath`, which
   * `testEnvSetup` redirects to a temp PATCHWORK_HOME — so these write to an
   * isolated store, never the developer's.
   */
  describe("standing permissions", () => {
    // Lazily imported so the module picks up the redirected PATCHWORK_HOME.
    async function permStore() {
      const { StandingPermissionStore } = await import(
        "../butler/permissionStore.js"
      );
      return new StandingPermissionStore();
    }

    // The gate constructs its own store from PATCHWORK_HOME, so there is no
    // injection seam to point at a temp dir — which means grants persist
    // between cases in this file unless the directory is cleared. Found the
    // hard way: a test asserting "a grant for another domain changes nothing"
    // passed the wrong way because an earlier test's grant was still live.
    beforeEach(async () => {
      const { patchworkPath } = await import("../patchworkHome.js");
      rmSync(patchworkPath("butler"), { recursive: true, force: true });
    });

    it("a covering grant lets a gated step flow WITHOUT queueing a human", async () => {
      const store = await permStore();
      store.grant({ scope: { domains: ["vcs-push"] }, note: "small pushes" });

      const g = await buildWorkerAutonomyGate("test-recipe", undefined, opts);
      const result = await g!({
        runTaskId: TEST_RUN,
        toolId: "gitPush",
        tier: "high",
        params: {},
      });

      expect(result).toBe(true);
      // The point of the whole feature: nobody was asked.
      expect(getApprovalQueue().list()).toHaveLength(0);
    });

    it("records an exercise — a use that leaves no receipt is a bug", async () => {
      const store = await permStore();
      const p = store.grant({ scope: { domains: ["vcs-push"] } });

      const g = await buildWorkerAutonomyGate("test-recipe", undefined, opts);
      await g!({
        runTaskId: TEST_RUN,
        toolId: "gitPush",
        tier: "high",
        params: {},
      });

      const exercises = (await permStore()).exercises();
      expect(exercises).toHaveLength(1);
      expect(exercises[0]?.permissionId).toBe(p.id);
      expect(exercises[0]?.toolName).toBe("gitPush");
      expect(exercises[0]?.workerId).toBe("test-worker");
    });

    it("the Decision Record says a permission answered, not just `gate`", async () => {
      const store = await permStore();
      const p = store.grant({ scope: { domains: ["vcs-push"] } });
      const records: RecordGateDecisionInput[] = [];

      const g = await buildWorkerAutonomyGate("test-recipe", undefined, opts, {
        recordGateDecision: (r) => records.push(r),
      });
      await g!({
        runTaskId: TEST_RUN,
        toolId: "gitPush",
        tier: "high",
        params: {},
      });

      // The gate's own verdict is unchanged — the trust maths still gated it.
      expect(records[0]?.action).toBe("gate");
      // ...but the record must not leave a reader thinking a human was asked.
      expect(records[0]?.standingPermissionId).toBe(p.id);
    });

    it("revocation bites immediately — the very next step queues again", async () => {
      const store = await permStore();
      const p = store.grant({ scope: { domains: ["vcs-push"] } });

      const g = await buildWorkerAutonomyGate("test-recipe", undefined, opts);
      expect(
        await g!({
          runTaskId: TEST_RUN,
          toolId: "gitPush",
          tier: "high",
          params: {},
        }),
      ).toBe(true);

      store.revoke(p.id);

      // Same gate instance — a grant cached for the run would keep flowing.
      const pending = g!({
        runTaskId: TEST_RUN,
        toolId: "gitPush",
        tier: "high",
        params: {},
      });
      await tick();
      expect(getApprovalQueue().list()).toHaveLength(1);
      getApprovalQueue().reject(firstCallId());
      expect((await verdictOf(pending)).approved).toBe(false);
    });

    it("a grant NEVER covers an irreversible action", async () => {
      const store = await permStore();
      // As broad as it gets, and naming the domain explicitly.
      store.grant({ scope: { domains: ["shell", "messaging", "vcs-push"] } });

      const g = await buildWorkerAutonomyGate("test-recipe", undefined, opts);
      const pending = g!({
        runTaskId: TEST_RUN,
        toolId: "runCommand",
        tier: "high",
        params: {},
      });
      await tick();
      expect(getApprovalQueue().list()).toHaveLength(1);
      getApprovalQueue().reject(firstCallId());
      expect((await verdictOf(pending)).approved).toBe(false);
    });

    it("a grant that names another domain changes nothing", async () => {
      const store = await permStore();
      store.grant({ scope: { domains: ["issue"] } });

      const g = await buildWorkerAutonomyGate("test-recipe", undefined, opts);
      const pending = g!({
        runTaskId: TEST_RUN,
        toolId: "gitPush",
        tier: "high",
        params: {},
      });
      await tick();
      expect(getApprovalQueue().list()).toHaveLength(1);
      getApprovalQueue().reject(firstCallId());
      expect((await verdictOf(pending)).approved).toBe(false);
    });
  });

  it("a throwing recordGateDecision never blocks the gate (fail-soft)", async () => {
    const gate = await buildWorkerAutonomyGate("test-recipe", undefined, opts, {
      recordGateDecision: () => {
        throw new Error("disk full");
      },
    });
    // logging blew up, but the reversible action still flows.
    expect(
      await gate!({
        runTaskId: TEST_RUN,
        toolId: "editText",
        tier: "low",
        params: {},
      }),
    ).toBe(true);
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

  /**
   * A plugin's tools are registered at runtime, so they are absent from both
   * static maps the sandbox universe is built from and were never denied —
   * callable by the agent subprocess at any trust level, while the recipe path
   * gated the same tool. This asserts the third argument actually reaches
   * `disallowedToolsForAgentStep`; the classification half is covered in
   * `workers/__tests__/workerGate.test.ts`.
   */
  it("denies a plugin tool once its name is passed through", async () => {
    const without = await buildWorkerAgentDisallowedTools("test-recipe", opts);
    expect(without).not.toContain("im_send");

    const withPlugin = await buildWorkerAgentDisallowedTools(
      "test-recipe",
      opts,
      ["im_send"],
    );
    expect(withPlugin).toContain("im_send");
    expect(withPlugin).toContain("mcp__patchwork__im_send");
  });

  it("an empty plugin list leaves the deny list byte-identical", async () => {
    // The no-`--plugin` case is every default install; it must not shift.
    const base = await buildWorkerAgentDisallowedTools("test-recipe", opts);
    expect(
      await buildWorkerAgentDisallowedTools("test-recipe", opts, []),
    ).toEqual(base);
  });
});

describe("buildWorkerAutonomyGate — manifest forbid rules reach ENFORCEMENT", () => {
  /**
   * The control-boundary screen renders three columns, and the third one says
   * "no approval can unlock these". `boundaryForRecipe` defaults forbid rules in
   * from `worker.forbids` — so if the enforcement path did NOT, the preview and
   * the gate would disagree: the screen would show an action as refused outright
   * while the gate merely queued it for a human, who could then approve it.
   *
   * That divergence is silent AND permissive — it tells an operator they are
   * protected when they are not — which is precisely the failure the boundary
   * exists to rule out. These tests pin enforcement to the manifest.
   */
  let dir: string;
  let opts: { workersDir: string; patchworkDir: string };

  const FORBIDDING_WORKER = `id: fin-worker
name: Finance Worker
recipe: fin-recipe
owns:
  - fs-write
  - messaging
autonomyCeiling: 4
forbids:
  - match: messaging
    reason: May never communicate externally on its own account.
`;

  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), "pw-forbid-gate-"));
    const workersDir = path.join(dir, "workers");
    mkdirSync(workersDir, { recursive: true });
    writeFileSync(path.join(workersDir, "fin.worker.yaml"), FORBIDDING_WORKER);
    opts = { workersDir, patchworkDir: dir };
    setFlag(FLAG_WORKER_AUTONOMY, true, false);
    resetApprovalQueueForTests();
  });

  afterEach(() => {
    setFlag(FLAG_WORKER_AUTONOMY, false, false);
    resetApprovalQueueForTests();
    rmSync(dir, { recursive: true, force: true });
  });

  it("refuses a forbidden action outright — it is never queued for approval", async () => {
    // Even with a permissive tier fn AND an uncapped ceiling, a forbidden
    // action must not reach a human: no approval unlocks it.
    const tierFn = vi.fn(async () => true);
    const g = await buildWorkerAutonomyGate("fin-recipe", tierFn, opts);
    const r = await g!({
      runTaskId: TEST_RUN,
      toolId: "slackPostMessage",
      tier: "high",
      params: {},
    });
    expect(r).toBe(false);
    // The critical half: nothing was offered to a person to approve.
    expect(getApprovalQueue().list()).toHaveLength(0);
  });

  it("still allows a non-forbidden action from the same worker", async () => {
    // Guards against the rule over-matching and bricking the worker entirely.
    const tierFn = vi.fn(async () => true);
    const g = await buildWorkerAutonomyGate("fin-recipe", tierFn, opts);
    const r = await g!({
      runTaskId: TEST_RUN,
      toolId: "editText",
      tier: "low",
      params: {},
    });
    expect(r).toBe(true);
  });
});
