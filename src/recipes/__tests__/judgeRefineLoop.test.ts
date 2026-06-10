/**
 * Judge→refine loop integration tests (first end-to-end coverage of the
 * #859/#860 loop through runYamlRecipe).
 *
 * Focus: audit 2026-06-03 (MEDIUM #17). When the RE-JUDGE agent call fails
 * (explicit failure marker / silent-fail / empty), the loop must NOT parse the
 * failure text into a verdict — that produced a bogus "unparseable" verdict,
 * silently dropping the prior `request_changes` signal and skipping the
 * on_exhausted gate, so the run proceeded as if the unvalidated revised draft
 * had been approved. The fix keeps the last good verdict (mirroring the
 * revise-failure break) and lets on_exhausted decide.
 *
 * Also covers audit 2026-06-03 LOW #2: budget admission is checked at the
 * top of the loop (before REVISE) but was NOT re-checked between REVISE and
 * RE-JUDGE, so when REVISE exhausted the budget the RE-JUDGE fired anyway —
 * one extra LLM call over budget. The fix adds a second admit() after REVISE.
 */
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { AgentResult } from "../agentExecutor.js";
import {
  type RunnerDeps,
  runYamlRecipe,
  type YamlRecipe,
} from "../yamlRunner.js";

const logDir = mkdtempSync(path.join(os.tmpdir(), "judge-refine-test-"));

/** A judge→refine recipe: a writer agent (into: draft) reviewed by a judge. */
function judgeRecipe(
  maxRevisions: number,
  onExhausted: "halt" | "proceed",
): YamlRecipe {
  return {
    name: "judge-refine",
    trigger: { type: "manual" },
    steps: [
      {
        agent: {
          prompt: "write the thing",
          model: "claude-haiku-4-5-20251001",
          driver: "anthropic",
          into: "draft",
        },
      },
      {
        agent: {
          kind: "judge",
          reviews: "draft",
          max_revisions: maxRevisions,
          on_exhausted: onExhausted,
          prompt: "review the draft",
          model: "claude-haiku-4-5-20251001",
          driver: "anthropic",
        },
      },
    ],
  } as YamlRecipe;
}

const REQUEST_CHANGES =
  '```json\n{"verdict":"request_changes","fixList":["tighten the intro"]}\n```';
const APPROVE = '```json\n{"verdict":"approve","reasons":["looks good"]}\n```';

/**
 * Drive the agent calls by inspecting the prompt:
 *   - a revision-request prompt   → the reviewed agent's revise → "REVISED v2"
 *   - a judge prompt (<artefact>) → first verdict, or the re-judge once the
 *     artefact contains the revised draft (controlled by `reJudge`)
 *   - otherwise                   → the initial reviewed-agent draft "DRAFT v1"
 */
function depsWithReJudge(reJudge: string): RunnerDeps {
  return {
    now: () => new Date("2026-06-03T08:00:00Z"),
    logDir,
    claudeFn: async (prompt: string) => {
      if (prompt.includes("<revision-request>")) return "REVISED v2";
      if (prompt.includes("<artefact>")) {
        return prompt.includes("REVISED v2") ? reJudge : REQUEST_CHANGES;
      }
      return "DRAFT v1";
    },
  };
}

function judgeResult(result: Awaited<ReturnType<typeof runYamlRecipe>>) {
  return result.stepResults.find((s) => s.judgeVerdict !== undefined);
}

