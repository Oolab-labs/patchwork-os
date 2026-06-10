/**
 * What-If Preview (P2) — trace-seeded mocked sandbox tests.
 *
 * These prove the non-negotiable safety invariant (ZERO real I/O, ZERO
 * persistence), the history-wins synthesis rule, the determinable-branch rule,
 * the routing hard guards, and the v2 schema.
 */

import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { Ajv } from "ajv";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RecipeDryRunPlan } from "../../../commands/recipe.js";
import { type RecipeRun, RecipeRunLog } from "../../../runLog.js";
import type { ChainedRecipe } from "../../chainedRunner.js";
import { generateSimulationSchema } from "../../schemaGenerator.js";
import {
  extractReferencedStepIds,
  simulateMockedFromPlan,
} from "../simulate.js";
import { createStubDeps, simulateMockedRun } from "../simulateMockedRun.js";
import { synthesizeMockedOutputs } from "../synthesizeMockedOutputs.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), "p2-mocked-"));
});
afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

/** Build an in-memory-backed RecipeRunLog seeded with the given runs. */
function makeRunLog(runs: Array<Partial<RecipeRun> & { recipeName: string }>): {
  log: RecipeRunLog;
  dir: string;
} {
  const dir = mkdtempSync(path.join(os.tmpdir(), "p2-runlog-"));
  const log = new RecipeRunLog({ dir });
  // Seed via the documented public startRun/completeRun lifecycle so query()
  // returns these runs newest-first.
  let seq = 0;
  for (const r of runs) {
    seq += 1;
    const startedSeq = log.startRun({
      taskId: `chained:${r.recipeName}:${seq}`,
      recipeName: r.recipeName,
      trigger: "recipe",
      createdAt: r.createdAt ?? seq * 1000,
    });
    const doneAt = r.doneAt ?? seq * 1000 + 100;
    log.completeRun(startedSeq, {
      status: (r.status as "done") ?? "done",
      doneAt,
      durationMs: 100,
      stepResults: (r.stepResults ?? []).map((s) => ({
        ...s,
        durationMs: s.durationMs ?? 1,
      })),
    });
  }
  return { log, dir };
}

function staticPlan(
  steps: RecipeDryRunPlan["steps"],
  triggerType = "chained",
): RecipeDryRunPlan {
  return {
    schemaVersion: 1,
    recipe: "r",
    mode: "dry-run",
    triggerType,
    generatedAt: new Date().toISOString(),
    steps,
    lint: { errors: [], warnings: [] },
  };
}

// ── synthesizeMockedOutputs: history wins, skip truncated/skipped ───────────

describe("synthesizeMockedOutputs", () => {
  it("takes the MOST RECENT non-truncated, non-skipped output per step id", () => {
    const { log } = makeRunLog([
      // older run (seq 1) — older value for "a"
      {
        recipeName: "r",
        stepResults: [{ id: "a", status: "ok", output: "old-a" }] as never,
      },
      // newer run (seq 2) — newer value for "a", plus "b"
      {
        recipeName: "r",
        stepResults: [
          { id: "a", status: "ok", output: "new-a" },
          { id: "b", status: "ok", output: { val: 2 } },
        ] as never,
      },
    ]);
    const { outputs, historyStepIds, sampleRuns } = synthesizeMockedOutputs(
      "r",
      log,
    );
    expect(sampleRuns).toBe(2);
    expect(outputs.get("a")).toBe("new-a"); // most-recent wins
    expect(outputs.get("b")).toEqual({ val: 2 });
    expect([...historyStepIds].sort()).toEqual(["a", "b"]);
  });

  it("ignores truncated and skipped outputs and undefined outputs", () => {
    const { log } = makeRunLog([
      {
        recipeName: "r",
        stepResults: [
          { id: "trunc", status: "ok", output: { "[truncated]": true } },
          { id: "skip", status: "skipped", output: "ignored" },
          { id: "undef", status: "ok" },
          { id: "good", status: "ok", output: "kept" },
        ] as never,
      },
    ]);
    const { outputs, historyStepIds } = synthesizeMockedOutputs("r", log);
    expect(outputs.has("trunc")).toBe(false);
    expect(outputs.has("skip")).toBe(false);
    expect(outputs.has("undef")).toBe(false);
    expect(outputs.get("good")).toBe("kept");
    expect([...historyStepIds]).toEqual(["good"]);
  });
});

