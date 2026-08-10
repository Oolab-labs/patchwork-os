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
  const parsed: unknown = JSON.parse(out);

  // npm changed this shape in v12: an ARRAY of pack results became an OBJECT
  // keyed by package name. The publish workflow runs `npm install -g npm@latest`
  // before testing, so it hit v12 while every PR job was still on v11 — the
  // release failed on a test that had been green all day. Accept both.
  //
  //   npm 11: [ { files: [ { path } ] } ]
  //   npm 12: { "patchwork-os": { files: [ { path } ] } }
  const entries = Array.isArray(parsed)
    ? (parsed as Array<{ files?: Array<{ path: string }> }>)
    : Object.values(
        (parsed ?? {}) as Record<string, { files?: Array<{ path: string }> }>,
      );
  const files = entries.flatMap((e) => e?.files ?? []);

  // Fail loudly on the NEXT shape change rather than returning an empty list.
  // Without this the failure reads "expected [] to include <path>", which
  // accuses the packaging of a defect the packaging does not have — and an
  // assertion phrased the other way round would have passed vacuously.
  if (files.length === 0) {
    throw new Error(
      `npm pack returned no files — likely another --json shape change ` +
        `(npm ${execSync("npm -v", { encoding: "utf8" }).trim()}). ` +
        `Raw output began: ${out.slice(0, 200)}`,
    );
  }
  return files.map((f) => f.path.replace(/\\/g, "/"));
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
