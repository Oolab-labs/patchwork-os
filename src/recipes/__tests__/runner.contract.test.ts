/**
 * Contract test: identical step-failure scenarios must produce an error result
 * in BOTH the flat runner (runYamlRecipe) and the chained runner (runChainedRecipe).
 *
 * These tests act as a drift-detector. If a behaviour is added or fixed in one
 * runner it must be mirrored in the other; a failure here is a signal to sync.
 */

import { describe, expect, it, vi } from "vitest";
import type {
  ChainedRecipe,
  ExecutionDeps,
  RunOptions,
} from "../chainedRunner.js";
import { runChainedRecipe } from "../chainedRunner.js";
import type { RunnerDeps, YamlRecipe } from "../yamlRunner.js";
import { runYamlRecipe } from "../yamlRunner.js";

// noop RunnerDeps baseline for flat runner tests
function noop(): RunnerDeps {
  return {
    gitLogSince: () => "",
    gitStaleBranches: () => "[]",
    getDiagnostics: () => "[]",
  };
}

// ── Flat runner helpers ─────────────────────────────────────────────────────

function flatDeps(overrides: Partial<RunnerDeps> = {}): RunnerDeps {
  return {
    claudeFn: vi.fn().mockResolvedValue("agent output"),
    claudeCodeFn: vi.fn().mockResolvedValue("agent output"),
    ...overrides,
  };
}

// ── Chained runner helpers ──────────────────────────────────────────────────

const baseOptions: RunOptions = {
  env: {},
  maxConcurrency: 4,
  maxDepth: 3,
  dryRun: false,
};

function chainedDeps(overrides: Partial<ExecutionDeps> = {}): ExecutionDeps {
  return {
    executeTool: vi.fn().mockResolvedValue("ok"),
    executeAgent: vi.fn().mockResolvedValue("agent output"),
    loadNestedRecipe: vi.fn().mockResolvedValue(null),
    ...overrides,
  };
}

// ── Contract scenarios ──────────────────────────────────────────────────────

describe("runner contract: agent [agent step failed:] sentinel", () => {
  const FAIL_SENTINEL = "[agent step failed: driver exited 1]";

  it("flat runner marks step as error", async () => {
    // Flat runner uses agent.into as stepId (defaults to "agent_output")
    const recipe: YamlRecipe = {
      name: "r",
      trigger: { type: "manual" },
      steps: [{ agent: { prompt: "do it", into: "step_a" } }],
    };
    const result = await runYamlRecipe(
      recipe,
      flatDeps({
        claudeFn: vi.fn().mockResolvedValue(FAIL_SENTINEL),
        claudeCodeFn: vi.fn().mockResolvedValue(FAIL_SENTINEL),
      }),
    );
    const step = result.stepResults.find((s) => s.id === "step_a");
    expect(step?.status).toBe("error");
    expect(result.errorMessage).toBeTruthy();
  });

  it("chained runner marks step as error", async () => {
    const recipe: ChainedRecipe = {
      name: "r",
      steps: [{ id: "a", agent: { prompt: "do it" } }],
    };
    const result = await runChainedRecipe(
      recipe,
      baseOptions,
      chainedDeps({
        executeAgent: vi.fn().mockResolvedValue(FAIL_SENTINEL),
      }),
    );
    expect(result.success).toBe(false);
    expect(result.errorMessage).toBeTruthy();
  });
});

describe("runner contract: tool {ok:false,error} sentinel", () => {
  const FAIL_RESULT = JSON.stringify({ ok: false, error: "permission denied" });

  it("flat runner marks step as error (via registered git.stale_branches tool returning {ok:false})", async () => {
    // git.stale_branches is a registered tool that respects the {ok:false} sentinel.
    const recipe: YamlRecipe = {
      name: "r",
      trigger: { type: "manual" },
      steps: [{ tool: "git.stale_branches", days: 30, into: "stale" }],
    };
    const result = await runYamlRecipe(recipe, {
      ...noop(),
      gitStaleBranches: () => FAIL_RESULT,
    });
    const step = result.stepResults.find(
      (s) => s.tool === "git.stale_branches",
    );
    expect(step?.status).toBe("error");
    expect(result.errorMessage).toBeTruthy();
  });

  it("chained runner marks step as error", async () => {
    const recipe: ChainedRecipe = {
      name: "r",
      steps: [{ id: "t", tool: "some_tool" }],
    };
    const result = await runChainedRecipe(
      recipe,
      baseOptions,
      chainedDeps({
        executeTool: vi.fn().mockResolvedValue(FAIL_RESULT),
      }),
    );
    expect(result.success).toBe(false);
    expect(result.errorMessage).toBeTruthy();
  });
});

