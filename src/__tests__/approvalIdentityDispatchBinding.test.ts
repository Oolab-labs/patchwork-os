/**
 * A human approval must bind the EXACT raw parameters that will be dispatched, and
 * every human-approved path must carry that binding to the final dispatch check.
 *
 * Found by an external experiment against 2526ad4f: a flat-runner step carrying a
 * genuine approval grant was refused at dispatch even though nothing had changed —
 * approval params were built from the whole step (incl. `tool`/`into`) and passed
 * through key-based redaction, while dispatch params skip those keys and carry the
 * raw values. Separately, the worker gate's own human approval returned no grant at
 * all, so its approved actions reached dispatch with no identity check.
 *
 * Expected on the unfixed runtime: F1, F3, Q1a, Q1b, Q2(display), P1, W1, W2 RED.
 * Guards that may already pass: F2, F4 (for the wrong reason until F3 is fixed), W0
 * (passes today only because no grant is checked), W3, D1a/D1b.
 */
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { routeApprovalRequest } from "../approvalHttp.js";
import {
  type ApprovalGrant,
  computeApprovedActionIdentity,
} from "../approvalIdentity.js";
import {
  ApprovalQueue,
  getApprovalQueue,
  resetApprovalQueueForTests,
} from "../approvalQueue.js";
import { resolveLocalGovernance } from "../commands/recipe.js";
import { FLAG_WORKER_AUTONOMY, setFlag } from "../featureFlags.js";
import {
  _resetActiveProfileForTesting,
  resolveProfile,
} from "../governance/profile.js";
import { clearConfigCache } from "../patchworkConfig.js";
import {
  buildWorkerAutonomyGate,
  makeRecipeApprovalFn,
} from "../recipeOrchestration.js";
import type { ApprovalRequestInput } from "../recipes/approvalRequest.js";
import { captureForRunlog } from "../recipes/stepObservation.js";
import { getTool, registerTool } from "../recipes/toolRegistry.js";
import {
  executeStep,
  type RunnerDeps,
  runYamlRecipe,
  type StepDeps,
  type YamlRecipe,
} from "../recipes/yamlRunner.js";
import { classifyActionClass } from "../workers/actionClass.js";

const PROBE = "test.bind_probe";
const dispatched: Array<Record<string, unknown>> = [];
if (!getTool(PROBE)) {
  registerTool({
    id: PROBE,
    namespace: "test",
    description:
      "Test-only write tool that records exactly what it was dispatched with.",
    paramsSchema: { type: "object" },
    outputSchema: { type: "string" },
    riskDefault: "high",
    isWrite: true,
    execute: async ({ params }) => {
      dispatched.push(JSON.parse(JSON.stringify(params)));
      return JSON.stringify({ ok: true });
    },
  });
}

/** A grant computed exactly as ApprovalQueue.request computes it. */
function genuineGrant(input: ApprovalRequestInput): {
  approved: true;
  grant: ApprovalGrant;
} {
  return {
    approved: true,
    grant: {
      decision: "approved",
      approvalId: "test-approval",
      // The runner's digest of the RAW dispatch params — exactly what the queue
      // adopts as the identity. `input.params` is redacted and must not be hashed.
      approvedActionIdentity:
        input.proposedActionIdentity ??
        computeApprovedActionIdentity({
          toolName: input.toolId,
          params: input.params ?? {},
          sessionId: "recipe",
          tier: input.tier,
          correlationId: input.runTaskId,
          recipeName: input.recipeName,
        }),
      facts: {
        tier: input.tier,
        correlationId: input.runTaskId,
        recipeName: input.recipeName,
      },
    },
  };
}

let TMP: string;
function deps(extra: Partial<RunnerDeps> = {}): RunnerDeps {
  return {
    now: () => new Date("2026-09-23T12:00:00Z"),
    logDir: TMP,
    testMode: false,
    workdir: TMP,
    readFile: () => {
      throw new Error("nf");
    },
    writeFile: () => {},
    appendFile: () => {},
    mkdir: () => {},
    gitLogSince: () => "",
    gitStaleBranches: () => "",
    getDiagnostics: () => "",
    ...extra,
  } as RunnerDeps;
}

