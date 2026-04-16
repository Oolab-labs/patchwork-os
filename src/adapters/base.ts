/**
 * ModelAdapter — provider-agnostic contract for LLM backends.
 *
 * Phase-0 scaffold. All providers (Claude, OpenAI, Gemini, Grok, local/Ollama)
 * implement this interface. The bridge dispatches completions through the
 * adapter returned by `createAdapter(config)` (see ./index.ts).
 *
 * Design notes:
 *  - Keep surface minimal; streaming is first-class (agents need token-level UX).
 *  - `tools` is the MCP-normalized shape; adapters translate to provider-native.
 *  - No refs to Anthropic SDK in this file — base must stay provider-neutral.
 */

export interface Message {
	role: "system" | "user" | "assistant" | "tool";
	content: string;
	/** Present when role === "tool"; matches the assistant tool_use id. */
	toolCallId?: string;
	/** Present on assistant messages that invoke tools. */
	toolCalls?: ToolCall[];
}

export interface ToolCall {
	id: string;
	name: string;
	arguments: Record<string, unknown>;
}

export interface ToolDef {
	name: string;
	description: string;
	/** JSON Schema for arguments. */
	inputSchema: Record<string, unknown>;
}

export interface CompletionParams {
	systemPrompt: string;
	messages: Message[];
	tools?: ToolDef[];
	maxTokens?: number;
	/** Provider-specific model identifier. Falls back to adapter default. */
	model?: string;
	/** 0.0 – 1.0. Provider may clamp. */
	temperature?: number;
}

export interface CompletionResult {
	text: string;
	toolCalls: ToolCall[];
	stopReason: "end_turn" | "tool_use" | "max_tokens" | "error";
	usage: { inputTokens: number; outputTokens: number };
}

export type StreamChunk =
	| { type: "text"; delta: string }
	| { type: "tool_call_start"; id: string; name: string }
	| { type: "tool_call_delta"; id: string; argumentsDelta: string }
	| { type: "tool_call_end"; id: string }
	| { type: "done"; result: CompletionResult }
	| { type: "error"; message: string };

export interface ModelAdapter {
	readonly name: string;
	complete(params: CompletionParams): Promise<CompletionResult>;
	stream(params: CompletionParams): AsyncIterable<StreamChunk>;
	supportsTools(): boolean;
	supportsVision(): boolean;
}
