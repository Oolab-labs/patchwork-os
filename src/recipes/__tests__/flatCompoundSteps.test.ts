/**
 * Flat-runner compound steps — run them, or fail loud. Never silently skip.
 *
 * Every cron / manual / event / webhook recipe runs on the flat runner
 * (`dispatchRecipe` routes on `trigger.type === "chained"` alone), which read
 * none of the compound forms. Such a step reached executeToolStep's
 * "Unknown tool — skip, don't throw (forward compat)" path, came back `null`,
 * and was recorded as `status: "skipped"` with no error: the run reported
 * success while the step body never executed. Eight recipes shipped in this
 * repo were inert that way, two of them behind green `recipe lint` CI gates.
 *
 * Three outcomes, one per kind of form:
 *   - `parallel: [ ... ]` is a scheduling hint with an exact sequential
 *     equivalent → desugared, so those recipes start working.
 *   - `each` / `parallel:{each}` / `recipe` / `chain` / `branch` change which
 *     steps run → no equivalent, so they error.
 *   - an unknown tool NAME → still skips (real forward-compat for un-loaded
 *     plugins), and a falsy `when:` guard still skips (an intentional skip).
 * The last two are pinned here precisely because they must NOT change.
 */

import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { validateRecipeDefinition } from "../validation.js";
import {
  type RunnerDeps,
  runYamlRecipe,
  type YamlRecipe,
} from "../yamlRunner.js";

let tmpDir: string;
let writes: Array<{ path: string; content: string }>;

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), "flat-compound-"));
  writes = [];
});
afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function deps(): RunnerDeps {
  return {
    // `testMode` is a RunnerDeps field, NOT a seed-context key — RunContext is
    // Record<string, string>, so the `{ testMode: true }` third argument used
    // elsewhere in this suite is a no-op that only survives because vitest
    // doesn't typecheck. tsconfig.tests.core.json does.
    testMode: true,
    now: () => new Date("2026-08-04T08:00:00Z"),
    logDir: tmpDir,
    readFile: () => {
      throw new Error("not found");
    },
    writeFile: (p: string, c: string) => writes.push({ path: p, content: c }),
    appendFile: () => {},
    mkdir: () => {},
    gitLogSince: () => "",
    gitStaleBranches: () => "",
    getDiagnostics: () => "",
  };
}

function recipeWithStep(step: Record<string, unknown>): YamlRecipe {
  return {
    name: "flat-compound",
    trigger: { type: "manual" },
    steps: [step],
  } as unknown as YamlRecipe;
}

/**
 * The write step a compound body would run if the form were implemented.
 * A function, not a const: `tmpDir` is per-test, and the audit-test-fixtures
 * gate rejects hardcoded /tmp literals.
 */
const innerWrite = () => ({
  tool: "file.write",
  path: path.join(tmpDir, "should-not-exist.txt"),
  content: "x",
});

describe("flat runner — compound steps fail loud", () => {
  // Thunks, not literals: `tmpDir` (via innerWrite) doesn't exist until
  // beforeEach runs, and this array is built at collection time.
  const cases: Array<[string, () => Record<string, unknown>]> = [
    [
      "parallel:{each} map-reduce",
      () => ({
        id: "scrub",
        parallel: { each: '["a","b"]', as: "doc", steps: [innerWrite()] },
      }),
    ],
    [
      "step-level each:",
      () => ({ id: "send", each: '["a","b"]', as: "row", ...innerWrite() }),
    ],
    ["nested recipe:", () => ({ id: "sub", recipe: "some-other-recipe" })],
    ["chain:", () => ({ id: "sub", chain: "some-other-recipe" })],
    [
      "branch:",
      () => ({ id: "pick", branch: [{ when: "x", steps: [innerWrite()] }] }),
    ],
  ];

  for (const [label, makeStep] of cases) {
    it(`${label} — errors instead of skipping, and the body does not run`, async () => {
      const result = await runYamlRecipe(recipeWithStep(makeStep()), deps());

      const first = result.stepResults[0];
      expect(first?.status).toBe("error");
      // The message must name the construct and point somewhere useful.
      expect(first?.error).toMatch(/not supported in this recipe/i);
      // And the run as a whole must not report clean.
      expect(result.errorMessage).toBeTruthy();
      // Body never ran either way — that part was never in doubt.
      expect(writes.length).toBe(0);
    });
  }

  it("names the specific construct, so the author knows what to change", async () => {
    const result = await runYamlRecipe(
      recipeWithStep({
        id: "scrub",
        parallel: { each: '["a"]', as: "doc", steps: [innerWrite()] },
      }),
      deps(),
    );
    expect(result.stepResults[0]?.error).toContain("parallel");
  });
});

