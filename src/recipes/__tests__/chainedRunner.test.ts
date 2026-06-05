import { describe, expect, it, vi } from "vitest";
import type {
  ChainedRecipe,
  ChainedStep,
  ExecutionDeps,
  RunOptions,
} from "../chainedRunner.js";
import {
  buildTemplateContext,
  executeChainedStep,
  expandParallelSteps,
  generateExecutionPlan,
  resolveStepTemplates,
  runChainedRecipe,
} from "../chainedRunner.js";
import { createOutputRegistry } from "../outputRegistry.js";

const noopDeps: ExecutionDeps = {
  executeTool: vi.fn().mockResolvedValue({ ok: true }),
  executeAgent: vi.fn().mockResolvedValue("agent output"),
  loadNestedRecipe: vi.fn().mockResolvedValue(null),
};

const baseOptions: RunOptions = {
  env: {},
  maxConcurrency: 4,
  maxDepth: 3,
  dryRun: false,
};

describe("buildTemplateContext", () => {
  it("exposes registry steps and env", () => {
    const reg = createOutputRegistry();
    reg.set("step1", { status: "success", data: { x: 1 } });
    const ctx = buildTemplateContext(reg, { HOME: "/home" });
    expect(ctx.steps.step1?.data).toEqual({ x: 1 });
    expect(ctx.env.HOME).toBe("/home");
  });
});

describe("resolveStepTemplates", () => {
  it("resolves string params with templates", () => {
    const ctx = { steps: {}, env: { NAME: "world" } };
    const { resolved, errors } = resolveStepTemplates(
      { id: "s", tool: "say", message: "hello {{env.NAME}}" },
      ctx,
    );
    expect(errors).toHaveLength(0);
    expect(resolved.message).toBe("hello world");
  });

  it("skips id, tool, agent, recipe keys", () => {
    const ctx = { steps: {}, env: {} };
    const { resolved } = resolveStepTemplates(
      { id: "s", tool: "t", agent: { prompt: "hi" } },
      ctx,
    );
    expect("id" in resolved).toBe(false);
    expect("tool" in resolved).toBe(false);
    expect("agent" in resolved).toBe(false);
  });

  it("resolves agent prompt", () => {
    const ctx = { steps: {}, env: { Q: "question?" } };
    const { resolved } = resolveStepTemplates(
      { id: "s", agent: { prompt: "Answer: {{env.Q}}" } },
      ctx,
    );
    expect(resolved.agentPrompt).toBe("Answer: question?");
  });

  it("conditionResult true when no when clause", () => {
    const { conditionResult } = resolveStepTemplates(
      { id: "s" },
      { steps: {}, env: {} },
    );
    expect(conditionResult).toBe(true);
  });

  it("conditionResult false for falsy when value", () => {
    const { conditionResult } = resolveStepTemplates(
      { id: "s", when: "false" },
      { steps: {}, env: {} },
    );
    expect(conditionResult).toBe(false);
  });

  it("conditionResult true for truthy when value", () => {
    const { conditionResult } = resolveStepTemplates(
      { id: "s", when: "yes" },
      { steps: {}, env: {} },
    );
    expect(conditionResult).toBe(true);
  });

  it("parses JSON values in resolved params", () => {
    const ctx = { steps: {}, env: { DATA: '{"key":"val"}' } };
    const { resolved } = resolveStepTemplates(
      { id: "s", tool: "t", param: "{{env.DATA}}" },
      ctx,
    );
    expect(resolved.param).toEqual({ key: "val" });
  });

  it("returns error for invalid template syntax", () => {
    const { errors } = resolveStepTemplates(
      { id: "s", tool: "t", param: "{{invalid!}}" },
      { steps: {}, env: {} },
    );
    expect(errors.length).toBeGreaterThan(0);
  });
});

describe("chain: alias for nested recipe steps", () => {
  it("calls loadNestedRecipe when step has chain: instead of recipe:", async () => {
    const childRecipe: ChainedRecipe = {
      name: "child",
      steps: [{ id: "c", tool: "child-tool" }],
    };
    const loadNestedRecipe = vi.fn().mockResolvedValue({
      recipe: childRecipe,
      sourcePath: "/tmp/child.yaml",
    });
    const deps: ExecutionDeps = {
      executeTool: vi.fn().mockResolvedValue("ok"),
      executeAgent: vi.fn().mockResolvedValue("ok"),
      loadNestedRecipe,
    };
    const reg = createOutputRegistry();
    const result = await executeChainedStep(
      {
        registry: reg,
        step: { id: "s", chain: "child.yaml" },
        options: { ...baseOptions, sourcePath: "/tmp/parent.yaml" },
        recipe: { name: "parent", steps: [] },
        depth: 0,
      },
      deps,
    );
    expect(result.success).toBe(true);
    expect(loadNestedRecipe).toHaveBeenCalledWith(
      "child.yaml",
      "/tmp/parent.yaml",
    );
  });
});

