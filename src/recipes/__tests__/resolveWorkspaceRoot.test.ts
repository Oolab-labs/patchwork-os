/**
 * Tests for `resolveWorkspaceRoot` — recipe workspace-root resolution.
 *
 * Diagnosed by the 2026-05-20 `improvement-research` run (top HIGH proposal
 * P2): the bridge LaunchAgent sets `WorkingDirectory: __HOME__`, so recipe
 * agent-step subprocesses inherit `$HOME` as cwd. Steps that shell out to
 * `git log` / `npm audit` / project scripts then fail with
 * `fatal: not a git repository` — recorded as the catch-all
 * `agent_silent_fail` (231/232 halts on 2026-05-20). The fix is a workspace
 * resolver the runner uses before spawning, plus a `recipe_no_workspace`
 * halt reason when nothing usable is found.
 *
 * Resolution precedence (highest first):
 *   1. `explicitPath` — from a recipe-level `workspace:` field
 *   2. `PATCHWORK_WORKSPACE` env var
 *   3. Walk up from `startDir` (default `process.cwd()`) looking for `.git`
 *   4. null — caller halts with `recipe_no_workspace`
 */

import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveWorkspaceRoot } from "../workspaceRoot.js";

let tmp: string;
let savedEnv: string | undefined;

beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), "pw-workspace-"));
  savedEnv = process.env.PATCHWORK_WORKSPACE;
  delete process.env.PATCHWORK_WORKSPACE;
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  if (savedEnv === undefined) delete process.env.PATCHWORK_WORKSPACE;
  else process.env.PATCHWORK_WORKSPACE = savedEnv;
});

describe("resolveWorkspaceRoot", () => {
  it("walks up to find the nearest ancestor with .git", () => {
    execSync("git init -q -b main", { cwd: tmp });
    const nested = path.join(tmp, "a", "b", "c");
    mkdirSync(nested, { recursive: true });

    const got = resolveWorkspaceRoot({ startDir: nested });

    expect(got).not.toBeNull();
    expect(got?.path).toBe(tmp);
    expect(got?.source).toBe("git-ancestor");
  });

  it("returns null when no .git ancestor exists and no env/explicit is set", () => {
    // Mimics the bug: cwd is `$HOME` with no git ancestor → recipe must
    // refuse to run steps that need a workspace.
    const got = resolveWorkspaceRoot({ startDir: tmp });
    expect(got).toBeNull();
  });

  it("honors PATCHWORK_WORKSPACE env var above the git walk", () => {
    execSync("git init -q -b main", { cwd: tmp });
    const other = mkdtempSync(path.join(os.tmpdir(), "pw-workspace-env-"));
    try {
      process.env.PATCHWORK_WORKSPACE = other;
      const got = resolveWorkspaceRoot({ startDir: tmp });
      expect(got?.path).toBe(path.resolve(other));
      expect(got?.source).toBe("env");
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });

  it("honors explicitPath above PATCHWORK_WORKSPACE and the git walk", () => {
    execSync("git init -q -b main", { cwd: tmp });
    const explicit = mkdtempSync(path.join(os.tmpdir(), "pw-workspace-x-"));
    try {
      process.env.PATCHWORK_WORKSPACE = tmp;
      const got = resolveWorkspaceRoot({
        startDir: tmp,
        explicitPath: explicit,
      });
      expect(got?.path).toBe(path.resolve(explicit));
      expect(got?.source).toBe("explicit");
    } finally {
      rmSync(explicit, { recursive: true, force: true });
    }
  });

  it("returns an absolute path even when input is relative", () => {
    execSync("git init -q -b main", { cwd: tmp });
    const got = resolveWorkspaceRoot({ explicitPath: tmp });
    expect(got).not.toBeNull();
    expect(path.isAbsolute(got!.path)).toBe(true);
  });

  it("rejects non-existent explicit paths (caller must halt loudly)", () => {
    const missing = path.join(tmp, "does", "not", "exist");
    const got = resolveWorkspaceRoot({ explicitPath: missing });
    expect(got).toBeNull();
  });
});
