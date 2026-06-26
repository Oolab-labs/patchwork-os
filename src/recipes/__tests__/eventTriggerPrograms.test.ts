import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  collectEventTriggerPrograms,
  shouldAutoEnableAutomation,
} from "../eventTriggerPrograms.js";

// Minimal valid recipe YAML by trigger type. parseRecipe requires a kebab
// `name`, a `trigger`, and a non-empty `steps` array.
function recipeYaml(name: string, triggerBlock: string): string {
  return `name: ${name}
version: "1.0.0"
${triggerBlock}
steps:
  - id: s1
    tool: getGitStatus
    params: {}
`;
}

const FILE_WATCH = `trigger:
  type: file_watch
  patterns:
    - "**/*.ts"`;
const GIT_HOOK = `trigger:
  type: git_hook
  event: post-commit`;
const CRON = `trigger:
  type: cron
  schedule: "0 9 * * *"`;
const MANUAL = `trigger:
  type: manual`;

describe("collectEventTriggerPrograms", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), "pw-evt-triggers-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function write(file: string, content: string) {
    writeFileSync(path.join(dir, file), content, "utf-8");
  }

  it("collects only the compilable event triggers (file_watch + git_hook)", () => {
    write("fw-recipe.yaml", recipeYaml("fw-recipe", FILE_WATCH));
    write("gh-recipe.yaml", recipeYaml("gh-recipe", GIT_HOOK));
    write("cron-recipe.yaml", recipeYaml("cron-recipe", CRON));
    write("manual-recipe.yaml", recipeYaml("manual-recipe", MANUAL));

    const { programs, recipeNames } = collectEventTriggerPrograms(dir, {
      disabledRecipes: [],
    });

    expect(recipeNames.sort()).toEqual(["fw-recipe", "gh-recipe"]);
    expect(programs).toHaveLength(2);
  });

  it("resolves install-dir recipes via recipe.json main", () => {
    const inst = path.join(dir, "installed");
    mkdirSync(inst);
    writeFileSync(
      path.join(inst, "recipe.json"),
      JSON.stringify({ recipes: { main: "main.yaml" } }),
      "utf-8",
    );
    writeFileSync(
      path.join(inst, "main.yaml"),
      recipeYaml("installed-fw", FILE_WATCH),
      "utf-8",
    );

    const { recipeNames } = collectEventTriggerPrograms(dir, {
      disabledRecipes: [],
    });
    expect(recipeNames).toContain("installed-fw");
  });

  it("skips install dirs carrying a .disabled marker", () => {
    const inst = path.join(dir, "off");
    mkdirSync(inst);
    writeFileSync(path.join(inst, ".disabled"), "", "utf-8");
    writeFileSync(
      path.join(inst, "r.yaml"),
      recipeYaml("should-not-load", FILE_WATCH),
      "utf-8",
    );

    const { recipeNames } = collectEventTriggerPrograms(dir, {
      disabledRecipes: [],
    });
    expect(recipeNames).not.toContain("should-not-load");
  });

  it("excludes recipes named in the disabled set", () => {
    write("fw-recipe.yaml", recipeYaml("fw-recipe", FILE_WATCH));
    write("gh-recipe.yaml", recipeYaml("gh-recipe", GIT_HOOK));

    const { recipeNames } = collectEventTriggerPrograms(dir, {
      disabledRecipes: ["fw-recipe"],
    });
    expect(recipeNames).toEqual(["gh-recipe"]);
  });

  it("is fail-soft: a malformed recipe is skipped, others still collected", () => {
    write("fw-recipe.yaml", recipeYaml("fw-recipe", FILE_WATCH));
    // Empty steps → parseRecipe throws → must be skipped, not fatal.
    write(
      "broken.yaml",
      `name: broken-recipe\nversion: "1.0.0"\n${FILE_WATCH}\nsteps: []\n`,
    );
    write("not-a-recipe.yaml", "this: is: not: valid: yaml: : :");

    const { programs, recipeNames } = collectEventTriggerPrograms(dir, {
      disabledRecipes: [],
    });
    expect(recipeNames).toEqual(["fw-recipe"]);
    expect(programs).toHaveLength(1);
  });

  it("returns empty for a non-existent recipes dir (no throw)", () => {
    const result = collectEventTriggerPrograms(
      path.join(dir, "does-not-exist"),
      { disabledRecipes: [] },
    );
    expect(result.programs).toHaveLength(0);
    expect(result.recipeNames).toHaveLength(0);
  });
});

describe("shouldAutoEnableAutomation", () => {
  it("auto-enables when a driver is active and event recipes exist", () => {
    expect(
      shouldAutoEnableAutomation({
        automationEnabled: false,
        hasDriver: true,
        eventProgramCount: 2,
      }),
    ).toBe(true);
  });

  it("never auto-enables when automation is already explicitly enabled", () => {
    expect(
      shouldAutoEnableAutomation({
        automationEnabled: true,
        hasDriver: true,
        eventProgramCount: 2,
      }),
    ).toBe(false);
  });

  it("safety floor: never auto-enables without a driver", () => {
    expect(
      shouldAutoEnableAutomation({
        automationEnabled: false,
        hasDriver: false,
        eventProgramCount: 2,
      }),
    ).toBe(false);
  });

  it("does not auto-enable when no event-trigger recipe is installed", () => {
    expect(
      shouldAutoEnableAutomation({
        automationEnabled: false,
        hasDriver: true,
        eventProgramCount: 0,
      }),
    ).toBe(false);
  });
});