function recipeWith(
  step: Record<string, unknown>,
  trigger = "manual",
  name = "bind-recipe",
): YamlRecipe {
  return { name, trigger: { type: trigger }, steps: [step] } as YamlRecipe;
}

beforeEach(() => {
  TMP = mkdtempSync(path.join(os.tmpdir(), "approval-bind-"));
  dispatched.length = 0;
});
afterEach(() => rmSync(TMP, { recursive: true, force: true }));

describe("flat runner: a genuine grant must let the unchanged action run, and only it", () => {
  it("F1 unchanged params with a genuine grant dispatch exactly once", async () => {
    const step = { tool: PROBE, content: "hello", into: "out" };
    const r = await runYamlRecipe(
      recipeWith(step),
      deps({ requireApprovalFn: async (i) => genuineGrant(i) }),
    );
    expect(r.errorMessage ?? "").not.toMatch(/approval_identity_mismatch/);
    expect(dispatched).toEqual([expect.objectContaining({ content: "hello" })]);
  });

  it("F2 a step mutated after approval is refused and never dispatched", async () => {
    const step: Record<string, unknown> = { tool: PROBE, content: "hello" };
    const r = await runYamlRecipe(
      recipeWith(step),
      deps({
        requireApprovalFn: async (i) => {
          const v = genuineGrant(i);
          step.content = "tampered";
          return v;
        },
      }),
    );
    expect(r.errorMessage ?? "").toMatch(/approval_identity_mismatch/);
    expect(dispatched).toEqual([]);
  });

  it("F3 an unchanged secret-bearing param dispatches with the raw secret", async () => {
    const step = {
      tool: PROBE,
      headers: { Authorization: "Bearer SECRET-A" },
    };
    const r = await runYamlRecipe(
      recipeWith(step),
      deps({ requireApprovalFn: async (i) => genuineGrant(i) }),
    );
    expect(r.errorMessage ?? "").not.toMatch(/approval_identity_mismatch/);
    expect(dispatched).toEqual([
      expect.objectContaining({
        headers: { Authorization: "Bearer SECRET-A" },
      }),
    ]);
  });

  it("F4 a secret swapped after approval is refused and never dispatched", async () => {
    const step: Record<string, unknown> = {
      tool: PROBE,
      headers: { Authorization: "Bearer SECRET-A" },
    };
    const r = await runYamlRecipe(
      recipeWith(step),
      deps({
        requireApprovalFn: async (i) => {
          const v = genuineGrant(i);
          step.headers = { Authorization: "Bearer SECRET-B" };
          return v;
        },
      }),
    );
    expect(r.errorMessage ?? "").toMatch(/approval_identity_mismatch/);
    expect(dispatched).toEqual([]);
  });
});

describe("approval callbacks never see a raw secret, yet cannot weaken the binding", () => {
  it("C1 a custom approval callback sees [REDACTED]; the tool still gets the raw secret", async () => {
    const seen: Array<Record<string, unknown> | undefined> = [];
    const r = await runYamlRecipe(
      recipeWith({
        tool: PROBE,
        headers: { Authorization: "Bearer SECRET-A" },
      }),
      deps({
        requireApprovalFn: async (i) => {
          seen.push(i.params);
          return genuineGrant(i);
        },
      }),
    );
    expect(r.errorMessage ?? "").not.toMatch(/approval_identity_mismatch/);
    expect(JSON.stringify(seen)).not.toContain("SECRET-A");
    expect(seen[0]).toEqual({ headers: { Authorization: "[REDACTED]" } });
    expect(dispatched).toEqual([
      { headers: { Authorization: "Bearer SECRET-A" } },
    ]);
  });

  it("C2 two actions differing only in a secret look identical to the callback but never share an identity", async () => {
    const inputs: ApprovalRequestInput[] = [];
    for (const secret of ["SECRET-A", "SECRET-B"]) {
      await runYamlRecipe(
        recipeWith({
          tool: PROBE,
          headers: { Authorization: `Bearer ${secret}` },
        }),
        deps({
          requireApprovalFn: async (i) => {
            inputs.push(i);
            return false;
          },
        }),
      );
    }
    expect(inputs).toHaveLength(2);
    expect(JSON.stringify(inputs[0]?.params)).toBe(
      JSON.stringify(inputs[1]?.params),
    );
    expect(inputs[0]?.proposedActionIdentity).toMatch(/^[0-9a-f]{64}$/);
    expect(inputs[0]?.proposedActionIdentity).not.toBe(
      inputs[1]?.proposedActionIdentity,
    );
    expect(dispatched).toEqual([]);
  });
});

