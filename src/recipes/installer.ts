import crypto from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import type { CompiledRecipe } from "./compiler.js";
import { compileRecipeFull } from "./compiler.js";
import { parseRecipe } from "./parser.js";

/**
 * Atomic temp+rename for the default install write. Audit 2026-05-17:
 * two concurrent installs of the same recipe (cross-process, e.g.
 * dashboard + CLI racing) used to interleave bytes within the JSON
 * payload because the previous `writeFileSync(destPath, ...)` is not
 * atomic for sub-page writes. A torn JSON file fails to parse and the
 * recipe becomes invisible to the scheduler.
 *
 * `rename` is atomic at the FS layer on every platform we ship on
 * (apfs / ext4 / ntfs / xfs). With temp+rename, two concurrent writers
 * each end up with their own intact file → last `rename` wins, but
 * the file on disk is ALWAYS a valid JSON document.
 */
function atomicWriteSync(target: string, content: string): void {
  const tmp = `${target}.tmp.${process.pid}.${crypto
    .randomBytes(6)
    .toString("hex")}`;
  try {
    writeFileSync(tmp, content);
    renameSync(tmp, target);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      /* already gone or never created */
    }
    throw err;
  }
}

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
  // Default writer is atomic (temp+rename). Callers may inject their
  // own writeFile (tests, in-memory fs); they are responsible for
  // their own atomicity guarantees.
  const writeFile = fs.writeFile ?? atomicWriteSync;
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
  // Manual, cron, and webhook triggers bypass the automation interpreter —
  // they fire via the CLI, RecipeScheduler, and POST /hooks/* endpoint
  // respectively. Synthesize an empty CompiledRecipe stub so the caller API
  // stays uniform; file_watch and git_hook still run through compile.
  const bypassCompile =
    recipe.trigger.type === "manual" ||
    recipe.trigger.type === "cron" ||
    recipe.trigger.type === "webhook";
  const compiled: CompiledRecipe = bypassCompile
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
  // Belt-and-braces: parseRecipe already constrains `name` to the
  // RECIPE_NAME_RE charset, but assert the resolved path stays inside
  // recipesDir before writing. Defends against any future parser bypass
  // and against callers reaching this function with a pre-parsed object
  // that skipped parseRecipe.
  const resolvedDir = path.resolve(opts.recipesDir);
  const resolvedDest = path.resolve(destPath);
  if (
    resolvedDest !== resolvedDir &&
    !resolvedDest.startsWith(resolvedDir + path.sep)
  ) {
    throw new Error(
      `installRecipeFromFile: refusing to write outside recipesDir (dest=${resolvedDest} dir=${resolvedDir})`,
    );
  }
  let action: "created" | "replaced" = "created";
  try {
    readFile(destPath);
    action = "replaced";
  } catch {
    // file doesn't exist — creating
  }
  writeFile(destPath, JSON.stringify(recipe, null, 2));

  // Permissions sidecar (`<name>.permissions.json`) was decorative — never read by toolRegistry.
  // Removed in alpha.36 per recipe-dogfood-2026-05-01/PLAN-MASTER-V2.md A-PR4.
  // Canonical permissions location: ~/.claude/settings.json.
  const permissionsJson = JSON.stringify(
    { permissions: compiled.suggestedPermissions },
    null,
    2,
  );

  return {
    compiled,
    installedPath: destPath,
    action,
    permissionsJson,
  };
}
