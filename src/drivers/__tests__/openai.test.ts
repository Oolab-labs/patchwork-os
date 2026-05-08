import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GeminiApiDriver } from "../gemini/api.js";
import { GrokApiDriver } from "../grok/index.js";
import { LocalApiDriver } from "../local/index.js";
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
  process.env.GEMINI_API_KEY = "test-gemini-key";
  process.env.LOCAL_ENDPOINT = "http://localhost:11434/v1";
  process.env.LOCAL_MODEL = "llama3.2";
  mockCreate.mockReset();
  log.mockReset();
});

afterEach(() => {
  delete process.env.OPENAI_API_KEY;
  delete process.env.XAI_API_KEY;
  delete process.env.GEMINI_API_KEY;
  delete process.env.LOCAL_ENDPOINT;
  delete process.env.LOCAL_MODEL;
  delete process.env.LOCAL_API_KEY;
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

  it("appends context file list to prompt when contextFiles provided", async () => {
    mockCreate.mockResolvedValue(makeStream(["ok"]));
    const driver = new OpenAIApiDriver(log);
    await driver.run({
      prompt: "hi",
      workspace: "/tmp",
      timeoutMs: 5000,
      signal: AbortSignal.timeout(5000),
      contextFiles: ["src/foo.ts", "src/bar.ts"],
    });
    const call = mockCreate.mock.calls[0]?.[0];
    const userMsg = call.messages.find(
      (m: { role: string }) => m.role === "user",
    );
    expect(userMsg?.content).toContain("BEGIN CONTEXT FILE LIST");
    expect(userMsg?.content).toContain("src/foo.ts");
  });

  it("records startupMs on first chunk", async () => {
    mockCreate.mockResolvedValue(makeStream(["hello"]));
    const driver = new OpenAIApiDriver(log);
    const result = await driver.run({
      prompt: "hi",
      workspace: "/tmp",
      timeoutMs: 5000,
      signal: AbortSignal.timeout(5000),
    });
    expect(result.startupMs).toBeGreaterThanOrEqual(0);
  });

  it("passes temperature when set in providerOptions", async () => {
    mockCreate.mockResolvedValue(makeStream(["ok"]));
    const driver = new OpenAIApiDriver(log);
    await driver.run({
      prompt: "hi",
      workspace: "/tmp",
      timeoutMs: 5000,
      signal: AbortSignal.timeout(5000),
      providerOptions: { temperature: 0.5 },
    });
    const call = mockCreate.mock.calls[0]?.[0];
    expect(call.temperature).toBe(0.5);
  });

  it("omits temperature when not set", async () => {
    mockCreate.mockResolvedValue(makeStream(["ok"]));
    const driver = new OpenAIApiDriver(log);
    await driver.run({
      prompt: "hi",
      workspace: "/tmp",
      timeoutMs: 5000,
      signal: AbortSignal.timeout(5000),
    });
    const call = mockCreate.mock.calls[0]?.[0];
    expect(call).not.toHaveProperty("temperature");
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

describe("GeminiApiDriver", () => {
  // Same approach as GrokApiDriver: subclass OpenAIApiDriver with Google's
  // OpenAI-compatible chat-completions endpoint as baseURL. Tests mirror
  // the Grok suite (default model, name, missing-key throw).

  it("uses gemini-2.5-pro as default model", async () => {
    mockCreate.mockResolvedValue(makeStream(["ok"]));
    const driver = new GeminiApiDriver(log);
    await driver.run({
      prompt: "hi",
      workspace: "/tmp",
      timeoutMs: 5000,
      signal: AbortSignal.timeout(5000),
    });
    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({ model: "gemini-2.5-pro" }),
      expect.anything(),
    );
  });

  it("has name gemini-api", () => {
    expect(new GeminiApiDriver(log).name).toBe("gemini-api");
  });

  it("throws if GEMINI_API_KEY missing", () => {
    delete process.env.GEMINI_API_KEY;
    expect(() => new GeminiApiDriver(log)).toThrow(/GEMINI_API_KEY/);
  });

  it("respects model override (e.g. gemini-2.5-flash)", async () => {
    mockCreate.mockResolvedValue(makeStream(["ok"]));
    const driver = new GeminiApiDriver(log);
    await driver.run({
      prompt: "hi",
      workspace: "/tmp",
      timeoutMs: 5000,
      signal: AbortSignal.timeout(5000),
      model: "gemini-2.5-flash",
    });
    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({ model: "gemini-2.5-flash" }),
      expect.anything(),
    );
  });
});

describe("LocalApiDriver", () => {
  // Subclasses OpenAIApiDriver with the configured LOCAL_ENDPOINT and
  // LOCAL_MODEL env vars. The bridge auto-injects these from
  // patchworkConfig.localEndpoint / localModel at startup
  // (src/config.ts), so a dashboard save → next-restart round-trip works
  // without any explicit driver wiring.

  it("uses LOCAL_MODEL env value as default model", async () => {
    mockCreate.mockResolvedValue(makeStream(["ok"]));
    const driver = new LocalApiDriver(log);
    await driver.run({
      prompt: "hi",
      workspace: "/tmp",
      timeoutMs: 5000,
      signal: AbortSignal.timeout(5000),
    });
    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({ model: "llama3.2" }),
      expect.anything(),
    );
  });

  it("falls back to llama3.2 when LOCAL_MODEL is unset", async () => {
    delete process.env.LOCAL_MODEL;
    mockCreate.mockResolvedValue(makeStream(["ok"]));
    const driver = new LocalApiDriver(log);
    await driver.run({
      prompt: "hi",
      workspace: "/tmp",
      timeoutMs: 5000,
      signal: AbortSignal.timeout(5000),
    });
    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({ model: "llama3.2" }),
      expect.anything(),
    );
  });

  it("respects model override (e.g. qwen3-coder:30b)", async () => {
    mockCreate.mockResolvedValue(makeStream(["ok"]));
    const driver = new LocalApiDriver(log);
    await driver.run({
      prompt: "hi",
      workspace: "/tmp",
      timeoutMs: 5000,
      signal: AbortSignal.timeout(5000),
      model: "qwen3-coder:30b",
    });
    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({ model: "qwen3-coder:30b" }),
      expect.anything(),
    );
  });

  it("has name local", () => {
    expect(new LocalApiDriver(log).name).toBe("local");
  });

  it("throws if LOCAL_ENDPOINT missing", () => {
    delete process.env.LOCAL_ENDPOINT;
    expect(() => new LocalApiDriver(log)).toThrow(/LOCAL_ENDPOINT/);
  });

  describe("LOCAL_ENDPOINT host validation", () => {
    afterEach(() => {
      delete process.env.LOCAL_ENDPOINT_ALLOW_REMOTE;
    });

    it("rejects non-loopback / non-private hostnames", () => {
      process.env.LOCAL_ENDPOINT = "https://attacker.example.com/v1";
      expect(() => new LocalApiDriver(log)).toThrow(/not loopback or private/i);
    });

    it("rejects public IPv4 addresses", () => {
      process.env.LOCAL_ENDPOINT = "http://8.8.8.8:11434/v1";
      expect(() => new LocalApiDriver(log)).toThrow(/not loopback or private/i);
    });

    it("accepts localhost", () => {
      process.env.LOCAL_ENDPOINT = "http://localhost:11434/v1";
      expect(() => new LocalApiDriver(log)).not.toThrow();
    });

    it("accepts 127.0.0.1", () => {
      process.env.LOCAL_ENDPOINT = "http://127.0.0.1:11434/v1";
      expect(() => new LocalApiDriver(log)).not.toThrow();
    });

    it("accepts RFC1918 (192.168.x.x)", () => {
      process.env.LOCAL_ENDPOINT = "http://192.168.1.50:11434/v1";
      expect(() => new LocalApiDriver(log)).not.toThrow();
    });

    it("accepts 10.x.x.x", () => {
      process.env.LOCAL_ENDPOINT = "http://10.0.0.5:11434/v1";
      expect(() => new LocalApiDriver(log)).not.toThrow();
    });

    it("accepts 172.16-31.x.x but rejects 172.32+", () => {
      process.env.LOCAL_ENDPOINT = "http://172.16.0.1:11434/v1";
      expect(() => new LocalApiDriver(log)).not.toThrow();
      process.env.LOCAL_ENDPOINT = "http://172.31.255.255:11434/v1";
      expect(() => new LocalApiDriver(log)).not.toThrow();
      process.env.LOCAL_ENDPOINT = "http://172.32.0.1:11434/v1";
      expect(() => new LocalApiDriver(log)).toThrow(/not loopback or private/i);
    });

    it("accepts .local mDNS hostnames", () => {
      process.env.LOCAL_ENDPOINT = "http://printer.local:11434/v1";
      expect(() => new LocalApiDriver(log)).not.toThrow();
    });

    it("LOCAL_ENDPOINT_ALLOW_REMOTE=1 bypasses validation", () => {
      process.env.LOCAL_ENDPOINT = "https://remote-llm.example.com/v1";
      process.env.LOCAL_ENDPOINT_ALLOW_REMOTE = "1";
      expect(() => new LocalApiDriver(log)).not.toThrow();
    });

    it("rejects malformed URLs", () => {
      process.env.LOCAL_ENDPOINT = "not-a-url";
      expect(() => new LocalApiDriver(log)).toThrow(/not loopback or private/i);
    });
  });
});