describe("runner contract: expect: assertion on agent output", () => {
  it("flat runner marks step as error when expect.equals fails", async () => {
    // Flat runner derives stepId from agent.into (default "agent_output")
    const recipe: YamlRecipe = {
      name: "r",
      trigger: { type: "manual" },
      steps: [
        {
          agent: { prompt: "return 42", into: "step_a" },
          expect: { equals: "expected_value" },
        },
      ],
    };
    const result = await runYamlRecipe(
      recipe,
      flatDeps({
        claudeFn: vi.fn().mockResolvedValue("actual_value"),
        claudeCodeFn: vi.fn().mockResolvedValue("actual_value"),
      }),
    );
    const step = result.stepResults.find((s) => s.id === "step_a");
    expect(step?.status).toBe("error");
    expect(result.errorMessage).toBeTruthy();
  });

  it("chained runner marks step as error when expect.equals fails", async () => {
    const recipe: ChainedRecipe = {
      name: "r",
      steps: [
        {
          id: "a",
          agent: { prompt: "return 42" },
          expect: { equals: "expected_value" },
        },
      ],
    };
    const result = await runChainedRecipe(
      recipe,
      baseOptions,
      chainedDeps({
        executeAgent: vi.fn().mockResolvedValue("actual_value"),
      }),
    );
    expect(result.success).toBe(false);
    expect(result.errorMessage).toBeTruthy();
  });
});

describe("runner contract: silent-fail detection", () => {
  // Flat runner has mature silent-fail detection; chained should match.
  const SILENT_FAIL = "(git branches unavailable)";

  it("flat runner detects silent-fail on tool output (via registered git.stale_branches)", async () => {
    const recipe: YamlRecipe = {
      name: "r",
      trigger: { type: "manual" },
      steps: [{ tool: "git.stale_branches", days: 30, into: "stale" }],
    };
    const result = await runYamlRecipe(recipe, {
      ...noop(),
      gitStaleBranches: () => SILENT_FAIL,
    });
    const step = result.stepResults.find(
      (s) => s.tool === "git.stale_branches",
    );
    expect(step?.status).toBe("error");
  });

  it("chained runner detects silent-fail on tool output", async () => {
    const recipe: ChainedRecipe = {
      name: "r",
      steps: [{ id: "t", tool: "git_branches" }],
    };
    const result = await runChainedRecipe(
      recipe,
      baseOptions,
      chainedDeps({
        executeTool: vi.fn().mockResolvedValue(SILENT_FAIL),
      }),
    );
    expect(result.success).toBe(false);
  });
});

describe("runner contract: optional step does not abort run", () => {
  it("flat runner continues after optional step failure", async () => {
    // A step that fails with optional:true should not abort the run.
    const recipe: YamlRecipe = {
      name: "r",
      trigger: { type: "manual" },
      steps: [
        // optional step — git tool returns an error but run continues
        { tool: "git.stale_branches", days: 30, into: "stale", optional: true },
        // subsequent agent step — must still execute
        { agent: { prompt: "continue", into: "result" } },
      ],
    };
    const result = await runYamlRecipe(recipe, {
      ...noop(),
      gitStaleBranches: () =>
        JSON.stringify({ ok: false, error: "git unavailable" }),
      claudeFn: vi.fn().mockResolvedValue("done"),
      claudeCodeFn: vi.fn().mockResolvedValue("done"),
    });
    // Run succeeds overall (optional failure is non-fatal)
    expect(result.errorMessage).toBeUndefined();
    // Subsequent step executed
    const followStep = result.stepResults.find((s) => s.id === "result");
    expect(followStep?.status).toBe("ok");
  });

  it("chained runner continues after optional step failure", async () => {
    const recipe: ChainedRecipe = {
      name: "r",
      steps: [
        { id: "opt", tool: "t", optional: true },
        { id: "post", agent: { prompt: "continue" } },
      ],
    };
    const result = await runChainedRecipe(
      recipe,
      baseOptions,
      chainedDeps({
        executeTool: vi.fn().mockRejectedValue(new Error("tool failed")),
        executeAgent: vi.fn().mockResolvedValue("ok"),
      }),
    );
    // Run should succeed overall — optional step failure is non-fatal
    expect(result.success).toBe(true);
    const post = result.stepResults.get("post");
    expect(post?.success).toBe(true);
  });
});
