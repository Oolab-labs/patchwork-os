import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiDriver } from "../claude/api.js";
import type { ProviderTaskInput } from "../types.js";

const mockCreate = vi.fn();
vi.mock("@anthropic-ai/sdk", () => ({
  default: vi.fn().mockImplementation(() => ({
    messages: { create: mockCreate },
  })),
}));

const log = vi.fn();

beforeEach(() => {
  process.env.ANTHROPIC_API_KEY = "test-anthropic-key";
  mockCreate.mockReset();
  log.mockReset();
});

afterEach(() => {
  delete process.env.ANTHROPIC_API_KEY;
});

function makeInput(
  overrides: Partial<ProviderTaskInput> = {},
): ProviderTaskInput {
  return {
    prompt: "hi",
    workspace: "/tmp",
    timeoutMs: 5000,
    signal: new AbortController().signal,
    ...overrides,
  };
}

describe("ApiDriver", () => {
  it("returns concatenated text on success", async () => {
    mockCreate.mockResolvedValue({
      content: [
        { type: "text", text: "Hello" },
        { type: "text", text: ", world" },
      ],
    });
    const driver = new ApiDriver(log);
    const result = await driver.run(makeInput());
    expect(result.text).toBe("Hello, world");
    expect(result.exitCode).toBe(0);
  });

  it("forwards token usage from message.usage into providerMeta", async () => {
    mockCreate.mockResolvedValue({
      model: "claude-haiku-4-5-20251001",
      content: [{ type: "text", text: "hi" }],
      usage: { input_tokens: 10, output_tokens: 20 },
    });
    const driver = new ApiDriver(log);
    const result = await driver.run(makeInput());
    expect(result.providerMeta).toEqual({
      model: "claude-haiku-4-5-20251001",
      inputTokens: 10,
      outputTokens: 20,
    });
  });

  it("omits token counts when usage is absent (fail-open)", async () => {
    mockCreate.mockResolvedValue({ content: [{ type: "text", text: "hi" }] });
    const driver = new ApiDriver(log);
    const result = await driver.run(makeInput({ model: "claude-x" }));
    // model falls back to input.model; no token fields → RunBudget skips it.
    expect(result.providerMeta).toEqual({ model: "claude-x" });
  });

  // Bug 2 regression: ProviderDriver.run must resolve, never reject. Before the
  // try/catch was added, a rejecting messages.create propagated the rejection.
  it("resolves with errorMessage when messages.create throws (does not reject)", async () => {
    mockCreate.mockRejectedValue(new Error("rate limit"));
    const driver = new ApiDriver(log);
    const result = await driver.run(makeInput());
    expect(result.errorMessage).toBe("rate limit");
    expect(result.text).toBe("");
    expect(result.wasAborted).toBeUndefined();
  });

  it("resolves with wasAborted on AbortError (does not reject)", async () => {
    const ac = new AbortController();
    mockCreate.mockImplementation(async () => {
      ac.abort();
      throw Object.assign(new Error("aborted"), { name: "AbortError" });
    });
    const driver = new ApiDriver(log);
    const result = await driver.run(makeInput({ signal: ac.signal }));
    expect(result.wasAborted).toBe(true);
    expect(result.text).toBe("");
    expect(result.errorMessage).toBeUndefined();
  });

  it("treats a thrown error as aborted when the signal is already aborted", async () => {
    const ac = new AbortController();
    ac.abort();
    mockCreate.mockRejectedValue(new Error("request cancelled"));
    const driver = new ApiDriver(log);
    const result = await driver.run(makeInput({ signal: ac.signal }));
    expect(result.wasAborted).toBe(true);
    expect(result.errorMessage).toBeUndefined();
  });
});
