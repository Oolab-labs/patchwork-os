import type { ModelAdapter } from "./base.js";
import { OpenAIAdapter } from "./openai.js";

/**
 * GrokAdapter — xAI Grok via OpenAI-compatible endpoint.
 * https://api.x.ai/v1 — same shape as OpenAI Chat Completions.
 */

const API_URL = "https://api.x.ai/v1/chat/completions";
const DEFAULT_MODEL = "grok-beta";

export function createGrokAdapter(opts: {
  apiKey?: string;
  defaultModel?: string;
  baseURL?: string;
  fetchImpl?: typeof fetch;
}): ModelAdapter {
  const apiKey = opts.apiKey ?? process.env.XAI_API_KEY;
  if (!apiKey)
    throw new Error(
      "GrokAdapter: no API key. Set XAI_API_KEY or config.apiKeys.xai.",
    );
  return new OpenAIAdapter({
    adapterName: "grok",
    baseURL: opts.baseURL ?? API_URL,
    defaultModel: opts.defaultModel ?? DEFAULT_MODEL,
    apiKey,
    requireApiKey: true,
    fetchImpl: opts.fetchImpl,
  });
}
