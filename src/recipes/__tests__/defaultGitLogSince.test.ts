/**
 * Regression test for `defaultGitLogSince`.
 *
 * Caught in the post-merge tool audit (docs/dogfood/tool-audit.md): the
 * function returned the literal string `(git log unavailable)` on any
 * failure, which the runner saw as success-with-empty-data. Downstream
 * agents summarized "no recent commits" — false signal.
 *
 * Fix returns a `{ok:false,error}` JSON shape on failure so the runner's
 * existing JSON-error detection (and #72's silent-fail detector) flag
 * the step as `error`. Successful runs still return bare git output.
 */

import { execSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defaultGitLogSince } from "../yamlRunner.js";

let repoDir: string;

beforeEach(() => {
  repoDir = mkdtempSync(path.join(os.tmpdir(), "git-log-since-"));
  execSync("git init -q -b main", { cwd: repoDir });
  execSync("git config user.email t@t.local && git config user.name t", {
    cwd: repoDir,
    shell: "/bin/bash",
  });
});

afterEach(() => {
  rmSync(repoDir, { recursive: true, force: true });
});

describe("defaultGitLogSince", () => {
  it("returns oneline log on success", () => {
    writeFileSync(path.join(repoDir, "a.txt"), "x");
    execSync("git add . && git commit -q -m 'first commit'", {
      cwd: repoDir,
      shell: "/bin/bash",
    });
    const out = defaultGitLogSince("1 year ago", repoDir);
    // Bare git oneline output (NOT a JSON shape on success).
    expect(out).toMatch(/[a-f0-9]{7,}\s+first commit/);
  });

  it("returns JSON error shape when run outside a git repo", () => {
    const nonRepo = mkdtempSync(path.join(os.tmpdir(), "not-a-repo-"));
    try {
      const out = defaultGitLogSince("1 day ago", nonRepo);
      // Now the failure is detectable: parses as JSON with ok:false.
      const parsed = JSON.parse(out) as { ok: boolean; error: string };
      expect(parsed.ok).toBe(false);
      expect(parsed.error).toMatch(/git log/i);
    } finally {
      rmSync(nonRepo, { recursive: true, force: true });
    }
  });

  it("does NOT return the bare '(git log unavailable)' placeholder anymore", () => {
    const nonRepo = mkdtempSync(path.join(os.tmpdir(), "not-a-repo-"));
    try {
      const out = defaultGitLogSince("1 day ago", nonRepo);
      // Regression sentinel: the OLD code returned the literal placeholder.
      // The fix returns a JSON shape instead so the runner can detect failure.
      expect(out).not.toBe("(git log unavailable)");
      expect(() => JSON.parse(out)).not.toThrow();
    } finally {
      rmSync(nonRepo, { recursive: true, force: true });
    }
  });
});