describe("queue: identity over raw params; display/persistence redacted by key AND value", () => {
  it("Q1a a raw Authorization header never reaches the live queue list", () => {
    const q = new ApprovalQueue({ persistDir: TMP });
    q.request({
      toolName: PROBE,
      params: { headers: { Authorization: "Bearer SECRET-A" } },
      tier: "high",
      sessionId: "recipe",
    });
    const live = JSON.stringify(q.list());
    q.clear();
    expect(live).not.toContain("SECRET-A");
  });

  it("Q1b a raw Authorization header never reaches the durable approval log", () => {
    const q = new ApprovalQueue({ persistDir: TMP });
    q.request({
      toolName: PROBE,
      params: { headers: { Authorization: "Bearer SECRET-A" } },
      tier: "high",
      sessionId: "recipe",
    });
    const durable = readFileSync(path.join(TMP, "approval_log.jsonl"), "utf-8");
    q.clear();
    expect(durable).toContain(PROBE); // the request row was written at all
    expect(durable).not.toContain("SECRET-A");
  });

  it("Q2 redaction must not weaken identity: same display, different identity", () => {
    const q = new ApprovalQueue({ persistDir: TMP });
    const a = q.request({
      toolName: PROBE,
      params: { headers: { Authorization: "Bearer SECRET-A" } },
      tier: "high",
      sessionId: "recipe",
    });
    const b = q.request({
      toolName: PROBE,
      params: { headers: { Authorization: "Bearer SECRET-B" } },
      tier: "high",
      sessionId: "recipe",
    });
    const shown = q.list().map((p) => JSON.stringify(p.params));
    q.clear();
    expect(a.approvedActionIdentity).not.toBe(b.approvedActionIdentity);
    expect(shown).toHaveLength(2);
    expect(shown[0]).toBe(shown[1]);
    expect(shown.join()).not.toMatch(/SECRET-[AB]/);
  });
});

describe("production tier approval: makeRecipeApprovalFn → real queue → grant → dispatch", () => {
  beforeEach(() => resetApprovalQueueForTests());
  afterEach(() => resetApprovalQueueForTests());

  it("P1 a human approval through the production fn lets the unchanged step run once", async () => {
    const fn = await makeRecipeApprovalFn("all");
    const q = getApprovalQueue();
    let approvals = 0;
    const unsub = q.subscribe(() => {
      for (const pend of q.list()) if (q.approve(pend.callId)) approvals++;
    });
    const r = await runYamlRecipe(
      recipeWith({ tool: PROBE, content: "hello", into: "out" }),
      // The tier gate must actually be ON, or the runner's effective policy is
      // ALLOW and the production fn returns true without queueing anything.
      deps({
        requireApprovalFn: fn,
        governance: resolveProfile({ approvalGate: "all" }),
      }),
    );
    unsub();
    expect(approvals).toBe(1); // a human approval really happened
    expect(r.errorMessage ?? "").not.toMatch(/approval_identity_mismatch/);
    expect(dispatched).toEqual([expect.objectContaining({ content: "hello" })]);
  });

  it("P2 a secret-bearing action approved through the production fn runs unchanged", async () => {
    // Without the runner's raw digest the queue would hash the REDACTED params,
    // and an unchanged secret-bearing action could never match at dispatch.
    const fn = await makeRecipeApprovalFn("all");
    const q = getApprovalQueue();
    let approvals = 0;
    const unsub = q.subscribe(() => {
      for (const pend of q.list()) if (q.approve(pend.callId)) approvals++;
    });
    const r = await runYamlRecipe(
      recipeWith({
        tool: PROBE,
        headers: { Authorization: "Bearer SECRET-A" },
      }),
      deps({
        requireApprovalFn: fn,
        governance: resolveProfile({ approvalGate: "all" }),
      }),
    );
    unsub();
    expect(approvals).toBe(1);
    expect(r.errorMessage ?? "").not.toMatch(/approval_identity_mismatch/);
    expect(dispatched).toEqual([
      { headers: { Authorization: "Bearer SECRET-A" } },
    ]);
    expect(JSON.stringify(q.list())).not.toContain("SECRET-A");
  });
});