describe("executeChainedStep", () => {
  it("executes tool step", async () => {
    const reg = createOutputRegistry();
    const result = await executeChainedStep(
      {
        registry: reg,
        step: { id: "s", tool: "myTool", param: "val" },
        options: baseOptions,
        recipe: { name: "r", steps: [] },
        depth: 0,
      },
      noopDeps,
    );
    expect(result.success).toBe(true);
    expect(result.data).toEqual({ ok: true });
  });

  it("executes agent step", async () => {
    const reg = createOutputRegistry();
    const result = await executeChainedStep(
      {
        registry: reg,
        step: { id: "s", agent: { prompt: "do it" } },
        options: baseOptions,
        recipe: { name: "r", steps: [] },
        depth: 0,
      },
      noopDeps,
    );
    expect(result.success).toBe(true);
    expect(result.data).toBe("agent output");
  });

  it("returns skipped when when-condition is falsy", async () => {
    const reg = createOutputRegistry();
    const result = await executeChainedStep(
      {
        registry: reg,
        step: { id: "s", tool: "t", when: "false" },
        options: baseOptions,
        recipe: { name: "r", steps: [] },
        depth: 0,
      },
      noopDeps,
    );
    expect(result.success).toBe(true);
    expect(result.skipped).toBe(true);
  });

  it("returns dry-run result when dryRun=true", async () => {
    const reg = createOutputRegistry();
    const result = await executeChainedStep(
      {
        registry: reg,
        step: { id: "s", tool: "myTool" },
        options: { ...baseOptions, dryRun: true },
        recipe: { name: "r", steps: [] },
        depth: 0,
      },
      noopDeps,
    );
    expect(result.success).toBe(true);
    expect((result.data as Record<string, unknown>).dryRun).toBe(true);
  });

  it("returns failure when tool throws", async () => {
    const reg = createOutputRegistry();
    const failDeps = {
      ...noopDeps,
      executeTool: vi.fn().mockRejectedValue(new Error("tool error")),
    };
    const result = await executeChainedStep(
      {
        registry: reg,
        step: { id: "s", tool: "t" },
        options: baseOptions,
        recipe: { name: "r", steps: [] },
        depth: 0,
      },
      failDeps,
    );
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/tool error/);
  });

  it("H2: agent returning [agent step failed:...] is reported as failure", async () => {
    const reg = createOutputRegistry();
    const failDeps = {
      ...noopDeps,
      executeAgent: vi
        .fn()
        .mockResolvedValue("[agent step failed: claude exited 1]"),
    };
    const result = await executeChainedStep(
      {
        registry: reg,
        step: { id: "s", agent: { prompt: "do something" } },
        options: baseOptions,
        recipe: { name: "r", steps: [] },
        depth: 0,
      },
      failDeps,
    );
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/agent step failed/);
  });

  it("H2: tool returning {ok:false,error} is reported as failure", async () => {
    const reg = createOutputRegistry();
    const failDeps = {
      ...noopDeps,
      executeTool: vi
        .fn()
        .mockResolvedValue(
          JSON.stringify({ ok: false, error: "permission denied" }),
        ),
    };
    const result = await executeChainedStep(
      {
        registry: reg,
        step: { id: "s", tool: "some_tool" },
        options: baseOptions,
        recipe: { name: "r", steps: [] },
        depth: 0,
      },
      failDeps,
    );
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/permission denied/);
  });

  it("M2: step with expect.equals that fails is reported as failure", async () => {
    const reg = createOutputRegistry();
    const failDeps = {
      ...noopDeps,
      executeTool: vi.fn().mockResolvedValue("actual_output"),
    };
    const result = await executeChainedStep(
      {
        registry: reg,
        step: {
          id: "s",
          tool: "t",
          expect: { equals: "expected_output" },
        } as ChainedStep,
        options: baseOptions,
        recipe: { name: "r", steps: [] },
        depth: 0,
      },
      failDeps,
    );
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/expect/i);
  });

  it("returns failure for step with no tool/agent/recipe", async () => {
    const reg = createOutputRegistry();
    const result = await executeChainedStep(
      {
        registry: reg,
        step: { id: "s" },
        options: baseOptions,
        recipe: { name: "r", steps: [] },
        depth: 0,
      },
      noopDeps,
    );
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/no tool/);
  });

  it("returns error on template errors in step", async () => {
    const reg = createOutputRegistry();
    const result = await executeChainedStep(
      {
        registry: reg,
        step: { id: "s", tool: "t", param: "{{invalid!}}" },
        options: baseOptions,
        recipe: { name: "r", steps: [] },
        depth: 0,
      },
      noopDeps,
    );
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/Template errors/);
  });
});

