/**
 * patchwork recipe install — download and install a recipe package.
 * patchwork recipe list   — list installed recipe packages.
 *
 * Supports:
 *   github:owner/repo
 *   github:owner/repo/subdir
 *   https://github.com/owner/repo
 *   ./local/path
 */

import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import {
  getManifestRecipeFiles,
  loadManifestFromDir,
  parseManifest,
  type RecipeManifest,
} from "../recipes/manifest.js";

export const INSTALL_RECIPES_DIR = path.join(
  os.homedir(),
  ".patchwork",
  "recipes",
);

/**
 * Marker file written into a recipe install dir to mark it as disabled.
 * Absence = enabled (the default for legacy installs predating this marker).
 * `runRecipeInstall` writes one on every fresh install so new recipes start
 * disabled per the wave2 plan's safety story; user runs `patchwork recipe
 * enable <name>` to remove it.
 */
const DISABLED_MARKER = ".disabled";

// ============================================================================
// Source parsing
// ============================================================================

export type InstallSourceType = "github" | "local";

export interface GitHubInstallSource {
  type: "github";
  owner: string;
  repo: string;
  subdir?: string;
  ref?: string; // branch/tag/sha — defaults to "main"
}

export interface LocalInstallSource {
  type: "local";
  path: string;
}

export type InstallSource = GitHubInstallSource | LocalInstallSource;

/**
 * Parse a user-supplied source string into a typed InstallSource.
 *
 * Supported forms:
 *   github:owner/repo
 *   github:owner/repo@<ref>           — pin to branch, tag, or commit SHA
 *   github:owner/repo/subdir
 *   github:owner/repo/subdir@<ref>
 *   gh:owner/repo[@<ref>]             — short alias for github:
 *   https://github.com/owner/repo
 *   https://github.com/owner/repo/tree/<ref>/subdir   — ref captured from URL
 *   ./relative/path
 *   /absolute/path
 *
 * `@<ref>` accepts any value that's valid as a git ref (branch, tag, SHA).
 * Empty ref (`...@`) is rejected.
 */
export function parseInstallSource(source: string): InstallSource {
  // Local path: starts with . or /
  if (
    source.startsWith("./") ||
    source.startsWith("/") ||
    source.startsWith("../")
  ) {
    return { type: "local", path: source };
  }

  // github:/gh: prefix
  if (source.startsWith("github:")) {
    return parseGithubShorthand(source.slice("github:".length));
  }
  if (source.startsWith("gh:")) {
    return parseGithubShorthand(source.slice("gh:".length));
  }

  // Full GitHub URL — captures owner, repo, optional ref (tree/<ref>), optional subdir
  const githubUrlMatch = source.match(
    /^https?:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?(?:\/tree\/([^/]+)(?:\/(.+))?)?\/?$/,
  );
  if (githubUrlMatch) {
    const [, owner, repo, ref, subdir] = githubUrlMatch;
    if (!owner || !repo) {
      throw new Error(`Invalid GitHub URL: ${source}`);
    }
    return {
      type: "github",
      owner,
      repo,
      ...(subdir ? { subdir } : {}),
      ...(ref ? { ref } : {}),
    };
  }

  throw new Error(
    `Unrecognized install source: "${source}"\n` +
      `Supported: github:owner/repo[@ref], github:owner/repo/subdir[@ref], gh:owner/repo[@ref], https://github.com/owner/repo, ./local/path`,
  );
}

function parseGithubShorthand(shorthand: string): GitHubInstallSource {
  // Extract trailing @<ref> if present. The ref is opaque to us — git accepts
  // branches, tags, and commit SHAs in the same slot, and the GitHub API
  // (which is what we ultimately call with this value) does too.
  let ref: string | undefined;
  const atIdx = shorthand.lastIndexOf("@");
  if (atIdx !== -1) {
    ref = shorthand.slice(atIdx + 1);
    shorthand = shorthand.slice(0, atIdx);
    if (!ref) {
      throw new Error(
        `Invalid github shorthand: empty ref after "@" in "${shorthand}@"`,
      );
    }
  }

  // owner/repo or owner/repo/subdir (may have multiple path segments)
  const parts = shorthand.split("/");
  if (parts.length < 2) {
    throw new Error(
      `Invalid github shorthand "${shorthand}": expected "owner/repo" or "owner/repo/subdir"`,
    );
  }
  const [owner, repo, ...subdirParts] = parts;
  if (!owner || !repo) {
    throw new Error(`Invalid github shorthand: "${shorthand}"`);
  }
  return {
    type: "github",
    owner,
    repo,
    ...(subdirParts.length > 0 ? { subdir: subdirParts.join("/") } : {}),
    ...(ref ? { ref } : {}),
  };
}

