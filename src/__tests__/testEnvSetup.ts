/**
 * Vitest setupFiles — runs in every test worker before any test file.
 *
 * Redirects CLAUDE_CONFIG_DIR to a per-process temp directory so that
 * lock files written by test bridge instances never land in ~/.claude/ide/.
 * This prevents cleanStale() in test bridges from scanning — and potentially
 * deleting — the lock file of the live production bridge that is serving
 * the current Claude Code MCP session.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const testConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-test-"));
process.env.CLAUDE_CONFIG_DIR = testConfigDir;

// Force file-backed token storage in tests so `security add-generic-password`
// is never shelled out — avoids the macOS "Keychain Not Found" prompt when
// test workers run in an exec context that can't see the login keychain.
// Also isolates tests from the user's real keychain entries.
process.env.PATCHWORK_TOKEN_STORAGE_BACKEND = "file";
process.env.PATCHWORK_HOME = testConfigDir;

// G-security A-PR1 path jail: production defaults reject `/tmp` (R2 C-2).
// Tests, however, depend on `os.tmpdir()` for hermetic temp dirs, so opt
// every worker into the tmp-jail at setup time. The opt-in is per-process
// env var — tests that explicitly want to assert "default OFF" pass
// `allowTmp: false` to `resolveRecipePath` directly.
process.env.CLAUDE_IDE_BRIDGE_RECIPE_TMP_JAIL = "1";

// Clean up the temp dir when the worker exits.
process.on("exit", () => {
  try {
    fs.rmSync(testConfigDir, { recursive: true, force: true });
  } catch {
    // best-effort
  }
});