// ── SAFETY: uncovered steps hit the STUB, no real I/O, no persistence ───────

describe("simulateMockedRun — safety invariant", () => {
  it("calls the STUB executor for a step with NO history and writes no run log", async () => {
    // step "a" HAS history; step "b" does NOT.
    const { log, dir } = makeRunLog([
      {
        recipeName: "r",
        stepResults: [{ id: "a", status: "ok", output: "hist-a" }] as never,
      },
    ]);

    const beforeFiles = readdirSync(dir);

    const stubTool = vi.fn(async (tool: string) => `[simulated:${tool}]`);
    const stubAgent = vi.fn(async () => ({ text: "[simulated:agent]" }));
    const stubLoad = vi.fn(async () => null);
    const stub = {
      executeTool: stubTool,
      executeAgent: stubAgent,
      loadNestedRecipe: stubLoad,
    };

    const recipe: ChainedRecipe = {
      name: "r",
      steps: [
        { id: "a", tool: "toolA" },
        { id: "b", tool: "toolB", awaits: ["a"] },
      ],
    };

    const result = await simulateMockedRun(recipe, log, {}, stub);

    // "a" came from history → stub NOT called for it.
    // "b" had no history → stub WAS called (no real execution).
    expect(stubTool).toHaveBeenCalledTimes(1);
    expect(stubTool).toHaveBeenCalledWith("toolB", expect.anything());

    // Result still returned with both steps.
    expect(result.stepData.get("a")?.mockedFrom).toBe("history");
    expect(result.stepData.get("b")?.mockedFrom).toBe("synthesized");
    expect(result.historyStepIds.has("a")).toBe(true);

    // No persistence: the seeded runs.jsonl is unchanged; no NEW run appended
    // by the sandbox (we passed no runLog to the runner).
    const afterFiles = readdirSync(dir);
    expect(afterFiles).toEqual(beforeFiles);
    // The run log still only has the one seeded run.
    expect(log.query({ recipe: "r" }).length).toBe(1);
  });

  it("default stub deps return synthesized placeholders and never null-throw", async () => {
    const stub = createStubDeps();
    await expect(stub.executeTool("x", {})).resolves.toBe("[simulated:x]");
    await expect(stub.executeAgent("p")).resolves.toEqual({
      text: "[simulated:agent]",
    });
    await expect(stub.loadNestedRecipe("n")).resolves.toBeNull();
  });
});

// ── env-leak guard + fail-soft logging (audit 2026-06-10) ───────────────────

describe("simulateMockedRun — env containment (recipe-misc-1)", () => {
  it("does NOT expose undeclared process.env secrets via {{env.X}}", async () => {
    const SECRET = "sk-ant-super-secret-XYZ";
    process.env.AUDIT_TEST_SECRET = SECRET;
    try {
      const { log } = makeRunLog([{ recipeName: "r" }]);
      const seenPrompts: string[] = [];
      const stub = {
        executeTool: vi.fn(async (tool: string) => `[simulated:${tool}]`),
        executeAgent: vi.fn(async (prompt: string) => {
          seenPrompts.push(prompt);
          return { text: "[simulated:agent]" };
        }),
        loadNestedRecipe: vi.fn(async () => null),
      };
      // No `context: type:env` block declares AUDIT_TEST_SECRET, so it must
      // NOT be resolvable — render should leave {{env.AUDIT_TEST_SECRET}} as
      // an empty string, never the real secret.
      const recipe: ChainedRecipe = {
        name: "r",
        steps: [
          {
            id: "leak",
            agent: { prompt: "key: {{env.AUDIT_TEST_SECRET}}" },
          },
        ],
      };
      await simulateMockedRun(recipe, log, {}, stub);
      expect(seenPrompts.join("\n")).not.toContain(SECRET);
    } finally {
      delete process.env.AUDIT_TEST_SECRET;
    }
  });
});

