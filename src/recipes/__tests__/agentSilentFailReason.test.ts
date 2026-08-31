/**
 * The agent silent-fail marker carries its own reason, and the halt sentence
 * threw it away.
 *
 * `detectSilentFail` returns `{ reason, matched }`. `reason` names WHICH
 * pattern fired ("agent step skipped or failed (string placeholder)") —
 * bookkeeping. `matched` is the marker itself, and that is where the cause
 * lives. The capture was deliberately widened to hold the whole marker, with a
 * comment recording why: a real refusal had been logging as the bare prefix
 * "[agent step failed:", "turning a precise safety message into an opaque
 * failure that had to be diagnosed by reading the source".
 *
 * The widening stopped one field short. `error` got `matched`; `haltReason` —
 * the field `patchwork halts`, `recipe doctor`, the run-detail page and the
 * dashboard's owner band all read — kept only `reason`.
 *
 * Measured over seven days on the reference machine: 9 halts, all rendered
 * with the identical contentless sentence, and TWO different causes underneath.
 * Six were `fetch failed` — the model endpoint was unreachable. Three were the
 * ADR-0021 information boundary refusing a dispatch and naming the one-line
 * remedy in its own message. A designed, correct, self-explaining safety
 * refusal was being reported as an agent malfunction with the fix hint
 * "inspect prompt + check trace".
 */

import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  type RunnerDeps,
  runYamlRecipe,
  type YamlRecipe,
} from "../yamlRunner.js";

const TMP = mkdtempSync(path.join(os.tmpdir(), "agent-silentfail-"));
afterAll(() => rmSync(TMP, { recursive: true, force: true }));

function runWithAgentResult(result: string) {
  const recipe = {
    name: "silent-fail-probe",
    trigger: { type: "manual" },
    steps: [{ agent: { prompt: "do it", driver: "local" }, into: "answer" }],
  } as unknown as YamlRecipe;
  const deps: RunnerDeps = {
    now: () => new Date("2026-08-31T09:00:00Z"),
    logDir: TMP,
    testMode: true,
    readFile: () => {
      throw new Error("nf");
    },
    writeFile: () => {},
    appendFile: () => {},
    mkdir: () => {},
    gitLogSince: () => "",
    gitStaleBranches: () => "",
    getDiagnostics: () => "",
    localFn: async () => result,
  } as unknown as RunnerDeps;
  return runYamlRecipe(recipe, deps);
}

describe("the halt sentence names what actually went wrong", () => {
  it("carries the information-boundary refusal, remedy and all", async () => {
    const marker =
      "[agent step failed: information boundary — set `driver: local` on this step; " +
      '"personal" may not leave the machine]';
    const result = await runWithAgentResult(marker);
    const halt = result.stepResults.find((s) => s.status === "error");
    expect(halt?.haltReason ?? "").toContain("information boundary");
    expect(halt?.haltReason ?? "").toContain("driver: local");
  });

  it("an unreachable model endpoint is a NETWORK failure, not an agent one", async () => {
    // Six of nine real halts. "inspect prompt + check trace" is the wrong
    // remedy for a connection that never opened.
    const result = await runWithAgentResult(
      "[agent step failed: fetch failed]",
    );
    const halt = result.stepResults.find((s) => s.status === "error");
    expect(halt?.haltReason ?? "").toContain("fetch failed");
    expect(halt?.haltCategory).toBe("network_error");
  });

  it("keeps agent_silent_fail when the marker names no known cause", async () => {
    const result = await runWithAgentResult(
      "[agent step failed: something nobody has a pattern for]",
    );
    const halt = result.stepResults.find((s) => s.status === "error");
    expect(halt?.haltCategory).toBe("agent_silent_fail");
  });

  it("the stored category is never CONTRADICTED by re-deriving it from the sentence", async () => {
    // `summariseHalts` trusts `haltCategory` when present and re-derives from
    // `haltReason` when it is not. Those two must not disagree — a row read one
    // way in the CLI and another way in a dashboard is worse than either.
    const { categoriseHaltReason } = await import("../haltCategory.js");
    for (const marker of [
      "[agent step failed: fetch failed]",
      "[agent step failed: ECONNREFUSED 127.0.0.1:11434]",
    ]) {
      const result = await runWithAgentResult(marker);
      const halt = result.stepResults.find((s) => s.status === "error");
      expect(categoriseHaltReason(halt?.haltReason)).toBe(halt?.haltCategory);
    }
  });

  it("`error` still carries the full detector output (unchanged)", async () => {
    const result = await runWithAgentResult(
      "[agent step failed: fetch failed]",
    );
    const halt = result.stepResults.find((s) => s.status === "error");
    expect(halt?.error ?? "").toContain("silent-fail detected");
  });
});