describe("flat runner — parallel: [] desugars to sequential", () => {
  const w = (name: string) => ({
    tool: "file.write",
    path: path.join(tmpDir, `${name}.txt`),
    content: name,
  });

  it("runs every child of the group, in order", async () => {
    const result = await runYamlRecipe(
      recipeWithStep({ id: "fan", parallel: [w("a"), w("b"), w("c")] }),
      deps(),
    );
    expect(writes.map((x) => x.content)).toEqual(["a", "b", "c"]);
    expect(result.errorMessage).toBeUndefined();
    expect(result.stepResults.every((s) => s.status === "ok")).toBe(true);
  });

  it("reports the EXPANDED step count, not 1 (progress must not exceed 100%)", async () => {
    const result = await runYamlRecipe(
      recipeWithStep({ id: "fan", parallel: [w("a"), w("b"), w("c")] }),
      deps(),
    );
    expect(result.stepResults.length).toBe(3);
    expect(result.stepsRun).toBe(3);
  });

  it("flattens a nested group too", async () => {
    const result = await runYamlRecipe(
      recipeWithStep({
        id: "outer",
        parallel: [w("a"), { id: "inner", parallel: [w("b"), w("c")] }],
      }),
      deps(),
    );
    expect(writes.map((x) => x.content)).toEqual(["a", "b", "c"]);
    expect(result.errorMessage).toBeUndefined();
  });

  it("carries the group's `when` guard down to its children", async () => {
    const result = await runYamlRecipe(
      recipeWithStep({
        id: "fan",
        when: "{{missing}}",
        parallel: [w("a"), w("b")],
      }),
      deps(),
    );
    expect(writes.length).toBe(0);
    expect(result.stepResults.every((s) => s.status === "skipped")).toBe(true);
    expect(result.errorMessage).toBeUndefined();
  });

  it("errors rather than silently dropping an un-carried group-level field", async () => {
    const result = await runYamlRecipe(
      recipeWithStep({
        id: "fan",
        timeout_ms: 5000,
        parallel: [w("a")],
      }),
      deps(),
    );
    expect(result.errorMessage).toMatch(/not carried to its steps/i);
    expect(writes.length).toBe(0);
  });

  it("errors when group and child both set `when` (cannot conjoin guards)", async () => {
    const result = await runYamlRecipe(
      recipeWithStep({
        id: "fan",
        when: "{{a}}",
        parallel: [{ ...w("a"), when: "{{b}}" }],
      }),
      deps(),
    );
    expect(result.errorMessage).toMatch(/both set `when`/i);
    expect(writes.length).toBe(0);
  });

  it("errors on an EMPTY parallel group instead of dropping the step", async () => {
    // Found in review: an empty array was treated as a group with no children,
    // so the step silently vanished — the exact bug this file exists to close,
    // reintroduced by the fix for it. The chained runner guards with
    // `.length > 0`; this is the flat counterpart.
    const result = await runYamlRecipe(
      recipeWithStep({ id: "fan", parallel: [] }),
      deps(),
    );
    expect(result.errorMessage).toMatch(/no steps/i);
  });

  it("errors on a malformed child instead of skipping it", async () => {
    // A typo'd child (null, a bare string) used to be dropped mid-loop, so a
    // group of 3 could silently run 2.
    const result = await runYamlRecipe(
      recipeWithStep({ id: "fan", parallel: [w("a"), null, w("b")] }),
      deps(),
    );
    expect(result.errorMessage).toMatch(/step 2 .*is not an object/i);
    expect(writes.length).toBe(0);
  });

  it("lint accepts the array form on a flat recipe", () => {
    const res = validateRecipeDefinition({
      name: "flat-array",
      description: "d",
      trigger: { type: "cron", at: "0 6 * * *" },
      steps: [{ id: "fan", parallel: [innerWrite()] }],
    });
    expect(
      res.issues.some((i) => i.code === "flat-compound-step-unsupported"),
    ).toBe(false);
  });
});

describe("flat runner — skip paths that must NOT change", () => {
  it("a falsy `when:` guard still skips, with no error", async () => {
    const result = await runYamlRecipe(
      recipeWithStep({
        tool: "file.write",
        when: "{{missing}}",
        path: path.join(tmpDir, "guarded.txt"),
        content: "nope",
      }),
      deps(),
    );
    expect(result.stepResults[0]?.status).toBe("skipped");
    expect(result.errorMessage).toBeUndefined();
    expect(writes.length).toBe(0);
  });

  it("an unknown tool NAME still skips (forward compat for un-loaded plugins)", async () => {
    const result = await runYamlRecipe(
      recipeWithStep({ tool: "someplugin.doesnotexist", foo: "bar" }),
      deps(),
    );
    expect(result.stepResults[0]?.status).toBe("skipped");
    expect(result.errorMessage).toBeUndefined();
  });
});

describe("flat recipe lint — compound steps are an authoring-time error", () => {
  it("flags parallel:{each} on a non-chained recipe", () => {
    const res = validateRecipeDefinition({
      name: "flat-each",
      description: "d",
      trigger: { type: "manual" },
      steps: [
        {
          id: "scrub",
          parallel: { each: '["a"]', as: "doc", steps: [innerWrite()] },
        },
      ],
    });
    expect(res.valid).toBe(false);
    expect(
      res.issues.some((i) => i.code === "flat-compound-step-unsupported"),
    ).toBe(true);
  });

  it("leaves chained recipes to the existing chained-specific error", () => {
    const res = validateRecipeDefinition({
      name: "chained-each",
      description: "d",
      trigger: { type: "chained" },
      steps: [
        {
          id: "scrub",
          parallel: { each: '["a"]', as: "doc", steps: [innerWrite()] },
        },
      ],
    });
    expect(
      res.issues.some((i) => i.code === "chained-parallel-each-unsupported"),
    ).toBe(true);
    expect(
      res.issues.some((i) => i.code === "flat-compound-step-unsupported"),
    ).toBe(false);
  });

  it("does not flag a chained recipe's supported parallel array form", () => {
    const res = validateRecipeDefinition({
      name: "chained-array",
      description: "d",
      trigger: { type: "chained" },
      steps: [{ id: "fan", parallel: [innerWrite()] }],
    });
    expect(
      res.issues.some((i) => i.code === "flat-compound-step-unsupported"),
    ).toBe(false);
  });
});
