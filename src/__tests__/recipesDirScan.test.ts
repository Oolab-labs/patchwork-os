/**
 * Every scanner of the recipes directory must agree on what a recipe entry is.
 *
 * - A directory whose name starts with "." (`.archive/`, `.install/`,
 *   `.audit/`, ...) is never an install dir. `archiveRecipe` moves a recipe
 *   into `.archive/`; a scanner that treats that directory as an install would
 *   keep scheduling (and listing) a recipe the operator archived.
 * - `promoteRecipeVariant`'s audit record is never a recipe. It used to be
 *   written as a top-level `<name>.promote-audit.json`, which every top-level
 *   scanner accepted as a JSON recipe.
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { listInstalledRecipes as listInstallDirs } from "../commands/recipeInstall.js";
import { collectEventTriggerPrograms } from "../recipes/eventTriggerPrograms.js";
import { RecipeScheduler } from "../recipes/scheduler.js";
import { listYamlRecipes } from "../recipes/yamlRunner.js";
import {
  archiveRecipe,
  listInstalledRecipes,
  promoteRecipeVariant,
} from "../recipesHttp.js";

// A non-empty disabled list bypasses listInstalledRecipes' per-dir cache and
// keeps the operator's real config out of the test.
const NO_CONFIG = { disabledRecipes: ["__none__"] };

function recipeYaml(name: string, trigger: string): string {
  return `name: ${name}
version: "1.0.0"
${trigger}
steps:
  - id: s1
    tool: getGitStatus
    params: {}
`;
}

const CRON = `trigger:
  type: cron
  schedule: "@every 1m"`;
const FILE_WATCH = `trigger:
  type: file_watch
  patterns:
    - "**/*.ts"`;
const MANUAL = `trigger:
  type: manual`;

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "pw-recipes-scan-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function startScheduler(): string[] {
  const scheduler = new RecipeScheduler({
    recipesDir: dir,
    enqueue: () => "tid",
    disabledRecipes: [],
  });
  const names = scheduler.start().map((s) => s.name);
  scheduler.stop();
  return names;
}

describe("archived recipes are invisible to every scanner", () => {
  it("scheduler does not schedule an archived cron recipe", () => {
    writeFileSync(
      path.join(dir, "noisy-recipe.yaml"),
      recipeYaml("noisy-recipe", CRON),
    );
    expect(startScheduler()).toEqual(["noisy-recipe"]);

    const archived = archiveRecipe(dir, "noisy-recipe");
    expect(archived.ok).toBe(true);
    expect(existsSync(path.join(dir, ".archive", "noisy-recipe.yaml"))).toBe(
      true,
    );

    expect(startScheduler()).toEqual([]);
  });

  it("event-trigger collection skips an archived recipe", () => {
    writeFileSync(
      path.join(dir, "noisy-recipe.yaml"),
      recipeYaml("noisy-recipe", FILE_WATCH),
    );
    expect(
      collectEventTriggerPrograms(dir, { disabledRecipes: [] }).recipeNames,
    ).toEqual(["noisy-recipe"]);

    expect(archiveRecipe(dir, "noisy-recipe").ok).toBe(true);

    expect(
      collectEventTriggerPrograms(dir, { disabledRecipes: [] }).recipeNames,
    ).toEqual([]);
  });

  it("install-dir listing does not report a dot-directory as an install", () => {
    mkdirSync(path.join(dir, "real-install"));
    writeFileSync(
      path.join(dir, "real-install", "main.yaml"),
      recipeYaml("real-install", MANUAL),
    );
    writeFileSync(
      path.join(dir, "noisy-recipe.yaml"),
      recipeYaml("noisy-recipe", MANUAL),
    );
    expect(archiveRecipe(dir, "noisy-recipe").ok).toBe(true);

    const names = listInstallDirs({ recipesDir: dir }).map((e) => e.name);
    expect(names).toEqual(["real-install"]);
  });

  it("HTTP listing does not report an archived recipe", () => {
    writeFileSync(
      path.join(dir, "noisy-recipe.yaml"),
      recipeYaml("noisy-recipe", MANUAL),
    );
    expect(archiveRecipe(dir, "noisy-recipe").ok).toBe(true);
    const names = listInstalledRecipes(dir, NO_CONFIG).recipes.map(
      (r) => r.name,
    );
    expect(names).toEqual([]);
  });
});

describe("the promote audit record is never read as a recipe", () => {
  async function promote(): Promise<void> {
    writeFileSync(
      path.join(dir, "noisy-recipe.yaml"),
      recipeYaml("noisy-recipe", MANUAL),
    );
    writeFileSync(
      path.join(dir, "noisy-recipe-v2.yaml"),
      recipeYaml("noisy-recipe-v2", MANUAL),
    );
    const res = await promoteRecipeVariant(
      dir,
      "noisy-recipe-v2",
      "noisy-recipe",
      { force: true },
    );
    expect(res.ok).toBe(true);
  }

  it("writes the audit record under .audit/, not beside the recipes", async () => {
    await promote();
    expect(
      readdirSync(dir).filter((f) => f.endsWith(".promote-audit.json")),
    ).toEqual([]);
    expect(
      existsSync(path.join(dir, ".audit", "noisy-recipe.promote-audit.json")),
    ).toBe(true);
  });

  it("HTTP listing contains only the promoted recipe", async () => {
    await promote();
    const names = listInstalledRecipes(dir, NO_CONFIG).recipes.map(
      (r) => r.name,
    );
    expect(names).toEqual(["noisy-recipe"]);
  });

  it("listYamlRecipes contains only the promoted recipe", async () => {
    await promote();
    expect(listYamlRecipes(dir).map((r) => r.name)).toEqual(["noisy-recipe"]);
  });

  it("a legacy top-level audit file is not listed as a recipe", () => {
    writeFileSync(
      path.join(dir, "noisy-recipe.yaml"),
      recipeYaml("noisy-recipe", MANUAL),
    );
    writeFileSync(
      path.join(dir, "noisy-recipe.promote-audit.json"),
      JSON.stringify({ action: "promote_overwrite" }),
    );
    expect(
      listInstalledRecipes(dir, NO_CONFIG).recipes.map((r) => r.name),
    ).toEqual(["noisy-recipe"]);
    expect(listYamlRecipes(dir).map((r) => r.name)).toEqual(["noisy-recipe"]);
  });
});
