import type {
	CompletionParams,
	CompletionResult,
	ModelAdapter,
	StreamChunk,
} from "./base.js";

/**
 * OpenAIAdapter — Phase-1 target. Will use the official `openai` SDK and
 * translate MCP ToolDef ↔ OpenAI function-calling shapes.
 *
 * Phase-0 ships the stub so the factory can dispatch `--model openai` without
 * crashing; invoking actually throws until Phase-1.
 */
export class OpenAIAdapter implements ModelAdapter {
	readonly name = "openai";

	constructor(
		private readonly opts: {
			apiKey?: string;
			baseURL?: string;
			defaultModel?: string;
		} = {},
	) {}

	async complete(_params: CompletionParams): Promise<CompletionResult> {
		throw new Error("OpenAIAdapter.complete: Phase-1 work. Not implemented.");
	}

	async *stream(_params: CompletionParams): AsyncIterable<StreamChunk> {
		yield { type: "error", message: "OpenAIAdapter.stream: Phase-1 work." };
	}

	supportsTools() {
		return true;
	}
	supportsVision() {
		return true;
	}
}
