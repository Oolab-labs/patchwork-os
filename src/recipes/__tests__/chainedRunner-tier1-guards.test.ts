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
import { resolveProfile } from "../../governance/profile.js";
import type {
  ChainedRecipe,
  ExecutionDeps,
  RunOptions,
} from "../chainedRunner.js";
import { executeChainedStep, runChainedRecipe } from "../chainedRunner.js";
import { createOutputRegistry } from "../outputRegistry.js";
import "../tools/index.js";
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

  it("forwards the run's AbortSignal into requireApprovalFn (L1/L5 chained path)", async () => {
    // A worker recipe can be chained; the approval wait must be cancellable so a
    // cancelled run doesn't block for the full TTL.
    const ac = new AbortController();
    const requireApprovalFn = vi.fn().mockResolvedValue(true);
    const deps = makeDeps({ requireApprovalFn });
    await executeChainedStep(
      ctxFor({ id: "s", tool: "some.tool" }, recipeNoTrigger, {
        options: { ...baseOptions, signal: ac.signal },
      }),
      deps,
    );
    expect(requireApprovalFn).toHaveBeenCalledWith(
      expect.objectContaining({ signal: ac.signal }),
    );
  });

  it("GATES nested chained steps (depth > 0) like the top-level run", async () => {
    // Audit 2026-10-15 (H2): nested steps never reached computeEffectivePolicy,
    // so a worker-owned chained recipe could reach a forbidden or
    // irreversible step one `recipe:` call deep with no tier gate, no worker
    // gate and no forbid rule. They are now evaluated with the parent's
    // trigger and the parent's worker gate (the shared deps).
    const requireApprovalFn = vi.fn().mockResolvedValue(false);
    const deps = makeDeps({ requireApprovalFn });
    const result = await executeChainedStep(
      ctxFor({ id: "s", agent: { prompt: "x" } }, recipeNoTrigger, {
        depth: 1,
        options: { ...baseOptions, policyRoot: { name: "parent" } },
      }),
      deps,
    );
    expect(requireApprovalFn).toHaveBeenCalledTimes(1);
    expect(result.success).toBe(false);
  });

  it("a nested child's own requireApproval:false cannot opt its parent's run out", async () => {
    const requireApprovalFn = vi.fn().mockResolvedValue(false);
    const deps = makeDeps({ requireApprovalFn });
    const child = {
      name: "child",
      steps: [],
      requireApproval: false,
    } as unknown as ChainedRecipe;
    const result = await executeChainedStep(
      ctxFor({ id: "s", agent: { prompt: "x" } }, child, {
        depth: 1,
        options: { ...baseOptions, policyRoot: { name: "parent" } },
      }),
      deps,
    );
    expect(requireApprovalFn).toHaveBeenCalledTimes(1);
    expect(result.success).toBe(false);
  });

  it("the PARENT's opt-out still covers its nested steps, so the two levels agree", async () => {
    const requireApprovalFn = vi.fn().mockResolvedValue(false);
    const deps = makeDeps({ requireApprovalFn });
    const result = await executeChainedStep(
      ctxFor({ id: "s", agent: { prompt: "x" } }, recipeNoTrigger, {
        depth: 1,
        options: {
          ...baseOptions,
          policyRoot: { name: "parent", requireApproval: false },
        },
      }),
      deps,
    );
    expect(requireApprovalFn).not.toHaveBeenCalled();
    expect(result.success).toBe(true);
  });

  it("end to end: a step inside a nested recipe is gated and a rejection halts it", async () => {
    const requireApprovalFn = vi.fn().mockResolvedValue(false);
    const executeTool = vi.fn().mockResolvedValue({ ok: true });
    const child = {
      name: "child",
      trigger: { type: "chained" },
      steps: [{ id: "write", tool: "file.write", path: "x.md", content: "c" }],
    } as unknown as ChainedRecipe;
    const deps = makeDeps({
      requireApprovalFn,
      executeTool,
      loadNestedRecipe: vi.fn().mockResolvedValue({ recipe: child }),
    });
    const parent = {
      name: "parent",
      trigger: { type: "chained" },
      steps: [{ id: "call", recipe: "child" }],
    } as unknown as ChainedRecipe;
    const result = await runChainedRecipe(parent, baseOptions, deps);
    expect(requireApprovalFn).toHaveBeenCalledWith(
      expect.objectContaining({ toolId: "file.write" }),
    );
    expect(executeTool).not.toHaveBeenCalled();
    expect(result.success).toBe(false);
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

describe("executeChainedStep — write acknowledgement under governed (audit M6)", () => {
  // The chained runner never checked `allowWrites` at all. Under governed an
  // unacknowledged write is refused before dispatch. A nested step is judged
  // against ITS OWN recipe's declaration: an acknowledgement is a statement
  // about the recipe's own steps, not an approval, so it is not inherited.
  const governed = resolveProfile({ profile: "governed" });

  it("refuses an unacknowledged write and never dispatches it", async () => {
    const executeTool = vi.fn().mockResolvedValue({ ok: true });
    const recipe = { name: "r", steps: [] } as unknown as ChainedRecipe;
    const result = await executeChainedStep(
      ctxFor(
        { id: "w", tool: "file.write", path: "x.md", content: "c" },
        recipe,
      ),
      makeDeps({ executeTool, governance: governed }),
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain("allowWrites");
    expect(executeTool).not.toHaveBeenCalled();
  });

  it("dispatches an acknowledged write", async () => {
    const executeTool = vi.fn().mockResolvedValue({ ok: true });
    const recipe = {
      name: "r",
      steps: [],
      allowWrites: ["file.write"],
    } as unknown as ChainedRecipe;
    const result = await executeChainedStep(
      ctxFor(
        { id: "w", tool: "file.write", path: "x.md", content: "c" },
        recipe,
      ),
      makeDeps({ executeTool, governance: governed }),
    );
    expect(result.success).toBe(true);
    expect(executeTool).toHaveBeenCalledTimes(1);
  });

  it("a nested step does not inherit its parent's acknowledgement", async () => {
    const executeTool = vi.fn().mockResolvedValue({ ok: true });
    const child = {
      name: "child",
      trigger: { type: "chained" },
      steps: [{ id: "w", tool: "file.write", path: "x.md", content: "c" }],
    } as unknown as ChainedRecipe;
    const parent = {
      name: "parent",
      trigger: { type: "chained" },
      allowWrites: ["file.write"],
      steps: [{ id: "call", recipe: "child" }],
    } as unknown as ChainedRecipe;
    const result = await runChainedRecipe(
      parent,
      baseOptions,
      makeDeps({
        executeTool,
        governance: governed,
        loadNestedRecipe: vi.fn().mockResolvedValue({ recipe: child }),
      }),
    );
    expect(executeTool).not.toHaveBeenCalled();
    expect(result.success).toBe(false);
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
