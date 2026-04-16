import type {
  CompletionParams,
  CompletionResult,
  Message,
  ModelAdapter,
  StreamChunk,
  ToolCall,
  ToolDef,
} from "./base.js";

/**
 * AnthropicAdapter — talks to the Anthropic Messages API over HTTPS via fetch.
 *
 * This is the direct-API adapter; it does NOT reuse the bridge's SubprocessDriver
 * (which is a black-box agent runner, not a per-turn message API). For users who
 * want the full Claude CLI loop, set config.model = "claude-cli" (wired in a later PR).
 *
 * Kept under the name "claude" so that `--model claude` → this adapter by default.
 */

const DEFAULT_MODEL = "claude-opus-4-7";
const DEFAULT_MAX_TOKENS = 4096;
const API_URL = "https://api.anthropic.com/v1/messages";
const API_VERSION = "2023-06-01";

interface AnthropicContentBlock {
  type: "text" | "tool_use";
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
}

interface AnthropicResponse {
  content: AnthropicContentBlock[];
  stop_reason: "end_turn" | "tool_use" | "max_tokens" | "stop_sequence";
  usage: { input_tokens: number; output_tokens: number };
}

export class ClaudeAdapter implements ModelAdapter {
  readonly name = "claude";

  constructor(
    private readonly opts: {
      apiKey?: string;
      defaultModel?: string;
      baseURL?: string;
      fetchImpl?: typeof fetch;
    } = {},
  ) {}

  private get apiKey(): string {
    const key = this.opts.apiKey ?? process.env.ANTHROPIC_API_KEY;
    if (!key)
      throw new Error(
        "ClaudeAdapter: no API key. Set ANTHROPIC_API_KEY or config.apiKeys.anthropic.",
      );
    return key;
  }

  private translateTools(tools: ToolDef[] | undefined) {
    if (!tools?.length) return undefined;
    return tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.inputSchema,
    }));
  }

  private translateMessages(messages: Message[]) {
    // Anthropic wants system as a top-level field; user/assistant/tool interleaved.
    return messages
      .filter((m) => m.role !== "system")
      .map((m) => {
        if (m.role === "tool") {
          return {
            role: "user" as const,
            content: [
              {
                type: "tool_result",
                tool_use_id: m.toolCallId ?? "",
                content: m.content,
              },
            ],
          };
        }
        if (m.role === "assistant" && m.toolCalls?.length) {
          const blocks: AnthropicContentBlock[] = [];
          if (m.content) blocks.push({ type: "text", text: m.content });
          for (const tc of m.toolCalls) {
            blocks.push({
              type: "tool_use",
              id: tc.id,
              name: tc.name,
              input: tc.arguments,
            });
          }
          return { role: "assistant" as const, content: blocks };
        }
        return { role: m.role as "user" | "assistant", content: m.content };
      });
  }

  async complete(params: CompletionParams): Promise<CompletionResult> {
    const body = {
      model: params.model ?? this.opts.defaultModel ?? DEFAULT_MODEL,
      max_tokens: params.maxTokens ?? DEFAULT_MAX_TOKENS,
      system: params.systemPrompt,
      messages: this.translateMessages(params.messages),
      tools: this.translateTools(params.tools),
      temperature: params.temperature,
    };

    const fetchImpl = this.opts.fetchImpl ?? fetch;
    const res = await fetchImpl(this.opts.baseURL ?? API_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": this.apiKey,
        "anthropic-version": API_VERSION,
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(
        `ClaudeAdapter: API error ${res.status}: ${text.slice(0, 500)}`,
      );
    }

    const data = (await res.json()) as AnthropicResponse;
    const text = data.content
      .filter((b) => b.type === "text")
      .map((b) => b.text ?? "")
      .join("");
    const toolCalls: ToolCall[] = data.content
      .filter((b) => b.type === "tool_use")
      .map((b) => ({
        id: b.id ?? "",
        name: b.name ?? "",
        arguments: (b.input as Record<string, unknown>) ?? {},
      }));

    const stopReason: CompletionResult["stopReason"] =
      data.stop_reason === "stop_sequence" ? "end_turn" : data.stop_reason;

    return {
      text,
      toolCalls,
      stopReason,
      usage: {
        inputTokens: data.usage.input_tokens,
        outputTokens: data.usage.output_tokens,
      },
    };
  }

  async *stream(params: CompletionParams): AsyncIterable<StreamChunk> {
    // Phase-1 shortcut: non-streaming impl wrapped as a single "done" chunk.
    // Proper SSE streaming planned when dashboard consumes it.
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
