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
 */
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
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
