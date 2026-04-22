import { spawnSync } from "node:child_process";
import { lstatSync, realpathSync } from "node:fs";
import path from "node:path";

export const PATCHWORK_PACKAGE_NAME = "patchwork-os";

export interface SymlinkInstallInfo {
  /** Logical package root path in the global node_modules slot. */
  logicalRoot: string;
  /** Fully resolved real path on the filesystem (the workspace). */
  realRoot: string;
}

/**
 * Detects a symlinked global install produced by `npm install -g .` from a
 * workspace checkout.
 *
 * Strategy: ask npm for the global node_modules root, then lstat the
 * patchwork-os slot inside it. If the slot is a symlink, the install is
 * workspace-linked rather than a real copy.
 *
 * We cannot reliably use import.meta.url or process.argv[1] for this check:
 * - import.meta.url is resolved by Node before we read it (real path, not logical)
 * - process.argv[1] points to the bin shim (/opt/homebrew/bin/patchwork-os),
 *   not to the package root in node_modules
 *
 * Returns null for normal installs or when the check cannot be performed.
 */
export function detectWorkspaceSymlinkInstall(): SymlinkInstallInfo | null {
  try {
    // Get the global node_modules root from npm.
    const result = spawnSync("npm", ["root", "-g"], {
      encoding: "utf-8",
      timeout: 5000,
    });
    if (result.error || result.status !== 0) return null;

    const globalRoot = result.stdout.trim();
    if (!globalRoot) return null;

    const logicalRoot = path.join(globalRoot, PATCHWORK_PACKAGE_NAME);

    // Check if the slot is a symlink (not a real directory copy).
    const stat = lstatSync(logicalRoot);
    if (!stat.isSymbolicLink()) return null;

    const realRoot = realpathSync(logicalRoot);
    return { logicalRoot, realRoot };
  } catch {
    // npm not found, permission error, etc. → safe default.
    return null;
  }
}

/** Human-readable install fix instructions. */
export const SYMLINK_INSTALL_FIX =
  `  Fix: npm pack && npm install -g ${PATCHWORK_PACKAGE_NAME}-*.tgz\n` +
  `  Or install from the registry: npm install -g ${PATCHWORK_PACKAGE_NAME}\n`;