describe("runChainedRecipe", () => {
  it("executes all steps and reports success", async () => {
    const recipe: ChainedRecipe = {
      name: "test",
      steps: [
        { id: "a", tool: "toolA" },
        { id: "b", tool: "toolB", awaits: ["a"] },
      ],
    };
    const result = await runChainedRecipe(recipe, baseOptions, noopDeps);
    expect(result.success).toBe(true);
    expect(result.summary.succeeded).toBe(2);
  });

  it("marks optional step success even when it fails", async () => {
    const failDeps = {
      ...noopDeps,
      executeTool: vi.fn().mockRejectedValue(new Error("fail")),
    };
    const recipe: ChainedRecipe = {
      name: "test",
      steps: [{ id: "opt", tool: "t", optional: true }],
    };
    const result = await runChainedRecipe(recipe, baseOptions, failDeps);
    expect(result.success).toBe(true);
  });

  it("treats step failure as non-fatal when recipe on_error.fallback=log_only", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const failDeps = {
      ...noopDeps,
      executeTool: vi.fn().mockRejectedValue(new Error("boom")),
    };
    const recipe: ChainedRecipe = {
      name: "test",
      on_error: { fallback: "log_only" },
      steps: [{ id: "a", tool: "t" }],
    };
    const result = await runChainedRecipe(recipe, baseOptions, failDeps);
    expect(result.success).toBe(true);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("on_error.fallback=log_only"),
    );
    warn.mockRestore();
  });

  it("propagates step failure when recipe on_error.fallback=abort (default)", async () => {
    const failDeps = {
      ...noopDeps,
      executeTool: vi.fn().mockRejectedValue(new Error("boom")),
    };
    const recipe: ChainedRecipe = {
      name: "test",
      on_error: { fallback: "abort" },
      steps: [{ id: "a", tool: "t" }],
    };
    const result = await runChainedRecipe(recipe, baseOptions, failDeps);
    expect(result.success).toBe(false);
  });

  it("retries a failing step up to step.retry times", async () => {
    let calls = 0;
    const failThenSucceedDeps = {
      ...noopDeps,
      executeTool: vi.fn().mockImplementation(async () => {
        calls++;
        if (calls < 3) throw new Error("transient");
      }),
    };
    const recipe: ChainedRecipe = {
      name: "test",
      steps: [{ id: "a", tool: "t", retry: 2, retryDelay: 0 }],
    };
    const result = await runChainedRecipe(
      recipe,
      baseOptions,
      failThenSucceedDeps,
    );
    expect(result.success).toBe(true);
    expect(calls).toBe(3);
  });

  it("respects recipe-level on_error.retry when step has no retry", async () => {
    let calls = 0;
    const failOnceDeps = {
      ...noopDeps,
      executeTool: vi.fn().mockImplementation(async () => {
        calls++;
        if (calls === 1) throw new Error("transient");
      }),
    };
    const recipe: ChainedRecipe = {
      name: "test",
      on_error: { retry: 1, retryDelay: 0 },
      steps: [{ id: "a", tool: "t" }],
    };
    const result = await runChainedRecipe(recipe, baseOptions, failOnceDeps);
    expect(result.success).toBe(true);
    expect(calls).toBe(2);
  });

  it("fails after exhausting all retries", async () => {
    const alwaysFailDeps = {
      ...noopDeps,
      executeTool: vi.fn().mockRejectedValue(new Error("permanent")),
    };
    const recipe: ChainedRecipe = {
      name: "test",
      steps: [{ id: "a", tool: "t", retry: 2, retryDelay: 0 }],
    };
    const result = await runChainedRecipe(recipe, baseOptions, alwaysFailDeps);
    expect(result.success).toBe(false);
    expect(alwaysFailDeps.executeTool).toHaveBeenCalledTimes(3);
  });

  it("still runs the step exactly once when retry is negative (audit 2026-06-03 HIGH #8)", async () => {
    // A negative retry (typo / misconfig) previously made `attempt <= maxRetries`
    // immediately false, so the step NEVER executed and reported as failed with
    // no diagnostic. The step must still run once (retries clamped to >= 0).
    const okDeps = {
      ...noopDeps,
      executeTool: vi.fn().mockResolvedValue(undefined),
    };
    const recipe: ChainedRecipe = {
      name: "test",
      steps: [{ id: "a", tool: "t", retry: -1, retryDelay: 0 }],
    };
    const result = await runChainedRecipe(recipe, baseOptions, okDeps);
    expect(result.success).toBe(true);
    expect(okDeps.executeTool).toHaveBeenCalledTimes(1);
  });

  it("caps an absurdly large retry count instead of looping unboundedly (audit 2026-06-03 HIGH #8)", async () => {
    const alwaysFailDeps = {
      ...noopDeps,
      executeTool: vi.fn().mockRejectedValue(new Error("permanent")),
    };
    const recipe: ChainedRecipe = {
      name: "test",
      steps: [{ id: "a", tool: "t", retry: 1_000_000, retryDelay: 0 }],
    };
    const result = await runChainedRecipe(recipe, baseOptions, alwaysFailDeps);
    expect(result.success).toBe(false);
    // Clamped to MAX_RETRIES (20) → 1 initial + 20 retries = 21 calls, not 1e6.
    expect(alwaysFailDeps.executeTool).toHaveBeenCalledTimes(21);
  });

  it("counts skipped steps correctly", async () => {
    const recipe: ChainedRecipe = {
      name: "test",
      steps: [
        { id: "a", tool: "t" },
        { id: "skip", tool: "t", when: "false" },
      ],
    };
    const result = await runChainedRecipe(recipe, baseOptions, noopDeps);
    expect(result.success).toBe(true);
    expect(result.summary.skipped).toBe(1);
    expect(result.summary.succeeded).toBe(1);
  });

  it("fires onStepStart and onStepComplete callbacks", async () => {
    const started: string[] = [];
    const completed: string[] = [];
    const recipe: ChainedRecipe = {
      name: "r",
      steps: [{ id: "x", tool: "t" }],
    };
    await runChainedRecipe(
      recipe,
      {
        ...baseOptions,
        onStepStart: (id) => started.push(id),
        onStepComplete: (id) => completed.push(id),
      },
      noopDeps,
    );
    expect(started).toContain("x");
    expect(completed).toContain("x");
  });

  it("returns error message when step fails", async () => {
    const failDeps = {
      ...noopDeps,
      executeTool: vi.fn().mockRejectedValue(new Error("boom")),
    };
    const recipe: ChainedRecipe = {
      name: "r",
      steps: [{ id: "bad", tool: "t" }],
    };
    const result = await runChainedRecipe(recipe, baseOptions, failDeps);
    expect(result.success).toBe(false);
    expect(result.errorMessage).toMatch(/failed/);
  });

  it("skips dependent steps when upstream fails (C1)", async () => {
    const executed: string[] = [];
    const failDeps = {
      ...noopDeps,
      executeTool: vi.fn().mockImplementation(async (tool: string) => {
        executed.push(tool);
        if (tool === "fail-tool") throw new Error("upstream boom");
      }),
    };
    const recipe: ChainedRecipe = {
      name: "r",
      steps: [
        { id: "a", tool: "fail-tool" },
        { id: "b", tool: "ok-tool", awaits: ["a"] },
      ],
    };
    const result = await runChainedRecipe(recipe, baseOptions, failDeps);
    expect(executed).toEqual(["fail-tool"]);
    expect(result.success).toBe(false);
  });

  it("does not pass step metadata keys to executeTool (W3)", async () => {
    const capturedParams: Record<string, unknown>[] = [];
    const captureDeps = {
      ...noopDeps,
      executeTool: vi
        .fn()
        .mockImplementation(
          async (_: string, params: Record<string, unknown>) => {
            capturedParams.push(params);
          },
        ),
    };
    const recipe: ChainedRecipe = {
      name: "r",
      steps: [
        {
          id: "s",
          tool: "t",
          awaits: [],
          optional: true,
          risk: "high",
          output: "out",
          when: "true",
          myParam: "val",
        },
      ],
    };
    await runChainedRecipe(recipe, baseOptions, captureDeps);
    const params = capturedParams[0] ?? {};
    expect(params).not.toHaveProperty("awaits");
    expect(params).not.toHaveProperty("optional");
    expect(params).not.toHaveProperty("risk");
    expect(params).not.toHaveProperty("when");
    expect(params).not.toHaveProperty("output");
    expect(params.myParam).toBe("val");
  });

  it("rejects cyclic dependency graph", async () => {
    const recipe: ChainedRecipe = {
      name: "r",
      steps: [
        { id: "a", tool: "t", awaits: ["b"] },
        { id: "b", tool: "t", awaits: ["a"] },
      ],
    };
    const result = await runChainedRecipe(recipe, baseOptions, noopDeps);
    expect(result.success).toBe(false);
    expect(result.errorMessage).toMatch(/circular/);
  });

  // Regression: a step awaiting a non-existent target was silently dropped
  // from the topological order (it AND its dependents never ran), but the
  // run still reported success:true / failed:0. The runner must now reject
  // the run with success:false and a descriptive error.
  it("rejects a recipe whose awaits target does not exist", async () => {
    const recipe: ChainedRecipe = {
      name: "r",
      steps: [
        { id: "a", tool: "t" },
        { id: "b", tool: "t", awaits: ["ghost"] },
      ],
    };
    const result = await runChainedRecipe(recipe, baseOptions, noopDeps);
    expect(result.success).toBe(false);
    expect(result.errorMessage).toMatch(/ghost/);
    expect(result.errorMessage).toMatch(/await/i);
  });
});

