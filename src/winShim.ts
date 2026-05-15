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
