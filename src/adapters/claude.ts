import type {
	CompletionParams,
	CompletionResult,
	ModelAdapter,
	StreamChunk,
} from "./base.js";

/**
 * ClaudeAdapter — wraps the existing Claude Code subprocess driver.
 *
 * Phase-0 stub. Real impl will delegate to `src/claudeDriver.ts` by reusing
 * `SubprocessDriver.run()`. Kept as a stub here so the factory + --model flag
 * can land before we refactor claudeDriver itself.
 */
export class ClaudeAdapter implements ModelAdapter {
	readonly name = "claude";

	constructor(
		private readonly opts: {
			binary?: string;
			defaultModel?: string;
		} = {},
	) {}

	async complete(_params: CompletionParams): Promise<CompletionResult> {
		throw new Error(
			"ClaudeAdapter.complete: not yet wired to SubprocessDriver. Phase-1 work.",
		);
	}

	async *stream(_params: CompletionParams): AsyncIterable<StreamChunk> {
		yield {
			type: "error",
			message:
				"ClaudeAdapter.stream: not yet wired to SubprocessDriver. Phase-1 work.",
		};
	}

	supportsTools() {
		return true;
	}
	supportsVision() {
		return true;
	}
}
