/**
 * resolveRecipePath — recipe-runner path jail.
 *
 * Closes G-security F-01 (CRITICAL — `file.read/write/append` accept any
 * absolute path), F-02 (CRITICAL — template-substituted vars escape via
 * `..`), and the R2 C-1 chained-runner third-substitution-site gap.
 *
 * Mirrors the symlink-walking strategy from `src/tools/utils.ts:104-200`
 * (`resolveFilePath`) but operates against an allowlist of recipe-roots
 * rather than a single workspace root:
 *
 *   - `~/.patchwork/`               (always allowed — recipe install dir)
 *   - the bridge / CLI workspace    (always allowed — passed in via `opts.workspace`)
 *   - `os.tmpdir()`                 (OFF by default; opt-in via the
 *                                    `CLAUDE_IDE_BRIDGE_RECIPE_TMP_JAIL=1`
 *                                    env var, per R2 C-2 maintainer decision)
 *
 * On any escape (null byte, segment outside all roots, symlink target
 * outside roots, hardlink on a write target) the helper throws an `Error`
 * with `err.code = "recipe_path_jail_escape"`. Callers and tests must
 * assert on `err.code`, never on message text (R2 M-4).
 *
 * Defense-in-depth — apply at every layer:
 *   - `src/recipes/tools/file.ts`            (per-tool execute())
 *   - `src/recipes/yamlRunner.ts:976-994`    (default StepDeps file ops)
 *   - `src/recipes/yamlRunner.ts:642`        (post-render path snapshot)
 *   - `src/recipes/yamlRunner.ts:1252-1262`  (chained-runner executeTool)
 *   - `src/recipes/chainedRunner.ts:194-205` (template-substitution site)
 *   - `src/recipeRoutes.ts:131-138 :172-181` (HTTP vars validator)
 *   - `src/commands/recipe.ts:1080-1102`     (CLI warn on out-of-jail recipe ref)
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export type RecipePathJailError = Error & { code: "recipe_path_jail_escape" };

/** Build a jail error with the canonical code. Never expose internals via message-matching. */
function jailError(message: string): RecipePathJailError {
  const err = new Error(message) as RecipePathJailError;
  err.code = "recipe_path_jail_escape";
  return err;
}

export interface ResolveRecipePathOptions {
  /** True when the caller will write/append/mkdir at the resolved path (enables hardlink check). */
  write?: boolean;
  /** Optional workspace allowlist root. Defaults to `process.cwd()`. */
  workspace?: string;
  /**
   * Override the tmp-jail opt-in. Used by tests to assert the env-var
   * behavior without polluting `process.env` across the suite. Production
   * callers should leave this undefined and rely on
   * `CLAUDE_IDE_BRIDGE_RECIPE_TMP_JAIL=1`.
   */
  allowTmp?: boolean;
  /**
   * Override the home dir. Used by tests to assert behavior without
   * touching the real `~`. Production callers leave undefined.
   */
  homeDir?: string;
}

/** Expand a leading `~/` segment using `os.homedir()` (or the test override). */
function expandHome(p: string, homeDir: string): string {
  if (p === "~") return homeDir;
  if (p.startsWith("~/")) return path.join(homeDir, p.slice(2));
  return p;
}

/** Compute the active jail roots given the runtime opts. */
function jailRoots(opts: ResolveRecipePathOptions): string[] {
  const homeDir = opts.homeDir ?? os.homedir();
  const allowTmp =
    opts.allowTmp ?? process.env.CLAUDE_IDE_BRIDGE_RECIPE_TMP_JAIL === "1";
  const workspace = opts.workspace ?? process.cwd();
  const roots = [path.resolve(homeDir, ".patchwork"), path.resolve(workspace)];
  if (allowTmp) {
    // On macOS `os.tmpdir()` returns `/var/folders/...` but the conventional
    // `/tmp` symlink points at `/private/tmp` — we expose both so a recipe
    // (or a legacy test) that hard-codes `/tmp/...` resolves cleanly. The
    // symlink-aware realpath check below will still reject anything whose
    // physical target is outside both roots.
    roots.push(path.resolve(os.tmpdir()));
    roots.push("/tmp");
  }
  // Dedupe — workspace==tmpdir on some CI runners would double-count and
  // confuse the "outside all roots" reject branch.
  return Array.from(new Set(roots));
}

/** True if `target` is inside (or equal to) any allowed jail root. */
function isInsideAnyRoot(target: string, roots: string[]): boolean {
  for (const root of roots) {
    if (target === root) return true;
    if (target.startsWith(root + path.sep)) return true;
  }
  return false;
}