describe("generateExecutionPlan", () => {
  it("returns step types and dependencies", () => {
    const recipe: ChainedRecipe = {
      name: "r",
      steps: [
        { id: "a", tool: "t1" },
        { id: "b", agent: { prompt: "go" }, awaits: ["a"] },
      ],
    };
    const plan = generateExecutionPlan(recipe);
    expect(plan.steps.find((s) => s.id === "a")?.type).toBe("tool");
    expect(plan.steps.find((s) => s.id === "b")?.type).toBe("agent");
    expect(plan.steps.find((s) => s.id === "b")?.dependencies).toEqual(["a"]);
  });

  it("groups independent steps in same parallel group", () => {
    const recipe: ChainedRecipe = {
      name: "r",
      steps: [
        { id: "a", tool: "t" },
        { id: "b", tool: "t" },
      ],
    };
    const plan = generateExecutionPlan(recipe);
    expect(plan.parallelGroups[0]).toContain("a");
    expect(plan.parallelGroups[0]).toContain("b");
  });

  it("puts dependent step in later group", () => {
    const recipe: ChainedRecipe = {
      name: "r",
      steps: [
        { id: "a", tool: "t" },
        { id: "b", tool: "t", awaits: ["a"] },
      ],
    };
    const plan = generateExecutionPlan(recipe);
    const aGroup = plan.parallelGroups.findIndex((g) => g.includes("a"));
    const bGroup = plan.parallelGroups.findIndex((g) => g.includes("b"));
    expect(aGroup).toBeLessThan(bGroup);
  });

  it("includes condition and risk in step info", () => {
    const recipe: ChainedRecipe = {
      name: "r",
      steps: [{ id: "a", tool: "t", when: "{{env.FLAG}}", risk: "high" }],
    };
    const plan = generateExecutionPlan(recipe);
    const step = plan.steps[0]!;
    expect(step.condition).toBe("{{env.FLAG}}");
    expect(step.risk).toBe("high");
  });
});

