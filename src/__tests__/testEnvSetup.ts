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

// Clean up the temp dir when the worker exits.
process.on("exit", () => {
  try {
    fs.rmSync(testConfigDir, { recursive: true, force: true });
  } catch {
    // best-effort
  }
});
