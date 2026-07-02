/**
 * Guard: unit tests must NEVER write the operator's real
 * `~/.patchwork/runs.jsonl`.
 *
 * `runYamlRecipe` persists a completed run to `deps.logDir ?? ~/.patchwork`
 * whenever `testMode` is off. Before the VITEST-aware default, a bare
 * `runYamlRecipe(recipe, deps)` in a test (no `testMode`, no `logDir`, no
 * `runLog`) defaulted `testMode` to `false` and appended a synthetic row to the
 * operator's live run log — which is also the de-facto worker-trust store and
 * rotates at 1 MB / 10k lines, so test rows evict real trust evidence and every
 * operator surface (halts, doctor, dashboard, push) reads noise.
 *
 * Per Bug Fix Protocol: the first test below FAILS on the pre-fix code (the
 * homedir file gets created) and passes once `testMode` defaults on under
 * vitest. The second test guards the explicit-persistence path — an explicit
 * `deps.testMode=false` + `logDir` override must still persist, and only to the
 * override dir, never homedir.
 */

import { existsSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type RunnerDeps,
  runYamlRecipe,
  type YamlRecipe,
} from "../yamlRunner.js";

// A recipe that runs one agent step to completion via a mocked driver — no
// network, no filesystem — so the only write attempted is the run-log append.
function probeRecipe(): YamlRecipe {
  return {
    name: "runlog-isolation-probe",
    trigger: { type: "manual" },
    steps: [{ agent: { prompt: "noop", into: "out", driver: "anthropic" } }],
  };
}

function agentDeps(overrides: Partial<RunnerDeps> = {}): RunnerDeps {
  return {
    claudeFn: vi.fn().mockResolvedValue("ok"),
    claudeCodeFn: vi.fn().mockResolvedValue("ok"),
    ...overrides,
  };
}

describe("run-log isolation — no unit test writes ~/.patchwork/runs.jsonl", () => {
  let fakeHome: string;
  let prevHome: string | undefined;
  let prevUserProfile: string | undefined;

  beforeEach(() => {
    fakeHome = mkdtempSync(path.join(os.tmpdir(), "runlog-iso-home-"));
    prevHome = process.env.HOME;
    prevUserProfile = process.env.USERPROFILE;
    // os.homedir() reads $HOME on POSIX and %USERPROFILE% on Windows, so
    // override BOTH to redirect the runner's default log dir (`~/.patchwork`)
    // into a throwaway directory on every platform. Without the USERPROFILE
    // override this guard is inert on the blocking windows-latest CI leg —
    // it would pass vacuously and, on pre-fix code, still pollute the real
    // %USERPROFILE%\.patchwork\runs.jsonl. (Same convention as
    // workerAutonomySmoke.test.ts.)
    process.env.HOME = fakeHome;
    process.env.USERPROFILE = fakeHome;
  });

  afterEach(() => {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    if (prevUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = prevUserProfile;
    rmSync(fakeHome, { recursive: true, force: true });
  });

  it("a bare runYamlRecipe under vitest writes nothing to $HOME/.patchwork/runs.jsonl", async () => {
    const runsPath = path.join(fakeHome, ".patchwork", "runs.jsonl");
    expect(existsSync(runsPath)).toBe(false);

    await runYamlRecipe(probeRecipe(), agentDeps());

    // The VITEST-aware `testMode` default must suppress the homedir persistence.
    expect(existsSync(runsPath)).toBe(false);
  });

  it("explicit deps.testMode=false + logDir override persists to the override dir, never homedir", async () => {
    const logDir = mkdtempSync(path.join(os.tmpdir(), "runlog-iso-log-"));
    try {
      await runYamlRecipe(
        probeRecipe(),
        agentDeps({ testMode: false, logDir }),
      );
      const homeRuns = path.join(fakeHome, ".patchwork", "runs.jsonl");
      const overrideRuns = path.join(logDir, "runs.jsonl");
      expect(existsSync(homeRuns)).toBe(false);
      expect(existsSync(overrideRuns)).toBe(true);
    } finally {
      rmSync(logDir, { recursive: true, force: true });
    }
  });
});
