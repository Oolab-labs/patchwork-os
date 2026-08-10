/**
 * Which `init` does a bare `init` mean?
 *
 * The package exposes three bins from one entrypoint (`patchwork`,
 * `patchwork-os`, `claude-ide-bridge`), and `init` historically meant two
 * different things depending on which name you typed:
 *
 *   - `patchwork-os init` → scaffold ~/.patchwork, register the CC PreToolUse
 *     hook (the documented onboarding command)
 *   - `patchwork init` / `claude-ide-bridge init` → the legacy IDE-bridge
 *     installer (extension, CLAUDE.md, MCP shim)
 *
 * That split was invisible to users and it broke the published onboarding
 * path outright: the old check keyed off `process.env._`, a shell convenience
 * variable that npx does not set to the resolved bin, so
 * `npx patchwork-os@beta init` fell through to `basename(argv[1])` — which is
 * `index`, from `dist/index.js` — and landed in the LEGACY installer. The
 * README, the docs and the tool's own `--help` all promised the other one.
 *
 * So: `init` means the Patchwork setup for every name except the explicitly
 * legacy `claude-ide-bridge`, and — critically — for unrecognised names too.
 * Defaulting an unknown invocation to the legacy path is what made an npx
 * install silently do the wrong thing; the safe default is the one every piece
 * of user-facing documentation describes.
 */

/** Bin name that keeps `init` on the pre-Patchwork IDE-bridge installer. */
export const LEGACY_INIT_BIN = "claude-ide-bridge";

export type InitTarget = "patchwork" | "bridge";

/**
 * @param binName Result of `invokedBinaryName()` — may be an npm/npx shim
 *   artifact (`index`, `node`) rather than a real bin name, which is exactly
 *   the case that must not silently pick the legacy path.
 */
export function resolveInitTarget(binName: string): InitTarget {
  const normalised = binName.trim().toLowerCase();
  return normalised === LEGACY_INIT_BIN ? "bridge" : "patchwork";
}