// ── transform field (chained) ─────────────────────────────────────────────────

describe("transform field (chained)", () => {
  it("applies transform to tool result", async () => {
    const deps: ExecutionDeps = {
      executeTool: vi.fn().mockResolvedValue("raw output"),
      executeAgent: vi.fn().mockResolvedValue("agent output"),
      loadNestedRecipe: vi.fn().mockResolvedValue(null),
    };
    const recipe: ChainedRecipe = {
      name: "r",
      steps: [{ id: "a", tool: "t", transform: "prefix: {{$result}}" }],
    };
    const result = await runChainedRecipe(recipe, baseOptions, deps);
    expect(result.success).toBe(true);
    const reg = result.stepResults.get("a");
    expect(reg?.success).toBe(true);
    // data stored in registry should be the transformed value
    // We access it via the ChainedRunResult summary — check stepResults map
    // The actual data is in the registry; verify by inspecting the run result
    // Run success indicates transform didn't break execution
  });

  it("stores transformed value in registry data", async () => {
    const reg = createOutputRegistry();
    const deps: ExecutionDeps = {
      executeTool: vi.fn().mockResolvedValue("hello"),
      executeAgent: vi.fn().mockResolvedValue(""),
      loadNestedRecipe: vi.fn().mockResolvedValue(null),
    };
    const step = {
      id: "s1",
      tool: "mytool",
      transform: "wrapped: {{$result}}",
    };
    const ctx = {
      registry: reg,
      step,
      options: baseOptions,
      recipe: { name: "r", steps: [step] },
      depth: 0,
    };
    const result = await executeChainedStep(ctx, deps);
    expect(result.success).toBe(true);
    expect(result.data).toBe("wrapped: hello");
  });

  it("applies transform to agent result", async () => {
    const deps: ExecutionDeps = {
      executeTool: vi.fn().mockResolvedValue(""),
      executeAgent: vi.fn().mockResolvedValue("agent says hi"),
      loadNestedRecipe: vi.fn().mockResolvedValue(null),
    };
    const reg = createOutputRegistry();
    const step = {
      id: "a1",
      agent: { prompt: "do something" },
      transform: "AGENT: {{$result}}",
    };
    const ctx = {
      registry: reg,
      step,
      options: baseOptions,
      recipe: { name: "r", steps: [step] },
      depth: 0,
    };
    const result = await executeChainedStep(ctx, deps);
    expect(result.success).toBe(true);
    expect(result.data).toBe("AGENT: agent says hi");
  });

  it("succeeds without transform field (unchanged behavior)", async () => {
    const deps: ExecutionDeps = {
      executeTool: vi.fn().mockResolvedValue("plain"),
      executeAgent: vi.fn().mockResolvedValue(""),
      loadNestedRecipe: vi.fn().mockResolvedValue(null),
    };
    const reg = createOutputRegistry();
    const step = { id: "s2", tool: "t" };
    const ctx = {
      registry: reg,
      step,
      options: baseOptions,
      recipe: { name: "r", steps: [step] },
      depth: 0,
    };
    const result = await executeChainedStep(ctx, deps);
    expect(result.success).toBe(true);
    expect(result.data).toBe("plain");
  });

  it("transform is excluded from tool params", () => {
    const ctx = { steps: {}, env: { NAME: "world" } };
    const { resolved } = resolveStepTemplates(
      { id: "s", tool: "t", transform: "{{$result}}", message: "hi" },
      ctx,
    );
    expect("transform" in resolved).toBe(false);
    expect(resolved.message).toBe("hi");
  });
});

