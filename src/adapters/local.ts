import type { ModelAdapter } from "./base.js";
import { OpenAIAdapter } from "./openai.js";

/**
 * LocalAdapter — Ollama / LM Studio / vLLM via OpenAI-compatible endpoint.
 *
 * Reuses OpenAIAdapter with:
 *  - adapterName = "local"
 *  - baseURL defaulting to Ollama's http://localhost:11434/v1/chat/completions
 *  - requireApiKey = false
 */

const DEFAULT_ENDPOINT = "http://localhost:11434/v1/chat/completions";
const DEFAULT_MODEL = "llama3";

export function createLocalAdapter(opts: {
  endpoint?: string;
  defaultModel?: string;
  apiKey?: string;
  fetchImpl?: typeof fetch;
}): ModelAdapter {
  return new OpenAIAdapter({
    adapterName: "local",
    baseURL: opts.endpoint ?? DEFAULT_ENDPOINT,
    defaultModel: opts.defaultModel ?? DEFAULT_MODEL,
    apiKey: opts.apiKey,
    requireApiKey: false,
    fetchImpl: opts.fetchImpl,
  });
}
