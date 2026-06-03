/**
 * Dispatch + attribution tests for `agentExecutor`.
 *
 * Pins ALL driver-resolution branches (both from the standard agent block in
 * runYamlRecipe and the chainedRunner executeAgent factory) so the unified
 * impl proves superset behaviour, AND that `executeAgent` stamps `servedBy`
 * with the driver it ACTUALLY resolved+ran — the substrate RunBudget.reconcile
 * uses instead of guessing from the configured `driver` string.
 *
 * Note: the injected deps return `AgentResult` objects ({text, usage?}), which
 * is what the real wired deps return (buildAgentExecutorDeps normalizes every
 * dep through `toAgentResult` before executeAgent sees it). Earlier revisions
 * of this test returned bare strings, which did not match that contract.
 *
 * Drift bug documented:
 *   runYamlRecipe handles driver:"local" and pwCfg.model==="local" branches.
 *   chainedRunner.executeAgent historically did NOT — both local paths were
 *   absent. The extracted module carries the superset (all 8 branches).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type AgentExecutorDeps, executeAgent } from "../agentExecutor.js";

// ── helpers ──────────────────────────────────────────────────────────────────

function makeDeps(
  overrides: Partial<AgentExecutorDeps> = {},
): AgentExecutorDeps {
  return {
    anthropicFn: vi.fn().mockResolvedValue({ text: "anthropic-result" }),
    providerDriverFn: vi
      .fn()
      .mockImplementation((driver: string) =>
        Promise.resolve({ text: `${driver}-result` }),
      ),
    claudeCliFn: vi.fn().mockResolvedValue({ text: "claude-cli-result" }),
    localFn: vi.fn().mockResolvedValue({ text: "local-result" }),
    probeClaudeCli: vi.fn().mockReturnValue(false),
    loadPatchworkConfig: vi.fn().mockReturnValue({}),
    ...overrides,
  };
}

// ── 1. Explicit driver:"anthropic" ───────────────────────────────────────────

describe('driver:"anthropic"', () => {
  it("calls anthropicFn, not others; servedBy=anthropic", async () => {
    const deps = makeDeps();
    const result = await executeAgent(
      { driver: "anthropic", prompt: "hello", model: "claude-haiku" },
      deps,
    );
    expect(result.text).toBe("anthropic-result");
    expect(result.servedBy).toEqual({
      driver: "anthropic",
      model: "claude-haiku",
    });
    expect(deps.anthropicFn).toHaveBeenCalledWith("hello", "claude-haiku");
    expect(deps.localFn).not.toHaveBeenCalled();
    expect(deps.claudeCliFn).not.toHaveBeenCalled();
  });
});

// ── 2. Explicit driver:"openai" ──────────────────────────────────────────────

describe('driver:"openai"', () => {
  it("calls providerDriverFn with openai; servedBy=openai", async () => {
    const deps = makeDeps();
    const result = await executeAgent(
      { driver: "openai", prompt: "hello", model: "gpt-4o" },
      deps,
    );
    expect(result.text).toBe("openai-result");
    expect(result.servedBy).toEqual({ driver: "openai", model: "gpt-4o" });
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
  it("calls providerDriverFn with gemini; servedBy=gemini", async () => {
    const deps = makeDeps();
    const result = await executeAgent(
      { driver: "gemini", prompt: "hello", model: "gemini-pro" },
      deps,
    );
    expect(result.text).toBe("gemini-result");
    expect(result.servedBy).toEqual({ driver: "gemini", model: "gemini-pro" });
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
  it("calls claudeCliFn; servedBy=subprocess (probe NOT consulted)", async () => {
    const deps = makeDeps({
      probeClaudeCli: vi.fn().mockReturnValue(false), // should be irrelevant
    });
    const result = await executeAgent(
      { driver: "subprocess", prompt: "hello" },
      deps,
    );
    expect(result.text).toBe("claude-cli-result");
    expect(result.servedBy?.driver).toBe("subprocess");
    expect(deps.claudeCliFn).toHaveBeenCalledWith("hello", undefined);
    expect(deps.anthropicFn).not.toHaveBeenCalled();
    expect(deps.localFn).not.toHaveBeenCalled();
    expect(deps.probeClaudeCli).not.toHaveBeenCalled();
  });
});

// ── 5. Explicit driver:"local" (THE MISSING BRANCH in chained path) ──────────

describe('driver:"local"', () => {
  it("calls localFn; servedBy=local — branch absent from chainedRunner", async () => {
    const deps = makeDeps();
    const result = await executeAgent(
      { driver: "local", prompt: "hello", model: "llama3" },
      deps,
    );
    expect(result.text).toBe("local-result");
    expect(result.servedBy).toEqual({ driver: "local", model: "llama3" });
    expect(deps.localFn).toHaveBeenCalledWith("hello", "llama3");
    expect(deps.anthropicFn).not.toHaveBeenCalled();
    expect(deps.claudeCliFn).not.toHaveBeenCalled();
  });

  it("uses default model when none supplied", async () => {
    const deps = makeDeps();
    const result = await executeAgent(
      { driver: "local", prompt: "hello" },
      deps,
    );
    expect(deps.localFn).toHaveBeenCalledWith("hello", expect.any(String));
    expect(result.servedBy?.driver).toBe("local");
  });
});

// ── 6. No driver + pwCfg model:"local" (THE OTHER MISSING BRANCH) ────────────

describe("no driver + pwCfg model:local", () => {
  it("calls localFn; servedBy=local — branch absent from chainedRunner", async () => {
    const deps = makeDeps({
      loadPatchworkConfig: vi.fn().mockReturnValue({ model: "local" }),
    });
    const result = await executeAgent({ prompt: "hello" }, deps);
    expect(result.text).toBe("local-result");
    expect(result.servedBy?.driver).toBe("local");
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

  it("probes for claude CLI; calls claudeCliFn; servedBy=subprocess", async () => {
    const deps = makeDeps({
      loadPatchworkConfig: vi.fn().mockReturnValue({}),
      probeClaudeCli: vi.fn().mockReturnValue(true),
    });
    const result = await executeAgent({ prompt: "hello" }, deps);
    expect(result.text).toBe("claude-cli-result");
    expect(result.servedBy?.driver).toBe("subprocess");
    expect(deps.claudeCliFn).toHaveBeenCalledWith("hello", undefined);
    expect(deps.probeClaudeCli).toHaveBeenCalled();
    expect(deps.anthropicFn).not.toHaveBeenCalled();
  });

  it("falls back to anthropicFn when probe fails; servedBy=anthropic", async () => {
    const deps = makeDeps({
      loadPatchworkConfig: vi.fn().mockReturnValue({}),
      probeClaudeCli: vi.fn().mockReturnValue(false),
    });
    const result = await executeAgent({ prompt: "hello" }, deps);
    expect(result.text).toBe("anthropic-result");
    expect(result.servedBy?.driver).toBe("anthropic");
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

  it("skips probeClaudeCli, calls anthropicFn; servedBy=anthropic", async () => {
    const deps = makeDeps({
      loadPatchworkConfig: vi.fn().mockReturnValue({}),
    });
    const result = await executeAgent(
      { prompt: "hello", model: "claude-haiku" },
      deps,
    );
    expect(result.text).toBe("anthropic-result");
    expect(result.servedBy).toEqual({
      driver: "anthropic",
      model: "claude-haiku",
    });
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
    const result = await executeAgent({ prompt: "hello" }, deps);
    expect(deps.anthropicFn).toHaveBeenCalledWith(
      "hello",
      "claude-haiku-4-5-20251001",
    );
    expect(result.servedBy).toEqual({
      driver: "anthropic",
      model: "claude-haiku-4-5-20251001",
    });
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

// ── 10. servedBy is idempotent — a dep that already set it is preserved ──────

describe("servedBy stamping", () => {
  it("does not overwrite a servedBy a dep already provided", async () => {
    const deps = makeDeps({
      providerDriverFn: vi.fn().mockResolvedValue({
        text: "openai-result",
        servedBy: { driver: "openai", model: "gpt-4o-mini" },
      }),
    });
    const result = await executeAgent(
      { driver: "openai", prompt: "hello", model: "gpt-4o" },
      deps,
    );
    // The dep's own attribution (the model it actually fell back to) wins.
    expect(result.servedBy).toEqual({ driver: "openai", model: "gpt-4o-mini" });
  });
});
