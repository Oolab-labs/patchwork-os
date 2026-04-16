import type {
  CompletionParams,
  CompletionResult,
  Message,
  ModelAdapter,
  StreamChunk,
  ToolCall,
  ToolDef,
} from "./base.js";
import { parseSseStream } from "./sse.js";

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

interface AnthropicStreamEvent {
  type:
    | "message_start"
    | "content_block_start"
    | "content_block_delta"
    | "content_block_stop"
    | "message_delta"
    | "message_stop"
    | "ping"
    | "error";
  index?: number;
  content_block?: { type: "text" | "tool_use"; id?: string; name?: string };
  delta?: {
    type?: "text_delta" | "input_json_delta";
    text?: string;
    partial_json?: string;
    stop_reason?: "end_turn" | "tool_use" | "max_tokens" | "stop_sequence";
  };
  usage?: { input_tokens?: number; output_tokens?: number };
  message?: { usage?: { input_tokens?: number; output_tokens?: number } };
  error?: { type: string; message: string };
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
    const body = {
      model: params.model ?? this.opts.defaultModel ?? DEFAULT_MODEL,
      max_tokens: params.maxTokens ?? DEFAULT_MAX_TOKENS,
      system: params.systemPrompt,
      messages: this.translateMessages(params.messages),
      tools: this.translateTools(params.tools),
      temperature: params.temperature,
      stream: true,
    };

    const fetchImpl = this.opts.fetchImpl ?? fetch;
    let res: Response;
    try {
      res = await fetchImpl(this.opts.baseURL ?? API_URL, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": this.apiKey,
          "anthropic-version": API_VERSION,
          accept: "text/event-stream",
        },
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
        message: `ClaudeAdapter: API error ${res.status}: ${text.slice(0, 500)}`,
      };
      return;
    }

    const toolStates = new Map<
      number,
      { id: string; name: string; json: string }
    >();
    const textParts: string[] = [];
    let inputTokens = 0;
    let outputTokens = 0;
    let stopReason: CompletionResult["stopReason"] = "end_turn";

    try {
      for await (const evt of parseSseStream(res.body)) {
        if (!evt.data || evt.data === "[DONE]") continue;
        let parsed: AnthropicStreamEvent;
        try {
          parsed = JSON.parse(evt.data) as AnthropicStreamEvent;
        } catch {
          continue;
        }

        switch (parsed.type) {
          case "content_block_start": {
            const idx = parsed.index ?? 0;
            const block = parsed.content_block;
            if (block?.type === "tool_use") {
              const id = block.id ?? "";
              const name = block.name ?? "";
              toolStates.set(idx, { id, name, json: "" });
              yield { type: "tool_call_start", id, name };
            }
            break;
          }
          case "content_block_delta": {
            const idx = parsed.index ?? 0;
            const delta = parsed.delta;
            if (delta?.type === "text_delta" && delta.text) {
              textParts.push(delta.text);
              yield { type: "text", delta: delta.text };
            } else if (delta?.type === "input_json_delta") {
              const state = toolStates.get(idx);
              if (state && delta.partial_json) {
                state.json += delta.partial_json;
                yield {
                  type: "tool_call_delta",
                  id: state.id,
                  argumentsDelta: delta.partial_json,
                };
              }
            }
            break;
          }
          case "content_block_stop": {
            const idx = parsed.index ?? 0;
            const state = toolStates.get(idx);
            if (state) yield { type: "tool_call_end", id: state.id };
            break;
          }
          case "message_delta": {
            if (parsed.delta?.stop_reason) {
              stopReason =
                parsed.delta.stop_reason === "stop_sequence"
                  ? "end_turn"
                  : parsed.delta.stop_reason;
            }
            if (parsed.usage) {
              outputTokens = parsed.usage.output_tokens ?? outputTokens;
            }
            break;
          }
          case "message_start": {
            inputTokens = parsed.message?.usage?.input_tokens ?? inputTokens;
            break;
          }
          case "error": {
            yield {
              type: "error",
              message: parsed.error?.message ?? "unknown Anthropic error",
            };
            return;
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

    const toolCalls: ToolCall[] = [...toolStates.values()].map((s) => ({
      id: s.id,
      name: s.name,
      arguments: safeJsonParse(s.json),
    }));

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

  supportsTools() {
    return true;
  }
  supportsVision() {
    return true;
  }
}