describe("final dispatch boundary: executeStep revalidates on its own", () => {
  const dispatch = (params: Record<string, unknown>) => {
    const identity = computeApprovedActionIdentity({
      toolName: PROBE,
      params,
      sessionId: "recipe",
      tier: "high",
      correlationId: "yaml:bind-recipe:1",
      recipeName: "bind-recipe",
    });
    return {
      grant: {
        decision: "approved" as const,
        approvalId: "d1",
        approvedActionIdentity: identity,
        facts: {
          tier: "high" as const,
          correlationId: "yaml:bind-recipe:1",
          recipeName: "bind-recipe",
        },
      },
      runTaskId: "yaml:bind-recipe:1",
      recipeName: "bind-recipe",
    };
  };
  const stepDeps = () =>
    ({ workdir: TMP, recipeName: "bind-recipe" }) as unknown as StepDeps;

  it("D1a a grant for the exact dispatch params A dispatches A", async () => {
    await executeStep(
      { tool: PROBE, content: "A" } as never,
      {} as never,
      stepDeps(),
      undefined,
      dispatch({ content: "A" }),
    );
    expect(dispatched).toEqual([{ content: "A" }]);
  });

  it("D1b a grant for A never dispatches B at the final boundary", async () => {
    await expect(
      executeStep(
        { tool: PROBE, content: "B" } as never,
        {} as never,
        stepDeps(),
        undefined,
        dispatch({ content: "A" }),
      ),
    ).rejects.toThrow(/approval_identity_mismatch/);
    expect(dispatched).toEqual([]);
  });
});

describe("worker gate: its own human approval must return a binding grant", () => {
  const WORKER_YAML = `id: bind-worker
name: Bind Worker
recipe: bind-recipe
owns:
  - fs-write
autonomyCeiling: 4
`;
  let opts: { workersDir: string; patchworkDir: string };
  beforeEach(() => {
    const workersDir = path.join(TMP, "workers");
    mkdirSync(workersDir, { recursive: true });
    writeFileSync(path.join(workersDir, "bind.worker.yaml"), WORKER_YAML);
    opts = { workersDir, patchworkDir: TMP };
    setFlag(FLAG_WORKER_AUTONOMY, true, false);
    resetApprovalQueueForTests();
  });
  afterEach(() => {
    setFlag(FLAG_WORKER_AUTONOMY, false, false);
    resetApprovalQueueForTests();
  });

  const tick = () => new Promise((r) => setImmediate(r));

  it("W0 a worker-gate human approval lets the UNCHANGED step dispatch exactly once", async () => {
    const g = await buildWorkerAutonomyGate("bind-recipe", undefined, opts);
    const q = getApprovalQueue();
    let approvals = 0;
    const unsub = q.subscribe(() => {
      for (const pend of q.list()) if (q.approve(pend.callId)) approvals++;
    });
    const r = await runYamlRecipe(
      recipeWith({ tool: PROBE, content: "hello" }, "cron"),
      deps({ requireApprovalFn: g!, gateAutomatedRuns: true }),
    );
    unsub();
    expect(approvals).toBe(1);
    expect(r.errorMessage ?? "").not.toMatch(/approval_identity_mismatch/);
    expect(dispatched).toEqual([{ content: "hello" }]);
  });

  it("W0s a worker-gate approval of a secret-bearing action lets it run unchanged", async () => {
    const g = await buildWorkerAutonomyGate("bind-recipe", undefined, opts);
    const q = getApprovalQueue();
    let approvals = 0;
    const unsub = q.subscribe(() => {
      for (const pend of q.list()) if (q.approve(pend.callId)) approvals++;
    });
    const r = await runYamlRecipe(
      recipeWith(
        { tool: PROBE, headers: { Authorization: "Bearer SECRET-A" } },
        "cron",
      ),
      deps({ requireApprovalFn: g!, gateAutomatedRuns: true }),
    );
    unsub();
    expect(approvals).toBe(1);
    expect(r.errorMessage ?? "").not.toMatch(/approval_identity_mismatch/);
    expect(dispatched).toEqual([
      { headers: { Authorization: "Bearer SECRET-A" } },
    ]);
  });

  it("W1 a worker-gated action approved by a human returns an ApprovalGrant", async () => {
    const g = await buildWorkerAutonomyGate("bind-recipe", undefined, opts);
    const p = g!({
      runTaskId: "yaml:bind-recipe:1",
      recipeName: "bind-recipe",
      toolId: PROBE,
      tier: "high",
      params: { content: "hello" },
    });
    await tick();
    const [pend] = getApprovalQueue().list();
    expect(pend).toBeDefined();
    getApprovalQueue().approve(pend!.callId);
    const v = await p;
    expect(typeof v).toBe("object");
    expect(
      (v as { grant?: ApprovalGrant }).grant?.approvedActionIdentity,
    ).toMatch(/^[0-9a-f]{64}$/);
  });

  it("W2 a worker-gate-approved step mutated before dispatch is refused", async () => {
    const g = await buildWorkerAutonomyGate("bind-recipe", undefined, opts);
    const step: Record<string, unknown> = { tool: PROBE, content: "hello" };
    const q = getApprovalQueue();
    const unsub = q.subscribe(() => {
      for (const pend of q.list()) {
        step.content = "tampered";
        q.approve(pend.callId);
      }
    });
    const r = await runYamlRecipe(
      recipeWith(step, "cron"),
      deps({ requireApprovalFn: g!, gateAutomatedRuns: true }),
    );
    unsub();
    expect(dispatched).toEqual([]);
    expect(r.errorMessage ?? "").toMatch(/approval_identity_mismatch/);
  });

  it("W3 worker allow deferring to a tier approval propagates the tier's grant", async () => {
    const tierGrant = genuineGrant({
      runTaskId: "yaml:bind-recipe:1",
      recipeName: "bind-recipe",
      toolId: "editText",
      tier: "low",
      params: {},
    });
    const g = await buildWorkerAutonomyGate(
      "bind-recipe",
      async () => tierGrant,
      opts,
    );
    const v = await g!({
      runTaskId: "yaml:bind-recipe:1",
      recipeName: "bind-recipe",
      toolId: "editText",
      tier: "low",
      params: {},
    });
    expect(v).toEqual(tierGrant);
  });
});

