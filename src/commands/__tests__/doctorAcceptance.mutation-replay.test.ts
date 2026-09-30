/**
 * Mutation: replay re-dispatches live (no captured outputs, no replay
 * boundary) ⇒ `replay` must FAIL.
 */
import os from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";

vi.mock("../../recipes/replayRun.js", async (orig) => {
  const actual = await orig<typeof import("../../recipes/replayRun.js")>();
  const { runYamlRecipe } = await import("../../recipes/yamlRunner.js");
  return {
    ...actual,
    replayFlatMockedRun: async (
      opts: Parameters<typeof actual.replayFlatMockedRun>[0],
    ) => {
      const result = await runYamlRecipe(opts.recipe, {
        ...opts.deps.runnerDeps,
        runLog: opts.deps.runLog,
        testMode: false,
      });
      return { ok: !result.errorMessage, result };
    },
  };
});

import { runAcceptance } from "../doctorAcceptance.js";

it("replay FAILS when a replay dispatches the tool live", async () => {
  const r = await runAcceptance({
    lockDir: path.join(os.tmpdir(), "no-such-lock-dir"),
    buildTimeMs: Date.now(),
  });
  const c = r.checks.find((x) => x.name === "replay");
  expect(c?.ok).toBe(false);
  expect(c?.detail).toMatch(/1 new request/);
  expect(r.ok).toBe(false);
}, 30_000);
