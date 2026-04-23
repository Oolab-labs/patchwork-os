import { describe, expect, it, vi } from "vitest";
import type {
  ChainedRecipe,
  ExecutionDeps,
  RunOptions,
} from "../chainedRunner.js";
import {
  buildTemplateContext,
  executeChainedStep,
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
