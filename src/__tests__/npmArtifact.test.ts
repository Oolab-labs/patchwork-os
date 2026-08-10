/**
 * Packaging guard: files the RUNTIME resolves by absolute path must actually
 * ship in the npm tarball.
 *
 * Why this exists: `patchwork-os init` registers a Claude Code PreToolUse hook
 * in the user's real `~/.claude/settings.json`, writing the absolute path that
 * `resolveHookScriptPath()` returns. In 1.1.0-beta.4 that script was excluded
 * from `files[]`, so an npm-installed user got a global CC config pointing at a
 * script that does not exist — the approval gate silently absent, on every tool
 * call, in every session. `npm run build` and the whole test suite stayed green,
 * because nothing here ever looked at the tarball.
 */
import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveHookScriptPath } from "../preToolUseHook.js";

const repoRoot = path.resolve(__dirname, "..", "..");

/**
 * File list `npm publish` would produce, without hitting the network.
 *
 * Runs through a shell deliberately. On Windows npm is `npm.cmd`, and since
 * the CVE-2024-27980 fix Node refuses to spawn a `.cmd`/`.bat` without a
 * shell — `execFileSync("npm", …)` fails ENOENT and `execFileSync("npm.cmd",
 * …)` fails EINVAL, which is exactly the pair CI walked through. A shell
 * resolves the shim via PATHEXT and works unchanged on POSIX. Passing one
 * command string rather than an args array also avoids Node's DEP0190
 * warning about unescaped args under `shell: true`; it is safe here because
 * the command is a constant with nothing interpolated into it.
 *
 * --ignore-scripts: `npm pack` otherwise runs the `prepare` lifecycle (husky),
 * which has no bearing on the file list and is not a test's business to fire.
 */
const PACK_CMD = "npm pack --dry-run --json --ignore-scripts";

function packedFiles(): string[] {
  const out = execSync(PACK_CMD, {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    timeout: 90_000,
  });
  const parsed = JSON.parse(out) as Array<{ files: Array<{ path: string }> }>;
  return (parsed[0]?.files ?? []).map((f) => f.path.replace(/\\/g, "/"));
}

describe("npm artifact", () => {
  it("ships the PreToolUse approval hook that init writes into ~/.claude/settings.json", () => {
    const hookPath = resolveHookScriptPath();

    // Guard the guard: if the script were merely missing from the repo, the
    // packing assertion below would fail for the wrong reason and this test
    // would stop meaning what it claims.
    expect(
      existsSync(hookPath),
      `${hookPath} does not exist in the repo — the packaging assertion below would be vacuous`,
    ).toBe(true);

    const relative = path.relative(repoRoot, hookPath).replace(/\\/g, "/");
    expect(packedFiles()).toContain(relative);
  }, 120_000);
});
