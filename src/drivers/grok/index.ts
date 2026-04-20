import { OpenAIApiDriver } from "../openai/index.js";

/**
 * Grok driver — xAI's API is OpenAI-compatible at https://api.x.ai/v1.
 * Requires XAI_API_KEY environment variable.
 * Install: npm install openai  (reuses OpenAI SDK with custom baseURL)
 */
export class GrokApiDriver extends OpenAIApiDriver {
  override readonly name = "grok";

  constructor(log: (msg: string) => void) {
    if (!process.env.XAI_API_KEY) {
      throw new Error(
        "GrokApiDriver requires XAI_API_KEY environment variable",
      );
    }
    super(log, {
      baseURL: "https://api.x.ai/v1",
      defaultModel: "grok-2-latest",
    });
  }

  protected override apiKey(): string | undefined {
    return process.env.XAI_API_KEY;
  }
}
