/**
 * The live-model tripwire.
 *
 * A test that runs an agent step without injecting an executor falls through
 * to the DEFAULT driver implementations. Two of them need no credential:
 * `defaultLocalFn` posts to `LOCAL_ENDPOINT`, and `defaultClaudeCodeFn`
 * spawns the subscription CLI. On a developer laptop both succeed — so the
 * test passed, a real model was called, and nothing said so. That is exactly
 * what happened while building fan_out agent sub-steps: an un-pinned `driver`
 * plus a config that said `model: "local"` produced a genuine ~3s completion
 * from inside a unit test.
 *
 * `testEnvSetup` sets `PATCHWORK_TEST_NO_LIVE_MODELS=1` for every worker.
 * These tests prove the guard actually fires — a tripwire that never trips is
 * indistinguishable from one that is broken — and that the documented escape
 * hatch works, since tests which exercise the default fns on purpose need it.
 */

import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type RunnerDeps,
  runYamlRecipe,
  type YamlRecipe,
} from "../recipes/yamlRunner.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), "live-guard-"));
});
afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.PATCHWORK_TEST_ALLOW_LIVE;
});

/** Deliberately omits claudeFn / localFn / claudeCodeFn. */
function bareDeps(): RunnerDeps {
  return {
    testMode: true,
    now: () => new Date("2026-08-05T08:00:00Z"),
    logDir: tmpDir,
    readFile: () => {
      throw new Error("not found");
    },
    writeFile: () => {},
    appendFile: () => {},
    mkdir: () => {},
    gitLogSince: () => "",
    gitStaleBranches: () => "",
    getDiagnostics: () => "",
  } as RunnerDeps;
}

function agentRecipe(driver: string): YamlRecipe {
  return {
    name: "live-guard",
    trigger: { type: "manual" },
    steps: [{ agent: { prompt: "hello", driver, into: "out" } }],
  } as unknown as YamlRecipe;
}

describe("live-model tripwire", () => {
  it("is armed in every test worker", () => {
    expect(process.env.PATCHWORK_TEST_NO_LIVE_MODELS).toBe("1");
  });

  it("refuses the local driver when no localFn is injected", async () => {
    const result = await runYamlRecipe(agentRecipe("local"), bareDeps());
    const text = JSON.stringify(result);
    expect(text).toMatch(/test-guard/);
    expect(text).toMatch(/LOCAL_ENDPOINT/);
    // The message must say what to do, not just that something went wrong.
    expect(text).toMatch(/Pin `driver:`|inject the matching fn/);
  });

  it("refuses the claude-code driver when no claudeCodeFn is injected", async () => {
    const result = await runYamlRecipe(agentRecipe("claude-code"), bareDeps());
    expect(JSON.stringify(result)).toMatch(/test-guard/);
    expect(JSON.stringify(result)).toMatch(/claude CLI subprocess/);
  });

  it("lets a test opt out when the live call IS the point", async () => {
    process.env.PATCHWORK_TEST_ALLOW_LIVE = "1";
    // With the guard off, the default fn runs. LOCAL_ENDPOINT is unset in a
    // test worker, so it fails on its own terms — the assertion is that the
    // GUARD is what stepped aside, not that a model answered.
    const result = await runYamlRecipe(agentRecipe("local"), bareDeps());
    expect(JSON.stringify(result)).not.toMatch(/test-guard/);
  });

  it("does not interfere with an injected executor", async () => {
    let called = 0;
    const result = await runYamlRecipe(agentRecipe("local"), {
      ...bareDeps(),
      localFn: async () => {
        called++;
        return "mocked";
      },
    } as RunnerDeps);
    expect(called).toBe(1);
    expect(JSON.stringify(result)).not.toMatch(/test-guard/);
  });

  it("leaves the keyless anthropic path alone (it already fails closed)", async () => {
    // `defaultClaudeFn` returns a skip marker without ANTHROPIC_API_KEY, so
    // guarding it unconditionally would break the tests that assert exactly
    // that behaviour. Only guarded when a key is actually present.
    const previous = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      const result = await runYamlRecipe(agentRecipe("anthropic"), bareDeps());
      expect(JSON.stringify(result)).not.toMatch(/test-guard/);
      // It reaches `defaultClaudeFn`, which returns its skip marker without
      // networking; the runner then reports that as a silent fail. The marker
      // arrives truncated ("[agent step skipped:") because the silent-fail
      // detector cuts it — so match the category, not the full sentence.
      expect(result.stepResults[0]?.haltCategory).toBe("agent_silent_fail");
      expect(JSON.stringify(result)).toMatch(/agent step skipped/);
    } finally {
      if (previous !== undefined) process.env.ANTHROPIC_API_KEY = previous;
    }
  });

  it("refuses the anthropic path when a real key IS present", async () => {
    const previous = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = "sk-ant-test-not-a-real-key";
    try {
      const result = await runYamlRecipe(agentRecipe("anthropic"), bareDeps());
      expect(JSON.stringify(result)).toMatch(/test-guard/);
    } finally {
      if (previous === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = previous;
    }
  });
});
