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

/**
 * Reject path components that aren't a single safe basename — used at every
 * boundary where externally-sourced filenames are joined onto a trusted
 * directory (manifest fields, GitHub API responses, CLI args).
 *
 * Rejects empty/".."/".", any path separator, and control chars (NUL/newline/tab).
 * Exported for testing and reuse.
 */
export function isSafeBasename(name: unknown): boolean {
  if (typeof name !== "string" || name.length === 0) return false;
  if (name === "." || name === "..") return false;
  if (name.includes("/") || name.includes("\\")) return false;
  // biome-ignore lint/suspicious/noControlCharactersInRegex: explicit control-char check
  if (/[\x00-\x1F\x7F]/.test(name)) return false;
  return true;
}

/**
 * GitHub repo and owner names. Lenient enough for real-world usage but
 * strict enough that the value can be string-interpolated into a URL path
 * without changing semantics. Rejects: empty, leading dash, leading dot,
 * `..`, anything outside [A-Za-z0-9_.-], length > 100.
 */
function isValidGitHubName(name: string): boolean {
  if (!name || name.length > 100) return false;
  if (name.startsWith("-") || name.startsWith(".")) return false;
  if (name.includes("..")) return false;
  return /^[A-Za-z0-9_.-]+$/.test(name);
}

/**
 * Subdir segment (one piece of a `/`-joined path). Must be non-empty,
 * not `.`/`..`, and contain only chars safe for URL path interpolation.
 */
function isValidSubdirSegment(segment: string): boolean {
  if (!segment || segment === "." || segment === "..") return false;
  return /^[A-Za-z0-9_.-]+$/.test(segment);
}

/**
 * Git ref (branch / tag / SHA / `feature/foo`). Mirrors `isValidRef` from
 * `src/tools/git-utils.ts` (we don't import it to avoid pulling tools-layer
 * deps into commands).
 *
 * Rejects: leading dash (CLI-flag injection territory), `..` (range syntax /
 * traversal), shell/URL metacharacters. Allows `/` for `feature/xyz`-style refs.
 */
function isValidGitRef(ref: string): boolean {
  if (!ref || ref.startsWith("-") || ref.includes("..")) return false;
  return /^[\w./\-^~@{}]+$/.test(ref);
}

/**
 * Allowlist for `httpsGet` redirect targets. The recipe-install fetch path
 * resolves user-supplied identifiers into GitHub API URLs and follows
 * redirects, so a malicious source could otherwise cause a server-side
 * fetch against an attacker host. Restrict redirects to the small set of
 * GitHub-owned hosts the installer actually needs, over HTTPS only.
 *
 * Exported for testing.
 */
export function isAllowedRedirectHost(url: string): boolean {
  if (typeof url !== "string" || !url) return false;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:") return false;
  return (
    parsed.hostname === "api.github.com" ||
    parsed.hostname === "raw.githubusercontent.com" ||
    parsed.hostname === "codeload.github.com"
  );
}

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
    return validateGitHubSource({
      type: "github",
      owner,
      repo,
      ...(subdir ? { subdir } : {}),
      ...(ref ? { ref } : {}),
    });
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
  return validateGitHubSource({
    type: "github",
    owner,
    repo,
    ...(subdirParts.length > 0 ? { subdir: subdirParts.join("/") } : {}),
    ...(ref ? { ref } : {}),
  });
}

/**
 * Validate a parsed GitHubInstallSource — every field that flows into a URL
 * must be safe for path interpolation. Throws with a descriptive message
 * naming the offending field. Returns the same source on success so callers
 * can chain.
 */
