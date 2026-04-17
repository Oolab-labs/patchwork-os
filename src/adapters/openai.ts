import type {
  CompletionParams,
  CompletionResult,
  ModelAdapter,
  StreamChunk,
  ToolCall,
  ToolDef,
} from "./base.js";
import { parseSseStream } from "./sse.js";

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
    const apiKey = this.getApiKey();
    const body = {
      model: params.model ?? this.opts.defaultModel ?? DEFAULT_MODEL,
      messages: this.translateMessages(params),
      tools: this.translateTools(params.tools),
      max_tokens: params.maxTokens ?? DEFAULT_MAX_TOKENS,
      temperature: params.temperature,
      stream: true,
    };

    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: "text/event-stream",
    };
    if (apiKey) headers.authorization = `Bearer ${apiKey}`;

    const fetchImpl = this.opts.fetchImpl ?? fetch;
    let res: Response;
    try {
      res = await fetchImpl(this.opts.baseURL ?? API_URL, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      });
    } catch (err) {
      yield {
        type: "error",
        message: err instanceof Error ? err.message : String(err),
      };
      return;
    }

    if (!res.ok || !res.body) {
      const text = await res.text().catch(() => "");
      yield {
        type: "error",
        message: `${this.name}Adapter: API error ${res.status}: ${text.slice(0, 500)}`,
      };
      return;
    }

    const textParts: string[] = [];
    // OpenAI streams tool_calls by index. Each delta adds partial function
    // name/arguments JSON. Reassemble per-index.
    const toolStates = new Map<
      number,
      { id: string; name: string; argsJson: string; started: boolean }
    >();
    let finishReason: string | undefined;
    let inputTokens = 0;
    let outputTokens = 0;

    try {
      for await (const evt of parseSseStream(res.body)) {
        if (!evt.data || evt.data === "[DONE]") continue;
        let parsed: OpenAIStreamChunk;
        try {
          parsed = JSON.parse(evt.data) as OpenAIStreamChunk;
        } catch {
          continue;
        }

        if (parsed.usage) {
          inputTokens = parsed.usage.prompt_tokens ?? inputTokens;
          outputTokens = parsed.usage.completion_tokens ?? outputTokens;
        }

        const choice = parsed.choices?.[0];
        if (!choice) continue;
        if (choice.finish_reason) finishReason = choice.finish_reason;

        const delta = choice.delta;
        if (!delta) continue;

        if (typeof delta.content === "string" && delta.content.length > 0) {
          textParts.push(delta.content);
          yield { type: "text", delta: delta.content };
        }

        for (const tc of delta.tool_calls ?? []) {
          const idx = tc.index ?? 0;
          let state = toolStates.get(idx);
          if (!state) {
            state = { id: "", name: "", argsJson: "", started: false };
            toolStates.set(idx, state);
          }
          if (tc.id) state.id = tc.id;
          if (tc.function?.name) state.name = tc.function.name;
          if (!state.started && state.id && state.name) {
            state.started = true;
            yield {
              type: "tool_call_start",
              id: state.id,
              name: state.name,
            };
          }
          const argsDelta = tc.function?.arguments ?? "";
          if (argsDelta) {
            state.argsJson += argsDelta;
            if (state.id) {
              yield {
                type: "tool_call_delta",
                id: state.id,
                argumentsDelta: argsDelta,
              };
            }
          }
        }
      }
    } catch (err) {
      yield {
        type: "error",
        message: err instanceof Error ? err.message : String(err),
      };
      return;
    }

    for (const state of toolStates.values()) {
      if (state.started) yield { type: "tool_call_end", id: state.id };
    }

    const toolCalls: ToolCall[] = [...toolStates.values()]
      .filter((s) => s.started)
      .map((s) => ({
        id: s.id,
        name: s.name,
        arguments: safeJsonParse(s.argsJson),
      }));

    const stopReason: CompletionResult["stopReason"] =
      finishReason === "tool_calls"
        ? "tool_use"
        : finishReason === "length"
          ? "max_tokens"
          : finishReason === "stop"
            ? "end_turn"
            : toolCalls.length > 0
              ? "tool_use"
              : "end_turn";

    yield {
      type: "done",
      result: {
        text: textParts.join(""),
        toolCalls,
        stopReason,
        usage: { inputTokens, outputTokens },
      },
    };
  }

  // end stream

  supportsTools() {
    return true;
  }
  supportsVision() {
    return true;
  }
}

interface OpenAIStreamChunk {
  choices?: Array<{
    index?: number;
    delta?: {
      content?: string | null;
      tool_calls?: Array<{
        index?: number;
        id?: string;
        type?: "function";
        function?: { name?: string; arguments?: string };
      }>;
    };
    finish_reason?: string | null;
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

function safeJsonParse(s: string): Record<string, unknown> {
  if (!s) return {};
  try {
    const parsed = JSON.parse(s);
    return typeof parsed === "object" && parsed !== null ? parsed : {};
  } catch {
    return {};
  }
}
