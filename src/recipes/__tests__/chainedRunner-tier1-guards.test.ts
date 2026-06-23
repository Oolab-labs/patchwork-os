/**
 * Tier-1 (audit 2026-06-22) — chainedRunner parity guards.
 *
 * The flat runner (yamlRunner) shipped three guards that the DAG chainedRunner
 * silently lacked ("incomplete-fix-one-path"):
 *   #4 approval gate     — requireApprovalFn was never consulted in the chain.
 *   #5 secret redaction  — {{env.SECRET}} leaked verbatim into the LLM prompt.
 *   #6 budget admission  — only AGENT steps were gated; tool steps ran unbounded.
 *
 * These tests assert the chained path now matches the flat path.
 */

import { describe, expect, it, vi } from "vitest";
import type {
  ChainedRecipe,
  ExecutionDeps,
  RunOptions,
} from "../chainedRunner.js";
import { executeChainedStep } from "../chainedRunner.js";
import { createOutputRegistry } from "../outputRegistry.js";
import type { RunBudget } from "../runBudget.js";

const baseOptions: RunOptions = {
  env: {},
  maxConcurrency: 4,
  maxDepth: 3,
  dryRun: false,
};

function makeDeps(over: Partial<ExecutionDeps> = {}): ExecutionDeps {
  return {
    executeTool: vi.fn().mockResolvedValue({ ok: true }),
    executeAgent: vi.fn().mockResolvedValue("agent output"),
    loadNestedRecipe: vi.fn().mockResolvedValue(null),
    ...over,
  };
}

const recipeNoTrigger = { name: "r", steps: [] } as unknown as ChainedRecipe;

function ctxFor(
  step: ExecutionContextStep,
  recipe: ChainedRecipe = recipeNoTrigger,
  extra: { options?: RunOptions; budget?: RunBudget; depth?: number } = {},
) {
  return {
    registry: createOutputRegistry(),
    step,
    options: extra.options ?? baseOptions,
    recipe,
    depth: extra.depth ?? 0,
    ...(extra.budget ? { budget: extra.budget } : {}),
  };
}
type ExecutionContextStep = Parameters<typeof executeChainedStep>[0]["step"];