describe("simulateMockedRun — fail-soft logging (recipe-misc-4)", () => {
  it("logs (does not swallow silently) when the mocked run throws", async () => {
    const { log } = makeRunLog([{ recipeName: "r" }]);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const boom = {
        executeTool: vi.fn(async () => {
          throw new TypeError("stub blew up");
        }),
        // Force a step to actually run the stub by giving it no history.
        executeAgent: vi.fn(async () => ({ text: "x" })),
        loadNestedRecipe: vi.fn(async () => null),
      };
      const recipe: ChainedRecipe = {
        name: "r",
        // A step config that makes runChainedRecipe throw out of the try
        // block (invalid recipe shape) so the catch path is exercised.
        steps: null as unknown as ChainedRecipe["steps"],
      };
      const result = await simulateMockedRun(recipe, log, {}, boom);
      // Fail-soft: still returns a (possibly empty) result.
      expect(result.stepData).toBeInstanceOf(Map);
      // …but the error is surfaced in logs, not swallowed.
      expect(warnSpy).toHaveBeenCalled();
      expect(
        warnSpy.mock.calls.some((c) =>
          String(c[0]).includes("[simulateMockedRun]"),
        ),
      ).toBe(true);
    } finally {
      warnSpy.mockRestore();
    }
  });
});

// ── extractReferencedStepIds + branch resolution ───────────────────────────

describe("extractReferencedStepIds", () => {
  it("pulls step ids from steps.<id>.data / outputs.<id> / bare id", () => {
    expect([...extractReferencedStepIds("{{ steps.a.data }}")]).toEqual(["a"]);
    expect([...extractReferencedStepIds("{{ outputs.b }}")]).toEqual(["b"]);
    expect([...extractReferencedStepIds("{{ c }}")]).toEqual(["c"]);
    expect([...extractReferencedStepIds("{{ env.FOO }}")]).toEqual([]);
  });
});

describe("branch resolution (mocked overlay)", () => {
  it("a when: referencing a step WITH history resolves to taken/skipped", async () => {
    // "a" has a truthy output → branch "b" (when steps.a.data) is taken.
    const { log } = makeRunLog([
      {
        recipeName: "r",
        stepResults: [{ id: "a", status: "ok", output: "yes" }] as never,
      },
    ]);
    const recipe: ChainedRecipe = {
      name: "r",
      steps: [
        { id: "a", tool: "toolA" },
        { id: "b", tool: "toolB", awaits: ["a"], when: "{{ steps.a.data }}" },
      ],
    };
    const mocked = await simulateMockedRun(recipe, log);

    const plan = staticPlan([
      { id: "a", type: "tool", tool: "toolA", resolved: true },
      {
        id: "b",
        type: "tool",
        tool: "toolB",
        resolved: true,
        condition: "{{ steps.a.data }}",
      },
    ]);
    const report = simulateMockedFromPlan(plan, mocked);
    expect(report.fidelity).toBe("mocked");
    expect(report.branches).toHaveLength(1);
    expect(report.branches[0]?.outcome).toBe("taken");
  });

  it("a when: referencing a falsy historical output resolves to skipped", async () => {
    const { log } = makeRunLog([
      {
        recipeName: "r",
        stepResults: [{ id: "a", status: "ok", output: "" }] as never,
      },
    ]);
    const recipe: ChainedRecipe = {
      name: "r",
      steps: [
        { id: "a", tool: "toolA" },
        { id: "b", tool: "toolB", awaits: ["a"], when: "{{ steps.a.data }}" },
      ],
    };
    const mocked = await simulateMockedRun(recipe, log);
    const plan = staticPlan([
      { id: "a", type: "tool", tool: "toolA", resolved: true },
      {
        id: "b",
        type: "tool",
        tool: "toolB",
        resolved: true,
        condition: "{{ steps.a.data }}",
      },
    ]);
    const report = simulateMockedFromPlan(plan, mocked);
    expect(report.branches[0]?.outcome).toBe("skipped");
  });

  it("a when: referencing a SYNTHESIZED (no-history) step stays undetermined", async () => {
    // No history at all → "a" is synthesized → branch undetermined.
    const { log } = makeRunLog([
      {
        recipeName: "r",
        stepResults: [{ id: "z", status: "ok", output: "unrelated" }] as never,
      },
    ]);
    const recipe: ChainedRecipe = {
      name: "r",
      steps: [
        { id: "a", tool: "toolA" },
        { id: "b", tool: "toolB", awaits: ["a"], when: "{{ steps.a.data }}" },
      ],
    };
    const mocked = await simulateMockedRun(recipe, log);
    const plan = staticPlan([
      { id: "a", type: "tool", tool: "toolA", resolved: true },
      {
        id: "b",
        type: "tool",
        tool: "toolB",
        resolved: true,
        condition: "{{ steps.a.data }}",
      },
    ]);
    const report = simulateMockedFromPlan(plan, mocked);
    expect(mocked.historyStepIds.has("a")).toBe(false);
    expect(report.branches[0]?.outcome).toBe("undetermined");
  });
});

