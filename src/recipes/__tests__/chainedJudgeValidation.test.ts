/**
 * Tier-1 #8 (audit 2026-06-22) — judge→refine is flat-runner-only.
 *
 * The judge→refine loop (`kind: judge` + `max_revisions`) is implemented ONLY
 * in the flat yamlRunner. A chained recipe (`trigger.type: "chained"`) treats a
 * judge step as a plain agent step and silently ignores `max_revisions` — the
 * refinement never runs, but lint reported the recipe clean. Reject it at lint
 * time so users aren't misled.
 */

import { describe, expect, it } from "vitest";
import { validateRecipeDefinition } from "../validation.js";

function recipeWith(triggerType: string, judgeAgent: Record<string, unknown>) {
  return {
    name: "cj",
    version: "1.0.0",
    trigger: { type: triggerType },
    steps: [
      { id: "synthesize", agent: { prompt: "write", into: "draft" } },
      { id: "judge", agent: judgeAgent },
    ],
  };
}

const chainedJudgeIssues = (judgeAgent: Record<string, unknown>) =>
  validateRecipeDefinition(recipeWith("chained", judgeAgent)).issues.filter(
    (i) => i.code === "chained-judge-unsupported",
  );

describe("chained recipe judge→refine rejection (Tier-1 #8)", () => {
  it("rejects a kind:judge step in a chained recipe", () => {
    const found = chainedJudgeIssues({
      kind: "judge",
      reviews: "draft",
      prompt: "review",
    });
    expect(found).toHaveLength(1);
    expect(found[0]?.level).toBe("error");
  });

  it("rejects max_revisions>0 in a chained recipe (even without kind:judge)", () => {
    const found = chainedJudgeIssues({
      max_revisions: 2,
      reviews: "draft",
      prompt: "review",
    });
    expect(found.length).toBeGreaterThanOrEqual(1);
  });

  it("does NOT flag a judge step in a flat (manual) recipe — it works there", () => {
    const found = validateRecipeDefinition(
      recipeWith("manual", {
        kind: "judge",
        reviews: "draft",
        max_revisions: 1,
        prompt: "review",
      }),
    ).issues.filter((i) => i.code === "chained-judge-unsupported");
    expect(found).toHaveLength(0);
  });
});
