/**
 * A worker manifest can be perfect and still govern a recipe that cannot run.
 *
 * `validateWorkers` checks the BINDING — does the manifest parse, does the
 * `recipe:` it names exist, does anyone else claim it. It never asked whether
 * the recipe on the other end of that binding works. Measured on the reference
 * install the day this was written: 8 manifests, "✓ no problems found", while
 * `recipe doctor` on one of the bound recipes reported 8 errors and 2 warnings
 * — six tool ids that are not registered, and a variable written three times by
 * three different steps. A second bound recipe wrote a file it never declared.
 *
 * Two workers of eight bound to recipes that cannot do their job, and the
 * health check for workers said everything was fine. It is the same shape as
 * every other finding in this file: a correct rule pointed at a subset.
 *
 * The probe is INJECTED rather than imported. `runPreflight` drags in the whole
 * recipe planner, and a validator that can only be tested against the planner
 * is a validator whose failure modes can only be produced by breaking a recipe.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  probeWorkerRecipes,
  type RecipeHealthProbe,
  summariseRecipeHealth,
} from "../workerRecipeHealth.js";
import {
  formatWorkersValidate,
  validateWorkers,
  validateWorkersWithRecipeHealth,
} from "../workersCli.js";

const workers = [
  { id: "scout", recipe: "nightly-scan" },
  { id: "guardian", recipe: "watch-tests" },
];

function probeReturning(
  byRecipe: Record<string, Awaited<ReturnType<RecipeHealthProbe>>>,
): RecipeHealthProbe {
  return async (recipe: string) => byRecipe[recipe] ?? { ok: true, issues: [] };
}

describe("probeWorkerRecipes", () => {
  it("an unrunnable recipe is a finding even when the manifest is perfect", async () => {
    const findings = await probeWorkerRecipes(workers, {
      probe: probeReturning({
        "nightly-scan": {
          ok: false,
          issues: [
            {
              level: "error",
              code: "lint-error",
              message: "step 3 has no id",
            },
          ],
        },
      }),
    });
    const f = findings.find((x) => x.code === "recipe-unhealthy");
    expect(f).toBeDefined();
    expect(f?.level).toBe("error");
    expect(f?.message).toContain("scout");
    expect(f?.message).toContain("nightly-scan");
  });

  it("an unresolved tool is a WARNING, and says why it is not an error", async () => {
    // The step is skipped silently and the run finishes `done` — but the tool
    // may equally come from a plugin this process did not load, and failing on
    // that would make the check permanently red on a correct install.
    const findings = await probeWorkerRecipes(workers, {
      probe: probeReturning({
        "nightly-scan": {
          ok: false,
          issues: [
            {
              level: "error",
              code: "unresolved-tool",
              message: 'Tool "code.scan_duplicates" is not registered',
            },
          ],
        },
      }),
    });
    const f = findings.find((x) => x.code === "recipe-unhealthy");
    expect(f?.level).toBe("warning");
    expect(f?.message).toMatch(/plugin/i);
    expect(f?.message).toMatch(/silently|skip/i);
  });

  it("one lint error among unresolved tools still makes it an error", async () => {
    const findings = await probeWorkerRecipes(workers, {
      probe: probeReturning({
        "nightly-scan": {
          ok: false,
          issues: [
            { level: "error", code: "unresolved-tool", message: "a" },
            { level: "error", code: "lint-error", message: "b" },
          ],
        },
      }),
    });
    expect(findings.find((x) => x.code === "recipe-unhealthy")?.level).toBe(
      "error",
    );
  });

  it("a probe that THROWS is reported as not-checked, never as healthy", async () => {
    const findings = await probeWorkerRecipes(workers, {
      probe: async (recipe: string) => {
        if (recipe === "nightly-scan") throw new Error("unreadable");
        return { ok: true, issues: [] };
      },
    });
    const f = findings.find((x) => x.code === "recipe-uncheckable");
    expect(f).toBeDefined();
    expect(findings.some((x) => x.code === "recipe-unhealthy")).toBe(false);
  });

  it("a worker with no recipe is not probed (validateWorkers already reports it)", async () => {
    let calls = 0;
    const findings = await probeWorkerRecipes(
      [{ id: "orphan", recipe: undefined }],
      {
        probe: async () => {
          calls++;
          return { ok: true, issues: [] };
        },
      },
    );
    expect(calls).toBe(0);
    expect(findings).toEqual([]);
  });

  it("probes each distinct recipe once even when two workers claim it", async () => {
    let calls = 0;
    await probeWorkerRecipes(
      [
        { id: "a", recipe: "shared" },
        { id: "b", recipe: "shared" },
      ],
      {
        probe: async () => {
          calls++;
          return { ok: true, issues: [] };
        },
      },
    );
    expect(calls).toBe(1);
  });
});

describe("summariseRecipeHealth leads with the denominator", () => {
  it("says how many were checked, not just how many failed", async () => {
    const findings = await probeWorkerRecipes(workers, {
      probe: probeReturning({
        "nightly-scan": {
          ok: false,
          issues: [{ level: "error", code: "lint-error", message: "x" }],
        },
      }),
    });
    const line = summariseRecipeHealth(findings, { probed: 2 });
    expect(line).toContain("2");
    expect(line).toMatch(/1 unhealthy|1 of 2/);
  });

  it("nothing to check reads differently from everything is fine", () => {
    expect(summariseRecipeHealth([], { probed: 0 })).toMatch(/no .*recipe/i);
    expect(summariseRecipeHealth([], { probed: 3 })).toMatch(/3/);
  });
});

/**
 * The WIRING, with the REAL probe.
 *
 * Every test above injects one, which proves the finding logic and proves
 * nothing about whether `recipe doctor`'s static half can actually be reached
 * from here — the gap that leaves a check landed and inert. So this one builds a
 * genuinely broken recipe on disk and lets the default probe find it.
 */