// ============================================================================
// Install name determination
// ============================================================================

/**
 * Determine the install directory name from the manifest or source.
 * - Manifest present: strip leading @ and replace / with -- for filesystem safety.
 * - GitHub source (no manifest): "owner/repo" or "owner/repo/subdir".
 * - Local source (no manifest): basename of the directory.
 */
export function determineInstallName(
  manifest: RecipeManifest | null,
  source: InstallSource,
): string {
  if (manifest) {
    // Strip leading @ and replace "/" with "--" so it's a valid directory name
    return manifest.name.replace(/^@/, "").replace(/\//g, "--");
  }

  if (source.type === "github") {
    const base = `${source.owner}/${source.repo}`;
    return source.subdir ? `${base}/${source.subdir}` : base;
  }

  return path.basename(path.resolve(source.path));
}

// ============================================================================
// GitHub file fetching via API
// ============================================================================

async function httpsGet(url: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      {
        headers: {
          "User-Agent": "patchwork-recipe-installer/1.0",
          Accept: "application/vnd.github.v3+json",
        },
      },
      (res) => {
        // Follow redirects
        if (
          res.statusCode &&
          res.statusCode >= 300 &&
          res.statusCode < 400 &&
          res.headers.location
        ) {
          httpsGet(res.headers.location).then(resolve).catch(reject);
          return;
        }

        if (res.statusCode && res.statusCode >= 400) {
          reject(new Error(`HTTP ${res.statusCode} fetching ${url}`));
          return;
        }

        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => resolve(Buffer.concat(chunks)));
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    req.end();
  });
}

interface GitHubContentItem {
  name: string;
  path: string;
  type: "file" | "dir";
  download_url: string | null;
}

async function listGitHubContents(
  owner: string,
  repo: string,
  dirPath: string,
  ref: string,
): Promise<GitHubContentItem[]> {
  const url = `https://api.github.com/repos/${owner}/${repo}/contents/${dirPath}?ref=${ref}`;
  const body = await httpsGet(url);
  const parsed = JSON.parse(body.toString("utf-8")) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error(
      `Expected array from GitHub contents API, got: ${typeof parsed}`,
    );
  }
  return parsed as GitHubContentItem[];
}

async function fetchGitHubFile(downloadUrl: string): Promise<Buffer> {
  return httpsGet(downloadUrl);
}

/**
 * Download all .yaml/.yml files (and recipe.json if present) from a GitHub
 * directory into `destDir`. Returns list of filenames written.
 */
async function downloadGitHubDir(
  owner: string,
  repo: string,
  dirPath: string,
  ref: string,
  destDir: string,
): Promise<string[]> {
  const items = await listGitHubContents(owner, repo, dirPath, ref);
  const written: string[] = [];

  for (const item of items) {
    if (item.type !== "file") continue;
    if (item.name !== "recipe.json" && !/\.ya?ml$/i.test(item.name)) {
      continue;
    }
    if (!item.download_url) continue;

    const content = await fetchGitHubFile(item.download_url);
    const destPath = path.join(destDir, item.name);
    writeFileSync(destPath, content);
    written.push(item.name);
  }

  return written;
}

// ============================================================================
// Core install logic
// ============================================================================

export interface InstallResult {
  name: string;
  version?: string;
  installDir: string;
  filesInstalled: string[];
  manifest: RecipeManifest | null;
}

/**
 * Install a recipe package from a source into INSTALL_RECIPES_DIR.
 * Returns metadata about what was installed.
 */