describe("executeChainedStep — approval gate (Tier-1 #4)", () => {
  it("rejects an agent step when requireApprovalFn resolves false (top-level run)", async () => {
    const executeAgent = vi.fn().mockResolvedValue("output");
    const deps = makeDeps({
      executeAgent,
      requireApprovalFn: vi.fn().mockResolvedValue(false),
    });
    const result = await executeChainedStep(
      ctxFor({ id: "s", agent: { prompt: "do it" } }),
      deps,
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain("approval_rejected");
    expect(executeAgent).not.toHaveBeenCalled();
  });

  it("allows the step when requireApprovalFn resolves true", async () => {
    const deps = makeDeps({
      requireApprovalFn: vi.fn().mockResolvedValue(true),
    });
    const result = await executeChainedStep(
      ctxFor({ id: "s", agent: { prompt: "do it" } }),
      deps,
    );
    expect(result.success).toBe(true);
    expect(deps.executeAgent).toHaveBeenCalled();
  });

  it("gates TOOL steps too, not just agent steps", async () => {
    const executeTool = vi.fn().mockResolvedValue({ ok: true });
    const deps = makeDeps({
      executeTool,
      requireApprovalFn: vi.fn().mockResolvedValue(false),
    });
    const result = await executeChainedStep(
      ctxFor({ id: "s", tool: "some.tool" }),
      deps,
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain("approval_rejected");
    expect(executeTool).not.toHaveBeenCalled();
  });

  it("does not gate when no requireApprovalFn is injected (approvalGate off)", async () => {
    const result = await executeChainedStep(
      ctxFor({ id: "s", agent: { prompt: "x" } }),
      makeDeps(),
    );
    expect(result.success).toBe(true);
  });

  it("does not gate NESTED chained recipes (depth > 0) — only the top-level run", async () => {
    // A chained recipe always has trigger.type:"chained" (cron/webhook route to
    // the flat runner), so depth is the safe-by-default signal: a nested chained
    // recipe runs under a parent whose own gating already governed admission.
    const requireApprovalFn = vi.fn().mockResolvedValue(false);
    const deps = makeDeps({ requireApprovalFn });
    const result = await executeChainedStep(
      ctxFor({ id: "s", agent: { prompt: "x" } }, recipeNoTrigger, {
        depth: 1,
      }),
      deps,
    );
    expect(requireApprovalFn).not.toHaveBeenCalled();
    expect(result.success).toBe(true);
  });

  it("respects per-recipe requireApproval:false opt-out", async () => {
    const requireApprovalFn = vi.fn().mockResolvedValue(false);
    const deps = makeDeps({ requireApprovalFn });
    const recipe = {
      name: "r",
      steps: [],
      requireApproval: false,
    } as unknown as ChainedRecipe;
    const result = await executeChainedStep(
      ctxFor({ id: "s", agent: { prompt: "x" } }, recipe),
      deps,
    );
    expect(requireApprovalFn).not.toHaveBeenCalled();
    expect(result.success).toBe(true);
  });
});

describe("executeChainedStep — secret redaction (Tier-1 #5)", () => {
  const recipe = {
    name: "r",
    steps: [],
    context: [{ type: "env", keys: ["MY_SECRET"] }],
  } as unknown as ChainedRecipe;
  const options: RunOptions = { ...baseOptions, env: { MY_SECRET: "s3cr3t" } };

  it("redacts declared env secrets from the agent prompt", async () => {
    let seenPrompt = "";
    const executeAgent = vi.fn(async (prompt: string) => {
      seenPrompt = prompt;
      return "ok";
    });
    const result = await executeChainedStep(
      ctxFor(
        { id: "a", agent: { prompt: "key is {{env.MY_SECRET}}" } },
        recipe,
        { options },
      ),
      makeDeps({ executeAgent }),
    );
    expect(result.success).toBe(true);
    expect(seenPrompt).toContain("[REDACTED]");
    expect(seenPrompt).not.toContain("s3cr3t");
  });

  it("keeps the real secret value for TOOL params (only the LLM prompt is redacted)", async () => {
    let seenParams: Record<string, unknown> = {};
    const executeTool = vi.fn(
      async (_tool: string, params: Record<string, unknown>) => {
        seenParams = params;
        return { ok: true };
      },
    );
    const result = await executeChainedStep(
      ctxFor(
        { id: "t", tool: "http.post", header: "{{env.MY_SECRET}}" },
        recipe,
        { options },
      ),
      makeDeps({ executeTool }),
    );
    expect(result.success).toBe(true);
    expect(seenParams.header).toBe("s3cr3t");
  });
});

describe("executeChainedStep — budget admission gates all step types (Tier-1 #6)", () => {
  const breached = {
    admit: () => ({
      admitted: false,
      reason: "Run exceeded its budget — budget_exceeded.",
    }),
  } as unknown as RunBudget;

  it("blocks a TOOL step when the budget is breached (was agent-only before)", async () => {
    const executeTool = vi.fn().mockResolvedValue({ ok: true });
    const result = await executeChainedStep(
      ctxFor({ id: "s", tool: "some.tool" }, recipeNoTrigger, {
        budget: breached,
      }),
      makeDeps({ executeTool }),
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain("budget_exceeded");
    expect(executeTool).not.toHaveBeenCalled();
  });

  it("still blocks an AGENT step when the budget is breached", async () => {
    const executeAgent = vi.fn().mockResolvedValue("x");
    const result = await executeChainedStep(
      ctxFor({ id: "s", agent: { prompt: "x" } }, recipeNoTrigger, {
        budget: breached,
      }),
      makeDeps({ executeAgent }),
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain("budget_exceeded");
    expect(executeAgent).not.toHaveBeenCalled();
  });
});
