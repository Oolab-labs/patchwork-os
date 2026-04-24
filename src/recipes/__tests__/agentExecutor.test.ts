/**
 * Phase 2a parity tests for the planned `agentExecutor` extraction.
 *
 * These tests are intentionally RED — `src/recipes/agentExecutor.ts` does not
 * exist yet. They pin ALL dispatch branches (both from the standard agent block
 * in runYamlRecipe, lines 378-475, and the chainedRunner executeAgent factory,
 * lines 1030-1058) so that the extraction can prove superset behaviour.
 *
 * Drift bug documented:
 *   runYamlRecipe (lines 388-428) handles driver:"local" and
 *   pwCfg.model==="local" branches. chainedRunner.executeAgent (lines 1030-1058)
 *   does NOT — both local paths are absent. The extracted module must carry
 *   the superset (all 8 branches) so both callers converge on one impl.
 *
 * Deps injected via constructor/factory args so every branch is unit-testable
 * without spawning a real process or touching ~/.patchwork/config.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type AgentExecutorDeps, executeAgent } from "../agentExecutor.js";

// ── helpers ──────────────────────────────────────────────────────────────────

function makeDeps(
  overrides: Partial<AgentExecutorDeps> = {},
): AgentExecutorDeps {
  return {
    anthropicFn: vi.fn().mockResolvedValue("anthropic-result"),
    providerDriverFn: vi
      .fn()
      .mockImplementation((driver: string) =>
        Promise.resolve(`${driver}-result`),
      ),
    claudeCliFn: vi.fn().mockResolvedValue("claude-cli-result"),
    localFn: vi.fn().mockResolvedValue("local-result"),
    probeClaudeCli: vi.fn().mockReturnValue(false),
    loadPatchworkConfig: vi.fn().mockReturnValue({}),
    ...overrides,
  };
}

// ── 1. Explicit driver:"anthropic" ───────────────────────────────────────────

describe('driver:"anthropic"', () => {
  it("calls anthropicFn, not others", async () => {
    const deps = makeDeps();
    const result = await executeAgent(
      { driver: "anthropic", prompt: "hello", model: "claude-haiku" },
      deps,
    );
    expect(result).toBe("anthropic-result");
    expect(deps.anthropicFn).toHaveBeenCalledWith("hello", "claude-haiku");
    expect(deps.localFn).not.toHaveBeenCalled();
    expect(deps.claudeCliFn).not.toHaveBeenCalled();
  });
});

// ── 2. Explicit driver:"openai" ──────────────────────────────────────────────

describe('driver:"openai"', () => {
  it("calls providerDriverFn with openai, not others", async () => {
    const deps = makeDeps();
    const result = await executeAgent(
      { driver: "openai", prompt: "hello", model: "gpt-4o" },
      deps,
    );
    expect(result).toBe("openai-result");
    expect(deps.providerDriverFn).toHaveBeenCalledWith(
      "openai",
      "hello",
      "gpt-4o",
    );
    expect(deps.anthropicFn).not.toHaveBeenCalled();
    expect(deps.localFn).not.toHaveBeenCalled();
  });
});

// ── 3. Explicit driver:"gemini" ──────────────────────────────────────────────

describe('driver:"gemini"', () => {
  it("calls providerDriverFn with gemini, not others", async () => {
    const deps = makeDeps();
    const result = await executeAgent(
      { driver: "gemini", prompt: "hello", model: "gemini-pro" },
      deps,
    );
    expect(result).toBe("gemini-result");
    expect(deps.providerDriverFn).toHaveBeenCalledWith(
      "gemini",
      "hello",
      "gemini-pro",
    );
    expect(deps.anthropicFn).not.toHaveBeenCalled();
    expect(deps.localFn).not.toHaveBeenCalled();
  });
});

// ── 4. Explicit driver:"subprocess" ─────────────────────────────────────────

describe('driver:"subprocess"', () => {
  it("calls claudeCliFn (probeClaudeCli is NOT consulted)", async () => {
    const deps = makeDeps({
      probeClaudeCli: vi.fn().mockReturnValue(false), // should be irrelevant
    });
    const result = await executeAgent(
      { driver: "subprocess", prompt: "hello" },
      deps,
    );
    expect(result).toBe("claude-cli-result");
    expect(deps.claudeCliFn).toHaveBeenCalledWith("hello");
    expect(deps.anthropicFn).not.toHaveBeenCalled();
    expect(deps.localFn).not.toHaveBeenCalled();
    expect(deps.probeClaudeCli).not.toHaveBeenCalled();
  });
});

// ── 5. Explicit driver:"local" (THE MISSING BRANCH in chained path) ──────────

describe('driver:"local"', () => {
  it("calls localFn — this branch is absent from chainedRunner.executeAgent", async () => {
    const deps = makeDeps();
    const result = await executeAgent(
      { driver: "local", prompt: "hello", model: "llama3" },
      deps,
    );
    expect(result).toBe("local-result");
    expect(deps.localFn).toHaveBeenCalledWith("hello", "llama3");
    expect(deps.anthropicFn).not.toHaveBeenCalled();
    expect(deps.claudeCliFn).not.toHaveBeenCalled();
  });

  it("uses default model when none supplied", async () => {
    const deps = makeDeps();
    await executeAgent({ driver: "local", prompt: "hello" }, deps);
    expect(deps.localFn).toHaveBeenCalledWith("hello", expect.any(String));
  });
});

// ── 6. No driver + pwCfg model:"local" (THE OTHER MISSING BRANCH) ────────────

describe("no driver + pwCfg model:local", () => {
  it("calls localFn — this branch is absent from chainedRunner.executeAgent", async () => {
    const deps = makeDeps({
      loadPatchworkConfig: vi.fn().mockReturnValue({ model: "local" }),
    });
    const result = await executeAgent({ prompt: "hello" }, deps);
    expect(result).toBe("local-result");
    expect(deps.localFn).toHaveBeenCalledWith("hello", expect.any(String));
    expect(deps.anthropicFn).not.toHaveBeenCalled();
    expect(deps.claudeCliFn).not.toHaveBeenCalled();
  });
});

// ── 7. No driver + pwCfg model:non-local + no ANTHROPIC_API_KEY ──────────────

describe("no driver + pwCfg non-local + claude CLI available", () => {
  beforeEach(() => {
    delete process.env.ANTHROPIC_API_KEY;
  });

  it("probes for claude CLI; calls claudeCliFn when probe succeeds", async () => {
    const deps = makeDeps({
      loadPatchworkConfig: vi.fn().mockReturnValue({}),
      probeClaudeCli: vi.fn().mockReturnValue(true),
    });
    const result = await executeAgent({ prompt: "hello" }, deps);
    expect(result).toBe("claude-cli-result");
    expect(deps.claudeCliFn).toHaveBeenCalledWith("hello");
    expect(deps.probeClaudeCli).toHaveBeenCalled();
    expect(deps.anthropicFn).not.toHaveBeenCalled();
  });

  it("falls back to anthropicFn when probe fails", async () => {
    const deps = makeDeps({
      loadPatchworkConfig: vi.fn().mockReturnValue({}),
      probeClaudeCli: vi.fn().mockReturnValue(false),
    });
    const result = await executeAgent({ prompt: "hello" }, deps);
    expect(result).toBe("anthropic-result");
    expect(deps.anthropicFn).toHaveBeenCalled();
    expect(deps.claudeCliFn).not.toHaveBeenCalled();
  });
});

// ── 8. No driver + ANTHROPIC_API_KEY set → skip probe, call anthropicFn ──────

describe("no driver + ANTHROPIC_API_KEY set", () => {
  beforeEach(() => {
    process.env.ANTHROPIC_API_KEY = "sk-test-key";
  });

  afterEach(() => {
    delete process.env.ANTHROPIC_API_KEY;
  });

  it("skips probeClaudeCli entirely, calls anthropicFn", async () => {
    const deps = makeDeps({
      loadPatchworkConfig: vi.fn().mockReturnValue({}),
    });
    const result = await executeAgent(
      { prompt: "hello", model: "claude-haiku" },
      deps,
    );
    expect(result).toBe("anthropic-result");
    expect(deps.anthropicFn).toHaveBeenCalledWith("hello", "claude-haiku");
    expect(deps.probeClaudeCli).not.toHaveBeenCalled();
    expect(deps.claudeCliFn).not.toHaveBeenCalled();
  });
});

// ── 8b. No driver + ANTHROPIC_API_KEY set + no model → uses DEFAULT_MODEL ────

describe("no driver + ANTHROPIC_API_KEY + no model specified", () => {
  beforeEach(() => {
    process.env.ANTHROPIC_API_KEY = "sk-test-key";
  });

  afterEach(() => {
    delete process.env.ANTHROPIC_API_KEY;
  });

  it("calls anthropicFn with DEFAULT_MODEL when model is omitted", async () => {
    const deps = makeDeps({
      loadPatchworkConfig: vi.fn().mockReturnValue({}),
    });
    await executeAgent({ prompt: "hello" }, deps);
    expect(deps.anthropicFn).toHaveBeenCalledWith(
      "hello",
      "claude-haiku-4-5-20251001",
    );
  });
});

// ── 9. Unknown driver → throws ────────────────────────────────────────────────

describe("unknown driver", () => {
  it("throws an error (not silently falls through)", async () => {
    const deps = makeDeps();
    await expect(
      executeAgent({ driver: "foobar" as never, prompt: "hello" }, deps),
    ).rejects.toThrow(/unknown.*driver|unsupported.*driver|foobar/i);
    expect(deps.anthropicFn).not.toHaveBeenCalled();
    expect(deps.localFn).not.toHaveBeenCalled();
  });
});