export async function runRecipeInstall(
  rawSource: string,
  options: { recipesDir?: string } = {},
): Promise<InstallResult> {
  const source = parseInstallSource(rawSource);
  const recipesDir = options.recipesDir ?? INSTALL_RECIPES_DIR;

  // Stage into temp dir first
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), "patchwork-recipe-"));

  try {
    if (source.type === "local") {
      await stageLocalSource(source, tmpDir);
    } else {
      await stageGitHubSource(source, tmpDir);
    }

    // Read manifest if present
    let manifest: RecipeManifest | null = null;
    const manifestPath = path.join(tmpDir, "recipe.json");
    if (existsSync(manifestPath)) {
      manifest = parseManifest(readFileSync(manifestPath, "utf-8"));
    }

    // Determine which files to copy
    let filesToCopy: string[];
    if (manifest) {
      const declared = getManifestRecipeFiles(manifest);
      // Include recipe.json + declared recipe files (that exist in tmpDir)
      filesToCopy = ["recipe.json", ...declared].filter((f) =>
        existsSync(path.join(tmpDir, f)),
      );
    } else {
      // No manifest: take all .yaml/.yml files
      filesToCopy = readdirSync(tmpDir).filter((f) => /\.ya?ml$/i.test(f));
    }

    if (filesToCopy.length === 0) {
      throw new Error(
        `No recipe files found in source "${rawSource}". ` +
          `Expected .yaml/.yml files or a recipe.json manifest.`,
      );
    }

    const installName = determineInstallName(manifest, source);
    const installDir = path.join(recipesDir, installName);

    if (!existsSync(installDir)) {
      mkdirSync(installDir, { recursive: true });
    }

    // Copy files
    for (const file of filesToCopy) {
      const src = path.join(tmpDir, file);
      const dest = path.join(installDir, file);
      // Ensure subdirs exist (recipe.json could declare children in subdirs)
      const destParent = path.dirname(dest);
      if (!existsSync(destParent)) {
        mkdirSync(destParent, { recursive: true });
      }
      cpSync(src, dest);
    }

    // New installs start disabled — user must run `recipe enable <name>`
    // before scheduled triggers (cron/file-watch) take effect. Manual
    // `recipe run <name>` still works regardless, since that's an explicit
    // user invocation.
    writeFileSync(path.join(installDir, DISABLED_MARKER), "");

    return {
      name: installName,
      version: manifest?.version,
      installDir,
      filesInstalled: filesToCopy,
      manifest,
    };
  } finally {
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  }
}

async function stageLocalSource(
  source: LocalInstallSource,
  tmpDir: string,
): Promise<void> {
  const resolvedPath = path.resolve(source.path);
  if (!existsSync(resolvedPath)) {
    throw new Error(`Local path does not exist: ${resolvedPath}`);
  }
  if (!statSync(resolvedPath).isDirectory()) {
    throw new Error(`Local path is not a directory: ${resolvedPath}`);
  }
  cpSync(resolvedPath, tmpDir, { recursive: true });
}

async function stageGitHubSource(
  source: GitHubInstallSource,
  tmpDir: string,
): Promise<void> {
  const ref = source.ref ?? "main";
  const dirPath = source.subdir ?? "";

  try {
    await downloadGitHubDir(source.owner, source.repo, dirPath, ref, tmpDir);
  } catch (err) {
    // If main branch fails, try master
    if (ref === "main") {
      try {
        await downloadGitHubDir(
          source.owner,
          source.repo,
          dirPath,
          "master",
          tmpDir,
        );
        return;
      } catch {
        // fall through to original error
      }
    }
    throw err;
  }
}

// ============================================================================
// patchwork recipe list
// ============================================================================

export interface InstalledRecipeEntry {
  name: string;
  version?: string;
  description?: string;
  connectors?: string[];
  mainRecipe?: string;
  yamlFiles?: string[];
  hasManifest: boolean;
  enabled: boolean;
}

/**
 * Returns true if the install dir does not contain the disabled marker.
 * Recipes installed before this marker existed have no marker and are
 * therefore considered enabled — preserves backwards compatibility.
 */
export function isRecipeEnabled(installDir: string): boolean {
  return !existsSync(path.join(installDir, DISABLED_MARKER));
}

/**
 * Locate an installed recipe directory by name. Returns null if not found.
 */
function findInstalledRecipeDir(
  name: string,
  recipesDir: string,
): string | null {
  const direct = path.join(recipesDir, name);
  if (existsSync(direct) && statSync(direct).isDirectory()) {
    return direct;
  }
  return null;
}

/**
 * Enable a recipe — removes the .disabled marker so triggers can fire.
 * Idempotent: enabling an already-enabled recipe is a no-op.
 */
export function runRecipeEnable(
  name: string,
  options: { recipesDir?: string } = {},
): { name: string; installDir: string; alreadyEnabled: boolean } {
  const recipesDir = options.recipesDir ?? INSTALL_RECIPES_DIR;
  const installDir = findInstalledRecipeDir(name, recipesDir);
  if (!installDir) {
    throw new Error(
      `No installed recipe named "${name}". Run \`patchwork recipe list\` to see installed recipes.`,
    );
  }
  const markerPath = path.join(installDir, DISABLED_MARKER);
  if (!existsSync(markerPath)) {
    return { name, installDir, alreadyEnabled: true };
  }
  unlinkSync(markerPath);
  return { name, installDir, alreadyEnabled: false };
}

