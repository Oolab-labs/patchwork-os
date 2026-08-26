/**
 * `expect.required` — an expectation on a conditional step used to be
 * unenforceable by construction.
 *
 * Both runners evaluate `step.expect` only on a step that RAN, so a `when:`
 * guard that resolved false skipped the assertion silently. "If X happened,
 * also check Y" is the common and correct reading, which is why the default is
 * unchanged — but an author who means "this step must happen, and here is the
 * evidence" had no way to say so.
 *
 * Written for BOTH runners in one change on purpose. A rule implemented on one
 * of them is the flat-vs-chained divergence this codebase keeps paying for, and
 * it is silent and permissive: the guard is honoured on one runner and
 * unenforced on the other, with nothing reporting the difference.
 *
 * NOT extended to the unregistered-tool skip, which is deliberate forward-compat
 * for un-loaded plugins and pinned by a guard test named "skip paths that must
 * NOT change". `required` is scoped to the `when:` guard only.
 */

import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type {
  ChainedRecipe,
  ExecutionDeps,
  RunOptions,
} from "../chainedRunner.js";
import { runChainedRecipe } from "../chainedRunner.js";
import { runYamlRecipe } from "../yamlRunner.js";

const flatDeps = () => ({
  readFile: () => "",
  writeFile: () => {},
  appendFile: () => {},
  mkdir: () => {},
  gitLogSince: () => "",
  gitStaleBranches: () => "",
  getDiagnostics: () => "",
  claudeFn: async () => "out",
  claudeCodeFn: async () => "out",
  providerDriverFn: async () => "out",
  testMode: true,
});

function flatRecipe(expectBlock: Record<string, unknown> | undefined) {
  return {
    name: "guarded",
    description: "d",
    trigger: { type: "manual" },
    steps: [
      {
        id: "guarded",
        when: "{{never}}",
        tool: "file.write",
        // `os.tmpdir()` rather than a literal `/tmp` — the fixture-hygiene gate
        // rejects hardcoded paths, and it is right to: `/tmp` is not a path on
        // Windows, where this suite also runs. The step never executes (its
        // guard is always false), which is precisely why a wrong path here
        // would have gone unnoticed.
        path: path.join(os.tmpdir(), "pw-never-written.txt"),
        content: "x",
        ...(expectBlock ? { expect: expectBlock } : {}),
      },
    ],
  } as unknown as Parameters<typeof runYamlRecipe>[0];
}

describe("flat runner — expect.required on a when:-skipped step", () => {
  it("stays skipped by default", async () => {
    const r = await runYamlRecipe(flatRecipe({ contains: "x" }), flatDeps());
    expect(r.stepResults[0]?.status).toBe("skipped");
    expect(r.errorMessage).toBeUndefined();
  });

  it("fails when the author marked the step required", async () => {
    const r = await runYamlRecipe(
      flatRecipe({ contains: "x", required: true }),
      flatDeps(),
    );
    expect(r.stepResults[0]?.status).toBe("error");
    expect(r.stepResults[0]?.haltCategory).toBe("expect_failed");
    expect(r.errorMessage).toContain("expect.required");
  });

  it("required: false is explicitly the old behaviour", async () => {
    const r = await runYamlRecipe(
      flatRecipe({ contains: "x", required: false }),
      flatDeps(),
    );
    expect(r.stepResults[0]?.status).toBe("skipped");
  });

  it("no expect block at all is untouched", async () => {
    const r = await runYamlRecipe(flatRecipe(undefined), flatDeps());
    expect(r.stepResults[0]?.status).toBe("skipped");
    expect(r.errorMessage).toBeUndefined();
  });

  /**
   * `optional: true` and `expect.required` together are contradictory.
   * `optional` wins on whether the RUN aborts — exactly as it does for a real
   * step error — but the step is still recorded as an error so the halt count
   * and `recipe doctor` can see it.
   */
  it("optional: true keeps the run alive but still records the halt", async () => {
    const recipe = flatRecipe({ contains: "x", required: true });
    (recipe as unknown as { steps: Array<Record<string, unknown>> })
      .steps[0]!.optional = true;
    const r = await runYamlRecipe(recipe, flatDeps());
    expect(r.stepResults[0]?.status).toBe("error");
    expect(r.errorMessage).toBeUndefined();
  });
});

const chainedDeps: ExecutionDeps = {
  executeTool: vi.fn().mockResolvedValue({ ok: true }),
  executeAgent: vi.fn().mockResolvedValue("agent output"),
  loadNestedRecipe: vi.fn().mockResolvedValue(null),
};

const chainedOptions: RunOptions = {
  env: {},
  maxConcurrency: 4,
  maxDepth: 3,
  dryRun: false,
};

function chainedRecipe(
  expectBlock: Record<string, unknown> | undefined,
): ChainedRecipe {
  return {
    name: "guarded-chained",
    steps: [
      {
        id: "guarded",
        // A literal `false`, not `{{never}}`. On this runner an unresolvable
        // template ref in a guard is a TEMPLATE ERROR (the step fails before
        // the skip branch is reached), where the flat runner treats the same
        // expression as falsy and skips — a real divergence, observed here and
        // deliberately not changed by this PR. `false` reaches the skip branch
        // on both, which is the behaviour under test.
        when: false as unknown as string,
        tool: "http.get",
        ...(expectBlock ? { expect: expectBlock } : {}),
      } as ChainedRecipe["steps"][number],
    ],
  };
}

describe("chained runner — the same rule, not half of it", () => {
  it("stays skipped by default", async () => {
    const r = await runChainedRecipe(
      chainedRecipe({ contains: "x" }),
      chainedOptions,
      chainedDeps,
    );
    expect(r.success).toBe(true);
    expect(r.summary.skipped).toBe(1);
  });

  it("fails when the author marked the step required", async () => {
    const r = await runChainedRecipe(
      chainedRecipe({ contains: "x", required: true }),
      chainedOptions,
      chainedDeps,
    );
    expect(r.success).toBe(false);
    expect(r.errorMessage).toContain("step(s) failed");
  });

  it("no expect block at all is untouched", async () => {
    const r = await runChainedRecipe(
      chainedRecipe(undefined),
      chainedOptions,
      chainedDeps,
    );
    expect(r.success).toBe(true);
    expect(r.summary.skipped).toBe(1);
  });
});
