/**
 * P1 — recipe run cost/token persistence.
 *
 * Per-step agent token usage (AgentResult.usage) is captured at the runner
 * level and persisted onto the run record (per-step inputTokens/outputTokens/
 * costUsd + run-level tokenTotals). This is corpus-building only — no
 * projection / new enforcement. Constraints proved here:
 *   - usage lands on the persisted step + run when a driver reports it
 *   - a judge→refine step sums usage across ALL its agent calls
 *   - no usage (tool-only / subscription / undefined) → fields ABSENT
 *     (old rows round-trip unchanged)
 *   - costUsd is set ONLY for a priceable billable model, never 0
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentResult } from "../agentExecutor.js";
import type {
  ChainedRecipe,
  ExecutionDeps,
  RunOptions,
} from "../chainedRunner.js";
import { runChainedRecipe } from "../chainedRunner.js";
import {
  type RunnerDeps,
  runYamlRecipe,
  type YamlRecipe,
} from "../yamlRunner.js";

// A priceable billable model from the built-in price table.
const PRICED_MODEL = "claude-haiku-4-5-20251001"; // input 1, output 5 ($/1M)

let tmpDir: string;
beforeEach(() => {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), "run-cost-persist-"));
});
afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function readRunLog(): Array<Record<string, unknown>> {
  const file = path.join(tmpDir, "runs.jsonl");
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf-8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

// ── yamlRunner (flat) ───────────────────────────────────────────────────────

describe("yamlRunner — per-step token capture + persistence", () => {
  it("persists inputTokens/outputTokens/costUsd for a priceable agent step and run-level tokenTotals", async () => {
    const recipe: YamlRecipe = {
      name: "cost-flat",
      trigger: { type: "manual" },
      steps: [
        {
          agent: {
            prompt: "do the thing",
            driver: "anthropic",
            model: PRICED_MODEL,
            into: "out",
          },
        },
      ],
    } as YamlRecipe;

    // claudeFn may return a full AgentResult; usage + servedBy flow through.
    const deps: RunnerDeps = {
      logDir: tmpDir,
      // Persistence test: force the run-log write to the temp dir (never
      // homedir) under the VITEST-aware testMode default. See runLogIsolation.test.ts.
      testMode: false,
      claudeFn: async (): Promise<AgentResult> => ({
        text: "the answer",
        usage: { inputTokens: 1000, outputTokens: 200 },
        servedBy: { driver: "anthropic", model: PRICED_MODEL },
      }),
    };

    const result = await runYamlRecipe(recipe, deps);
    const step = result.stepResults.find((s) => s.tool === "agent");
    expect(step?.inputTokens).toBe(1000);
    expect(step?.outputTokens).toBe(200);
    // 1000/1e6*1 + 200/1e6*5 = 0.001 + 0.001 = 0.002
    expect(step?.costUsd).toBeCloseTo(0.002, 9);
    expect(step?.costUsd).not.toBe(0);

    expect(result.tokenTotals).toEqual({
      inputTokens: 1000,
      outputTokens: 200,
      costUsd: expect.closeTo(0.002, 9),
    });

    // Persisted row carries the same fields.
    const rows = readRunLog();
    expect(rows).toHaveLength(1);
    const persistedStep = (
      rows[0]!.stepResults as Array<Record<string, unknown>>
    )[0]!;
    expect(persistedStep.inputTokens).toBe(1000);
    expect(persistedStep.outputTokens).toBe(200);
    expect(persistedStep.costUsd).toBeCloseTo(0.002, 9);
    expect(rows[0]!.tokenTotals).toMatchObject({
      inputTokens: 1000,
      outputTokens: 200,
    });
  });

  it("sums per-step tokens across all agent calls in a judge→refine loop", async () => {
    const recipe: YamlRecipe = {
      name: "cost-judge-refine",
      trigger: { type: "manual" },
      steps: [
        {
          agent: {
            prompt: "write the thing",
            driver: "anthropic",
            model: PRICED_MODEL,
            into: "draft",
          },
        },
        {
          agent: {
            kind: "judge",
            reviews: "draft",
            max_revisions: 1,
            on_exhausted: "proceed",
            prompt: "review the draft",
            driver: "anthropic",
            model: PRICED_MODEL,
          },
        },
      ],
    } as YamlRecipe;

    const REQUEST_CHANGES =
      '```json\n{"verdict":"request_changes","fixList":["tighten"]}\n```';
    const APPROVE = '```json\n{"verdict":"approve","reasons":["ok"]}\n```';

    // Each call reports 100/10 usage. The judge step makes 3 calls:
    //  1) first judge verdict (request_changes)
    //  2) revise (reviewed agent re-run)
    //  3) re-judge (approve)
    // → per-step sum for the judge step = 300 in / 30 out.
    const deps: RunnerDeps = {
      logDir: tmpDir,
      // Persistence test: force the run-log write to the temp dir (never
      // homedir) under the VITEST-aware testMode default. See runLogIsolation.test.ts.
      testMode: false,
      claudeFn: async (prompt: string): Promise<AgentResult> => {
        let text: string;
        if (prompt.includes("<revision-request>")) text = "REVISED v2";
        else if (prompt.includes("<artefact>"))
          text = prompt.includes("REVISED v2") ? APPROVE : REQUEST_CHANGES;
        else text = "DRAFT v1";
        return {
          text,
          usage: { inputTokens: 100, outputTokens: 10 },
          servedBy: { driver: "anthropic", model: PRICED_MODEL },
        };
      },
    };

    const result = await runYamlRecipe(recipe, deps);
    const judge = result.stepResults.find((s) => s.judgeVerdict !== undefined);
    expect(judge).toBeDefined();
    // first judge + revise + re-judge = 3 agent calls folded into this step.
    expect(judge?.inputTokens).toBe(300);
    expect(judge?.outputTokens).toBe(30);

    // run-level total = draft(100/10) + judge(300/30) = 400/40.
    expect(result.tokenTotals?.inputTokens).toBe(400);
    expect(result.tokenTotals?.outputTokens).toBe(40);
  });

  it("omits token fields when no driver reports usage (tool-only run round-trips unchanged)", async () => {
    const recipe: YamlRecipe = {
      name: "no-usage",
      trigger: { type: "manual" },
      steps: [
        // agent step served by a plain-string driver → usage undefined.
        {
          agent: {
            prompt: "x",
            driver: "anthropic",
            model: PRICED_MODEL,
            into: "o",
          },
        },
      ],
    } as YamlRecipe;

    const deps: RunnerDeps = {
      logDir: tmpDir,
      // Persistence test: force the run-log write to the temp dir (never
      // homedir) under the VITEST-aware testMode default. See runLogIsolation.test.ts.
      testMode: false,
      // plain string → toAgentResult → { text } with no usage.
      claudeFn: async () => "just text, no usage",
    };

    const result = await runYamlRecipe(recipe, deps);
    const step = result.stepResults.find((s) => s.tool === "agent");
    expect(step).toBeDefined();
    expect(step).not.toHaveProperty("inputTokens");
    expect(step).not.toHaveProperty("outputTokens");
    expect(step).not.toHaveProperty("costUsd");
    expect(result.tokenTotals).toBeUndefined();

    const rows = readRunLog();
    const persistedStep = (
      rows[0]!.stepResults as Array<Record<string, unknown>>
    )[0]!;
    expect(persistedStep).not.toHaveProperty("inputTokens");
    expect(rows[0]!).not.toHaveProperty("tokenTotals");
  });

  it("omits costUsd (but keeps tokens) for usage on an unpriced model — never 0", async () => {
    const recipe: YamlRecipe = {
      name: "unpriced",
      trigger: { type: "manual" },
      steps: [
        {
          agent: {
            prompt: "x",
            driver: "anthropic",
            model: "some-unlisted-model-9000",
            into: "o",
          },
        },
      ],
    } as YamlRecipe;

    const deps: RunnerDeps = {
      logDir: tmpDir,
      // Persistence test: force the run-log write to the temp dir (never
      // homedir) under the VITEST-aware testMode default. See runLogIsolation.test.ts.
      testMode: false,
      claudeFn: async (): Promise<AgentResult> => ({
        text: "text",
        usage: { inputTokens: 500, outputTokens: 50 },
        servedBy: { driver: "anthropic", model: "some-unlisted-model-9000" },
      }),
    };

    const result = await runYamlRecipe(recipe, deps);
    const step = result.stepResults.find((s) => s.tool === "agent");
    expect(step?.inputTokens).toBe(500);
    expect(step?.outputTokens).toBe(50);
    expect(step).not.toHaveProperty("costUsd");
    expect(result.tokenTotals).toMatchObject({
      inputTokens: 500,
      outputTokens: 50,
    });
    expect(result.tokenTotals).not.toHaveProperty("costUsd");
  });
});

// ── chainedRunner ───────────────────────────────────────────────────────────

describe("chainedRunner — per-step token capture + persistence", () => {
  function chainedRecipe(): ChainedRecipe & { trigger: { type: string } } {
    return {
      name: "cost-chained",
      trigger: { type: "chained" },
      steps: [
        {
          id: "s1",
          agent: { prompt: "go", driver: "anthropic", model: PRICED_MODEL },
        },
      ],
    } as ChainedRecipe & { trigger: { type: string } };
  }

  function opts(): RunOptions {
    return {
      env: {},
      maxConcurrency: 4,
      maxDepth: 3,
      dryRun: false,
      runLogDir: tmpDir,
    } as RunOptions;
  }

  it("persists per-step tokens/costUsd and run tokenTotals for a priceable agent step", async () => {
    const deps: ExecutionDeps = {
      executeTool: vi.fn().mockResolvedValue("ok"),
      executeAgent: vi.fn().mockResolvedValue({
        text: "answer",
        usage: { inputTokens: 2000, outputTokens: 100 },
        servedBy: { driver: "anthropic", model: PRICED_MODEL },
      } satisfies AgentResult),
      loadNestedRecipe: vi.fn().mockResolvedValue(null),
    };

    const result = await runChainedRecipe(chainedRecipe(), opts(), deps);
    expect(result.success).toBe(true);

    const rows = readRunLog();
    expect(rows).toHaveLength(1);
    const step = (rows[0]!.stepResults as Array<Record<string, unknown>>).find(
      (s) => s.id === "s1",
    )!;
    expect(step.inputTokens).toBe(2000);
    expect(step.outputTokens).toBe(100);
    // 2000/1e6*1 + 100/1e6*5 = 0.002 + 0.0005 = 0.0025
    expect(step.costUsd).toBeCloseTo(0.0025, 9);
    expect(step.costUsd).not.toBe(0);
    expect(rows[0]!.tokenTotals).toMatchObject({
      inputTokens: 2000,
      outputTokens: 100,
    });
  });

  it("omits token fields when the agent reports no usage (round-trip unchanged)", async () => {
    const deps: ExecutionDeps = {
      executeTool: vi.fn().mockResolvedValue("ok"),
      executeAgent: vi.fn().mockResolvedValue("plain text, no usage"),
      loadNestedRecipe: vi.fn().mockResolvedValue(null),
    };

    const result = await runChainedRecipe(chainedRecipe(), opts(), deps);
    expect(result.success).toBe(true);

    const rows = readRunLog();
    const step = (rows[0]!.stepResults as Array<Record<string, unknown>>).find(
      (s) => s.id === "s1",
    )!;
    expect(step).not.toHaveProperty("inputTokens");
    expect(step).not.toHaveProperty("costUsd");
    expect(rows[0]!).not.toHaveProperty("tokenTotals");
  });
});