// ── expandParallelSteps ───────────────────────────────────────────────────────

describe("expandParallelSteps", () => {
  it("passes through flat steps unchanged", () => {
    const steps = [
      { id: "a", tool: "t" },
      { id: "b", tool: "t", awaits: ["a"] },
    ];
    expect(expandParallelSteps(steps)).toEqual(steps);
  });

  it("expands a parallel group into flat sibling steps", () => {
    const steps = [
      {
        id: "grp",
        parallel: [
          { id: "p1", tool: "t1" },
          { id: "p2", tool: "t2" },
        ],
      },
    ];
    const expanded = expandParallelSteps(steps);
    expect(expanded).toHaveLength(2);
    expect(expanded.map((s) => s.id)).toEqual(["p1", "p2"]);
  });

  it("children of a group inherit the group awaits", () => {
    const steps = [
      { id: "pre", tool: "t" },
      {
        id: "grp",
        awaits: ["pre"],
        parallel: [
          { id: "p1", tool: "t1" },
          { id: "p2", tool: "t2" },
        ],
      },
    ];
    const expanded = expandParallelSteps(steps);
    const p1 = expanded.find((s) => s.id === "p1");
    const p2 = expanded.find((s) => s.id === "p2");
    expect(p1?.awaits).toContain("pre");
    expect(p2?.awaits).toContain("pre");
  });

  it("steps after the group await all children not the group id", () => {
    const steps = [
      {
        id: "grp",
        parallel: [
          { id: "p1", tool: "t1" },
          { id: "p2", tool: "t2" },
        ],
      },
      { id: "post", tool: "t", awaits: ["grp"] },
    ];
    const expanded = expandParallelSteps(steps);
    const post = expanded.find((s) => s.id === "post");
    expect(post?.awaits).toContain("p1");
    expect(post?.awaits).toContain("p2");
    expect(post?.awaits).not.toContain("grp");
  });

  it("auto-generates child ids when children have no id", () => {
    const steps = [
      {
        id: "grp",
        parallel: [{ tool: "t1" }, { tool: "t2" }],
      },
    ] as ChainedRecipe["steps"];
    const expanded = expandParallelSteps(steps);
    expect(expanded).toHaveLength(2);
    expect(expanded[0]?.id).toBe("grp_0");
    expect(expanded[1]?.id).toBe("grp_1");
  });

  it("M1: duplicate child ids across two parallel groups are detected", () => {
    const steps: ChainedStep[] = [
      {
        id: "grp1",
        parallel: [
          { id: "shared", tool: "t1" },
          { id: "grp1_b", tool: "t2" },
        ],
      } as ChainedStep,
      {
        id: "grp2",
        parallel: [
          { id: "shared", tool: "t3" },
          { id: "grp2_b", tool: "t4" },
        ],
      } as ChainedStep,
    ];
    expect(() => expandParallelSteps(steps)).toThrow(
      /duplicate.*id|id.*duplicate/i,
    );
  });

  it("parallel group executes both steps end-to-end", async () => {
    const executed: string[] = [];
    const deps: ExecutionDeps = {
      executeTool: vi.fn().mockImplementation(async (tool: string) => {
        executed.push(tool);
      }),
      executeAgent: vi.fn().mockResolvedValue("ok"),
      loadNestedRecipe: vi.fn().mockResolvedValue(null),
    };
    const recipe: ChainedRecipe = {
      name: "r",
      steps: [
        {
          id: "grp",
          parallel: [
            { id: "p1", tool: "tool-a" },
            { id: "p2", tool: "tool-b" },
          ],
        } as ChainedRecipe["steps"][number],
      ],
    };
    const result = await runChainedRecipe(recipe, baseOptions, deps);
    expect(result.success).toBe(true);
    expect(executed).toContain("tool-a");
    expect(executed).toContain("tool-b");
    expect(result.summary.succeeded).toBe(2);
  });

  it("step after parallel group runs only after all children complete", async () => {
    const order: string[] = [];
    const deps: ExecutionDeps = {
      executeTool: vi.fn().mockImplementation(async (tool: string) => {
        order.push(tool);
      }),
      executeAgent: vi.fn().mockResolvedValue("ok"),
      loadNestedRecipe: vi.fn().mockResolvedValue(null),
    };
    const recipe: ChainedRecipe = {
      name: "r",
      steps: [
        {
          id: "grp",
          parallel: [
            { id: "p1", tool: "tool-a" },
            { id: "p2", tool: "tool-b" },
          ],
        } as ChainedRecipe["steps"][number],
        { id: "post", tool: "tool-post", awaits: ["grp"] },
      ],
    };
    const result = await runChainedRecipe(recipe, baseOptions, deps);
    expect(result.success).toBe(true);
    expect(order.indexOf("tool-post")).toBeGreaterThan(
      Math.max(order.indexOf("tool-a"), order.indexOf("tool-b")),
    );
  });
});

