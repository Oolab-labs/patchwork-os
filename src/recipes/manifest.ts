/**
 * RecipeManifest — recipe.json format for the Patchwork recipe marketplace.
 *
 * Each recipe package directory contains a recipe.json manifest describing
 * the package metadata, entry-point recipe file, child recipes, required
 * connectors, and configurable variables.
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

export interface RecipeManifest {
  name: string; // e.g. "@acme/morning-brief" or "morning-brief"
  version: string; // semver e.g. "1.0.0"
  description: string;
  author?: string;
  license?: string; // e.g. "MIT"
  tags?: string[]; // e.g. ["productivity", "morning", "gmail"]
  connectors?: string[]; // e.g. ["gmail", "slack", "linear"]
  recipes: {
    main: string; // filename of the entry-point recipe e.g. "morning-brief.yaml"
    children?: string[]; // filenames of child recipes e.g. ["followup-child.yaml"]
  };
  variables?: Record<
    string,
    {
      description: string;
      required?: boolean;
      default?: string;
    }
  >;
  homepage?: string; // GitHub URL
  repository?: string; // git URL
}

const NAME_RE = /^(@[a-z0-9-]+\/)?[a-z0-9][a-z0-9\-_.]*$/;
const VERSION_RE = /^\d+\.\d+\.\d+/;
const YAML_EXT_RE = /\.ya?ml$/;

/**
 * Recipe filenames in the manifest must be plain basenames, not paths.
 * Rejects "../escape.yaml", "subdir/foo.yaml", "/etc/passwd.yaml", control
 * characters, and so on — anything that could resolve outside the install
 * directory when the consumer does `path.join(installDir, recipes.main)`.
 */
function isSafeRecipeBasename(filename: unknown): filename is string {
  if (typeof filename !== "string" || filename.length === 0) return false;
  if (filename === "." || filename === "..") return false;
  if (filename.includes("/") || filename.includes("\\")) return false;
  // biome-ignore lint/suspicious/noControlCharactersInRegex: explicit control-char check
  if (/[\x00-\x1F\x7F]/.test(filename)) return false;
  return YAML_EXT_RE.test(filename);
}

/**
 * Validate an unknown value as a RecipeManifest.
 * Throws a descriptive Error if any required field is missing or invalid.
 */
export function validateManifest(manifest: unknown): RecipeManifest {
  if (typeof manifest !== "object" || manifest === null) {
    throw new Error("recipe.json must be a JSON object");
  }

  const m = manifest as Record<string, unknown>;

  // name
  if (typeof m.name !== "string" || !m.name) {
    throw new Error('recipe.json: "name" is required and must be a string');
  }
  if (!NAME_RE.test(m.name)) {
    throw new Error(
      `recipe.json: "name" must match pattern (@scope/)?[a-z0-9][a-z0-9-_.]*  — got "${m.name}"`,
    );
  }

  // version
  if (typeof m.version !== "string" || !m.version) {
    throw new Error('recipe.json: "version" is required and must be a string');
  }
  if (!VERSION_RE.test(m.version)) {
    throw new Error(
      `recipe.json: "version" must be valid semver (e.g. "1.0.0") — got "${m.version}"`,
    );
  }

  // description
  if (typeof m.description !== "string" || !m.description) {
    throw new Error(
      'recipe.json: "description" is required and must be a non-empty string',
    );
  }

  // recipes
  if (typeof m.recipes !== "object" || m.recipes === null) {
    throw new Error('recipe.json: "recipes" is required and must be an object');
  }
  const recipes = m.recipes as Record<string, unknown>;

  if (!isSafeRecipeBasename(recipes.main)) {
    throw new Error(
      `recipe.json: "recipes.main" must be a .yaml or .yml basename without path separators or control characters — got "${recipes.main}"`,
    );
  }

  if (recipes.children !== undefined) {
    if (!Array.isArray(recipes.children)) {
      throw new Error('recipe.json: "recipes.children" must be an array');
    }
    for (let i = 0; i < recipes.children.length; i++) {
      if (!isSafeRecipeBasename(recipes.children[i])) {
        throw new Error(
          `recipe.json: "recipes.children[${i}]" must be a .yaml or .yml basename without path separators or control characters — got "${recipes.children[i]}"`,
        );
      }
    }
  }

  // optional string fields
  for (const field of [
    "author",
    "license",
    "homepage",
    "repository",
  ] as const) {
    if (m[field] !== undefined && typeof m[field] !== "string") {
      throw new Error(`recipe.json: "${field}" must be a string`);
    }
  }

  // optional string[] fields
  for (const field of ["tags", "connectors"] as const) {
    if (m[field] !== undefined) {
      if (!Array.isArray(m[field])) {
        throw new Error(`recipe.json: "${field}" must be an array of strings`);
      }
      for (let i = 0; i < (m[field] as unknown[]).length; i++) {
        if (typeof (m[field] as unknown[])[i] !== "string") {
          throw new Error(`recipe.json: "${field}[${i}]" must be a string`);
        }
      }
    }
  }

  // variables
  if (m.variables !== undefined) {
    if (typeof m.variables !== "object" || m.variables === null) {
      throw new Error('recipe.json: "variables" must be an object');
    }
    for (const [key, val] of Object.entries(
      m.variables as Record<string, unknown>,
    )) {
      if (typeof val !== "object" || val === null) {
        throw new Error(
          `recipe.json: "variables.${key}" must be an object with a "description" field`,
        );
      }
      const v = val as Record<string, unknown>;
      if (typeof v.description !== "string" || !v.description) {
        throw new Error(
          `recipe.json: "variables.${key}.description" is required and must be a non-empty string`,
        );
      }
      if (v.required !== undefined && typeof v.required !== "boolean") {
        throw new Error(
          `recipe.json: "variables.${key}.required" must be a boolean`,
        );
      }
      if (v.default !== undefined && typeof v.default !== "string") {
        throw new Error(
          `recipe.json: "variables.${key}.default" must be a string`,
        );
      }
    }
  }

  return m as unknown as RecipeManifest;
}

/**
 * Parse and validate a recipe.json string.
 * Throws with a clear error message if invalid JSON or schema violations.
 */
export function parseManifest(json: string): RecipeManifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (err) {
    throw new Error(
      `recipe.json: invalid JSON — ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return validateManifest(parsed);
}

/**
 * Load and parse recipe.json from a directory.
 * Returns null if the file does not exist (not a recipe package dir).
 * Throws if file exists but is invalid.
 */
export function loadManifestFromDir(dir: string): RecipeManifest | null {
  const manifestPath = path.join(dir, "recipe.json");
  if (!existsSync(manifestPath)) {
    return null;
  }
  const raw = readFileSync(manifestPath, "utf-8");
  return parseManifest(raw);
}

/**
 * Returns all recipe filenames declared in the manifest: [main, ...children].
 */
export function getManifestRecipeFiles(manifest: RecipeManifest): string[] {
  return [manifest.recipes.main, ...(manifest.recipes.children ?? [])];
}
