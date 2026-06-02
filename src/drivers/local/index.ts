import { isLoopbackOrPrivateEndpoint } from "../../localEndpointGuard.js";
import { OpenAIApiDriver } from "../openai/index.js";

// Re-export so existing importers (`import { isLoopbackOrPrivateEndpoint }
// from ".../drivers/local/index.js"`) keep working after the predicate moved
// to the shared `src/localEndpointGuard.ts` module.
export { isLoopbackOrPrivateEndpoint };

/**
 * Local LLM driver — Ollama, LM Studio, vLLM, llama.cpp server, and most
 * other self-hosted runtimes expose an OpenAI-compatible chat-completions
 * endpoint at /v1/chat/completions. Same trick as Grok / Gemini API:
 * subclass OpenAIApiDriver with a different baseURL + default model.
 *
 * Auth: most local runtimes don't validate the API key, but the OpenAI SDK
 * requires *something* in the apiKey field — we send a constant placeholder.
 *
 * Configuration: LOCAL_ENDPOINT and LOCAL_MODEL environment variables.
 * The bridge auto-injects `patchwork.localEndpoint` / `patchwork.localModel`
 * into these env vars at startup (see config.ts), so saving via the
 * dashboard's Local LLM card flows straight through to the driver.
 *
 * Examples:
 *   Ollama     → http://localhost:11434/v1
 *   LM Studio  → http://localhost:1234/v1
 *   vLLM       → http://localhost:8000/v1
 *   llama.cpp  → http://localhost:8080/v1
 */
export class LocalApiDriver extends OpenAIApiDriver {
  override readonly name = "local";

  constructor(log: (msg: string) => void) {
    const baseURL = process.env.LOCAL_ENDPOINT;
    if (!baseURL) {
      throw new Error(
        "LocalApiDriver requires LOCAL_ENDPOINT environment variable (e.g. http://localhost:11434/v1)",
      );
    }
    if (
      process.env.LOCAL_ENDPOINT_ALLOW_REMOTE !== "1" &&
      !isLoopbackOrPrivateEndpoint(baseURL)
    ) {
      throw new Error(
        `LocalApiDriver: LOCAL_ENDPOINT="${baseURL}" is not loopback or private. ` +
          `The local driver streams prompts + context to this URL — a public host ` +
          `would exfiltrate them. Set LOCAL_ENDPOINT_ALLOW_REMOTE=1 to override ` +
          `(only for audited internal inference clusters).`,
      );
    }
    super(log, {
      baseURL,
      // Per-install default — caller can still override via input.model.
      defaultModel: process.env.LOCAL_MODEL ?? "llama3.2",
    });
  }

  protected override apiKey(): string | undefined {
    // Most local runtimes ignore the key but the OpenAI SDK requires a
    // non-empty value. "ollama" is the conventional placeholder.
    return process.env.LOCAL_API_KEY ?? "ollama";
  }
}
