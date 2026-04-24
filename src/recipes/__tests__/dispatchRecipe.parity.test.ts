/**
 * Phase 1 parity tests for the planned RecipeOrchestrator extraction.
 *
 * These tests pin the public contract of `dispatchRecipe` and the result
 * envelopes of `runYamlRecipe` / `runChainedRecipe` BEFORE orchestrator
 * extraction begins. They are mandatory blockers per the Bug Fix Protocol
 * (medium/high-risk refactor → tests first).
 *
 * What they assert:
 *   1. dispatchRecipe selection logic (chained vs flat) — selection seam.
 *   2. yaml result envelope key-set + types per on_error.fallback mode.
 *   3. chained result envelope key-set + types.
 *   4. Documented divergence between the two envelopes — the bug to fix.
 */

import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type {
  ChainedRecipe,
  ChainedRunResult,
  ExecutionDeps,
} from "../chainedRunner.js";
import {
  dispatchRecipe,
  type RunnerDeps,
  type RunResult,
  type YamlRecipe,
} from "../yamlRunner.js";

const tmpLogDir = mkdtempSync(path.join(os.tmpdir(), "dispatch-parity-"));

function baseDeps(): RunnerDeps {
  return {
    now: () => new Date("2026-04-25T12:00:00Z"),
    logDir: tmpLogDir,
    readFile: () => {
      throw new Error("not found");
    },
    writeFile: () => {},
    appendFile: () => {},
    mkdir: () => {},
    gitLogSince: () => "",
    gitStaleBranches: () => "",
    getDiagnostics: () => "",
  };
}

function flatRecipe(overrides: Partial<YamlRecipe> = {}): YamlRecipe {
  return {
    name: "flat",
    trigger: { type: "manual" },
    steps: [{ tool: "file.write", path: "/tmp/x", content: "hi" }],
    ...overrides,
  };
}

function chainedRecipe(): ChainedRecipe & { trigger: { type: string } } {
  return {
    name: "chained",
    trigger: { type: "chained" },
    steps: [{ id: "s1", tool: "noop.tool" }],
  };
}

function chainedDeps(): ExecutionDeps {
  return {
    executeTool: vi.fn().mockResolvedValue("ok"),
    executeAgent: vi.fn().mockResolvedValue("agent"),
    loadNestedRecipe: vi.fn().mockResolvedValue(null),
  };
}

function isRunResult(r: unknown): r is RunResult {
  return !!r && typeof r === "object" && "stepsRun" in r;
}

function isChainedResult(r: unknown): r is ChainedRunResult {
  return !!r && typeof r === "object" && "summary" in r;
}

// ── 1. dispatchRecipe selection logic ───────────────────────────────────────

describe("dispatchRecipe — selection (orchestrator seam)", () => {
  it("selects yaml runner when trigger.type !== 'chained'", async () => {
    const result = await dispatchRecipe(flatRecipe(), {
      ...baseDeps(),
      writeFile: () => {},
    });
    expect(isRunResult(result)).toBe(true);
    expect(isChainedResult(result)).toBe(false);
  });

  it("selects chained runner when trigger.type === 'chained'", async () => {
    const result = await dispatchRecipe(chainedRecipe() as never, {
      ...baseDeps(),
      chainedDeps: chainedDeps(),
    });
    expect(isChainedResult(result)).toBe(true);
    expect(isRunResult(result)).toBe(false);
  });

  it("selects yaml runner for trigger.type 'manual', 'cron', 'webhook' alike", async () => {
    for (const triggerType of ["manual", "cron", "webhook"]) {
      const r = flatRecipe({ trigger: { type: triggerType } });
      const result = await dispatchRecipe(r, {
        ...baseDeps(),
        writeFile: () => {},
      });
      expect(isRunResult(result)).toBe(true);
    }
  });

  it("throws (does not silently route) when chained recipe lacks chainedDeps", async () => {
    await expect(
      dispatchRecipe(chainedRecipe() as never, baseDeps()),
    ).rejects.toThrow(/chainedDeps required/);
  });
});

