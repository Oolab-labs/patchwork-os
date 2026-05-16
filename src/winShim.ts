import path from "node:path";

/**
 * Resolve a binary name to its `.cmd` shim on Windows when needed.
 *
 * npm-installed binaries on Windows are `.cmd` files in `node_modules/.bin/`
 * (or under `%APPDATA%\npm` for `-g` installs). Node's `child_process.spawn`
 * with `shell:false` does NOT auto-resolve `.cmd` shims — only `.exe` via
 * `PATHEXT`. Calling `spawn("claude", …)` on Windows therefore ENOENTs even
 * though `claude --version` works fine in any terminal.
 *
 * This helper appends `.cmd` to bare binary names on win32, leaving:
 *   - absolute / relative paths (anything with a separator) alone
 *   - names that already have an extension alone
 *   - non-Windows platforms untouched
 *
 * This was the fix pattern established in PR #525 for the Claude subprocess
 * driver; centralising it here keeps the four other spawn sites consistent.
 *
 * Also used when *writing* an MCP stdio config that another process will
 * spawn — that spawning process inherits the same shell:false limitation,
 * so the config must record the `.cmd` form on Windows.
 */
export function ensureCmdShim(binary: string): string {
  if (process.platform !== "win32") return binary;
  // Use path.win32 explicitly so the check behaves identically when tests
  // mock process.platform on a POSIX host (where path.sep would still be '/').
  if (path.win32.extname(binary)) return binary;
  if (binary.includes("\\") || binary.includes("/")) return binary;
  return `${binary}.cmd`;
}

/**
 * Binaries that ship as `.cmd` shims on Windows when npm-installed (or via
 * the standard VS Code / Cursor / Windsurf installers for the editor CLIs).
 *
 * Conservative by design — only names that are dependably `.cmd` on Windows
 * across the common install paths. Anything ambiguous (`rg`, `fd`, `jq`,
 * `python`, `node`) is omitted so we don't break `spawn("git")` style
 * callers — Windows' PATHEXT auto-resolves `.exe` for those.
 *
 * Add to this set only after confirming the binary really is a `.cmd` shim
 * in every realistic install path; a wrong inclusion turns working `.exe`
 * spawns into ENOENT.
 */
const KNOWN_CMD_SHIMS: ReadonlySet<string> = new Set([
  // Package managers — always `.cmd` from any install path
  "npm",
  "npx",
  "yarn",
  "pnpm",
  // npm-installed dev tools — bin entries land as `.cmd` shims
  "tsc",
  "eslint",
  "biome",
  "prettier",
  "ruff",
  "black",
  "ts-prune",
  // Patchwork OS / Claude orchestration — npm-installed
  "claude",
  "claude-ide-bridge",
  "gemini",
  "code-server",
  // VS Code-family editor CLIs — `.cmd` shims from the official installers
  "code",
  "code-insiders",
  "cursor",
  "windsurf",
]);

/**
 * Conservative variant of `ensureCmdShim`: only appends `.cmd` when the
 * binary is in {@link KNOWN_CMD_SHIMS}. Use this from generic helpers like
 * `execSafe` that receive arbitrary binary names from many call sites —
 * blindly wrapping every bare name would turn working `spawn("git")` into
 * broken `spawn("git.cmd")`.
 *
 * Same boilerplate as `ensureCmdShim` (no-op on non-Win, leaves explicit
 * paths and pre-extended names alone). Differs only in the final wrap
 * decision.
 */
export function ensureCmdShimIfKnown(binary: string): string {
  if (process.platform !== "win32") return binary;
  if (path.win32.extname(binary)) return binary;
  if (binary.includes("\\") || binary.includes("/")) return binary;
  if (!KNOWN_CMD_SHIMS.has(binary)) return binary;
  return `${binary}.cmd`;
}
