/**
 * The governed recipe instruction must reach the MODEL on the OpenAI-shaped
 * API drivers (openai, grok, gemini-api), not merely the `providerDriverFn`
 * seam.
 *
 * `agentTransportParity.test.ts` proves `executeAgent` hands the governed
 * prompt to `providerDriverFn` as its 5th argument — against a mock. The
 * production implementation (`makeProviderDriverFn`) declared only four
 * parameters and never set `ProviderTaskInput.systemPrompt`, so under governed
 * the `<untrusted>` envelope arrived in the user message with nothing
 * explaining it. A mocked seam cannot see missing wiring; this test runs the
 * real `makeProviderDriverFn` and the real driver classes, faking only the
 * `openai` SDK so the outgoing request body can be read.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockCreate = vi.fn();
vi.mock("openai", () => ({
  // biome-ignore lint/complexity/useArrowFunction: must be constructable with `new`
  default: vi.fn().mockImplementation(function () {
    return { chat: { completions: { create: mockCreate } } };
  }),
}));

import {
  _resetActiveProfileForTesting,
  resolveProfile,
  setActiveProfile,
} from "../../governance/profile.js";
import { UNTRUSTED_SYSTEM_INSTRUCTION } from "../../governance/untrustedContent.js";
import { type AgentExecutorDeps, executeAgent } from "../agentExecutor.js";
import { makeProviderDriverFn } from "../yamlRunner.js";

function stream(text: string): AsyncIterable<unknown> {
  return {
    [Symbol.asyncIterator]: async function* () {
      yield { choices: [{ delta: { content: text } }] };
    },
  };
}

function deps(): AgentExecutorDeps {
  // Same normalisation the runner applies (`toAgentResult`) — the real
  // implementation may return a bare string.
  const real = makeProviderDriverFn();
  return {
    anthropicFn: vi.fn(),
    providerDriverFn: async (driver, prompt, model, options, systemPrompt) => {
      const r = await real(driver, prompt, model, options, systemPrompt);
      return typeof r === "string" ? { text: r } : r;
    },
    claudeCliFn: vi.fn(),
    localFn: vi.fn(),
    probeClaudeCli: () => false,
    loadPatchworkConfig: () => ({}),
  };
}

const PROMPT = "Summarise <untrusted>synthetic ticket body</untrusted>";

beforeEach(() => {
  _resetActiveProfileForTesting();
  process.env.OPENAI_API_KEY = "test-openai-key";
  process.env.XAI_API_KEY = "test-xai-key";
  process.env.GEMINI_API_KEY = "test-gemini-key";
  mockCreate.mockReset();
  mockCreate.mockImplementation(async () => stream("ok"));
});

afterEach(() => {
  delete process.env.OPENAI_API_KEY;
  delete process.env.XAI_API_KEY;
  delete process.env.GEMINI_API_KEY;
  _resetActiveProfileForTesting();
});

const DRIVERS = ["openai", "grok", "gemini-api"] as const;

describe("governed: API drivers send the untrusted instruction as a system message", () => {
  for (const driver of DRIVERS) {
    it(driver, async () => {
      setActiveProfile(resolveProfile({ profile: "governed" }));
      const res = await executeAgent({ driver, prompt: PROMPT }, deps());
      expect(res.text).toBe("ok");
      const body = mockCreate.mock.calls[0]?.[0] as {
        messages: Array<{ role: string; content: string }>;
      };
      const system = body.messages.filter((m) => m.role === "system");
      expect(system).toHaveLength(1);
      expect(system[0]?.content).toContain(UNTRUSTED_SYSTEM_INSTRUCTION);
      // Sent once, in the system channel — not duplicated into the user turn.
      const all = JSON.stringify(body.messages);
      expect(all.split(UNTRUSTED_SYSTEM_INSTRUCTION).length - 1).toBe(1);
      expect(body.messages.at(-1)).toEqual({ role: "user", content: PROMPT });
    });
  }
});

describe("compat: request is byte-identical to before (no system message)", () => {
  for (const driver of DRIVERS) {
    it(driver, async () => {
      setActiveProfile(resolveProfile({ profile: "compat" }));
      await executeAgent({ driver, prompt: PROMPT }, deps());
      const body = mockCreate.mock.calls[0]?.[0] as { messages: unknown };
      expect(body.messages).toEqual([{ role: "user", content: PROMPT }]);
    });
  }
});