// ── Routing (runRecipeSimulate hard guards) ────────────────────────────────

describe("runRecipeSimulate routing", () => {
  function writeRecipe(name: string, body: string): void {
    const recipesDir = path.join(os.homedir(), ".patchwork", "recipes");
    mkdirSync(recipesDir, { recursive: true });
    writeFileSync(path.join(recipesDir, `${name}.yaml`), body);
  }

  it("chained + runLog-with-history → fidelity:mocked", async () => {
    const name = `p2route-chained-${Date.now()}`;
    writeRecipe(
      name,
      `name: ${name}\ntrigger:\n  type: chained\nsteps:\n  - id: a\n    tool: noop.tool\n`,
    );
    const { log } = makeRunLog([
      {
        recipeName: name,
        stepResults: [{ id: "a", status: "ok", output: "hist" }] as never,
      },
    ]);
    const { runRecipeSimulate } = await import("../../../commands/recipe.js");
    const report = await runRecipeSimulate(name, { runLog: log });
    expect(report.fidelity).toBe("mocked");
    expect(report.sampleRuns).toBe(1);
    rmSync(path.join(os.homedir(), ".patchwork", "recipes", `${name}.yaml`), {
      force: true,
    });
  });

  it("chained + NO runLog → fidelity:static", async () => {
    const name = `p2route-norunlog-${Date.now()}`;
    writeRecipe(
      name,
      `name: ${name}\ntrigger:\n  type: chained\nsteps:\n  - id: a\n    tool: noop.tool\n`,
    );
    const { runRecipeSimulate } = await import("../../../commands/recipe.js");
    const report = await runRecipeSimulate(name);
    expect(report.fidelity).toBe("static");
    rmSync(path.join(os.homedir(), ".patchwork", "recipes", `${name}.yaml`), {
      force: true,
    });
  });

  it("FLAT recipe → fidelity:static even WITH runLog (hard guard, runner never invoked)", async () => {
    const name = `p2route-flat-${Date.now()}`;
    writeRecipe(
      name,
      `name: ${name}\ntrigger:\n  type: manual\nsteps:\n  - tool: noop.tool\n    into: a\n`,
    );
    const { log } = makeRunLog([
      {
        recipeName: name,
        stepResults: [{ id: "a", status: "ok", output: "hist" }] as never,
      },
    ]);
    const { runRecipeSimulate } = await import("../../../commands/recipe.js");
    const report = await runRecipeSimulate(name, { runLog: log });
    expect(report.fidelity).toBe("static");
    rmSync(path.join(os.homedir(), ".patchwork", "recipes", `${name}.yaml`), {
      force: true,
    });
  });
});

// ── Schema v2 ──────────────────────────────────────────────────────────────

describe("simulation schema v2", () => {
  it("validates a real mocked report; schemaVersion const 2; fidelity accepts mocked", async () => {
    const { log } = makeRunLog([
      {
        recipeName: "r",
        stepResults: [{ id: "a", status: "ok", output: "yes" }] as never,
      },
    ]);
    const recipe: ChainedRecipe = {
      name: "r",
      steps: [
        { id: "a", tool: "toolA" },
        { id: "b", tool: "toolB", awaits: ["a"], when: "{{ steps.a.data }}" },
      ],
    };
    const mocked = await simulateMockedRun(recipe, log);
    const plan = staticPlan([
      { id: "a", type: "tool", tool: "toolA", resolved: true },
      {
        id: "b",
        type: "tool",
        tool: "toolB",
        resolved: true,
        condition: "{{ steps.a.data }}",
      },
    ]);
    const report = simulateMockedFromPlan(plan, mocked);

    const schema = generateSimulationSchema() as Record<string, unknown>;
    const props = schema.properties as Record<string, { const?: number }>;
    expect(props.schemaVersion?.const).toBe(2);

    const ajv = new Ajv({ strict: false });
    const validate = ajv.compile(schema as object);
    const ok = validate(report);
    if (!ok) {
      throw new Error(
        `schema errors: ${JSON.stringify(validate.errors, null, 2)}`,
      );
    }
    expect(ok).toBe(true);
    expect(report.fidelity).toBe("mocked");
    expect(report.schemaVersion).toBe(2);
  });
});
