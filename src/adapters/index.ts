import type { PatchworkConfig } from "../patchworkConfig.js";
import type { ModelAdapter } from "./base.js";
import { ClaudeAdapter } from "./claude.js";
import { OpenAIAdapter } from "./openai.js";

export type ModelChoice =
	| "claude"
	| "openai"
	| "gemini"
	| "grok"
	| "local";

export function createAdapter(config: PatchworkConfig): ModelAdapter {
	switch (config.model) {
		case "claude":
			return new ClaudeAdapter({ defaultModel: config.defaultModel });
		case "openai":
			return new OpenAIAdapter({
				apiKey: config.apiKeys?.openai,
				defaultModel: config.defaultModel,
			});
		case "gemini":
		case "grok":
		case "local":
			throw new Error(
				`Adapter '${config.model}' is a Phase-1 target. Not implemented yet.`,
			);
		default:
			throw new Error(
				`Unknown model '${(config as { model: string }).model}'. Expected one of: claude, openai, gemini, grok, local.`,
			);
	}
}

export type { ModelAdapter } from "./base.js";
