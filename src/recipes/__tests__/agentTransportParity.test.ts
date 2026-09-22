/**
 * Provenance step 2 — the governed recipe instruction reaches EVERY agent
 * transport, resolved once at the executor seam.
 *
 * Inventory finding (main @ faab4bd7): of the four transports a recipe agent
 * step can dispatch through, exactly one carried the governed system prompt.
 * `defaultClaudeCodeFn` chose it internally for the subprocess path
 * (yamlRunner, profile-gated); `anthropicFn`, `providerDriverFn` and `localFn`
 * had no system-prompt parameter AT ALL, so there was nowhere to put one.
 * `localFn`'s implementation passed a bare `systemPrompt: ""` — an explicit
 * empty that reads as a decision and cannot be told apart from an omission.
 *
 * The rule this pins: **governance decides the mandatory recipe instruction
 * ONCE, at the executor seam; transports only receive it.** No driver reads
 * `activeProfile()`.
 *
 * ## Compat is protected structurally, not by care
 *
 * Under `compat` the executor passes NO extra argument, so every call keeps
 * the exact shape and arity it had. That is what lets the 19 pre-existing
 * `toHaveBeenCalledWith` assertions across `agentExecutor.test.ts` and its
 * siblings go on proving the old contract instead of being rewritten to
 * accommodate this feature. A test that had to be edited to keep passing would
 * have stopped being evidence.
 *
 * ## The 4-then-5 argument trap
 *
 * `providerDriverFn` already has an optional 4th argument (`providerOptions`).
 * The governed system prompt is a 5th, so an ungoverned-options call under
 * `governed` MUST pass `undefined` in the 4th position explicitly — otherwise
 * the governance string lands where provider options are read. Pinned below.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  _resetActiveProfileForTesting,
  resolveProfile,
  setActiveProfile,
} from "../../governance/profile.js";
import { UNTRUSTED_SYSTEM_INSTRUCTION } from "../../governance/untrustedContent.js";
import { type AgentExecutorDeps, executeAgent } from "../agentExecutor.js";
import { RECIPE_SYSTEM_PROMPT_GOVERNED } from "../yamlRunner.js";

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

const governed = () =>
  setActiveProfile(resolveProfile({ profile: "governed" }));
const compat = () => setActiveProfile(resolveProfile({ profile: "compat" }));

beforeEach(() => _resetActiveProfileForTesting());

describe("governed — every transport receives the instruction", () => {
  beforeEach(governed);

  it("anthropic", async () => {
    const deps = makeDeps();
    await executeAgent(
      { driver: "anthropic", prompt: "hello", model: "claude-haiku" },
      deps,
    );
    expect(deps.anthropicFn).toHaveBeenCalledWith(
      "hello",
      "claude-haiku",
      RECIPE_SYSTEM_PROMPT_GOVERNED,
    );
  });

  it("provider driver, no providerOptions — the 4th arg is an explicit undefined", async () => {
    const deps = makeDeps();
    await executeAgent(
      { driver: "openai", prompt: "hello", model: "gpt-4o" },
      deps,
    );
    // The governance string must NOT land in the providerOptions position.
    expect(deps.providerDriverFn).toHaveBeenCalledWith(
      "openai",
      "hello",
      "gpt-4o",
      undefined,
      RECIPE_SYSTEM_PROMPT_GOVERNED,
    );
  });

  it("provider driver, WITH providerOptions — options preserved, prompt appended", async () => {
    const deps = makeDeps();
    await executeAgent(
      {
        driver: "openai",
        prompt: "hello",
        model: "gpt-4o",
        providerOptions: { responseFormat: "json" },
      },
      deps,
    );
    expect(deps.providerDriverFn).toHaveBeenCalledWith(
      "openai",
      "hello",
      "gpt-4o",
      { responseFormat: "json" },
      RECIPE_SYSTEM_PROMPT_GOVERNED,
    );
  });

  it("local — the bare empty system prompt is gone", async () => {
    const deps = makeDeps();
    await executeAgent(
      { driver: "local", prompt: "hello", model: "llama3" },
      deps,
    );
    expect(deps.localFn).toHaveBeenCalledWith(
      "hello",
      "llama3",
      RECIPE_SYSTEM_PROMPT_GOVERNED,
    );
  });

  it("subprocess receives the EXECUTOR-resolved prompt through opts", async () => {
    const deps = makeDeps();
    await executeAgent(
      { driver: "subprocess", prompt: "hello", model: "claude-haiku" },
      deps,
    );
    const opts = vi.mocked(deps.claudeCliFn).mock.calls[0]?.[1];
    expect(opts?.systemPrompt).toBe(RECIPE_SYSTEM_PROMPT_GOVERNED);
  });

  it("what every transport receives names the untrusted envelope", () => {
    // One assertion for the property that actually matters, so a future
    // rewording of the recipe prompt cannot quietly drop the governance half.
    expect(RECIPE_SYSTEM_PROMPT_GOVERNED).toContain(
      UNTRUSTED_SYSTEM_INSTRUCTION,
    );
  });
});

describe("compat — exact pre-change call shapes", () => {
  beforeEach(compat);

  it("anthropic keeps its 2-arg call", async () => {
    const deps = makeDeps();
    await executeAgent(
      { driver: "anthropic", prompt: "hello", model: "claude-haiku" },
      deps,
    );
    expect(deps.anthropicFn).toHaveBeenCalledWith("hello", "claude-haiku");
  });

  it("provider driver keeps its 3-arg call when unconstrained", async () => {
    const deps = makeDeps();
    await executeAgent(
      { driver: "openai", prompt: "hello", model: "gpt-4o" },
      deps,
    );
    expect(deps.providerDriverFn).toHaveBeenCalledWith(
      "openai",
      "hello",
      "gpt-4o",
    );
  });

  it("provider driver keeps its 4-arg call when providerOptions are set", async () => {
    const deps = makeDeps();
    await executeAgent(
      {
        driver: "openai",
        prompt: "hello",
        model: "gpt-4o",
        providerOptions: { responseFormat: "json" },
      },
      deps,
    );
    expect(deps.providerDriverFn).toHaveBeenCalledWith(
      "openai",
      "hello",
      "gpt-4o",
      {
        responseFormat: "json",
      },
    );
  });

  it("local keeps its 2-arg call", async () => {
    const deps = makeDeps();
    await executeAgent(
      { driver: "local", prompt: "hello", model: "llama3" },
      deps,
    );
    expect(deps.localFn).toHaveBeenCalledWith("hello", "llama3");
  });

  it("subprocess sends no executor-resolved prompt, leaving the impl's own fallback in charge", async () => {
    const deps = makeDeps();
    await executeAgent(
      { driver: "subprocess", prompt: "hello", model: "claude-haiku" },
      deps,
    );
    const opts = vi.mocked(deps.claudeCliFn).mock.calls[0]?.[1];
    expect(opts?.systemPrompt).toBeUndefined();
  });
});

describe("no transport decides governance for itself", () => {
  it("no driver module reads activeProfile()", async () => {
    const { readFileSync, readdirSync } = await import("node:fs");
    const path = await import("node:path");
    const dir = path.join(__dirname, "..", "..", "drivers");
    const offenders: string[] = [];
    const walk = (d: string): void => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) {
          if (e.name !== "__tests__") walk(p);
          continue;
        }
        if (!e.name.endsWith(".ts")) continue;
        if (readFileSync(p, "utf-8").includes("activeProfile(")) {
          offenders.push(e.name);
        }
      }
    };
    walk(dir);
    expect(offenders).toEqual([]);
  });
});
