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
  // Empty policy → parsePolicy returns ok([]) → interpreter backend initialises,
  // so registered recipe programs have a live backend to run on.
  const hooks = new AutomationHooks(
    {} as AutomationPolicy,
    orch,
    () => {},
    undefined,
    os.tmpdir(),
  );
  return { hooks, orch };
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
    const { hooks, orch } = makeHooks();

    // Unregistered: the gap this PR closes — nothing fires.
    hooks.handleFileSaved("id", "save", tsFile());
    await settle();
    expect(orch.list()).toHaveLength(0);

    hooks.registerRecipePrograms([fwProgram]);
    hooks.handleFileSaved("id", "save", tsFile());
    await settle();

    const tasks = orch.list();
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.prompt).toContain("fw-recipe");
  });

  it("gates by hook type: git_hook recipe fires on commit, not on file save", async () => {
    const { hooks, orch } = makeHooks();
    hooks.registerRecipePrograms([fwProgram, ghProgram]);

    hooks.handleFileSaved("id", "save", tsFile());
    await settle();
    let tasks = orch.list();
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.prompt).toContain("fw-recipe");
    expect(tasks[0]!.prompt).not.toContain("gh-recipe");

    await hooks.handleGitCommit({
      hash: "abc1234",
      branch: "main",
      message: "feat: x",
      count: 1,
      files: ["src/a.ts"],
    });
    await settle();
    tasks = orch.list();
    expect(tasks).toHaveLength(2);
    expect(tasks.some((t) => t.prompt.includes("gh-recipe"))).toBe(true);
  });

  it("is idempotent: re-registering the same set does not duplicate hooks", async () => {
    const { hooks, orch } = makeHooks();
    hooks.registerRecipePrograms([fwProgram]);
    hooks.registerRecipePrograms([fwProgram]); // simulate hot-reload

    hooks.handleFileSaved("id", "save", tsFile());
    await settle();
    expect(orch.list()).toHaveLength(1);
  });
});
