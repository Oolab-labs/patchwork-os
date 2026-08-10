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
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveHookScriptPath } from "../preToolUseHook.js";

const repoRoot = path.resolve(__dirname, "..", "..");

/** File list `npm publish` would produce, without hitting the network. */
function packedFiles(): string[] {
  const out = execFileSync("npm", ["pack", "--dry-run", "--json"], {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
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
  }, 60_000);
});