describe("judge→refine: failed re-judge (audit 2026-06-03 MEDIUM #17)", () => {
  it("keeps the last good verdict and halts when the re-judge fails (on_exhausted: halt)", async () => {
    const result = await runYamlRecipe(
      judgeRecipe(1, "halt"),
      depsWithReJudge("[agent step failed: re-judge timeout]"),
    );
    const judge = judgeResult(result);
    expect(judge).toBeDefined();
    // The failed re-judge must NOT overwrite the verdict with "unparseable".
    expect(judge?.judgeVerdict?.verdict).toBe("request_changes");
    // on_exhausted: halt → the judge step errors and the run reports an error.
    expect(judge?.status).toBe("error");
    expect(result.errorMessage).toMatch(/did not approve/i);
  });

  it("keeps the last good verdict and proceeds when on_exhausted: proceed", async () => {
    const result = await runYamlRecipe(
      judgeRecipe(1, "proceed"),
      depsWithReJudge("[agent step failed: re-judge timeout]"),
    );
    const judge = judgeResult(result);
    expect(judge?.judgeVerdict?.verdict).toBe("request_changes");
    // proceed → no halt; the judge step stays ok with the unapproved verdict.
    expect(judge?.status).toBe("ok");
    expect(result.errorMessage).toBeUndefined();
  });

  it("happy path intact: a successful re-judge that approves clears the loop", async () => {
    const result = await runYamlRecipe(
      judgeRecipe(1, "halt"),
      depsWithReJudge(APPROVE),
    );
    const judge = judgeResult(result);
    expect(judge?.judgeVerdict?.verdict).toBe("approve");
    expect(judge?.status).toBe("ok");
    expect(result.errorMessage).toBeUndefined();
  });
});

describe("judge→refine: budget off-by-one (audit 2026-06-03 LOW #2)", () => {
  /**
   * Returns RunnerDeps whose claudeFn always reports 500 input + 500 output
   * tokens so RunBudget.reconcile() accumulates real token counts. Also
   * increments callCount.n so the test can verify how many LLM calls fired.
   */
  function depsWithBudget(callCount: { n: number }): RunnerDeps {
    return {
      now: () => new Date("2026-06-03T08:00:00Z"),
      logDir,
      claudeFn: async (prompt: string): Promise<AgentResult> => {
        callCount.n += 1;
        // Initial write step → plain draft.
        if (
          !prompt.includes("<artefact>") &&
          !prompt.includes("<revision-request>")
        ) {
          return {
            text: "DRAFT v1",
            usage: { inputTokens: 500, outputTokens: 500 },
          };
        }
        // REVISE step.
        if (prompt.includes("<revision-request>")) {
          return {
            text: "REVISED v2",
            usage: { inputTokens: 500, outputTokens: 500 },
          };
        }
        // Initial judge (artefact = DRAFT v1) → request_changes.
        // Re-judge (artefact = REVISED v2) → should NOT fire when budget exhausted.
        if (prompt.includes("REVISED v2")) {
          return {
            text: '```json\n{"verdict":"approve","reasons":["ok"]}\n```',
            usage: { inputTokens: 500, outputTokens: 500 },
          };
        }
        return {
          text: REQUEST_CHANGES,
          usage: { inputTokens: 500, outputTokens: 500 },
        };
      },
    };
  }

  it("does NOT fire re-judge when the REVISE call exhausts the token budget", async () => {
    // Token accounting:
    //   initial write:  500 + 500 = 1 000   (total = 1 000)
    //   initial judge:  500 + 500 = 1 000   (total = 2 000)
    //   loop admit() at 2 000 → 2 000 < 3 000 → admitted ✓
    //   revise:         500 + 500 = 1 000   (total = 3 000)
    //   WITH FIX: post-revise admit() at 3 000 → 3 000 >= 3 000 → break
    //             callCount = 3, revisions = 0
    //   WITHOUT FIX: re-judge fires → total = 4 000, callCount = 4, revisions = 1
    const callCount = { n: 0 };
    const recipe: YamlRecipe = {
      name: "budget-judge",
      trigger: { type: "manual" },
      budget: { tokensMax: 3000 },
      steps: [
        {
          agent: {
            prompt: "write the thing",
            model: "claude-haiku-4-5-20251001",
            driver: "anthropic",
            into: "draft",
          },
        },
        {
          agent: {
            kind: "judge",
            reviews: "draft",
            max_revisions: 3,
            on_exhausted: "proceed",
            prompt: "review the draft",
            model: "claude-haiku-4-5-20251001",
            driver: "anthropic",
          },
        },
      ],
    } as YamlRecipe;

    const result = await runYamlRecipe(recipe, depsWithBudget(callCount));
    const judge = judgeResult(result);

    // The re-judge must NOT have fired: only 3 calls (write + judge + revise).
    expect(callCount.n).toBe(3);
    // revisions = 0 because the loop broke before re-judging.
    expect(judge?.revisions).toBe(0);
    // The verdict must still be "request_changes" (the initial judge verdict).
    expect(judge?.judgeVerdict?.verdict).toBe("request_changes");
    // on_exhausted: proceed → no overall error, the step itself is ok.
    expect(result.errorMessage).toBeUndefined();
  });

  it("promotes the revised draft on the post-revise budget break (on_exhausted: proceed) — audit 2026-06-08 recipe-flat-1", async () => {
    // Same token accounting as above: the loop breaks right after REVISE
    // produced "REVISED v2" but before the re-judge. With the data-loss bug,
    // ctx.draft kept the stale pre-revision "DRAFT v1" and the agent's revision
    // was silently discarded. on_exhausted: proceed means "use best effort", so
    // the most recent revision must be promoted.
    const callCount = { n: 0 };
    const recipe: YamlRecipe = {
      name: "budget-judge-promote",
      trigger: { type: "manual" },
      budget: { tokensMax: 3000 },
      steps: [
        {
          agent: {
            prompt: "write the thing",
            model: "claude-haiku-4-5-20251001",
            driver: "anthropic",
            into: "draft",
          },
        },
        {
          agent: {
            kind: "judge",
            reviews: "draft",
            max_revisions: 3,
            on_exhausted: "proceed",
            prompt: "review the draft",
            model: "claude-haiku-4-5-20251001",
            driver: "anthropic",
          },
        },
      ],
    } as YamlRecipe;

    const result = await runYamlRecipe(recipe, depsWithBudget(callCount));

    // Re-judge still must NOT fire (budget off-by-one fix preserved).
    expect(callCount.n).toBe(3);
    // The agent's revision must be promoted, not discarded.
    expect(result.context.draft).toBe("REVISED v2");
    expect(result.errorMessage).toBeUndefined();
  });
});

