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
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import {
  pluginNotAllowlistedError,
  pluginSpecsOfYaml,
  policyInputFromConfig,
  refusedPluginSpecs,
} from "../governance/pluginPolicy.js";
import { activeProfile } from "../governance/profile.js";
import { loadConfig } from "../patchworkConfig.js";
import { patchworkPath } from "../patchworkHome.js";
import {
  disabledMarkerPath,
  isInstallDirDisabled,
} from "../recipes/disabledMarkers.js";
import { loadAllowlist } from "../recipes/githubInstallSource.js";
import {
  getManifestRecipeFiles,
  loadManifestFromDir,
  parseManifest,
  type RecipeManifest,
} from "../recipes/manifest.js";
import {
  listInstalledRecipes as listInstalledRecipesSharedView,
  setRecipeEnabled,
} from "../recipesHttp.js";

/**
 * The recipe install directory.
 *
 * A FUNCTION, not the `const` it used to be (#1265). `patchworkHome()` is
 * documented as read-per-call and never cached, because tests and the CLI both
 * change `PATCHWORK_HOME` at runtime; a module-level const would freeze
 * whichever value happened to be set when this module was first imported and
 * make the first importer's environment win for the process lifetime.
 *
 * This site was invisible to `audit-patchwork-home` until now: it spelled
 * `path.join(os.homedir(), ".patchwork", "recipes")` across FOUR LINES, and
 * the gate matched line by line. The gate now scans whole files — see the note
 * in that script.
 */
export function installRecipesDir(): string {
  return patchworkPath("recipes");
}

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
  // Local path: starts with . or any absolute path (POSIX or Windows).
  // Win32 absolute paths like `C:\foo` or `\\server\share` must be accepted
  // alongside POSIX `/foo` — the original `source.startsWith("/")` test
  // silently rejected every Windows local install source.
  if (
    source.startsWith("./") ||
    source.startsWith("../") ||
    path.isAbsolute(source)
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
/**
 * Hard cap on a single httpsGet response body (cli-commands-2). A recipe
 * install fetches GitHub contents listings and individual recipe files —
 * legitimate payloads are well under a megabyte. 50 MB leaves generous
 * headroom for an unusually large recipe tree while preventing a hostile or
 * runaway response from streaming unbounded into process heap.
 */
const HTTPS_GET_MAX_BYTES = 50 * 1024 * 1024;

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

        // Cap the accumulated response so a malicious / accidentally huge
        // GitHub payload can't stream unbounded into process heap and OOM the
        // installer (cli-commands-2).
        const chunks: Buffer[] = [];
        let totalBytes = 0;
        res.on("data", (chunk: Buffer) => {
          totalBytes += chunk.length;
          if (totalBytes > HTTPS_GET_MAX_BYTES) {
            res.destroy();
            reject(
              new Error(
                `Response too large (>${HTTPS_GET_MAX_BYTES} bytes) fetching ${url}`,
              ),
            );
            return;
          }
          chunks.push(chunk);
        });
        res.on("end", () => resolve(Buffer.concat(chunks)));
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    req.end();
  });
}
// END A-PR2 EDIT BLOCK

/**
 * Test-only handle on the private `httpsGet` helper + its byte cap, exposed so
 * the cli-commands-2 response-size regression can assert the abort path without
 * widening the module's public install surface.
 */
export const _httpsGetForTests = httpsGet;
export const _HTTPS_GET_MAX_BYTES_FOR_TESTS = HTTPS_GET_MAX_BYTES;

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
 * Install a recipe package from a source into the recipe install dir.
 * Returns metadata about what was installed.
 */