// ── 2. RunResult envelope shape (yaml runner) ───────────────────────────────

describe("RunResult envelope (yaml runner) — orchestrator must preserve", () => {
  const yamlEnvelopeKeys = new Set([
    "recipe",
    "stepsRun",
    "outputs",
    "context",
    "stepResults",
  ]);

  it("on success: required keys present with expected types", async () => {
    const result = (await dispatchRecipe(flatRecipe(), {
      ...baseDeps(),
      writeFile: () => {},
    })) as RunResult;

    for (const k of yamlEnvelopeKeys) {
      expect(result).toHaveProperty(k);
    }
    expect(typeof result.recipe).toBe("string");
    expect(typeof result.stepsRun).toBe("number");
    expect(Array.isArray(result.outputs)).toBe(true);
    expect(Array.isArray(result.stepResults)).toBe(true);
    expect(typeof result.context).toBe("object");
    expect(result.errorMessage).toBeUndefined();
  });

  it("on_error.fallback=abort: errorMessage set, stepResults still array", async () => {
    const recipe = flatRecipe({
      on_error: { fallback: "abort" },
      steps: [{ tool: "file.read", path: "/tmp/a", into: "data" }],
    });
    const result = (await dispatchRecipe(recipe, {
      ...baseDeps(),
      readFile: () => {
        throw new Error("boom");
      },
    })) as RunResult;
    expect(typeof result.errorMessage).toBe("string");
    expect(result.errorMessage).toContain("file.read failed");
    expect(Array.isArray(result.stepResults)).toBe(true);
    expect(result.stepResults[0]?.status).toBe("error");
  });

  it("on_error.fallback=log_only: errorMessage undefined, step recorded as error", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const recipe = flatRecipe({
      on_error: { fallback: "log_only" },
      steps: [{ tool: "file.read", path: "/tmp/a", into: "data" }],
    });
    const result = (await dispatchRecipe(recipe, {
      ...baseDeps(),
      readFile: () => {
        throw new Error("boom");
      },
    })) as RunResult;
    expect(result.errorMessage).toBeUndefined();
    expect(result.stepResults[0]?.status).toBe("error");
    warn.mockRestore();
  });

  it("on_error.fallback=deliver_original: same envelope shape as log_only", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const recipe = flatRecipe({
      on_error: { fallback: "deliver_original" },
      steps: [{ tool: "file.read", path: "/tmp/a", into: "data" }],
    });
    const result = (await dispatchRecipe(recipe, {
      ...baseDeps(),
      readFile: () => {
        throw new Error("boom");
      },
    })) as RunResult;
    expect(result.errorMessage).toBeUndefined();
    expect(Object.keys(result).sort()).toEqual(
      expect.arrayContaining([
        "recipe",
        "stepsRun",
        "stepResults",
        "context",
        "outputs",
      ]),
    );
    warn.mockRestore();
  });

  it("warn message format for fallback path is stable (downstream log scrapers)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const recipe = flatRecipe({
      on_error: { fallback: "log_only" },
      steps: [{ tool: "file.read", path: "/tmp/a", into: "data" }],
    });
    await dispatchRecipe(recipe, {
      ...baseDeps(),
      readFile: () => {
        throw new Error("boom");
      },
    });
    // Pin the exact format scrapers depend on:
    //   "step <id> failed but on_error.fallback=<mode> — treating as non-fatal: <wrapped-err>"
    // The wrapped error includes tool name (e.g. "file.read: could not read /tmp/a"),
    // not the raw thrown message — this is the contract.
    expect(warn).toHaveBeenCalledWith(
      expect.stringMatching(
        /^step .+ failed but on_error\.fallback=log_only — treating as non-fatal: .+$/,
      ),
    );
    warn.mockRestore();
  });
});

// ── 3. ChainedRunResult envelope shape ──────────────────────────────────────

