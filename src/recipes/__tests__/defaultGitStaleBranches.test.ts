/**
 * Regression test for `defaultGitStaleBranches`.
 *
 * Caught dogfooding the `branch-health` recipe: the implementation used
 * `git branch --since=<date>`, but `--since` is NOT a valid flag on
 * `git branch` (git exits 129 with `error: unknown option`). The
 * function ALWAYS returned the `(git branches unavailable)` placeholder
 * — the agent in the recipe correctly flagged "data unavailable".
 *
 * Fix uses `git for-each-ref` + JS-side date parse to identify branches
 * whose last commit is OLDER than the cutoff (true "stale" semantics —
 * the previous code's `--since` would have inverted the meaning even
 * if the flag had existed).
 */

import { execSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defaultGitStaleBranches } from "../yamlRunner.js";

let repoDir: string;

beforeEach(() => {
  repoDir = mkdtempSync(path.join(os.tmpdir(), "stale-branches-"));
  // init repo with a default branch + one commit
  execSync("git init -q -b main", { cwd: repoDir });
  execSync("git config user.email t@t.local && git config user.name t", {
    cwd: repoDir,
    shell: "/bin/bash",
  });
  writeFileSync(path.join(repoDir, "f.txt"), "hello\n");
  execSync("git add . && git commit -q -m init", {
    cwd: repoDir,
    shell: "/bin/bash",
  });
});

afterEach(() => {
  rmSync(repoDir, { recursive: true, force: true });
});

function commitOnNewBranch(name: string, ageDays: number) {
  execSync(`git checkout -q -b ${name}`, { cwd: repoDir });
  writeFileSync(path.join(repoDir, `${name}.txt`), name);
  const ts = new Date(Date.now() - ageDays * 86_400_000).toISOString();
  // Backdate both AUTHOR and COMMITTER so for-each-ref's committerdate
  // sort matches the simulated age.
  execSync(`git add . && git commit -q -m '${name}'`, {
    cwd: repoDir,
    shell: "/bin/bash",
    env: {
      ...process.env,
      GIT_AUTHOR_DATE: ts,
      GIT_COMMITTER_DATE: ts,
    },
  });
  // Return to main so subsequent commits don't pile up on the new branch.
  execSync("git checkout -q main", { cwd: repoDir });
}

describe("defaultGitStaleBranches", () => {
  it("returns branches with last commit older than the cutoff", () => {
    commitOnNewBranch("ancient", 90);
    commitOnNewBranch("kinda-old", 45);
    commitOnNewBranch("fresh", 1);

    const out = defaultGitStaleBranches(30, repoDir);
    // Stale: ancient (90d) + kinda-old (45d). Fresh (1d) excluded. main:
    // committed during beforeEach (~now), excluded.
    expect(out).toContain("ancient");
    expect(out).toContain("kinda-old");
    expect(out).not.toContain("fresh");
    // Format: branch \t YYYY-MM-DD per line
    for (const line of out.split("\n")) {
      expect(line).toMatch(/^[a-z0-9_-]+\t\d{4}-\d{2}-\d{2}$/);
    }
  });

  it("emits a clean 'no stale branches' message when none exceed the cutoff", () => {
    commitOnNewBranch("recent", 5);
    const out = defaultGitStaleBranches(30, repoDir);
    expect(out).toBe("(no branches inactive >30d)");
  });

  it("returns the unavailable placeholder when git fails", () => {
    // Point at a non-git directory to force a non-zero exit.
    const nonRepo = mkdtempSync(path.join(os.tmpdir(), "not-a-repo-"));
    try {
      const out = defaultGitStaleBranches(30, nonRepo);
      expect(out).toBe("(git branches unavailable)");
    } finally {
      rmSync(nonRepo, { recursive: true, force: true });
    }
  });

  // Regression sentinel: prove the original `git branch --since=...` form
  // doesn't work, so the new implementation actually had to change.
  it("regression sentinel: 'git branch --since=...' was never a valid flag", () => {
    const r = spawnSync(
      "git",
      ["branch", "--no-column", "--sort=-committerdate", "--since=2026-01-01"],
      { cwd: repoDir, encoding: "utf-8" },
    );
    expect(r.status).not.toBe(0);
    expect(`${r.stderr}`).toMatch(/unknown option `since/);
  });
});