/**
 * Disable a recipe — writes the .disabled marker so triggers stop firing.
 * Idempotent: disabling an already-disabled recipe is a no-op.
 */
export function runRecipeDisable(
  name: string,
  options: { recipesDir?: string } = {},
): { name: string; installDir: string; alreadyDisabled: boolean } {
  const recipesDir = options.recipesDir ?? INSTALL_RECIPES_DIR;
  const installDir = findInstalledRecipeDir(name, recipesDir);
  if (!installDir) {
    throw new Error(
      `No installed recipe named "${name}". Run \`patchwork recipe list\` to see installed recipes.`,
    );
  }
  const markerPath = path.join(installDir, DISABLED_MARKER);
  if (existsSync(markerPath)) {
    return { name, installDir, alreadyDisabled: true };
  }
  writeFileSync(markerPath, "");
  return { name, installDir, alreadyDisabled: false };
}

export function listInstalledRecipes(
  options: { recipesDir?: string } = {},
): InstalledRecipeEntry[] {
  const recipesDir = options.recipesDir ?? INSTALL_RECIPES_DIR;

  if (!existsSync(recipesDir)) {
    return [];
  }

  const entries: InstalledRecipeEntry[] = [];

  function scanDir(dir: string, namePrefix: string): void {
    const items = readdirSync(dir);
    for (const item of items) {
      const itemPath = path.join(dir, item);
      if (!statSync(itemPath).isDirectory()) continue;

      const entryName = namePrefix ? `${namePrefix}/${item}` : item;
      const manifest = loadManifestFromDir(itemPath);

      if (manifest) {
        entries.push({
          name: entryName,
          version: manifest.version,
          description: manifest.description,
          connectors: manifest.connectors,
          mainRecipe: manifest.recipes.main,
          hasManifest: true,
          enabled: isRecipeEnabled(itemPath),
        });
      } else {
        const yamlFiles = readdirSync(itemPath).filter((f) =>
          /\.ya?ml$/i.test(f),
        );
        if (yamlFiles.length > 0) {
          entries.push({
            name: entryName,
            yamlFiles,
            hasManifest: false,
            enabled: isRecipeEnabled(itemPath),
          });
        } else {
          // Recurse one level for namespaced dirs like "owner/repo"
          if (!namePrefix) {
            scanDir(itemPath, item);
          }
        }
      }
    }
  }

  scanDir(recipesDir, "");
  return entries.sort((a, b) => a.name.localeCompare(b.name));
}

// ============================================================================
// CLI output helpers
// ============================================================================

export function printInstallResult(result: InstallResult): void {
  const versionStr = result.version ? `@${result.version}` : "";
  console.log(
    `✓ Installed ${result.name}${versionStr} to ${result.installDir}`,
  );

  if (result.manifest?.connectors && result.manifest.connectors.length > 0) {
    console.log(
      `  Requires connectors: ${result.manifest.connectors.join(", ")}`,
    );
  }

  console.log(
    `  Status: disabled (run \`patchwork recipe enable ${result.name}\` to activate scheduled triggers)`,
  );

  const mainRecipe = result.manifest?.recipes.main ?? result.filesInstalled[0];
  if (mainRecipe) {
    console.log(
      `  Run with: patchwork recipe run ${path.join(result.installDir, mainRecipe)}`,
    );
  }
}

export function printInstalledList(entries: InstalledRecipeEntry[]): void {
  if (entries.length === 0) {
    console.log(
      "No recipes installed. Use `patchwork recipe install <source>` to install.",
    );
    return;
  }

  const maxName = Math.max(...entries.map((e) => e.name.length), 4);
  const maxVersion = Math.max(
    ...entries.map((e) => (e.version ?? "—").length),
    7,
  );

  const header = `${"Name".padEnd(maxName)}  ${"Version".padEnd(maxVersion)}  Status    Description / Files`;
  console.log(header);
  console.log("-".repeat(Math.min(header.length, 100)));

  for (const entry of entries) {
    const version = (entry.version ?? "—").padEnd(maxVersion);
    const status = (entry.enabled ? "enabled" : "disabled").padEnd(8);
    const detail = entry.hasManifest
      ? (entry.description ?? "")
      : `[${(entry.yamlFiles ?? []).join(", ")}]`;
    console.log(
      `${entry.name.padEnd(maxName)}  ${version}  ${status}  ${detail}`,
    );

    if (entry.connectors && entry.connectors.length > 0) {
      console.log(
        `${"".padEnd(maxName)}  ${"".padEnd(maxVersion)}  ${"".padEnd(8)}  connectors: ${entry.connectors.join(", ")}`,
      );
    }
  }
}
