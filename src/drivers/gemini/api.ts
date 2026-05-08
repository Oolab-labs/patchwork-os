import { OpenAIApiDriver } from "../openai/index.js";

/**
 * Gemini API driver — Google exposes an OpenAI-compatible chat-completions
 * endpoint at https://generativelanguage.googleapis.com/v1beta/openai/, so
 * the existing OpenAIApiDriver streaming + tool-handling can be reused with
 * just a different baseURL + default model + key source. Same trick as Grok.
 *
 * Auth: GEMINI_API_KEY environment variable (the bridge auto-injects the
 * dashboard-saved `apiKeys.google` value into GEMINI_API_KEY at startup —
 * see config.ts:487).
 *
 * Install: npm install openai  (reuses OpenAI SDK with custom baseURL)
 */
export class GeminiApiDriver extends OpenAIApiDriver {
  override readonly name = "gemini-api";

  constructor(log: (msg: string) => void) {
    if (!process.env.GEMINI_API_KEY) {
      throw new Error(
        "GeminiApiDriver requires GEMINI_API_KEY environment variable",
      );
    }
    super(log, {
      baseURL: "https://generativelanguage.googleapis.com/v1beta/openai/",
      defaultModel: "gemini-2.5-pro",
    });
  }

  protected override apiKey(): string | undefined {
    return process.env.GEMINI_API_KEY;
  }
}
