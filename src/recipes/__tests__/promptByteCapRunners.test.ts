/**
 * Gap 7 — the prompt byte cap as the RUNNERS see it.
 *
 * `promptByteCap.test.ts` pins the decision at the seam. This file pins that
 * every path which can reach the seam actually does, and that the refusal
 * arrives as a halted step rather than a silently-skipped one:
 *
 *   T7   flat runner agent step
 *   T8   chained runner (through the injected executor)
 *   T9   fan_out per-item agent
 *   T10  a judge/refine REVISION
 *
 * Each dispatches a real driver dep, so "the model was not called" is checked
 * where it matters — a cap that only formats a message would pass a runner test
 * written against the returned text alone.
 */

import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { MAX_AGENT_PROMPT_BYTES } from "../agentExecutor.js";
import {
  buildChainedDeps,
  type RunnerDeps,
  runYamlRecipe,
  type YamlRecipe,
} from "../yamlRunner.js";

const TMP = mkdtempSync(path.join(os.tmpdir(), "prompt-cap-runners-"));
afterAll(() => rmSync(TMP, { recursive: true, force: true }));

const OVER = "a".repeat(MAX_AGENT_PROMPT_BYTES + 1);

function baseDeps(overrides: Partial<RunnerDeps> = {}): RunnerDeps {
  return {
    now: () => new Date("2026-09-03T09:00:00Z"),
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
    ...overrides,
  } as unknown as RunnerDeps;
}

// ── T7: flat runner ──────────────────────────────────────────────────────────

describe("flat runner", () => {
  it("halts the step with prompt_too_large and never calls the driver", async () => {
    const localFn = vi.fn(async () => "should not be reached");
    const recipe = {
      name: "prompt-cap-flat",
      trigger: { type: "manual" },
      steps: [{ agent: { prompt: OVER, driver: "local" }, into: "answer" }],
    } as unknown as YamlRecipe;

    const result = await runYamlRecipe(recipe, baseDeps({ localFn }));
    const halt = result.stepResults.find((s) => s.status === "error");

    expect(localFn).not.toHaveBeenCalled();
    // An over-cap step must HALT, not skip: a skipped step finishes the run
    // `done`, which is the failure mode the unregistered-tool path already has
    // and the one an operator cannot see.
    expect(halt).toBeDefined();
    expect(halt?.haltReason ?? "").toContain("prompt_too_large");
  });

  it("control: an under-cap step dispatches and succeeds", async () => {
    const localFn = vi.fn(async () => "real answer");
    const recipe = {
      name: "prompt-cap-flat-ok",
      trigger: { type: "manual" },
      steps: [{ agent: { prompt: "small", driver: "local" }, into: "answer" }],
    } as unknown as YamlRecipe;

    const result = await runYamlRecipe(recipe, baseDeps({ localFn }));
    expect(localFn).toHaveBeenCalledTimes(1);
    expect(
      result.stepResults.find((s) => s.status === "error"),
    ).toBeUndefined();
  });
});

// ── T9: fan_out per-item agent ───────────────────────────────────────────────

describe("fan_out agent iterations", () => {
  it("refuses the over-cap iteration without dispatching it", async () => {
    const localFn = vi.fn(async () => "should not be reached");
    const recipe = {
      name: "prompt-cap-fanout",
      trigger: { type: "manual" },
      steps: [
        {
          tool: "fan_out",
          items: ["one", "two"],
          as: "item",
          do: { agent: { prompt: `${OVER}{{item}}`, driver: "local" } },
          into: "results",
        },
      ],
    } as unknown as YamlRecipe;

    const result = await runYamlRecipe(recipe, baseDeps({ localFn }));
    expect(localFn).not.toHaveBeenCalled();
    const halt = result.stepResults.find((s) => s.status === "error");
    expect(halt?.haltReason ?? "").toContain("prompt_too_large");
  });

  it("control: under-cap iterations each dispatch once", async () => {
    const localFn = vi.fn(async () => "ok");
    const recipe = {
      name: "prompt-cap-fanout-ok",
      trigger: { type: "manual" },
      steps: [
        {
          tool: "fan_out",
          items: ["one", "two"],
          as: "item",
          do: { agent: { prompt: "handle {{item}}", driver: "local" } },
          into: "results",
        },
      ],
    } as unknown as YamlRecipe;

    await runYamlRecipe(recipe, baseDeps({ localFn }));
    expect(localFn).toHaveBeenCalledTimes(2);
  });
});

// ── T10: a judge/refine revision ─────────────────────────────────────────────

describe("judge / refine", () => {
  it("an over-cap revision refuses without dispatching, and is not counted as a completed revision", async () => {
    // First pass is small and succeeds; the revision prompt carries the
    // (over-cap) prior output back in, which is how a revision grows past a
    // limit the original pass sat under.
    const localFn = vi.fn(async () => OVER);
    const recipe = {
      name: "prompt-cap-revision",
      trigger: { type: "manual" },
      steps: [
        {
          agent: {
            prompt: "draft something",
            driver: "local",
            reviews: "answer",
            max_revisions: 1,
          },
          into: "answer",
        },
      ],
    } as unknown as YamlRecipe;

    const result = await runYamlRecipe(recipe, baseDeps({ localFn }));
    const halt = result.stepResults.find((s) => s.status === "error");
    expect(halt?.haltReason ?? "").toContain("prompt_too_large");
    // The revision that never dispatched must not be recorded as one that did.
    expect(halt?.revisions ?? 0).toBe(0);
  });
});

// ── T8: chained runner ───────────────────────────────────────────────────────

describe("chained runner", () => {
  // The chained runner receives `executeAgent` as an injected dep, so mocking
  // that dep would test the mock. The property that matters is that the
  // PRODUCTION wiring — the closure `buildChainedDeps` hands it — routes
  // through the real seam, and therefore inherits the cap for free.
  it("its production executor refuses an over-cap prompt without dispatching", async () => {
    const localFn = vi.fn(async () => "should not be reached");
    const deps = buildChainedDeps(baseDeps({ localFn }));

    const result = await deps.executeAgent(OVER, undefined, "local");

    expect(localFn).not.toHaveBeenCalled();
    const text = typeof result === "string" ? result : result.text;
    expect(text).toContain("prompt_too_large");
  });

  it("control: an under-cap prompt dispatches once", async () => {
    const localFn = vi.fn(async () => "real answer");
    const deps = buildChainedDeps(baseDeps({ localFn }));

    await deps.executeAgent("small", undefined, "local");

    expect(localFn).toHaveBeenCalledTimes(1);
  });
});