describe("validateWorkersWithRecipeHealth against the real probe", () => {
  let root: string;
  let workersDir: string;
  let recipesDir: string;

  beforeEach(() => {
    root = mkdtempSync(path.join(os.tmpdir(), "pw-worker-recipe-health-"));
    workersDir = path.join(root, "workers");
    recipesDir = path.join(root, "recipes");
    for (const d of [workersDir, recipesDir]) mkdirSync(d, { recursive: true });
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  function install(worker: string, recipeFile: string, recipeBody: string) {
    writeFileSync(path.join(workersDir, "w.worker.yaml"), worker);
    writeFileSync(path.join(recipesDir, recipeFile), recipeBody);
  }

  const workerYaml = `id: probe-worker
name: Probe
responsibilities: [x]
recipe: bound-recipe
owns: [issue]
autonomyCeiling: 1
`;

  it("reaches a recipe whose FILENAME differs from its declared name", async () => {
    // A worker's \`recipe:\` names the declared name, not the file. Resolving by
    // guessing "<name>.yaml" reports a recipe that is right there as one it
    // could not check.
    install(
      workerYaml,
      "totally-different-filename.yaml",
      "name: bound-recipe\ndescription: d\ntrigger: { type: manual }\nsteps:\n  - tool: not.a.real.tool\n    into: x\n",
    );
    const result = await validateWorkersWithRecipeHealth({
      workersDir,
      recipesDir,
    });
    expect(result.findings.some((f) => f.code === "recipe-uncheckable")).toBe(
      false,
    );
    const f = result.findings.find((x) => x.code === "recipe-unhealthy");
    expect(f).toBeDefined();
    expect(f?.message).toContain("not.a.real.tool");
    // Unresolved tools alone stay a warning, so the exit code does not flip.
    expect(f?.level).toBe("warning");
    expect(result.healthy).toBe(true);
  });

  it("a clean bound recipe reports the denominator and no finding", async () => {
    install(
      workerYaml,
      "bound.yaml",
      "name: bound-recipe\ndescription: d\ntrigger: { type: manual }\nsteps:\n  - agent:\n      prompt: say hello\n      into: out\n",
    );
    const result = await validateWorkersWithRecipeHealth({
      workersDir,
      recipesDir,
    });
    expect(result.findings.filter((f) => f.code.startsWith("recipe-"))).toEqual(
      [],
    );
    expect(result.counts.recipesProbed).toBe(1);
    expect(result.recipeHealth).toContain("0 of 1");
    expect(formatWorkersValidate(result)).toContain("0 of 1");
  });

  it("says a recipe was NOT checked rather than passing it", async () => {
    // No recipe file at all: the dangling-recipe error fires next door, and the
    // health pass must not quietly count it as healthy.
    writeFileSync(path.join(workersDir, "w.worker.yaml"), workerYaml);
    const result = await validateWorkersWithRecipeHealth({
      workersDir,
      recipesDir,
      probe: async () => {
        throw new Error("no such recipe");
      },
    });
    const f = result.findings.find((x) => x.code === "recipe-uncheckable");
    expect(f?.message).toMatch(/not a pass/i);
  });
});

/**
 * The third way a perfect binding governs nothing: the recipe is DISABLED.
 *
 * `recipes.disabled` in the patchwork config is read by the scheduler, the
 * event-trigger programs and the HTTP route, so a disabled recipe never fires
 * from any trigger. A worker bound to one is installed, parses, binds, owns
 * action classes, carries a `forbids` list — and can never run.
 *
 * A WARNING, not an error: disabling a recipe is a deliberate operator act, and
 * failing the check on an intended state is how a gate gets ignored. What is
 * worth saying is the PAIRING — the worker is still installed and still claims
 * to govern something.
 */
describe("a worker bound to a disabled recipe", () => {
  let root: string;
  let workersDir: string;
  let recipesDir: string;

  beforeEach(() => {
    root = mkdtempSync(path.join(os.tmpdir(), "pw-worker-disabled-"));
    workersDir = path.join(root, "workers");
    recipesDir = path.join(root, "recipes");
    for (const d of [workersDir, recipesDir]) mkdirSync(d, { recursive: true });
    writeFileSync(
      path.join(workersDir, "w.worker.yaml"),
      "id: scout\nname: Scout\nresponsibilities: [x]\nrecipe: nightly-scan\nowns: [issue]\nautonomyCeiling: 1\n",
    );
    writeFileSync(
      path.join(recipesDir, "nightly-scan.yaml"),
      "name: nightly-scan\ndescription: d\ntrigger: { type: manual }\nsteps:\n  - agent:\n      prompt: x\n      into: out\n",
    );
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("is reported, and says the worker cannot run at all", () => {
    const result = validateWorkers({
      workersDir,
      recipesDir,
      disabledRecipes: ["nightly-scan"],
    });
    const f = result.findings.find((x) => x.code === "disabled-recipe");
    expect(f).toBeDefined();
    expect(f?.level).toBe("warning");
    expect(f?.message).toContain("scout");
    expect(f?.message).toContain("nightly-scan");
    // Deliberate operator state — it must not fail the check.
    expect(result.healthy).toBe(true);
  });

  it("is silent when the recipe is enabled", () => {
    const result = validateWorkers({ workersDir, recipesDir });
    expect(result.findings.some((x) => x.code === "disabled-recipe")).toBe(
      false,
    );
  });
});