export async function runRecipeInstall(
  rawSource: string,
  options: { recipesDir?: string } = {},
): Promise<InstallResult> {
  const source = parseInstallSource(rawSource);
  // Enforce the same repo allowlist the HTTP install path uses
  // (`POST /recipes/install` via parseGithubInstallSource). The CLI used to
  // skip this check entirely, so `patchwork recipe install github:evil/repo`
  // would fetch from any org. Default-deny for github sources: only
  // `patchworkos/recipes` plus operator-opted-in PATCHWORK_RECIPE_REPO_ALLOWLIST
  // entries pass. Local sources are unaffected.
  if (source.type === "github") {
    const allowSet = new Set(loadAllowlist().map((s) => s.toLowerCase()));
    const ownerRepo = `${source.owner}/${source.repo}`.toLowerCase();
    if (!allowSet.has(ownerRepo)) {
      throw new Error(
        `'${source.owner}/${source.repo}' is not in the recipe-repo allowlist. ` +
          `Set PATCHWORK_RECIPE_REPO_ALLOWLIST=${source.owner}/${source.repo} to opt in.`,
      );
    }
  }
  const recipesDir = options.recipesDir ?? installRecipesDir();

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

    // Plugin policy: under the governed profile a recipe naming a `servers:`
    // spec outside `config.plugins.allow` is refused BEFORE it reaches the
    // recipes directory. Same verdict function the runtime applies on load.
    {
      const refused = new Set<string>();
      const policy = policyInputFromConfig(activeProfile(), loadConfig());
      for (const file of filesToCopy) {
        if (!/\.ya?ml$/i.test(file)) continue;
        const specs = pluginSpecsOfYaml(
          readFileSync(path.join(tmpDir, file), "utf-8"),
        );
        for (const v of refusedPluginSpecs(specs, policy)) refused.add(v.spec);
      }
      if (refused.size > 0)
        throw pluginNotAllowlistedError(
          [...refused].map((spec) => ({ spec, allowed: false, reason: "" })),
        );
    }

    const installName = determineInstallName(manifest, source);
    const installDir = path.join(recipesDir, installName);

    // Reinstall correctness: detect whether this is an upgrade in place,
    // and snapshot the existing enabled state so the upgrade doesn't
    // silently re-disable a recipe the user explicitly opted into.
    const isReinstall = existsSync(installDir);
    const wasEnabled = isReinstall ? !isInstallDirDisabled(installDir) : false;

    // Stage the new install content in a sibling directory inside
    // `recipesDir` (same filesystem as `installDir`, required for an
    // atomic rename below) instead of copying directly into `installDir`.
    //
    // Previously, files were `cpSync`'d one at a time straight into
    // `installDir`, with the `.disabled` safety marker written only AFTER
    // every file finished copying. A crash/kill between the first and
    // last copy left a partially-copied recipe with no marker — the next
    // startup's directory scan (eventTriggerPrograms.ts / scheduler.ts,
    // neither of which checks "does this look complete") would treat it
    // as a live, enabled recipe and either throw cryptically on the
    // missing file or silently run a mutated/incomplete version.
    //
    // Now the `.disabled` marker is written into the staging dir BEFORE
    // any file is copied, so a crash anywhere before the final rename
    // leaves (at worst) an orphaned `.installing-*` directory that scans
    // as disabled and is inert. The marker is only removed from the real
    // `installDir` — restoring "was enabled" for a reinstall — after the
    // rename has fully succeeded.
    mkdirSync(recipesDir, { recursive: true });
    const stagingDir = mkdtempSync(
      path.join(recipesDir, `.installing-${installName}-`),
    );
    try {
      writeFileSync(disabledMarkerPath(stagingDir), "");

      for (const file of filesToCopy) {
        const src = path.join(tmpDir, file);
        const dest = path.join(stagingDir, file);
        // Ensure subdirs exist (recipe.json could declare children in subdirs)
        const destParent = path.dirname(dest);
        if (!existsSync(destParent)) {
          mkdirSync(destParent, { recursive: true });
        }
        cpSync(src, dest);
      }

      if (isReinstall) {
        // Move the old install dir aside rather than deleting it first —
        // if the process dies between removing the old dir and renaming
        // the new one into place, the recipe would vanish entirely
        // instead of just being stale. Renaming keeps a recoverable copy
        // on disk until the very last (best-effort) cleanup step.
        const backupDir = `${installDir}.replaced-${Date.now()}`;
        renameSync(installDir, backupDir);
        try {
          renameSync(stagingDir, installDir);
        } catch (err) {
          // Restore the old install dir so the recipe isn't left missing.
          renameSync(backupDir, installDir);
          throw err;
        }
        try {
          rmSync(backupDir, { recursive: true, force: true });
        } catch {
          // best-effort — a leftover `${name}.replaced-<ts>` dir is
          // harmless (not a valid recipe name; won't collide on rescan)
        }
      } else {
        renameSync(stagingDir, installDir);
      }
    } catch (err) {
      try {
        rmSync(stagingDir, { recursive: true, force: true });
      } catch {
        /* best-effort cleanup */
      }
      throw err;
    }

    // Write the disabled-marker policy:
    //   - Fresh install: start disabled (per the wave2 plan's safety story;
    //     the marker written into the staging dir above already achieves
    //     this — nothing further to do).
    //   - Reinstall (upgrade in place): preserve whatever the user had set.
    //     If the recipe was enabled before, remove the marker we staged
    //     with so it goes back to enabled; if disabled, leave it.
    if (isReinstall && wasEnabled) {
      try {
        unlinkSync(disabledMarkerPath(installDir));
      } catch {
        /* best-effort — worst case the recipe stays disabled and the user
           re-enables it, rather than silently losing the "enabled" state */
      }
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
  return !isInstallDirDisabled(installDir);
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
  // Audit 2026-06-08 HIGH (cli-1): manifest-less GitHub installs live at a
  // multi-segment "owner/repo[/subdir]" directory, so a single-basename check
  // broke enable/disable/uninstall for them. Allow path separators between
  // valid segments but still reject empty / "." / ".." segments and control
  // characters; the path-jail check below is the real traversal boundary.
  const segments = typeof name === "string" ? name.split(/[/\\]/) : [];
  const invalidName =
    typeof name !== "string" ||
    name.length === 0 ||
    segments.length === 0 ||
    segments.some((seg) => !isSafeBasename(seg));
  if (invalidName) {
    throw new Error(
      `Invalid recipe name "${name}" — no empty, ".", "..", or control-character path segments.`,
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
  const recipesDir = options.recipesDir ?? installRecipesDir();
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
 * Validate a CLI-supplied recipe name and canonicalise it to the DECLARED
 * recipe name before any enable/disable write.
 *
 * Two guards, both RESTORED here rather than newly invented: delegating to
 * `setRecipeEnabled` moved the routing out of this file and took these with
 * it, and the test suite caught both.
 *
 * 1. NAME SHAPE (HIGH-2). `findInstalledRecipeDir` rejected traversal and
 *    control characters. `setRecipeEnabled` resolves install dirs by reading
 *    each entrypoint's declared `name` and never joins the input onto a path,
 *    so it is not itself traversable — but a traversal-shaped name would fall
 *    through to the legacy config array and be WRITTEN there. Accepting
 *    hostile input somewhere new is not an improvement on rejecting it.
 *
 * 2. EXISTENCE. The install-dir-only version errored on a typo. Delegation
 *    alone would make `patchwork recipe disable typoo` succeed silently by
 *    adding `typoo` to `cfg.recipes.disabled` — a write that looks like it
 *    worked and governs nothing.
 *
 * Existence is checked against `listInstalledRecipes`, the same two-pass view
 * (flat files + install dirs) that `recipe list` adopted in the read half of
 * #1360. Resolving a name against a DIFFERENT view than the one that printed
 * it is the whole bug: the CLI listed 75 recipes and could act on 2.
 */
function installRecipesDirForCli(): string {
  // Must match `setRecipeEnabled`'s own default, or the guard validates
  // against a different directory than the write targets.
  //
  // Since #1265 the two are the same function by construction:
  // `installRecipesDir()` IS `patchworkPath("recipes")`, which is exactly
  // `setRecipeEnabled`'s default. Before that they could DIVERGE — the CLI
  // resolved `$HOME/.patchwork/recipes` from a hardcoded `os.homedir()` while
  // the bridge honoured `PATCHWORK_HOME`, so setting the override split the
  // guard from the write. This wrapper stays only to keep that requirement
  // stated where a future edit to either default would read it.
  return installRecipesDir();
}

function resolveActionableRecipeName(name: string, recipesDir: string): string {
  const segments = typeof name === "string" ? name.split(/[/\\]/) : [];
  const invalidName =
    typeof name !== "string" ||
    name.length === 0 ||
    segments.length === 0 ||
    segments.some((seg) => !isSafeBasename(seg));
  if (invalidName) {
    throw new Error(
      `Invalid recipe name "${name}" — no empty, ".", "..", or control-character path segments.`,
    );
  }
  let known: ReadonlyArray<{ name: string }> = [];
  try {
    // ALIASED on import. This file exports its own `listInstalledRecipes`
    // that enumerates install DIRECTORIES only — and those two functions
    // sharing a name, with `recipe list` calling the wrong one, IS #1360.
    // The shared view is the one that printed the names, so it is the one a
    // name must be resolved against.
    known = listInstalledRecipesSharedView(recipesDir).recipes;
  } catch {
    // An unreadable recipes dir is not evidence the name is wrong. Fall
    // through and let the write attempt report the real failure.
    return name;
  }
  if (known.some((r) => r.name === name)) return name;

  // Not a DECLARED name. Before failing, try the INSTALL-DIRECTORY name —
  // the identifier this CLI historically accepted.
  //
  // The two are genuinely different and routinely differ: a recipe in
  // `owner/repo/` can declare `name: morning-brief`. `recipe list` (after the
  // read half of #1360) prints only the DECLARED name, so the verb was
  // refusing the very identifier the list had just shown. Both spellings are
  // accepted here so neither an operator's muscle memory nor the printed
  // output is wrong.
  let dir: string | null = null;
  try {
    dir = findInstalledRecipeDir(name, recipesDir);
  } catch {
    dir = null;
  }
  if (dir) return name;

  throw new Error(
    `No installed recipe named "${name}". Run \`patchwork recipe list\` to see installed recipes.`,
  );
}

/**
 * Whether `setRecipeEnabled` can actually reach this install dir.
 *
 * It cannot reach all of them. `iterateInstallDirs` walks DIRECT CHILDREN of
 * the recipes dir, so a manifest-less GitHub install at `owner/repo/` — whose
 * entrypoint sits one level deeper — is invisible to it. Handing such a name
 * to the shared function does not error: it finds no install dir, falls
 * through to the legacy `config.json` array, and writes a name there that
 * nothing governing that recipe ever reads. A silent write to the wrong
 * mechanism is exactly the class of failure #1360 reports, so the CLI keeps
 * its own directory-resolved marker write for these.
 *
 * This is a real gap in the shared function rather than a CLI quirk, and it
 * is filed separately — fixing `iterateInstallDirs` changes the bridge's and
 * dashboard's view of the installation too, which is not this change's blast
 * radius.
 */
function markerWriteForInstallDir(
  installDir: string,
  enabled: boolean,
): { changed: boolean } {
  const markerPath = disabledMarkerPath(installDir);
  const wasDisabled = existsSync(markerPath);
  if (enabled) {
    if (wasDisabled) unlinkSync(markerPath);
  } else if (!wasDisabled) {
    writeFileSync(markerPath, "");
  }
  return { changed: enabled ? wasDisabled : !wasDisabled };
}

/**
 * The one implementation behind both CLI verbs.
 *
 * Order matters. The directory-resolved marker write comes FIRST because it is
 * the only path that reaches nested `owner/repo` installs; everything else
 * delegates to the shared `setRecipeEnabled` so the CLI, the bridge route and
 * the dashboard agree about which mechanism governs a recipe.
 */
function setEnabledFromCli(
  name: string,
  enabled: boolean,
  options: SetEnabledCliOptions = {},
): {
  installDir?: string;
  changed: boolean;
  mechanism: "marker" | "config";
} {
  const recipesDir = options.recipesDir ?? installRecipesDirForCli();
  const canonical = resolveActionableRecipeName(name, recipesDir);

  let dir: string | null = null;
  try {
    dir = findInstalledRecipeDir(canonical, recipesDir);
  } catch {
    dir = null;
  }
  if (dir) {
    return {
      installDir: dir,
      ...markerWriteForInstallDir(dir, enabled),
      mechanism: "marker",
    };
  }

  const r = setRecipeEnabled(canonical, enabled, options);
  if (!r.ok) {
    throw new Error(
      r.error ??
        `No installed recipe named "${name}". Run \`patchwork recipe list\` to see installed recipes.`,
    );
  }
  return {
    ...(r.installDir !== undefined && { installDir: r.installDir }),
    changed: r.changed,
    mechanism: r.mechanism === "config" ? "config" : "marker",
  };
}

/**
 * Options forwarded verbatim to `setRecipeEnabled`.
 *
 * The config seams are forwarded, not just `recipesDir`, so a test can drive
 * THESE functions — the ones the CLI actually calls — rather than reaching
 * past them to the shared helper. A test that calls `setRecipeEnabled`
 * directly proves the helper works and says nothing about whether the CLI is
 * wired to it, which is the exact shape of bug #1360 reports.
 */
type SetEnabledCliOptions = Parameters<typeof setRecipeEnabled>[2];

/**
 * Enable a recipe — removes the .disabled marker so triggers can fire.
 * Idempotent: enabling an already-enabled recipe is a no-op.
 */
export function runRecipeEnable(
  name: string,
  options: SetEnabledCliOptions = {},
): {
  name: string;
  installDir?: string;
  alreadyEnabled: boolean;
  mechanism: "marker" | "config";
} {
  const r = setEnabledFromCli(name, true, options);
  return {
    name,
    ...(r.installDir !== undefined && { installDir: r.installDir }),
    alreadyEnabled: !r.changed,
    mechanism: r.mechanism,
  };
}

/**
 * Disable a recipe — writes the .disabled marker so triggers stop firing.
 * Idempotent: disabling an already-disabled recipe is a no-op.
 */
export function runRecipeDisable(
  name: string,
  options: SetEnabledCliOptions = {},
): {
  name: string;
  installDir?: string;
  alreadyDisabled: boolean;
  mechanism: "marker" | "config";
} {
  const r = setEnabledFromCli(name, false, options);
  return {
    name,
    ...(r.installDir !== undefined && { installDir: r.installDir }),
    alreadyDisabled: !r.changed,
    mechanism: r.mechanism,
  };
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
  const recipesDir = options.recipesDir ?? installRecipesDir();
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
  const recipesDir = options.recipesDir ?? installRecipesDir();

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
    const rawDetail = entry.hasManifest
      ? (entry.description ?? "")
      : `[${(entry.yamlFiles ?? []).join(", ")}]`;
    // Truncate the description/files column so a long value can't wrap and
    // destroy column alignment on 80-col terminals. Matches the 120-char
    // cap used by the `halts` command for recent reasons.
    const detail =
      rawDetail.length > 120 ? `${rawDetail.slice(0, 117)}…` : rawDetail;
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
