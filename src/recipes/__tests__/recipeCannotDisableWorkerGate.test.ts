/**
 * A recipe may opt out of the workspace TIER approval policy.
 * It may NEVER opt itself out of Worker governance.
 *
 * `requireApproval: false` is documented as a per-recipe opt-out of "the
 * flat-runner approval gate", and it was written before the worker-autonomy
 * gate existed. The two then composed in a way nobody chose: the worker gate is
 * injected as `requireApprovalFn`, so the flag suppressed BOTH — and
 * `recordGateDecision` lives inside that function.
 *
 * The consequence is worse than a missing approval. A recipe could switch off
 * the governance machinery that exists to govern it, by setting one boolean in
 * its own file, and the evidence simply stopped being written: no decision, no
 * `ruleId`, no `correlationId`. A run that governed nothing looks exactly like
 * a run that had nothing to govern.
 *
 * Found while trying to let two dogfood recipes accumulate unattended evidence:
 * the opt-out that would have unblocked them would also have erased the thing
 * being accumulated.
 */

import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import type {
  ChainedRecipe,
  ExecutionDeps,
  RunOptions,
} from "../chainedRunner.js";
import { executeChainedStep } from "../chainedRunner.js";
import { createOutputRegistry } from "../outputRegistry.js";
import {
  type RunnerDeps,
  runYamlRecipe,
  type YamlRecipe,
} from "../yamlRunner.js";

const TMP = mkdtempSync(path.join(os.tmpdir(), "opt-out-gate-"));
afterAll(() => rmSync(TMP, { recursive: true, force: true }));

function deps(extra: Partial<RunnerDeps> = {}): RunnerDeps {
  return {
    now: () => new Date("2026-08-31T09:00:00Z"),
    logDir: TMP,
    testMode: false,
    readFile: () => {
      throw new Error("nf");
    },
    writeFile: () => {},
    appendFile: () => {},
    mkdir: () => {},
    gitLogSince: () => "",
    gitStaleBranches: () => "",
    getDiagnostics: () => "",
    ...extra,
  };
}

/** `requireApproval: false` — the opt-out under test. */
function optedOutRecipe(): YamlRecipe {
  return {
    name: "opted-out",
    trigger: { type: "cron", at: "0 9 * * *" },
    requireApproval: false,
    steps: [{ tool: "file.write", path: `${TMP}/a`, content: "1" }],
  } as unknown as YamlRecipe;
}

describe("a recipe cannot opt out of worker governance", () => {
  it("STILL consults the gate when a worker owns the recipe", async () => {
    // `gateAutomatedRuns` is set exactly when `buildWorkerAutonomyGate`
    // returned a fn, so it is the runner's only signal that the injected
    // approval fn IS the worker gate rather than the tier gate.
    const gate = vi.fn(async () => true);
    await runYamlRecipe(
      optedOutRecipe(),
      deps({ requireApprovalFn: gate, gateAutomatedRuns: true }),
      {},
    );
    expect(
      gate,
      "the worker gate must run even though the recipe opted out",
    ).toHaveBeenCalled();
  });

  it("still HALTS when the worker gate refuses, opt-out or not", async () => {
    // The opt-out must not become a way to make a refusal advisory.
    const gate = vi.fn(async () => false);
    const result = await runYamlRecipe(
      optedOutRecipe(),
      deps({ requireApprovalFn: gate, gateAutomatedRuns: true }),
      {},
    );
    expect(gate).toHaveBeenCalled();
    expect(result.stepResults[0]?.status).toBe("error");
  });

  it("still SKIPS the tier gate when no worker owns the recipe", async () => {
    // The original behaviour, and the whole point of the flag. A non-worker
    // recipe opting out gets no approval prompt — unchanged.
    const tier = vi.fn(async () => true);
    await runYamlRecipe(
      optedOutRecipe(),
      deps({ requireApprovalFn: tier }), // no gateAutomatedRuns → tier only
      {},
    );
    expect(
      tier,
      "a non-worker recipe's opt-out still suppresses the tier gate",
    ).not.toHaveBeenCalled();
  });

  it("consults the gate normally when the recipe does NOT opt out", async () => {
    const gate = vi.fn(async () => true);
    const normal = {
      ...optedOutRecipe(),
      requireApproval: undefined,
      trigger: { type: "manual" },
    } as unknown as YamlRecipe;
    await runYamlRecipe(normal, deps({ requireApprovalFn: gate }), {});
    expect(gate).toHaveBeenCalled();
  });
});

describe("the same invariant holds on the chained runner", () => {
  // The chained path receives the flat runner's deps whole (`...runnerDeps`),
  // so it gets the worker gate too — and honoured `requireApproval: false`
  // unconditionally, with no signal that the injected fn was the worker gate.
  // Fixing only the flat path would leave the invariant half-true, which is the
  // "gate pointed at a subset" shape this repo has been bitten by before.
  const options: RunOptions = {
    env: {},
    maxConcurrency: 4,
    maxDepth: 3,
    dryRun: false,
  };
  const optedOut = {
    name: "chained-opted-out",
    steps: [],
    requireApproval: false,
  } as unknown as ChainedRecipe;

  function run(deps: Partial<ExecutionDeps>) {
    return executeChainedStep(
      {
        registry: createOutputRegistry(),
        step: { id: "s", tool: "github.list_prs" },
        options,
        recipe: optedOut,
        depth: 0,
      } as unknown as Parameters<typeof executeChainedStep>[0],
      {
        executeTool: vi.fn().mockResolvedValue({ ok: true }),
        executeAgent: vi.fn(),
        loadNestedRecipe: vi.fn().mockResolvedValue(null),
        ...deps,
      } as unknown as ExecutionDeps,
    );
  }

  it("STILL consults the gate when the worker gate is the injected fn", async () => {
    const gate = vi.fn(async () => true);
    await run({ requireApprovalFn: gate, gateAutomatedRuns: true });
    expect(gate).toHaveBeenCalled();
  });

  it("still SKIPS the tier gate when it is not the worker gate", async () => {
    const tier = vi.fn(async () => true);
    await run({ requireApprovalFn: tier });
    expect(tier).not.toHaveBeenCalled();
  });
});
