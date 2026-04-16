import type {
  CompletionParams,
  CompletionResult,
  ModelAdapter,
  StreamChunk,
  ToolCall,
  ToolDef,
} from "./base.js";

/**
 * GeminiAdapter — Google Generative Language API (v1beta generateContent).
 * Uses `fetch` — no SDK dep.
 */

const DEFAULT_MODEL = "gemini-1.5-pro";
const API_BASE = "https://generativelanguage.googleapis.com/v1beta/models";

interface GeminiPart {
  text?: string;
  functionCall?: { name: string; args: Record<string, unknown> };
  functionResponse?: { name: string; response: Record<string, unknown> };
}

interface GeminiResponse {
  candidates?: Array<{
    content: { parts: GeminiPart[]; role: string };
    finishReason?: string;
  }>;
  usageMetadata?: { promptTokenCount: number; candidatesTokenCount: number };
}

export class GeminiAdapter implements ModelAdapter {
  readonly name = "gemini";

  constructor(
    private readonly opts: {
      apiKey?: string;
      defaultModel?: string;
      baseURL?: string;
      fetchImpl?: typeof fetch;
    } = {},
  ) {}

  private get apiKey(): string {
    const key = this.opts.apiKey ?? process.env.GOOGLE_API_KEY;
    if (!key)
      throw new Error(
        "GeminiAdapter: no API key. Set GOOGLE_API_KEY or config.apiKeys.google.",
      );
    return key;
  }

  private translateTools(tools: ToolDef[] | undefined) {
    if (!tools?.length) return undefined;
    return [
      {
        functionDeclarations: tools.map((t) => ({
          name: t.name,
          description: t.description,
          parameters: t.inputSchema,
        })),
      },
    ];
  }

  async complete(params: CompletionParams): Promise<CompletionResult> {
    const model = params.model ?? this.opts.defaultModel ?? DEFAULT_MODEL;
    const url =
      this.opts.baseURL ??
      `${API_BASE}/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(this.apiKey)}`;

    const contents = params.messages
      .filter((m) => m.role !== "system")
      .map((m) => ({
        role: m.role === "assistant" ? "model" : "user",
        parts: [{ text: m.content }],
      }));

    const body = {
      systemInstruction: params.systemPrompt
        ? { parts: [{ text: params.systemPrompt }] }
        : undefined,
      contents,
      tools: this.translateTools(params.tools),
      generationConfig: {
        maxOutputTokens: params.maxTokens,
        temperature: params.temperature,
      },
    };

    const fetchImpl = this.opts.fetchImpl ?? fetch;
    const res = await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(
        `GeminiAdapter: API error ${res.status}: ${text.slice(0, 500)}`,
      );
    }

    const data = (await res.json()) as GeminiResponse;
    const candidate = data.candidates?.[0];
    const parts: GeminiPart[] = candidate?.content?.parts ?? [];
    const text = parts
      .map((p) => p.text ?? "")
      .join("")
      .trim();
    const toolCalls: ToolCall[] = parts
      .filter((p) => p.functionCall)
      .map((p, i) => ({
        id: `gemini_${Date.now()}_${i}`,
        name: p.functionCall?.name ?? "",
        arguments: p.functionCall?.args ?? {},
      }));

    const stopReason: CompletionResult["stopReason"] =
      toolCalls.length > 0
        ? "tool_use"
        : candidate?.finishReason === "MAX_TOKENS"
          ? "max_tokens"
          : "end_turn";

    return {
      text,
      toolCalls,
      stopReason,
      usage: {
        inputTokens: data.usageMetadata?.promptTokenCount ?? 0,
        outputTokens: data.usageMetadata?.candidatesTokenCount ?? 0,
      },
    };
  }

  async *stream(params: CompletionParams): AsyncIterable<StreamChunk> {
    try {
      const result = await this.complete(params);
      if (result.text) yield { type: "text", delta: result.text };
      for (const tc of result.toolCalls) {
        yield { type: "tool_call_start", id: tc.id, name: tc.name };
        yield {
          type: "tool_call_delta",
          id: tc.id,
          argumentsDelta: JSON.stringify(tc.arguments),
        };
        yield { type: "tool_call_end", id: tc.id };
      }
      yield { type: "done", result };
    } catch (err) {
      yield {
        type: "error",
        message: err instanceof Error ? err.message : String(err),
      };
    }
  }

  supportsTools() {
    return true;
  }
  supportsVision() {
    return true;
  }
}
