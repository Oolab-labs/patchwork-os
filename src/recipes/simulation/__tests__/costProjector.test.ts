import { describe, expect, it } from "vitest";
import type { RecipeDryRunPlan } from "../../../commands/recipe.js";
import type { RecipeRun, RecipeRunLog } from "../../../runLog.js";
import { projectCost } from "../costProjector.js";

function plan(
  steps: RecipeDryRunPlan["steps"],
  recipe = "demo",
): RecipeDryRunPlan {
  return {
    schemaVersion: 1,
    recipe,
    mode: "dry-run",
    triggerType: "chained",
    generatedAt: "2026-06-05T00:00:00.000Z",
    steps,
    lint: { errors: [], warnings: [] },
  };
}

/** Minimal RecipeRunLog stub — projectCost only calls `query`. */
function stubLog(runs: Partial<RecipeRun>[]): RecipeRunLog {
  return {
    query: () => runs as RecipeRun[],
  } as unknown as RecipeRunLog;
}

function runWith(
  stepResults: Array<{
    id: string;
    inputTokens?: number;
    outputTokens?: number;
    costUsd?: number;
  }>,
): Partial<RecipeRun> {
  return { stepResults: stepResults as RecipeRun["stepResults"] };
}

const AGENT = (
  id: string,
  prompt?: string,
): RecipeDryRunPlan["steps"][number] =>
  ({ id, type: "agent", ...(prompt ? { prompt } : {}) }) as never;

describe("projectCost", () => {
  it("projects median tokens + USD range from history (high confidence)", () => {
    const runs = [100, 200, 300, 400, 500].map((t, i) =>
      runWith([
        {
          id: "draft",
          inputTokens: t,
          outputTokens: t / 10,
          costUsd: (i + 1) / 1000,
        },
      ]),
    );
    const cost = projectCost(plan([AGENT("draft")]), stubLog(runs), {
      threshold: 5,
    });
    expect(cost.basis).toBe("history");
    expect(cost.confidence).toBe("high");
    expect(cost.sampleRuns).toBe(5);
    expect(cost.estInputTokens).toBe(300); // median of 100..500
    expect(cost.estOutputTokens).toBe(30); // median of 10..50
    expect(cost.usd).toBeCloseTo(0.003, 9); // median of 0.001..0.005
    expect(cost.minUsd).toBeCloseTo(0.001, 9);
    expect(cost.maxUsd).toBeCloseTo(0.005, 9);
    expect(cost.historyAgentSteps).toBe(1);
  });

  it("projects tokens but omits USD for subscription history (never $0)", () => {
    const runs = [100, 200, 300].map((t) =>
      runWith([{ id: "draft", inputTokens: t, outputTokens: 20 }]),
    );
    const cost = projectCost(plan([AGENT("draft")]), stubLog(runs), {
      threshold: 5,
    });
    expect(cost.basis).toBe("history");
    expect(cost.confidence).toBe("low"); // sampleN 3 < threshold 5
    expect(cost.estInputTokens).toBe(200);
    expect(cost.usd).toBeNull();
    expect(cost.minUsd).toBeNull();
    expect(cost.maxUsd).toBeNull();
    expect(cost.note).toContain("notional");
  });

  it("falls back to the chars/4 heuristic when there is no history", () => {
    const cost = projectCost(
      plan([AGENT("draft", "x".repeat(40))]),
      stubLog([]),
    );
    expect(cost.basis).toBe("heuristic");
    expect(cost.confidence).toBe("low");
    expect(cost.estPromptTokens).toBe(10); // 40 / 4
    expect(cost.usd).toBeNull();
  });

  it("is unavailable when there are no agent steps", () => {
    const cost = projectCost(
      plan([{ id: "read", type: "tool", tool: "git.log" } as never]),
      stubLog([runWith([{ id: "read", inputTokens: 999 }])]),
    );
    expect(cost.basis).toBe("unavailable");
    expect(cost.confidence).toBe("none");
    expect(cost.estInputTokens).toBeNull();
  });

  it("is low confidence when only some agent steps have history", () => {
    const runs = [1, 2, 3, 4, 5].map((t) =>
      runWith([{ id: "a", inputTokens: t * 100, outputTokens: 10 }]),
    );
    const cost = projectCost(
      plan([AGENT("a"), AGENT("b", "prompt for b")]),
      stubLog(runs),
      { threshold: 5 },
    );
    expect(cost.basis).toBe("history");
    expect(cost.confidence).toBe("low"); // step "b" has no history
    expect(cost.historyAgentSteps).toBe(1);
    expect(cost.agentSteps).toBe(2);
  });

  it("only counts the configured agent steps, ignoring unrelated history rows", () => {
    const runs = [1, 2, 3, 4, 5].map((t) =>
      runWith([
        { id: "draft", inputTokens: t * 10, outputTokens: 1 },
        { id: "other", inputTokens: 99999, outputTokens: 9999 },
      ]),
    );
    const cost = projectCost(plan([AGENT("draft")]), stubLog(runs), {
      threshold: 5,
    });
    expect(cost.estInputTokens).toBe(30); // median of 10..50, "other" ignored
  });
});
