import { describe, expect, it, vi } from "vitest";
import { validateModelChoice } from "../../patchworkConfig.js";
import { ClaudeAdapter } from "../claude.js";
import { GeminiAdapter } from "../gemini.js";
import { createGrokAdapter } from "../grok.js";
import { createAdapter } from "../index.js";
import { createLocalAdapter } from "../local.js";
import { OpenAIAdapter } from "../openai.js";

function mockFetch(body: unknown, ok = true, status = 200) {
  return vi.fn(async () => ({
    ok,
    status,
    json: async () => body,
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
  })) as unknown as typeof fetch;
}

describe("createAdapter factory", () => {
  it("dispatches to each provider", () => {
    expect(
      createAdapter({ model: "claude", apiKeys: { anthropic: "x" } }).name,
    ).toBe("claude");
    expect(
      createAdapter({ model: "openai", apiKeys: { openai: "x" } }).name,
    ).toBe("openai");
    expect(
      createAdapter({ model: "gemini", apiKeys: { google: "x" } }).name,
    ).toBe("gemini");
    expect(createAdapter({ model: "grok", apiKeys: { xai: "x" } }).name).toBe(
      "grok",
    );
    expect(createAdapter({ model: "local" }).name).toBe("local");
  });

  it("throws on unknown model", () => {
    expect(() => createAdapter({ model: "bogus" as never })).toThrow(
      /Unknown model/,
    );
  });
});

describe("validateModelChoice", () => {
  it.each([
    "claude",
    "openai",
    "gemini",
    "grok",
    "local",
  ])("accepts %s", (m) => {
    expect(validateModelChoice(m)).toBe(true);
  });
  it("rejects invalid", () => {
    expect(validateModelChoice("gpt4")).toBe(false);
    expect(validateModelChoice("")).toBe(false);
  });
});