describe("judge→refine: quality-aware escalation", () => {
  it("re-runs the revision with escalate[0]'s model, not the base model", async () => {
    const calls: Array<{ kind: string; model?: string }> = [];
    const recipe = {
      name: "judge-escalate",
      trigger: { type: "manual" },
      steps: [
        {
          agent: {
            prompt: "write the thing",
            driver: "anthropic",
            model: "claude-haiku-4-5-20251001",
            into: "draft",
            // On judge rejection, escalate the revision to a stronger model.
            escalate: [{ model: "claude-opus-4-8" }],
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
            model: "claude-haiku-4-5-20251001",
          },
        },
      ],
    } as YamlRecipe;

    const deps: RunnerDeps = {
      now: () => new Date("2026-06-03T08:00:00Z"),
      logDir,
      claudeFn: async (prompt: string, model: string) => {
        if (prompt.includes("<revision-request>")) {
          calls.push({ kind: "revise", model });
          return "REVISED v2";
        }
        if (prompt.includes("<artefact>")) {
          calls.push({ kind: "judge", model });
          return prompt.includes("REVISED v2") ? APPROVE : REQUEST_CHANGES;
        }
        calls.push({ kind: "draft", model });
        return "DRAFT v1";
      },
    };

    const result = await runYamlRecipe(recipe, deps);

    const draft = calls.find((c) => c.kind === "draft");
    const revise = calls.find((c) => c.kind === "revise");
    // First pass used the cheap base model…
    expect(draft?.model).toBe("claude-haiku-4-5-20251001");
    // …and the rejection re-ran the revision on the escalated (stronger) model.
    expect(revise).toBeDefined();
    expect(revise?.model).toBe("claude-opus-4-8");
    expect(result.errorMessage).toBeUndefined();
  });

  it("reuses the base model on revision when no escalate list is set", async () => {
    const reviseModels: string[] = [];
    const deps: RunnerDeps = {
      now: () => new Date("2026-06-03T08:00:00Z"),
      logDir,
      claudeFn: async (prompt: string, model: string) => {
        if (prompt.includes("<revision-request>")) {
          reviseModels.push(model);
          return "REVISED v2";
        }
        if (prompt.includes("<artefact>")) {
          return prompt.includes("REVISED v2") ? APPROVE : REQUEST_CHANGES;
        }
        return "DRAFT v1";
      },
    };
    await runYamlRecipe(judgeRecipe(1, "proceed"), deps);
    // No escalate → the revision uses the reviewed agent's base model.
    expect(reviseModels).toEqual(["claude-haiku-4-5-20251001"]);
  });
});