/**
 * Walk up the ancestor chain of a (possibly non-existent) path, returning
 * the realpath of the first ancestor that exists on disk plus the unresolved
 * suffix. Mirrors `src/tools/utils.ts:130-177` so a symlink anywhere along
 * the chain (including the bridge / install dir) is followed before the
 * containment check.
 */
function realpathOrAncestor(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    let ancestor = path.dirname(p);
    const suffix = [path.basename(p)];
    while (ancestor !== path.dirname(ancestor)) {
      try {
        const realAncestor = fs.realpathSync(ancestor);
        return path.join(realAncestor, ...suffix);
      } catch {
        suffix.unshift(path.basename(ancestor));
        ancestor = path.dirname(ancestor);
      }
    }
    // Reached fs root without finding a real ancestor — fail closed; the
    // caller will translate this to a jail-escape rather than skip the
    // containment check.
    throw new Error(`no real ancestor found for "${p}"`);
  }
}

/**
 * Resolve a recipe-supplied path, expanding `~/`, normalising, and asserting
 * the result lives inside one of the jail roots after symlink resolution.
 *
 * Throws `RecipePathJailError` (code `"recipe_path_jail_escape"`) on any
 * containment violation. Callers should propagate the error unchanged so
 * tests can assert on `err.code`.
 */
export function resolveRecipePath(
  rawPath: string,
  opts: ResolveRecipePathOptions = {},
): string {
  if (typeof rawPath !== "string") {
    throw jailError("recipe path must be a string");
  }
  if (rawPath.length === 0) {
    throw jailError("recipe path must not be empty");
  }
  if (rawPath.includes("\x00")) {
    throw jailError("recipe path must not contain null bytes");
  }

  const homeDir = opts.homeDir ?? os.homedir();
  const expanded = expandHome(rawPath, homeDir);
  const resolved = path.isAbsolute(expanded)
    ? path.resolve(expanded)
    : path.resolve(opts.workspace ?? process.cwd(), expanded);

  const roots = jailRoots(opts);

  // Lexical containment first — cheap reject for `..` segments resolving
  // outside any root before we do any FS calls.
  if (!isInsideAnyRoot(resolved, roots)) {
    throw jailError(
      `recipe path "${rawPath}" resolves outside the allowed jail roots`,
    );
  }

  // Symlink-aware re-check. We resolve the realpath of every existing
  // ancestor so a link at any level (including a freshly-installed recipe
  // dir pointing at `/tmp`) cannot bypass the lexical check above.
  let real: string;
  try {
    real = realpathOrAncestor(resolved);
  } catch (err) {
    throw jailError(
      `recipe path "${rawPath}" failed symlink resolution: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const realRoots: string[] = [];
  for (const root of roots) {
    try {
      realRoots.push(fs.realpathSync(root));
    } catch {
      // Root does not exist yet (e.g. ~/.patchwork on a fresh install).
      // Use the resolved (lexical) form — `mkdirSync({recursive:true})`
      // will create it inside the lexical jail anyway, and the symlink
      // walk above already confirmed nothing on disk redirects out.
      realRoots.push(root);
    }
  }
  if (!isInsideAnyRoot(real, realRoots)) {
    throw jailError(
      `recipe path "${rawPath}" escapes jail via symlink (real target "${real}")`,
    );
  }

  // Hardlink guard for write paths — same rationale as `resolveFilePath`'s
  // `opts.write` branch: a hardlink from inside the jail to an outside
  // file shares an inode and passes the realpath check, but writing
  // through it would modify the outside file.
  if (opts.write) {
    try {
      const lst = fs.lstatSync(resolved);
      if (!lst.isDirectory() && lst.nlink > 1) {
        throw jailError(
          `recipe path "${rawPath}" is a hardlink (nlink=${lst.nlink}); writes denied to prevent jail escape`,
        );
      }
    } catch (err) {
      // ENOENT — file doesn't exist yet, safe to create. Re-throw if it's
      // already a jail error (the nlink branch above).
      if (
        err instanceof Error &&
        (err as { code?: string }).code === "recipe_path_jail_escape"
      ) {
        throw err;
      }
      // Other lstat errors (EACCES, etc.) — non-fatal; the write call will
      // surface them with the OS-level message.
    }
  }

  return resolved;
}

/**
 * Side-effect-free predicate variant — returns `null` on jail escape rather
 * than throwing. Used by the CLI `recipe run` warn path (F-10), which wants
 * to write a stderr notice when a recipe **file** lives outside the jail
 * but still loads it (the YAML loader is a separate trust boundary from the
 * tool dispatch jail).
 */
export function tryResolveRecipePath(
  rawPath: string,
  opts: ResolveRecipePathOptions = {},
): string | null {
  try {
    return resolveRecipePath(rawPath, opts);
  } catch {
    return null;
  }
}
