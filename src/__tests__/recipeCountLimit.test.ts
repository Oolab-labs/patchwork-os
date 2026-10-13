/**
 * Operator recipe limit — PATCHWORK_MAX_RECIPES.
 *
 * The variable used to be accepted and read by nothing. Now every path that
 * can ADD a recipe (dashboard create, PUT of a new name, duplicate, HTTP and
 * CLI install) refuses once the installed top-level count would exceed it.
 * Updating a recipe that already exists is always allowed, and so is a
 * promote (it replaces a variant, so the count does not grow).
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runRecipeInstall } from "../commands/recipeInstall.js";
import { installRecipeFromFile } from "../recipes/installer.js";
import {
  maxRecipesFromEnv,
  RECIPE_LIMIT_REACHED,
  RecipeLimitError,
  recipeLimitMessage,
} from "../recipes/runLimits.js";
import {
  countInstalledRecipes,
  duplicateRecipe,
  invalidateRecipesCache,
  promoteRecipeVariant,
  saveRecipe,
  saveRecipeContent,
} from "../recipesHttp.js";

const yamlFor = (name: string) => `name: ${name}
trigger:
  type: manual
steps:
  - id: s1
    agent:
      prompt: "hello"
      into: out
`;

let recipesDir = "";
let scratch = "";

beforeEach(() => {
  recipesDir = mkdtempSync(path.join(os.tmpdir(), "pw-recipe-limit-"));
  scratch = mkdtempSync(path.join(os.tmpdir(), "pw-recipe-limit-src-"));
  vi.stubEnv("PATCHWORK_HOME", scratch);
  invalidateRecipesCache();
});

afterEach(() => {
  vi.unstubAllEnvs();
  invalidateRecipesCache();
  for (const d of [recipesDir, scratch]) {
    if (d && existsSync(d)) rmSync(d, { recursive: true, force: true });
  }
});

function seed(...names: string[]) {
  for (const n of names) {
    writeFileSync(path.join(recipesDir, `${n}.yaml`), yamlFor(n));
  }
}

describe("maxRecipesFromEnv", () => {
  it("absent / 0 / invalid means unlimited", () => {
    expect(maxRecipesFromEnv({})).toBeNull();
    expect(maxRecipesFromEnv({ PATCHWORK_MAX_RECIPES: "0" })).toBeNull();
    expect(maxRecipesFromEnv({ PATCHWORK_MAX_RECIPES: "many" })).toBeNull();
    expect(maxRecipesFromEnv({ PATCHWORK_MAX_RECIPES: "5" })).toBe(5);
  });
});

describe("countInstalledRecipes", () => {
  it("counts top-level recipe files and install dirs, not sidecars or reserved dirs", () => {
    seed("alpha", "beta");
    writeFileSync(path.join(recipesDir, "alpha.yaml.permissions.json"), "{}");
    mkdirSync(path.join(recipesDir, ".archive"));
    writeFileSync(
      path.join(recipesDir, ".archive", "old.yaml"),
      yamlFor("old"),
    );
    const pkg = path.join(recipesDir, "pkg");
    mkdirSync(pkg);
    writeFileSync(path.join(pkg, "main.yaml"), yamlFor("pkg"));
    writeFileSync(path.join(pkg, "child.yaml"), yamlFor("pkg-child"));
    expect(countInstalledRecipes(recipesDir)).toBe(3);
  });

  it("is 0 for a missing directory", () => {
    expect(countInstalledRecipes(path.join(recipesDir, "nope"))).toBe(0);
  });
});

describe("PUT content (saveRecipeContent)", () => {
  it("with no limit set, adding recipes is unchanged", () => {
    seed("a", "b", "c");
    expect(saveRecipeContent(recipesDir, "d", yamlFor("d")).ok).toBe(true);
  });

  it("refuses a NEW name once the limit is reached", () => {
    vi.stubEnv("PATCHWORK_MAX_RECIPES", "2");
    seed("a", "b");
    const r = saveRecipeContent(recipesDir, "c", yamlFor("c"));
    expect(r).toMatchObject({
      ok: false,
      error: RECIPE_LIMIT_REACHED,
      message: recipeLimitMessage(2),
    });
    expect(existsSync(path.join(recipesDir, "c.yaml"))).toBe(false);
  });

  it("allows a new name below the limit", () => {
    vi.stubEnv("PATCHWORK_MAX_RECIPES", "2");
    seed("a");
    expect(saveRecipeContent(recipesDir, "b", yamlFor("b")).ok).toBe(true);
  });

  it("always allows updating an existing recipe at the limit", () => {
    vi.stubEnv("PATCHWORK_MAX_RECIPES", "2");
    seed("a", "b");
    expect(saveRecipeContent(recipesDir, "b", yamlFor("b")).ok).toBe(true);
  });
});

describe("dashboard create (saveRecipe)", () => {
  const draft = {
    name: "fresh",
    description: "x",
    trigger: { type: "manual" },
    steps: [{ id: "s1", agent: true, prompt: "hi" }],
  } as never;

  it("refuses a new recipe at the limit", () => {
    vi.stubEnv("PATCHWORK_MAX_RECIPES", "1");
    seed("a");
    expect(saveRecipe(recipesDir, draft)).toMatchObject({
      ok: false,
      error: RECIPE_LIMIT_REACHED,
    });
    expect(existsSync(path.join(recipesDir, "fresh.json"))).toBe(false);
  });

  it("allows the same recipe below the limit", () => {
    vi.stubEnv("PATCHWORK_MAX_RECIPES", "2");
    seed("a");
    expect(saveRecipe(recipesDir, draft).ok).toBe(true);
  });
});

describe("duplicate and promote", () => {
  it("duplicate is refused at the limit", () => {
    vi.stubEnv("PATCHWORK_MAX_RECIPES", "1");
    seed("a");
    expect(duplicateRecipe(recipesDir, "a")).toMatchObject({
      ok: false,
      error: RECIPE_LIMIT_REACHED,
    });
  });

  it("promote is allowed at the limit (it replaces the variant)", async () => {
    vi.stubEnv("PATCHWORK_MAX_RECIPES", "2");
    seed("a", "a-v2");
    const r = await promoteRecipeVariant(recipesDir, "a-v2", "brand-new");
    expect(r.ok).toBe(true);
    expect(countInstalledRecipes(recipesDir)).toBe(2);
  });
});

describe("install paths", () => {
  it("single-file install (HTTP install / CLI .json) refuses a new recipe at the limit", () => {
    vi.stubEnv("PATCHWORK_MAX_RECIPES", "1");
    seed("a");
    const src = path.join(scratch, "incoming.yaml");
    writeFileSync(src, yamlFor("incoming"));
    let caught: unknown;
    try {
      installRecipeFromFile(src, { recipesDir });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(RecipeLimitError);
    expect((caught as RecipeLimitError).code).toBe(RECIPE_LIMIT_REACHED);
    expect(existsSync(path.join(recipesDir, "incoming.json"))).toBe(false);
  });

  it("single-file install may replace an already-installed recipe at the limit", () => {
    vi.stubEnv("PATCHWORK_MAX_RECIPES", "1");
    const src = path.join(scratch, "incoming.yaml");
    writeFileSync(src, yamlFor("incoming"));
    installRecipeFromFile(src, { recipesDir });
    const again = installRecipeFromFile(src, { recipesDir });
    expect(again.action).toBe("replaced");
  });

  function writePackage(name: string): string {
    const dir = mkdtempSync(path.join(scratch, "pkg-"));
    writeFileSync(path.join(dir, "main.yaml"), yamlFor(name));
    writeFileSync(
      path.join(dir, "recipe.json"),
      JSON.stringify({
        name,
        version: "1.0.0",
        description: "x",
        recipes: { main: "main.yaml" },
      }),
    );
    return dir;
  }

  it("CLI package install refuses a new package at the limit, allows a reinstall", async () => {
    vi.stubEnv("PATCHWORK_MAX_RECIPES", "1");
    const first = writePackage("pkg-one");
    await runRecipeInstall(first, { recipesDir });
    await expect(
      runRecipeInstall(writePackage("pkg-two"), { recipesDir }),
    ).rejects.toBeInstanceOf(RecipeLimitError);
    expect(existsSync(path.join(recipesDir, "pkg-two"))).toBe(false);
    await expect(
      runRecipeInstall(writePackage("pkg-one"), { recipesDir }),
    ).resolves.toMatchObject({ name: "pkg-one" });
  });
});
