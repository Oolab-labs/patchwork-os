/**
 * Integration test: `defaultClaudeCodeFn` threads the resolved workspace
 * root into `spawnSync` as `cwd`, instead of inheriting `$HOME` from the
 * bridge LaunchAgent.
 *
 * Unit tests for `resolveWorkspaceRoot` prove the helper logic; this test
 * proves the wiring — a real subprocess launched by `defaultClaudeCodeFn`
 * lands in the workspace dir, not in whatever cwd the test runner happens
 * to use. Uses a fake `claude` shell script (via `PATCHWORK_CLAUDE_BINARY`)
 * that prints its own `pwd`, so the assertion is end-to-end through the
 * real spawn — no mocks of `node:child_process`.
 *
 * Bug context: P2 of the 2026-05-20 improvement-research run — the bridge
 * LaunchAgent sets WorkingDirectory=$HOME, so agent steps shelling out to
 * git/npm/project scripts failed with "fatal: not a git repository"
 * (231/232 silent-fail halts).
 */

import { execSync } from "node:child_process";
import {
  chmodSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defaultClaudeCodeFn } from "../yamlRunner.js";

let workspace: string;
let fakeBinDir: string;
let savedBinary: string | undefined;
let savedWorkspace: string | undefined;

beforeEach(() => {
  // Real git repo so resolveWorkspaceRoot's git-ancestor walk could find
  // it if needed. Tests below set PATCHWORK_WORKSPACE explicitly so the
  // path through the resolver is deterministic regardless of where the
  // test runner is launched from.
  workspace = mkdtempSync(path.join(os.tmpdir(), "pw-cwd-ws-"));
  execSync("git init -q -b main", { cwd: workspace });

  // Fake `claude` binary: prints its cwd. Mirrors how a real run would
  // behave when `harvest_internal` shells out — but for the spawn path
  // itself, not the LLM behaviour.
  fakeBinDir = mkdtempSync(path.join(os.tmpdir(), "pw-cwd-bin-"));
  const fakeClaude = path.join(fakeBinDir, "claude");
  writeFileSync(fakeClaude, "#!/bin/sh\npwd\n");
  chmodSync(fakeClaude, 0o755);

  savedBinary = process.env.PATCHWORK_CLAUDE_BINARY;
  savedWorkspace = process.env.PATCHWORK_WORKSPACE;
  process.env.PATCHWORK_CLAUDE_BINARY = fakeClaude;
});

afterEach(() => {
  rmSync(workspace, { recursive: true, force: true });
  rmSync(fakeBinDir, { recursive: true, force: true });
  if (savedBinary === undefined) delete process.env.PATCHWORK_CLAUDE_BINARY;
  else process.env.PATCHWORK_CLAUDE_BINARY = savedBinary;
  if (savedWorkspace === undefined) delete process.env.PATCHWORK_WORKSPACE;
  else process.env.PATCHWORK_WORKSPACE = savedWorkspace;
});

describe("defaultClaudeCodeFn — workspace cwd threading", () => {
  it("spawns the agent subprocess with cwd = PATCHWORK_WORKSPACE", async () => {
    process.env.PATCHWORK_WORKSPACE = workspace;
    const out = await defaultClaudeCodeFn("ignored — fake binary");
    // `pwd` on macOS may resolve /var → /private/var; compare via realpath.
    expect(realpathSync(out)).toBe(realpathSync(workspace));
  });

  it("returns the typed recipe_no_workspace error when no workspace resolves", async () => {
    // No env var, no .git ancestor of a deeply-nested tmpdir.
    const isolated = mkdtempSync(path.join(os.tmpdir(), "pw-cwd-isolated-"));
    const originalCwd = process.cwd();
    try {
      process.chdir(isolated);
      const out = await defaultClaudeCodeFn("ignored");
      expect(out).toMatch(/^\[agent step failed: recipe_no_workspace\b/);
      // Must mention how to fix it — operators reading the halt log need
      // the env var name + the recipe field as actionable info.
      expect(out).toMatch(/PATCHWORK_WORKSPACE/);
      expect(out).toMatch(/workspace:/);
    } finally {
      process.chdir(originalCwd);
      rmSync(isolated, { recursive: true, force: true });
    }
  });
});