describe("runChainedRecipe — budget enforcement (S1 alignment)", () => {
  // A deterministic agent that reports usage so RunBudget reconciles real
  // spend. Each call returns a fixed token usage stamped as an API driver.
  function meteredAgentDeps(perCallTokens: number) {
    const calls: string[] = [];
    const executeAgent = vi.fn(async (prompt: string) => {
      calls.push(prompt);
      return {
        text: `done:${calls.length}`,
        usage: {
          inputTokens: perCallTokens / 2,
          outputTokens: perCallTokens / 2,
        },
        servedBy: { driver: "anthropic", model: "test-model" },
      };
    });
    const deps: ExecutionDeps = {
      executeTool: vi.fn().mockResolvedValue({ ok: true }),
      executeAgent,
      loadNestedRecipe: vi.fn().mockResolvedValue(null),
    };
    return { deps, executeAgent, calls };
  }

  it("HALTS further agent dispatch once cumulative spend exceeds tokensMax", async () => {
    // tokensMax=1000, each agent call burns 600 tokens.
    //   a: admit ok (total 0) → dispatch → reconcile 600
    //   b: admit ok (600 < 1000) → dispatch → reconcile 1200 (breached)
    //   c: admit DENIED (1200 >= 1000) → no dispatch
    const { deps, executeAgent } = meteredAgentDeps(600);
    const recipe: ChainedRecipe = {
      name: "budget-chain",
      budget: { tokensMax: 1000 },
      steps: [
        { id: "a", agent: { prompt: "step a" } },
        { id: "b", agent: { prompt: "step b" }, awaits: ["a"] },
        { id: "c", agent: { prompt: "step c" }, awaits: ["b"] },
      ],
    };

    const result = await runChainedRecipe(recipe, baseOptions, deps);

    // Only two agent dispatches happened — the third was admission-denied.
    expect(executeAgent).toHaveBeenCalledTimes(2);
    // The run failed because step c halted on the budget.
    expect(result.success).toBe(false);
    const stepC = result.stepResults.get("c");
    expect(stepC?.success).toBe(false);
    expect(stepC?.error?.message).toMatch(/budget_exceeded/);
  });

  it("admits all dispatches when cumulative spend stays under tokensMax", async () => {
    // 3 calls * 100 tokens = 300 < tokensMax 10000 → all run.
    const { deps, executeAgent } = meteredAgentDeps(100);
    const recipe: ChainedRecipe = {
      name: "budget-chain-ok",
      budget: { tokensMax: 10000 },
      steps: [
        { id: "a", agent: { prompt: "a" } },
        { id: "b", agent: { prompt: "b" }, awaits: ["a"] },
        { id: "c", agent: { prompt: "c" }, awaits: ["b"] },
      ],
    };
    const result = await runChainedRecipe(recipe, baseOptions, deps);
    expect(executeAgent).toHaveBeenCalledTimes(3);
    expect(result.success).toBe(true);
  });

  it("records the budget breach + spend in the run log (runLogDir path)", async () => {
    const { mkdtempSync, readFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "chained-budget-"));

    const { deps } = meteredAgentDeps(600);
    const recipe: ChainedRecipe = {
      name: "budget-runlog",
      budget: { tokensMax: 1000 },
      steps: [
        { id: "a", agent: { prompt: "a" } },
        { id: "b", agent: { prompt: "b" }, awaits: ["a"] },
        { id: "c", agent: { prompt: "c" }, awaits: ["b"] },
      ],
    };

    const result = await runChainedRecipe(
      recipe,
      { ...baseOptions, runLogDir: dir },
      deps,
    );
    expect(result.success).toBe(false);

    const lines = readFileSync(join(dir, "runs.jsonl"), "utf8")
      .trim()
      .split("\n")
      .filter(Boolean);
    const lastLine = lines[lines.length - 1] ?? "";
    const run = JSON.parse(lastLine) as {
      status: string;
      stepResults: Array<{ id: string; status: string; haltReason?: string }>;
    };
    expect(run.status).toBe("error");
    const cRow = run.stepResults.find((s) => s.id === "c");
    expect(cRow?.status).toBe("error");
    // haltReason carries the budget breach so the dashboard pill categorises it.
    expect(cRow?.haltReason).toMatch(/budget/i);
  });

  it("reconcile is fed REAL usage — no breach when usage is small enough", async () => {
    // Same step count as the halting test but tiny per-call usage proves the
    // budget reconciles the ACTUAL reported usage (not a fixed guess): with
    // 1-token calls the 1000 cap is never reached.
    const { deps, executeAgent } = meteredAgentDeps(2);
    const recipe: ChainedRecipe = {
      name: "budget-real-usage",
      budget: { tokensMax: 1000 },
      steps: [
        { id: "a", agent: { prompt: "a" } },
        { id: "b", agent: { prompt: "b" }, awaits: ["a"] },
        { id: "c", agent: { prompt: "c" }, awaits: ["b"] },
      ],
    };
    const result = await runChainedRecipe(recipe, baseOptions, deps);
    expect(executeAgent).toHaveBeenCalledTimes(3);
    expect(result.success).toBe(true);
  });
});
