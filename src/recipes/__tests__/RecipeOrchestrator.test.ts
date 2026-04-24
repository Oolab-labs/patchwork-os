import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { RecipeOrchestrator } from "../RecipeOrchestrator.js";
import type { RunResult, YamlRecipe } from "../yamlRunner.js";

const tmpLogDir = mkdtempSync(path.join(os.tmpdir(), "orchestrator-test-"));

function baseDeps() {
  return {
    now: () => new Date("2026-04-25T12:00:00Z"),
    logDir: tmpLogDir,
    readFile: () => {
      throw new Error("not found");
    },
    writeFile: () => {},
    appendFile: () => {},
    mkdir: () => {},
    gitLogSince: () => "",
    gitStaleBranches: () => "",
    getDiagnostics: () => "",
  };
}

function flatRecipe(overrides: Partial<YamlRecipe> = {}): YamlRecipe {
  return {
    name: "flat",
    trigger: { type: "manual" },
    steps: [{ tool: "file.write", path: "/tmp/x", content: "hi" }],
    ...overrides,
  };
}

describe("RecipeOrchestrator", () => {
  it("delegates to dispatchRecipe and returns RunResult", async () => {
    const orch = new RecipeOrchestrator(baseDeps());
    const result = (await orch.run(flatRecipe())) as RunResult;
    expect(result).toHaveProperty("recipe", "flat");
    expect(result).toHaveProperty("stepsRun", 1);
    expect(Array.isArray(result.stepResults)).toBe(true);
  });

  it("propagates errorMessage on step failure", async () => {
    const orch = new RecipeOrchestrator({
      ...baseDeps(),
      readFile: () => {
        throw new Error("boom");
      },
    });
    const recipe = flatRecipe({
      on_error: { fallback: "abort" },
      steps: [{ tool: "file.read", path: "/tmp/missing", into: "x" }],
    });
    const result = (await orch.run(recipe)) as RunResult;
    expect(typeof result.errorMessage).toBe("string");
  });

  it("is a pure wrapper — same result shape as dispatchRecipe direct call", async () => {
    const deps = baseDeps();
    const orch = new RecipeOrchestrator(deps);
    const { dispatchRecipe } = await import("../yamlRunner.js");

    const recipe = flatRecipe();
    const [direct, wrapped] = await Promise.all([
      dispatchRecipe(recipe, deps),
      orch.run(recipe),
    ]);
    const d = direct as RunResult;
    const w = wrapped as RunResult;
    expect(Object.keys(w).sort()).toEqual(Object.keys(d).sort());
    expect(w.stepsRun).toBe(d.stepsRun);
    expect(w.recipe).toBe(d.recipe);
  });
});
