/**
 * disabledMarkers — single source of truth for "is this recipe disabled?"
 *
 * Two parallel disable mechanisms exist, and previously each lived in a
 * different file with the constant + check duplicated:
 *
 *   1. Per-install-dir `.disabled` marker file. Written by `runRecipeInstall`
 *      on every fresh install (so newly-installed recipes are inert until
 *      explicitly enabled) and toggled by `setRecipeEnabled` for
 *      install-dir recipes. The trigger-side enforcement (PRs #42/#43/#49)
 *      reads this marker on every dispatch path.
 *
 *   2. Legacy `cfg.recipes.disabled[]` array in `~/.patchwork/config.json`.
 *      Used by top-level recipe files (direct children of `recipesDir`,
 *      no install dir to put a marker in). The scheduler honors it both at
 *      start-time scan and as a TOCTOU re-check at fire time.
 *
 * Both surface here so the constant + readers can't drift between
 * `recipesHttp.ts` and `scheduler.ts`. Issue #253 follow-up.
 */

import { existsSync } from "node:fs";
import path from "node:path";

import type { PatchworkConfig } from "../config.js";

/**
 * Filename of the per-install-dir disable marker. Lives in this module
 * (not in `commands/recipeInstall.ts` where it's also written) to avoid
 * a circular import via commands → recipesHttp → commands.
 */
export const DISABLED_MARKER = ".disabled";

/**
 * Returns true if the given install dir contains a `.disabled` marker
 * file. Pass the *install dir*, not a recipe path inside it.
 */
export function isInstallDirDisabled(installDir: string): boolean {
  return existsSync(path.join(installDir, DISABLED_MARKER));
}

/**
 * Path to the marker file for a given install dir — caller-side use when
 * writing or removing the marker (`setRecipeEnabled`).
 */
export function disabledMarkerPath(installDir: string): string {
  return path.join(installDir, DISABLED_MARKER);
}

/**
 * Extract the legacy disabled-name set from a parsed config. Returns an
 * empty set when the config is missing the field. Centralized so the
 * scheduler's start-time scan and fire-time TOCTOU re-check (and
 * `setRecipeEnabled`'s legacy fallback) all read it the same way.
 */
export function getConfigDisabledNames(
  cfg: PatchworkConfig | { recipes?: { disabled?: string[] } } | undefined,
): Set<string> {
  return new Set(cfg?.recipes?.disabled ?? []);
}