describe("local CLI approval (governed, no bridge) carries the binding too", () => {
  const savedHome = process.env.PATCHWORK_HOME;
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(path.join(os.tmpdir(), "bind-cli-"));
    process.env.PATCHWORK_HOME = home;
    writeFileSync(
      path.join(home, "config.json"),
      JSON.stringify({ model: "claude", profile: "governed" }),
    );
    clearConfigCache();
    _resetActiveProfileForTesting();
  });
  afterEach(() => {
    process.env.PATCHWORK_HOME = savedHome;
    clearConfigCache();
    _resetActiveProfileForTesting();
    rmSync(home, { recursive: true, force: true });
  });

  async function cliDeps(ask: (q: string) => Promise<string>) {
    const g = await resolveLocalGovernance(undefined, { isTTY: true, ask });
    return deps(g as Partial<RunnerDeps>);
  }

  it("L1 yes + unchanged action dispatches exactly once", async () => {
    const r = await runYamlRecipe(
      recipeWith({ tool: PROBE, content: "hello" }),
      await cliDeps(async () => "y"),
    );
    expect(r.errorMessage ?? "").not.toMatch(/approval_identity_mismatch/);
    expect(dispatched).toEqual([{ content: "hello" }]);
  });

  it("L2 an action changed while the prompt is pending is refused", async () => {
    const step: Record<string, unknown> = { tool: PROBE, content: "hello" };
    const r = await runYamlRecipe(
      recipeWith(step),
      await cliDeps(async () => {
        step.content = "tampered";
        return "y";
      }),
    );
    expect(dispatched).toEqual([]);
    expect(r.errorMessage ?? "").toMatch(/approval_identity_mismatch/);
  });

  it("L3 no terminal, or an answer of no, still refuses", async () => {
    const noTty = await resolveLocalGovernance(undefined, { isTTY: false });
    const input = {
      toolId: PROBE,
      tier: "high" as const,
      runTaskId: "t",
      effective: "HUMAN_APPROVAL_REQUIRED" as const,
    };
    expect(await noTty.requireApprovalFn!(input)).toMatchObject({
      approved: false,
    });
    const no = await resolveLocalGovernance(undefined, {
      isTTY: true,
      ask: async () => "n",
    });
    expect(await no.requireApprovalFn!(input)).toMatchObject({
      approved: false,
    });
  });

  it("L4 an action the effective policy already allows gets no fabricated grant", async () => {
    const g = await resolveLocalGovernance(undefined, {
      isTTY: true,
      ask: async () => {
        throw new Error("must not prompt");
      },
    });
    expect(
      await g.requireApprovalFn!({
        toolId: PROBE,
        tier: "high",
        runTaskId: "t",
        effective: "ALLOW",
      }),
    ).toBe(true);
  });

  it("L5 the grant binds the identity captured BEFORE the prompt", async () => {
    const digest = "a".repeat(64);
    const g = await resolveLocalGovernance(undefined, {
      isTTY: true,
      ask: async () => "y",
    });
    const v = await g.requireApprovalFn!({
      toolId: PROBE,
      tier: "high",
      runTaskId: "t",
      recipeName: "bind-recipe",
      effective: "HUMAN_APPROVAL_REQUIRED",
      params: { content: "[display]" },
      proposedActionIdentity: digest,
    });
    expect(v).toMatchObject({
      approved: true,
      grant: { decision: "approved", approvedActionIdentity: digest },
    });
  });
});

