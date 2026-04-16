import type {
  CompletionParams,
  CompletionResult,
  ModelAdapter,
  StreamChunk,
  ToolCall,
  ToolDef,
} from "./base.js";

/**
 * OpenAIAdapter — Chat Completions API via fetch. Compatible with any
 * OpenAI-compatible endpoint (Ollama, LM Studio, vLLM, Together.ai, ...)
 * by setting baseURL.
 */

const DEFAULT_MODEL = "gpt-4o";
const DEFAULT_MAX_TOKENS = 4096;
const API_URL = "https://api.openai.com/v1/chat/completions";

interface OpenAIToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

interface OpenAIChoice {
  message: {
    role: "assistant";
    content: string | null;
    tool_calls?: OpenAIToolCall[];
  };
  finish_reason: "stop" | "length" | "tool_calls" | "content_filter" | null;
}

interface OpenAIResponse {
  choices: OpenAIChoice[];
  usage: { prompt_tokens: number; completion_tokens: number };
}

export class OpenAIAdapter implements ModelAdapter {
  readonly name: string;

  constructor(
    private readonly opts: {
      apiKey?: string;
      baseURL?: string;
      defaultModel?: string;
      fetchImpl?: typeof fetch;
      /** Override the adapter's public name; "local" uses this for Ollama. */
      adapterName?: string;
      /** Some local endpoints (Ollama) don't require a bearer token. */
      requireApiKey?: boolean;
    } = {},
  ) {
    this.name = opts.adapterName ?? "openai";
  }

  private getApiKey(): string | undefined {
    const required = this.opts.requireApiKey ?? this.name === "openai";
    const key = this.opts.apiKey ?? process.env.OPENAI_API_KEY;
    if (required && !key) {
      throw new Error(
        `${this.name}Adapter: no API key. Set OPENAI_API_KEY or config.apiKeys.openai.`,
      );
    }
    return key;
  }

  private translateTools(tools: ToolDef[] | undefined) {
    if (!tools?.length) return undefined;
    return tools.map((t) => ({
      type: "function" as const,
      function: {
        name: t.name,
        description: t.description,
        parameters: t.inputSchema,
      },
    }));
  }

  private translateMessages(params: CompletionParams) {
    const out: Array<Record<string, unknown>> = [];
    if (params.systemPrompt) {
      out.push({ role: "system", content: params.systemPrompt });
    }
    for (const m of params.messages) {
      if (m.role === "tool") {
        out.push({
          role: "tool",
          tool_call_id: m.toolCallId ?? "",
          content: m.content,
        });
      } else if (m.role === "assistant" && m.toolCalls?.length) {
        out.push({
          role: "assistant",
          content: m.content || null,
          tool_calls: m.toolCalls.map((tc) => ({
            id: tc.id,
            type: "function",
            function: {
              name: tc.name,
              arguments: JSON.stringify(tc.arguments),
            },
          })),
        });
      } else {
        out.push({ role: m.role, content: m.content });
      }
    }
    return out;
  }

  async complete(params: CompletionParams): Promise<CompletionResult> {
    const apiKey = this.getApiKey();
    const body = {
      model: params.model ?? this.opts.defaultModel ?? DEFAULT_MODEL,
      messages: this.translateMessages(params),
      tools: this.translateTools(params.tools),
      max_tokens: params.maxTokens ?? DEFAULT_MAX_TOKENS,
      temperature: params.temperature,
    };

    const headers: Record<string, string> = {
      "content-type": "application/json",
    };
    if (apiKey) headers.authorization = `Bearer ${apiKey}`;

    const fetchImpl = this.opts.fetchImpl ?? fetch;
    const res = await fetchImpl(this.opts.baseURL ?? API_URL, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(
        `${this.name}Adapter: API error ${res.status}: ${text.slice(0, 500)}`,
      );
    }

    const data = (await res.json()) as OpenAIResponse;
    const choice = data.choices[0];
    if (!choice) throw new Error(`${this.name}Adapter: empty choices`);
    const text = choice.message.content ?? "";
    const toolCalls: ToolCall[] = (choice.message.tool_calls ?? []).map(
      (tc) => ({
        id: tc.id,
        name: tc.function.name,
        arguments: safeJsonParse(tc.function.arguments),
      }),
    );

    const stopReason: CompletionResult["stopReason"] =
      choice.finish_reason === "tool_calls"
        ? "tool_use"
        : choice.finish_reason === "length"
          ? "max_tokens"
          : choice.finish_reason === "stop"
            ? "end_turn"
            : "error";

    return {
      text,
      toolCalls,
      stopReason,
      usage: {
        inputTokens: data.usage?.prompt_tokens ?? 0,
        outputTokens: data.usage?.completion_tokens ?? 0,
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

function safeJsonParse(s: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(s);
    return typeof parsed === "object" && parsed !== null ? parsed : {};
  } catch {
    return {};
  }
}
