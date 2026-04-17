import type { PatchworkConfig } from "../patchworkConfig.js";
import type { ModelAdapter } from "./base.js";
import { ClaudeAdapter } from "./claude.js";
import { GeminiAdapter } from "./gemini.js";
import { createGrokAdapter } from "./grok.js";
import { createLocalAdapter } from "./local.js";
import { OpenAIAdapter } from "./openai.js";

export type ModelChoice = "claude" | "openai" | "gemini" | "grok" | "local";

export function createAdapter(config: PatchworkConfig): ModelAdapter {
  switch (config.model) {
    case "claude":
      return new ClaudeAdapter({
        apiKey: config.apiKeys?.anthropic,
        defaultModel: config.defaultModel,
      });
    case "openai":
      return new OpenAIAdapter({
        apiKey: config.apiKeys?.openai,
        defaultModel: config.defaultModel,
      });
    case "gemini":
      return new GeminiAdapter({
        apiKey: config.apiKeys?.google,
        defaultModel: config.defaultModel,
      });
    case "grok":
      return createGrokAdapter({
        apiKey: config.apiKeys?.xai,
        defaultModel: config.defaultModel,
      });
    case "local":
      return createLocalAdapter({
        endpoint: config.localEndpoint,
        defaultModel: config.localModel ?? config.defaultModel,
      });
    default:
      throw new Error(
        `Unknown model '${(config as { model: string }).model}'. Expected one of: claude, openai, gemini, grok, local.`,
      );
  }
}

export type { ModelAdapter } from "./base.js";
