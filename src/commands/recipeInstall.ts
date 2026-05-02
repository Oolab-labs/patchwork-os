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

// ---------------------------------------------------------------------
// BEGIN A-PR2 EDIT BLOCK — `parseGithubShorthand` strict validation
// (dogfood R2 M-2). Owner/repo segments are validated against GitHub's own
// rules (alphanumeric or hyphen/dot/underscore, max 39 chars, must start
// alphanumeric) so injection attempts via shorthand (`gh:foo@bar:baz/repo`,
// `gh:owner/<repo>?evil=1`) are rejected before reaching the URL builder.
// Refs reject userinfo (`@`) and port markers (`:`) — these would otherwise
// land inside the constructed `https://github.com/.../tree/<ref>/...` URL.
// ---------------------------------------------------------------------
const GITHUB_OWNER_REPO_RE = /^[a-zA-Z0-9](?:[a-zA-Z0-9-._]{0,38})$/;

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
    // Reject embedded URL syntax that would corrupt the constructed
    // https://github.com/<owner>/<repo>/tree/<ref> URL (R2 M-2).
    if (/[@:?#\s]/.test(ref) || ref.includes("..")) {
      throw new Error(
        `Invalid github shorthand: ref "${ref}" contains disallowed characters`,
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
  if (!GITHUB_OWNER_REPO_RE.test(owner)) {
    throw new Error(
      `Invalid github shorthand: owner "${owner}" is not a valid GitHub username`,
    );
  }
  if (!GITHUB_OWNER_REPO_RE.test(repo)) {
    throw new Error(
      `Invalid github shorthand: repo "${repo}" is not a valid GitHub repository name`,
    );
  }
  // Subdir segments: each must be a safe path component (no traversal, no
  // control chars). Reuses `isSafeBasename` for consistency with the post-fetch
  // file boundary check.
  for (const seg of subdirParts) {
    if (!isSafeBasename(seg)) {
      throw new Error(
        `Invalid github shorthand: subdir segment "${seg}" is unsafe`,
      );
    }
  }
  return {
    type: "github",
    owner,
    repo,
    ...(subdirParts.length > 0 ? { subdir: subdirParts.join("/") } : {}),
    ...(ref ? { ref } : {}),
  };
}
// END A-PR2 EDIT BLOCK

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

// ---------------------------------------------------------------------
// BEGIN A-PR2 EDIT BLOCK — `httpsGet` redirect chain hardening
// (dogfood R2 I-2). Redirect targets must (1) be one of GitHub's known hosts
// and (2) clear the SSRF guard. Hop count capped at 5 to bound the chain.
// Origin is also validated up-front: this helper is reached only after
// `parseGithubShorthand` / GitHub URL parsing, so all callers should already
// be pointed at github.com / api.github.com / raw.githubusercontent.com.
// ---------------------------------------------------------------------
const GITHUB_REDIRECT_HOSTS = new Set<string>([
  "github.com",
  "www.github.com",
  "api.github.com",
  "raw.githubusercontent.com",
  "codeload.github.com",
  "objects.githubusercontent.com",
  "media.githubusercontent.com",
]);
const HTTPS_GET_MAX_REDIRECTS = 5;

function isAllowedGithubHost(hostname: string): boolean {
  return GITHUB_REDIRECT_HOSTS.has(hostname.toLowerCase());
}

async function httpsGet(url: string, hops = 0): Promise<Buffer> {
  // Lazy-load the SSRF guard so test harnesses that mock https.get don't have
  // to also stub DNS — the guard fast-paths public hostnames anyway.
  const { isPrivateHost } = await import("../ssrfGuard.js");
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Invalid URL: ${url}`);
  }
  if (parsed.protocol !== "https:") {
    throw new Error(`Refusing non-https URL: ${url}`);
  }
  if (!isAllowedGithubHost(parsed.hostname)) {
    throw new Error(
      `Refusing redirect to non-GitHub host "${parsed.hostname}"`,
    );
  }
  if (isPrivateHost(parsed.hostname)) {
    throw new Error(`Refusing redirect to private host "${parsed.hostname}"`);
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
        // Follow redirects — bounded chain, allowlisted host, SSRF-guarded.
        if (
          res.statusCode &&
          res.statusCode >= 300 &&
          res.statusCode < 400 &&
          res.headers.location
        ) {
          if (hops >= HTTPS_GET_MAX_REDIRECTS) {
            reject(
              new Error(`Too many redirects (>${HTTPS_GET_MAX_REDIRECTS})`),
            );
            return;
          }
          // Resolve relative redirects against the current URL so a relative
          // `Location: /foo` doesn't get treated as an empty hostname.
          let nextUrl: URL;
          try {
            nextUrl = new URL(res.headers.location, url);
          } catch {
            reject(
              new Error(`Invalid redirect location: "${res.headers.location}"`),
            );
            return;
          }
          if (nextUrl.protocol !== "https:") {
            reject(
              new Error(
                `Refusing redirect to non-https protocol: "${nextUrl.protocol}"`,
              ),
            );
            return;
          }
          httpsGet(nextUrl.toString(), hops + 1)
            .then(resolve)
            .catch(reject);
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
// END A-PR2 EDIT BLOCK

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

    // Reinstall correctness: detect whether this is an upgrade in place,
    // and snapshot the existing enabled state so the upgrade doesn't
    // silently re-disable a recipe the user explicitly opted into.
    const isReinstall = existsSync(installDir);
    const wasEnabled = isReinstall
      ? !existsSync(path.join(installDir, DISABLED_MARKER))
      : false;

    if (isReinstall) {
      // Clear stale files from the previous version so files dropped from
      // the new manifest don't linger. We rebuild the install dir wholesale
      // rather than overlay the new files on top of the old.
      try {
        rmSync(installDir, { recursive: true, force: true });
      } catch {
        // best-effort; mkdirSync below will throw with a clearer error
      }
    }
    mkdirSync(installDir, { recursive: true });

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

    // Write the disabled-marker policy:
    //   - Fresh install: start disabled (per the wave2 plan's safety story).
    //   - Reinstall (upgrade in place): preserve whatever the user had set.
    //     If the recipe was enabled before, leave it enabled; if disabled,
    //     leave it disabled. Don't silently revoke an explicit user opt-in.
    if (!isReinstall || !wasEnabled) {
      writeFileSync(path.join(installDir, DISABLED_MARKER), "");
    }

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
 * Resolve an install-dir-name (the directory `runRecipeInstall` created) to
 * the YAML entrypoint inside it. Used by `recipe run <name>` so the user can
 * pass the name they see in `recipe list` rather than having to dig into the
 * install directory layout.
 *
 * Resolution order:
 *   1. `recipe.json` manifest's `recipes.main`, if the manifest exists and
 *      the file it points at exists on disk.
 *   2. First `*.yaml` / `*.yml` in the install dir.
 *
 * Returns null if `name` doesn't correspond to an install dir, or the dir
 * exists but contains no resolvable entrypoint. Path-traversal `name` values
 * (e.g. `../../etc`) throw via the underlying `findInstalledRecipeDir` —
 * same defence as enable/disable/uninstall.
 */
export function findInstalledRecipeEntrypoint(
  name: string,
  options: { recipesDir?: string } = {},
): string | null {
  const recipesDir = options.recipesDir ?? INSTALL_RECIPES_DIR;
  const installDir = findInstalledRecipeDir(name, recipesDir);
  if (!installDir) return null;

  const manifestPath = path.join(installDir, "recipe.json");
  if (existsSync(manifestPath)) {
    try {
      const m = JSON.parse(readFileSync(manifestPath, "utf-8")) as {
        recipes?: { main?: string };
      };
      if (m.recipes?.main && isSafeBasename(m.recipes.main)) {
        const candidate = path.join(installDir, m.recipes.main);
        if (existsSync(candidate)) return candidate;
      }
    } catch {
      // Malformed manifest → fall through to first-yaml lookup. The
      // scheduler does the same; surfacing the parse error here would
      // shadow the top-level "recipe not found" error from the CLI.
    }
  }

  try {
    for (const entry of readdirSync(installDir)) {
      if (/\.ya?ml$/i.test(entry)) {
        return path.join(installDir, entry);
      }
    }
  } catch {
    // unreadable
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

/**
 * Uninstall a recipe — removes its install directory entirely.
 *
 * Returns `{ ok: false, error }` when the recipe isn't found rather than
 * throwing, so the CLI can surface a clean error message instead of a
 * stack trace. Path-traversal attempts in `name` still throw via
 * `findInstalledRecipeDir`'s validator (HIGH-2 hardening from #46).
 */
export function runRecipeUninstall(
  name: string,
  options: { recipesDir?: string } = {},
): { ok: boolean; installDir?: string; error?: string } {
  const recipesDir = options.recipesDir ?? INSTALL_RECIPES_DIR;
  const installDir = findInstalledRecipeDir(name, recipesDir);
  if (!installDir) {
    return {
      ok: false,
      error: `No installed recipe named "${name}". Run \`patchwork recipe list\` to see installed recipes.`,
    };
  }
  rmSync(installDir, { recursive: true, force: true });
  return { ok: true, installDir };
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