describe("the identity digest is internal-only and stays consequential", () => {
  it("B1 a digest in an HTTP /approvals body is ignored, not adopted", async () => {
    const q = new ApprovalQueue();
    const forged = "b".repeat(64);
    const call = (params: Record<string, unknown>) =>
      routeApprovalRequest(
        {
          method: "POST",
          path: "/approvals",
          body: { toolName: PROBE, params, proposedActionIdentity: forged },
        },
        {
          queue: q,
          workspace: TMP,
          ccLoader: () => ({ allow: [], ask: [], deny: [] }),
          approvalGate: "all",
        },
      );
    void call({ x: 1 });
    void call({ x: 2 });
    // The route does async work (risk signals) before queueing; wait for it.
    for (let i = 0; i < 100 && q.list().length < 2; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    const pending = q.list().length;
    q.clear();
    // Adopted, the shared forged digest would have deduplicated them into one.
    expect(pending).toBe(2);
  });

  it("B2 a malformed internal digest is rejected, never replaced by a hash of redacted params", () => {
    const q = new ApprovalQueue();
    expect(() =>
      q.request(
        { toolName: PROBE, params: {}, tier: "high", sessionId: "recipe" },
        { proposedActionIdentity: "not-a-digest" },
      ),
    ).toThrow(/64-char hex/);
    expect(q.list()).toEqual([]);
  });

  it("B3 same redacted display, different digests: two approvals, resolved independently", async () => {
    const q = new ApprovalQueue();
    const display = { headers: { Authorization: "[REDACTED]" } };
    const a = q.request(
      { toolName: PROBE, params: display, tier: "high", sessionId: "recipe" },
      { proposedActionIdentity: "c".repeat(64) },
    );
    const b = q.request(
      { toolName: PROBE, params: display, tier: "high", sessionId: "recipe" },
      { proposedActionIdentity: "d".repeat(64) },
    );
    expect(a.callId).not.toBe(b.callId);
    expect(q.list()).toHaveLength(2);
    q.approve(a.callId);
    expect(await a.promise).toBe("approved");
    expect(q.list().map((p) => p.callId)).toEqual([b.callId]);
    q.clear();
  });
});

describe("display cap never makes a payment look cheaper", () => {
  it("M1 an amount lost to the display cap bands as the WIDEST band", () => {
    const raw = { amount: 100, memo: "x".repeat(20_000) };
    const display = captureForRunlog(raw) as Record<string, unknown>;
    expect(classifyActionClass("stripe.create_refund", raw).magnitudeBand).toBe(
      "band<=50",
    );
    expect(
      classifyActionClass("stripe.create_refund", display).magnitudeBand,
    ).toBe("band>500");
  });
});
