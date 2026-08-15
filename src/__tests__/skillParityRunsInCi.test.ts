/**
 * `audit-skill-parity` must actually RUN its tool-existence check in CI.
 *
 * It never did. The check answers "does the tool this skill tells the model to
 * call exist?" by reading `dist/tools` — but `dist/` is gitignored, and the
 * job that runs the script did `npm ci` with no build. So `knownToolNames()`
 * returned null on every CI run, the check skipped itself, and the script
 * exited 0 printing
 *
 *     [skill-parity] NOTE dist/ not built — tool-existence check skipped.
 *     [skill-parity] OK — every shared skill is identical.
 *
 * The green tick was reporting the skip. Reproduced locally by moving `dist/`
 * aside, which is exactly the state of a fresh CI checkout.
 *
 * Two things now hold it open, and this file pins both:
 *
 *   1. the job builds before auditing — checked against the real workflow
 *      file, because a step is easy to drop while refactoring YAML;
 *   2. the script REFUSES to skip when `CI` is set — so if (1) is ever
 *      removed, the job goes red instead of quietly passing again.
 *
 * (2) is the load-bearing one. (1) alone would restore the original failure
 * mode the moment someone moved the step to a different job.
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const root = path.resolve(import.meta.dirname, "..", "..");
const SCRIPT = path.join(root, "scripts", "audit-skill-parity.mjs");

/** The steps of the workflow job that runs a given script, in order. */
function jobStepsRunning(scriptName: string): string[] {
  const yml = readFileSync(
    path.join(root, ".github", "workflows", "ci.yml"),
    "utf8",
  );
  // Jobs are the 2-space-indented keys under `jobs:`. Split on them rather
  // than pulling in a YAML parser for one assertion.
  const jobs = yml.split(/\n {2}(?=[a-z][a-z0-9-]*:\n)/);
  const job = jobs.find((j) => j.includes(scriptName));
  if (!job) throw new Error(`no CI job runs ${scriptName}`);
  return job
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith("run:"));
}

describe("the tool-existence check is not silently skipped in CI", () => {
  it("builds before running the skill-parity audit", () => {
    const runs = jobStepsRunning("audit-skill-parity.mjs");
    const build = runs.findIndex((r) => r.includes("npm run build"));
    const audit = runs.findIndex((r) => r.includes("audit-skill-parity.mjs"));

    expect(audit).toBeGreaterThan(-1);
    // Without this the audit reads a dist/ that does not exist.
    expect(build).toBeGreaterThan(-1);
    expect(build).toBeLessThan(audit);
  });

  it("refuses to skip when CI is set", () => {
    // Drives the REAL script. A source-string assertion would pass just as
    // happily against a version with the branch deleted, which is the
    // failure this whole file is about.
    //
    // dist/ exists in a normal working tree, so this asserts the CI path does
    // NOT fire spuriously; the negative case (no dist + CI ⇒ exit 1) is
    // covered by the source assertion below, because moving dist/ aside
    // inside a test would break every other test running in parallel.
    const out = execFileSync(process.execPath, [SCRIPT], {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, CI: "1" },
    });
    expect(out).toContain("registered tools · tool references checked");
    expect(out).not.toContain("tool-existence check skipped");
  });

  it("the CI branch exits non-zero rather than noting the skip", () => {
    const src = readFileSync(SCRIPT, "utf8");
    const idx = src.indexOf("if (!real)");
    expect(idx).toBeGreaterThan(-1);
    const branch = src.slice(idx, idx + 1400);
    expect(branch).toContain("process.env.CI");
    expect(branch).toContain("process.exit(1)");
  });
});