function validateGitHubSource(s: GitHubInstallSource): GitHubInstallSource {
  if (!isValidGitHubName(s.owner)) {
    throw new Error(
      `Invalid GitHub owner "${s.owner}": must be [A-Za-z0-9_.-], no leading dash/dot, no "..", ≤ 100 chars`,
    );
  }
  if (!isValidGitHubName(s.repo)) {
    throw new Error(
      `Invalid GitHub repo "${s.repo}": must be [A-Za-z0-9_.-], no leading dash/dot, no "..", ≤ 100 chars`,
    );
  }
  if (s.ref !== undefined && !isValidGitRef(s.ref)) {
    throw new Error(
      `Invalid git ref "${s.ref}": must be a valid branch/tag/SHA without shell or URL metacharacters`,
    );
  }
  if (s.subdir !== undefined) {
    const segments = s.subdir.split("/");
    for (const seg of segments) {
      if (!isValidSubdirSegment(seg)) {
        throw new Error(
          `Invalid subdir segment "${seg}" in "${s.subdir}": must be [A-Za-z0-9_.-], not "." or ".."`,
        );
      }
    }
  }
  return s;
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
  // Reject the initial URL too — defense in depth in case a caller bypasses
  // parseInstallSource validation (e.g., raw download_url from API responses).
  if (!isAllowedRedirectHost(url)) {
    throw new Error(`Refused fetch: host not in GitHub allowlist (${url})`);
  }
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
        // Follow redirects — but only to other GitHub-owned hosts over HTTPS.
        // A 30x to an attacker-controlled URL would otherwise be silently
        // followed and the body parsed/written to disk.
        if (
          res.statusCode &&
          res.statusCode >= 300 &&
          res.statusCode < 400 &&
          res.headers.location
        ) {
          if (!isAllowedRedirectHost(res.headers.location)) {
            reject(
              new Error(
                `Refused redirect to non-allowlisted host: ${res.headers.location}`,
              ),
            );
            return;
          }
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
  // URL-encode every interpolated component so user-controlled values can't
  // change URL semantics (extra query params, path traversal, fragment).
  // Note: `dirPath` is encoded per-segment so legitimate `/` separators
  // survive while reserved chars inside segments get encoded.
  const encodedOwner = encodeURIComponent(owner);
  const encodedRepo = encodeURIComponent(repo);
  const encodedPath = dirPath.split("/").map(encodeURIComponent).join("/");
  const encodedRef = encodeURIComponent(ref);
  const url = `https://api.github.com/repos/${encodedOwner}/${encodedRepo}/contents/${encodedPath}?ref=${encodedRef}`;
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
    // GitHub Contents API responses are not implicitly trusted: a hostile
    // repo (or a redirect-to-attacker) could supply names like `../etc/x`.
    // The existing extension filter above already blocks the most obvious
    // payloads, but we explicitly reject anything that isn't a single
    // basename so a future change to the filter doesn't reopen the gap.
    if (!isSafeBasename(item.name)) {
      continue;
    }

    const content = await fetchGitHubFile(item.download_url);
    const destPath = path.join(destDir, item.name);
    // Belt-and-suspenders: confirm the resolved write path lives inside destDir.
    if (
      !path.resolve(destPath).startsWith(`${path.resolve(destDir)}${path.sep}`)
    ) {
      continue;
    }
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
 *
 * Validates `name` is a safe basename to defend against `recipe enable
 * ../../../etc/foo` and similar — even though the on-disk effect would be
 * limited to the `.disabled` filename, an arbitrary-path file write under
 * the user's privilege is still a real attack surface.
 */
function findInstalledRecipeDir(
  name: string,
  recipesDir: string,
): string | null {
  if (!isSafeBasename(name)) {
    throw new Error(
      `Invalid recipe name "${name}" — must be a single directory name without path separators or control characters.`,
    );
  }
  const direct = path.join(recipesDir, name);
  // Defense-in-depth: even with the basename check above, confirm the resolved
  // path lives under recipesDir. Symlinks inside recipesDir could in principle
  // escape, so this catches that too.
  const resolvedRoot = path.resolve(recipesDir);
  const resolvedDir = path.resolve(direct);
  if (!resolvedDir.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new Error(
      `Resolved recipe path escapes recipes directory: "${name}"`,
    );
  }
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
