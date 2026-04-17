import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import type { CompiledRecipe } from "./compiler.js";
import { compileRecipeFull } from "./compiler.js";
import { parseRecipe } from "./parser.js";

/**
 * Recipe installer — loads a recipe file, validates, compiles, and copies it
 * into ~/.patchwork/recipes/ so the bridge picks it up at next restart.
 *
 * Phase-2 scope: JSON only. YAML lands when the `yaml` dep is added.
 * The on-disk schema is unchanged either way — compile is source-format agnostic.
 */

export interface InstallOptions {
  recipesDir: string;
  force?: boolean;
  fs?: {
    readFile?: (p: string) => string;
    writeFile?: (p: string, content: string) => void;
    copyFile?: (src: string, dest: string) => void;
    mkdir?: (p: string) => void;
  };
}

export interface InstallResult {
  compiled: CompiledRecipe;
  installedPath: string;
  action: "created" | "replaced";
  permissionsJson: string;
}

export function installRecipeFromFile(
  sourcePath: string,
  opts: InstallOptions,
): InstallResult {
  const ext = path.extname(sourcePath).toLowerCase();
  if (ext !== ".json" && ext !== ".yaml" && ext !== ".yml") {
    throw new Error(
      `Unsupported recipe format '${ext || "<none>"}' for ${sourcePath}. Expected .json, .yaml, or .yml.`,
    );
  }

  const fs = opts.fs ?? {};
  const readFile = fs.readFile ?? ((p: string) => readFileSync(p, "utf-8"));
  const writeFile =
    fs.writeFile ?? ((p: string, c: string) => writeFileSync(p, c));
  const mkdir = fs.mkdir ?? ((p: string) => mkdirSync(p, { recursive: true }));

  const text = readFile(sourcePath);
  const raw =
    ext === ".json"
      ? (JSON.parse(text) as unknown)
      : (parseYaml(text) as unknown);
  const recipe = parseRecipe(raw);
  // Manual-trigger recipes run via `patchwork recipe run <name>` and bypass
  // the automation interpreter, so the compile step (which targets the
  // interpreter DSL) doesn't apply. Skip compile and synthesize an empty
  // CompiledRecipe stub so the caller API stays uniform.
  // Manual + cron triggers bypass the automation interpreter (they run via
  // `patchwork recipe run <name>` and the RecipeScheduler respectively),
  // so the compile step doesn't apply. Synthesize an empty CompiledRecipe
  // stub so the caller API stays uniform.
  const compiled: CompiledRecipe =
    recipe.trigger.type === "manual" || recipe.trigger.type === "cron"
      ? {
          program: {
            tag: "Sequence",
            steps: [],
          } as unknown as CompiledRecipe["program"],
          suggestedPermissions: { allow: [], ask: [], deny: [] },
        }
      : compileRecipeFull(recipe);

  mkdir(opts.recipesDir);
  const destPath = path.join(opts.recipesDir, `${recipe.name}.json`);
  let action: "created" | "replaced" = "created";
  try {
    readFile(destPath);
    action = "replaced";
  } catch {
    // file doesn't exist — creating
  }
  writeFile(destPath, JSON.stringify(recipe, null, 2));

  // Write permissions suggestion alongside for user review.
  const permsPath = `${destPath}.permissions.json`;
  const permissionsJson = JSON.stringify(
    { permissions: compiled.suggestedPermissions },
    null,
    2,
  );
  writeFile(permsPath, permissionsJson);

  return {
    compiled,
    installedPath: destPath,
    action,
    permissionsJson,
  };
}