describe("ClaudeAdapter", () => {
  it("calls Messages API + parses text + tool_use", async () => {
    const fetchImpl = mockFetch({
      content: [
        { type: "text", text: "hello" },
        {
          type: "tool_use",
          id: "t1",
          name: "read_file",
          input: { path: "a.ts" },
        },
      ],
      stop_reason: "tool_use",
      usage: { input_tokens: 10, output_tokens: 5 },
    });
    const a = new ClaudeAdapter({ apiKey: "sk-x", fetchImpl });
    const r = await a.complete({
      systemPrompt: "sys",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(r.text).toBe("hello");
    expect(r.toolCalls).toEqual([
      { id: "t1", name: "read_file", arguments: { path: "a.ts" } },
    ]);
    expect(r.stopReason).toBe("tool_use");
    expect(r.usage).toEqual({ inputTokens: 10, outputTokens: 5 });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("throws on missing api key", async () => {
    const prev = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = "";
    try {
      await expect(
        new ClaudeAdapter().complete({ systemPrompt: "", messages: [] }),
      ).rejects.toThrow(/no API key/);
    } finally {
      if (prev !== undefined) process.env.ANTHROPIC_API_KEY = prev;
      else process.env.ANTHROPIC_API_KEY = undefined as unknown as string;
    }
  });

  it("surfaces API error", async () => {
    const fetchImpl = mockFetch("rate limited", false, 429);
    const a = new ClaudeAdapter({ apiKey: "k", fetchImpl });
    await expect(
      a.complete({
        systemPrompt: "",
        messages: [{ role: "user", content: "x" }],
      }),
    ).rejects.toThrow(/API error 429/);
  });

  it("stream emits text + done", async () => {
    const fetchImpl = mockFetch({
      content: [{ type: "text", text: "hi" }],
      stop_reason: "end_turn",
      usage: { input_tokens: 1, output_tokens: 1 },
    });
    const a = new ClaudeAdapter({ apiKey: "k", fetchImpl });
    const chunks = [];
    for await (const c of a.stream({
      systemPrompt: "",
      messages: [{ role: "user", content: "x" }],
    })) {
      chunks.push(c);
    }
    expect(chunks[0]).toEqual({ type: "text", delta: "hi" });
    expect(chunks.at(-1)?.type).toBe("done");
  });

  it("translates tool_result messages back to Anthropic shape", async () => {
    let sentBody: Record<string, unknown> = {};
    const fetchImpl = vi.fn(async (_url: unknown, init: RequestInit) => {
      sentBody = JSON.parse(init.body as string);
      return {
        ok: true,
        status: 200,
        json: async () => ({
          content: [{ type: "text", text: "ok" }],
          stop_reason: "end_turn",
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
        text: async () => "",
      };
    }) as unknown as typeof fetch;

    const a = new ClaudeAdapter({ apiKey: "k", fetchImpl });
    await a.complete({
      systemPrompt: "sys",
      messages: [
        { role: "user", content: "q" },
        {
          role: "assistant",
          content: "",
          toolCalls: [{ id: "t1", name: "read", arguments: { p: "a" } }],
        },
        { role: "tool", toolCallId: "t1", content: "contents" },
      ],
    });
    const msgs = sentBody.messages as Array<{ role: string; content: unknown }>;
    expect(sentBody.system).toBe("sys");
    expect(msgs[1]?.content).toMatchObject([
      expect.objectContaining({ type: "tool_use", id: "t1", name: "read" }),
    ]);
    expect(msgs[2]?.content).toMatchObject([
      expect.objectContaining({ type: "tool_result", tool_use_id: "t1" }),
    ]);
  });
});

describe("OpenAIAdapter", () => {
  it("calls Chat Completions + parses tool_calls", async () => {
    const fetchImpl = mockFetch({
      choices: [
        {
          message: {
            role: "assistant",
            content: "sure",
            tool_calls: [
              {
                id: "c1",
                type: "function",
                function: { name: "read_file", arguments: '{"path":"a.ts"}' },
              },
            ],
          },
          finish_reason: "tool_calls",
        },
      ],
      usage: { prompt_tokens: 12, completion_tokens: 3 },
    });
    const a = new OpenAIAdapter({ apiKey: "sk", fetchImpl });
    const r = await a.complete({
      systemPrompt: "sys",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(r.text).toBe("sure");
    expect(r.toolCalls[0]).toEqual({
      id: "c1",
      name: "read_file",
      arguments: { path: "a.ts" },
    });
    expect(r.stopReason).toBe("tool_use");
  });

  it("handles malformed tool args gracefully", async () => {
    const fetchImpl = mockFetch({
      choices: [
        {
          message: {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "c1",
                type: "function",
                function: { name: "x", arguments: "not-json" },
              },
            ],
          },
          finish_reason: "tool_calls",
        },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    });
    const a = new OpenAIAdapter({ apiKey: "sk", fetchImpl });
    const r = await a.complete({
      systemPrompt: "",
      messages: [{ role: "user", content: "x" }],
    });
    expect(r.toolCalls[0]?.arguments).toEqual({});
  });

  it("maps finish_reason length → max_tokens", async () => {
    const fetchImpl = mockFetch({
      choices: [
        {
          message: { role: "assistant", content: "truncated" },
          finish_reason: "length",
        },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    });
    const a = new OpenAIAdapter({ apiKey: "k", fetchImpl });
    const r = await a.complete({
      systemPrompt: "",
      messages: [{ role: "user", content: "x" }],
    });
    expect(r.stopReason).toBe("max_tokens");
  });
});

describe("LocalAdapter (OpenAI-compat)", () => {
  it("does not require api key", async () => {
    const fetchImpl = mockFetch({
      choices: [
        {
          message: { role: "assistant", content: "yo" },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    });
    const a = createLocalAdapter({ fetchImpl });
    expect(a.name).toBe("local");
    const r = await a.complete({
      systemPrompt: "",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(r.text).toBe("yo");
  });
});

describe("GrokAdapter", () => {
  it("reuses OpenAI shape", async () => {
    const fetchImpl = mockFetch({
      choices: [
        {
          message: { role: "assistant", content: "grok says hi" },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    });
    const a = createGrokAdapter({ apiKey: "xai-x", fetchImpl });
    expect(a.name).toBe("grok");
    const r = await a.complete({
      systemPrompt: "",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(r.text).toBe("grok says hi");
  });

  it("throws without key", () => {
    const prev = process.env.XAI_API_KEY;
    process.env.XAI_API_KEY = "";
    try {
      expect(() => createGrokAdapter({})).toThrow(/no API key/);
    } finally {
      if (prev !== undefined) process.env.XAI_API_KEY = prev;
      else process.env.XAI_API_KEY = undefined as unknown as string;
    }
  });
});

describe("GeminiAdapter", () => {
  it("parses functionCall into ToolCall", async () => {
    const fetchImpl = mockFetch({
      candidates: [
        {
          content: {
            role: "model",
            parts: [
              { text: "let me check" },
              { functionCall: { name: "read_file", args: { path: "a.ts" } } },
            ],
          },
          finishReason: "STOP",
        },
      ],
      usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 2 },
    });
    const a = new GeminiAdapter({ apiKey: "AIza", fetchImpl });
    const r = await a.complete({
      systemPrompt: "sys",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(r.text).toBe("let me check");
    expect(r.toolCalls[0]?.name).toBe("read_file");
    expect(r.stopReason).toBe("tool_use");
  });
});
