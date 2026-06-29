/**
 * Recipe-trigger registration → firing proof.
 *
 * Guards the wiring that makes `trigger: { type: file_watch | git_hook }`
 * recipes actually fire: collected programs are registered into AutomationHooks
 * and run on the same events the bridge already dispatches. Before this wiring
 * such recipes were parsed + installed but decorative (the "0 tasks" assertion
 * below). See docs/dogfood/recipe-dogfood-2026-05-01/C-triggers.md.
 */

import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { AutomationPolicy } from "../automation.js";
import { AutomationHooks } from "../automation.js";
import { ClaudeOrchestrator } from "../claudeOrchestrator.js";
import type { IClaudeDriver } from "../drivers/types.js";
import type { BackendFireRecipeOpts } from "../fp/interpreterContext.js";
import { compileRecipe } from "../recipes/compiler.js";
import { parseRecipe } from "../recipes/parser.js";

function makeHooks() {
  const driver: IClaudeDriver = {
    name: "instant",
    async run() {
      return { text: "ok", exitCode: 0, durationMs: 1 };
    },
  };
  const orch = new ClaudeOrchestrator(driver, os.tmpdir(), () => {});
  const firedRecipes: BackendFireRecipeOpts[] = [];
  // recipeFireFn (7th arg) collects fired recipe invocations for assertions.
  // Recipe triggers now go through fireRecipe, not enqueueTask, so orch.list()
  // stays empty — assertions must check firedRecipes instead.
  const hooks = new AutomationHooks(
    {} as AutomationPolicy,
    orch,
    () => {},
    undefined,
    os.tmpdir(),
    false,
    async (opts) => {
      firedRecipes.push(opts);
      return `recipe-task-${firedRecipes.length}`;
    },
  );
  return { hooks, orch, firedRecipes };
}

const settle = () => new Promise((r) => setTimeout(r, 30));
const tsFile = () => path.join(os.tmpdir(), "watched.ts");

const fwProgram = compileRecipe(
  parseRecipe({
    name: "fw-recipe",
    version: "1.0.0",
    trigger: { type: "file_watch", patterns: ["**/*.ts"] },
    steps: [{ id: "s1", tool: "getGitStatus", params: {} }],
  }),
);
const ghProgram = compileRecipe(
  parseRecipe({
    name: "gh-recipe",
    version: "1.0.0",
    trigger: { type: "git_hook", event: "post-commit" },
    steps: [{ id: "s1", tool: "getGitStatus", params: {} }],
  }),
);

describe("recipe trigger registration", () => {
  it("file_watch recipe is decorative until registered, then fires on save", async () => {
    const { hooks, firedRecipes } = makeHooks();

    // Unregistered: the gap this PR closes — nothing fires.
    hooks.handleFileSaved("id", "save", tsFile());
    await settle();
    expect(firedRecipes).toHaveLength(0);

    hooks.registerRecipePrograms([fwProgram]);
    hooks.handleFileSaved("id", "save", tsFile());
    await settle();

    expect(firedRecipes).toHaveLength(1);
    expect(firedRecipes[0]!.recipeName).toBe("fw-recipe");
  });

  it("gates by hook type: git_hook recipe fires on commit, not on file save", async () => {
    const { hooks, firedRecipes } = makeHooks();
    hooks.registerRecipePrograms([fwProgram, ghProgram]);

    hooks.handleFileSaved("id", "save", tsFile());
    await settle();
    expect(firedRecipes).toHaveLength(1);
    expect(firedRecipes[0]!.recipeName).toBe("fw-recipe");
    expect(firedRecipes.some((r) => r.recipeName === "gh-recipe")).toBe(false);

    await hooks.handleGitCommit({
      hash: "abc1234",
      branch: "main",
      message: "feat: x",
      count: 1,
      files: ["src/a.ts"],
    });
    await settle();
    expect(firedRecipes).toHaveLength(2);
    expect(firedRecipes.some((r) => r.recipeName === "gh-recipe")).toBe(true);
  });

  it("is idempotent: re-registering the same set does not duplicate hooks", async () => {
    const { hooks, firedRecipes } = makeHooks();
    hooks.registerRecipePrograms([fwProgram]);
    hooks.registerRecipePrograms([fwProgram]); // simulate hot-reload

    hooks.handleFileSaved("id", "save", tsFile());
    await settle();
    expect(firedRecipes).toHaveLength(1);
  });
});