describe("ChainedRunResult envelope — orchestrator must preserve", () => {
  const chainedEnvelopeKeys = new Set([
    "success",
    "stepResults",
    "summary",
    "context",
  ]);

  it("on success: required keys present with expected types", async () => {
    const result = (await dispatchRecipe(chainedRecipe() as never, {
      ...baseDeps(),
      chainedDeps: chainedDeps(),
    })) as ChainedRunResult;

    for (const k of chainedEnvelopeKeys) {
      expect(result).toHaveProperty(k);
    }
    expect(typeof result.success).toBe("boolean");
    expect(result.success).toBe(true);
    expect(result.stepResults).toBeInstanceOf(Map);
    expect(result.summary).toMatchObject({
      total: expect.any(Number),
      succeeded: expect.any(Number),
      failed: expect.any(Number),
      skipped: expect.any(Number),
    });
    expect(typeof result.context).toBe("object");
  });

  it("on step failure: success=false, errorMessage set, summary.failed > 0", async () => {
    const failing: ExecutionDeps = {
      executeTool: vi.fn().mockRejectedValue(new Error("boom")),
      executeAgent: vi.fn(),
      loadNestedRecipe: vi.fn().mockResolvedValue(null),
    };
    const result = (await dispatchRecipe(chainedRecipe() as never, {
      ...baseDeps(),
      chainedDeps: failing,
    })) as ChainedRunResult;
    expect(result.success).toBe(false);
    expect(typeof result.errorMessage).toBe("string");
    expect(result.summary.failed).toBeGreaterThan(0);
  });
});

// ── 4. Documented envelope divergence (the bug-to-fix) ──────────────────────

/**
 * The yaml and chained runners return *structurally different* envelopes
 * today. The orchestrator extraction must either (a) unify them behind a
 * common shape or (b) keep both shapes and document a discriminated union.
 *
 * These assertions PIN the current divergence so the refactor doesn't
 * accidentally change one without the other.
 */
describe("envelope divergence (current state — pin before refactor)", () => {
  it("yaml envelope has 'stepsRun' (number); chained does not", async () => {
    const yaml = (await dispatchRecipe(flatRecipe(), {
      ...baseDeps(),
      writeFile: () => {},
    })) as RunResult;
    const chained = (await dispatchRecipe(chainedRecipe() as never, {
      ...baseDeps(),
      chainedDeps: chainedDeps(),
    })) as ChainedRunResult;

    expect("stepsRun" in yaml).toBe(true);
    expect("stepsRun" in chained).toBe(false);
  });

  it("chained envelope has 'success' + 'summary'; yaml does not", async () => {
    const yaml = (await dispatchRecipe(flatRecipe(), {
      ...baseDeps(),
      writeFile: () => {},
    })) as RunResult;
    const chained = (await dispatchRecipe(chainedRecipe() as never, {
      ...baseDeps(),
      chainedDeps: chainedDeps(),
    })) as ChainedRunResult;

    expect("success" in chained).toBe(true);
    expect("summary" in chained).toBe(true);
    expect("success" in yaml).toBe(false);
    expect("summary" in yaml).toBe(false);
  });

  it("yaml stepResults is Array; chained stepResults is Map", async () => {
    const yaml = (await dispatchRecipe(flatRecipe(), {
      ...baseDeps(),
      writeFile: () => {},
    })) as RunResult;
    const chained = (await dispatchRecipe(chainedRecipe() as never, {
      ...baseDeps(),
      chainedDeps: chainedDeps(),
    })) as ChainedRunResult;

    expect(Array.isArray(yaml.stepResults)).toBe(true);
    expect(chained.stepResults).toBeInstanceOf(Map);
  });

  it("both envelopes share 'context' (Record<string,string>)", async () => {
    const yaml = (await dispatchRecipe(flatRecipe(), {
      ...baseDeps(),
      writeFile: () => {},
    })) as RunResult;
    const chained = (await dispatchRecipe(chainedRecipe() as never, {
      ...baseDeps(),
      chainedDeps: chainedDeps(),
    })) as ChainedRunResult;

    expect(typeof yaml.context).toBe("object");
    expect(typeof chained.context).toBe("object");
  });
});
