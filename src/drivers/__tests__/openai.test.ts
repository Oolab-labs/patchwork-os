import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GrokApiDriver } from "../grok/index.js";
import { OpenAIApiDriver } from "../openai/index.js";

const mockCreate = vi.fn();
vi.mock("openai", () => ({
  default: vi.fn().mockImplementation(() => ({
    chat: { completions: { create: mockCreate } },
  })),
}));

const log = vi.fn();

beforeEach(() => {
  process.env.OPENAI_API_KEY = "test-openai-key";
  process.env.XAI_API_KEY = "test-xai-key";
  mockCreate.mockReset();
  log.mockReset();
});

afterEach(() => {
  delete process.env.OPENAI_API_KEY;
  delete process.env.XAI_API_KEY;
});

function makeStream(chunks: string[]): AsyncIterable<unknown> {
  return {
    [Symbol.asyncIterator]: async function* () {
      for (const c of chunks) {
        yield { choices: [{ delta: { content: c } }] };
      }
    },
  };
}

describe("OpenAIApiDriver", () => {
  it("streams chunks and returns concatenated text", async () => {
    mockCreate.mockResolvedValue(makeStream(["Hello", ", ", "world"]));
    const driver = new OpenAIApiDriver(log);
    const chunks: string[] = [];
    const result = await driver.run({
      prompt: "say hello",
      workspace: "/tmp",
      timeoutMs: 5000,
      signal: AbortSignal.timeout(5000),
      onChunk: (c) => chunks.push(c),
    });
    expect(result.text).toBe("Hello, world");
    expect(chunks).toEqual(["Hello", ", ", "world"]);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("returns errorMessage on API failure", async () => {
    mockCreate.mockRejectedValue(new Error("rate limit"));
    const driver = new OpenAIApiDriver(log);
    const result = await driver.run({
      prompt: "hi",
      workspace: "/tmp",
      timeoutMs: 5000,
      signal: AbortSignal.timeout(5000),
    });
    expect(result.errorMessage).toBe("rate limit");
    expect(result.text).toBe("");
  });

  it("returns wasAborted on AbortError", async () => {
    const ac = new AbortController();
    mockCreate.mockImplementation(async () => {
      ac.abort();
      throw Object.assign(new Error("aborted"), { name: "AbortError" });
    });
    const driver = new OpenAIApiDriver(log);
    const result = await driver.run({
      prompt: "hi",
      workspace: "/tmp",
      timeoutMs: 5000,
      signal: ac.signal,
    });
    expect(result.wasAborted).toBe(true);
  });

  it("uses gpt-4o as default model", async () => {
    mockCreate.mockResolvedValue(makeStream(["ok"]));
    const driver = new OpenAIApiDriver(log);
    await driver.run({
      prompt: "hi",
      workspace: "/tmp",
      timeoutMs: 5000,
      signal: AbortSignal.timeout(5000),
    });
    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({ model: "gpt-4o" }),
      expect.anything(),
    );
  });

  it("respects model override from input", async () => {
    mockCreate.mockResolvedValue(makeStream(["ok"]));
    const driver = new OpenAIApiDriver(log);
    await driver.run({
      prompt: "hi",
      workspace: "/tmp",
      timeoutMs: 5000,
      signal: AbortSignal.timeout(5000),
      model: "gpt-4o-mini",
    });
    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({ model: "gpt-4o-mini" }),
      expect.anything(),
    );
  });

  it("includes systemPrompt as system message", async () => {
    mockCreate.mockResolvedValue(makeStream(["ok"]));
    const driver = new OpenAIApiDriver(log);
    await driver.run({
      prompt: "hi",
      workspace: "/tmp",
      timeoutMs: 5000,
      signal: AbortSignal.timeout(5000),
      systemPrompt: "be concise",
    });
    const call = mockCreate.mock.calls[0]?.[0];
    expect(call.messages[0]).toEqual({ role: "system", content: "be concise" });
  });

  it("throws if OPENAI_API_KEY missing and no baseURL", () => {
    delete process.env.OPENAI_API_KEY;
    expect(() => new OpenAIApiDriver(log)).toThrow(/OPENAI_API_KEY/);
  });
});

describe("GrokApiDriver", () => {
  it("uses grok-2-latest as default model", async () => {
    mockCreate.mockResolvedValue(makeStream(["ok"]));
    const driver = new GrokApiDriver(log);
    await driver.run({
      prompt: "hi",
      workspace: "/tmp",
      timeoutMs: 5000,
      signal: AbortSignal.timeout(5000),
    });
    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({ model: "grok-2-latest" }),
      expect.anything(),
    );
  });

  it("has name grok", () => {
    expect(new GrokApiDriver(log).name).toBe("grok");
  });

  it("throws if XAI_API_KEY missing", () => {
    delete process.env.XAI_API_KEY;
    expect(() => new GrokApiDriver(log)).toThrow(/XAI_API_KEY/);
  });
});
