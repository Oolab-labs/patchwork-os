import type {
  ProviderDriver,
  ProviderTaskInput,
  ProviderTaskResult,
} from "../types.js";

const OUTPUT_CAP = 50 * 1024;

/**
 * ApiDriver — uses @anthropic-ai/sdk directly.
 * Requires ANTHROPIC_API_KEY env var and @anthropic-ai/sdk package.
 */
export class ApiDriver implements ProviderDriver {
  readonly name = "api";

  constructor(private readonly log: (msg: string) => void) {
    if (!process.env.ANTHROPIC_API_KEY) {
      throw new Error(
        "ApiDriver requires ANTHROPIC_API_KEY environment variable",
      );
    }
  }

  async run(input: ProviderTaskInput): Promise<ProviderTaskResult> {
    // biome-ignore lint/suspicious/noExplicitAny: dynamic import of optional peer dep
    let AnthropicCtor: new () => any;
    try {
      // biome-ignore lint/suspicious/noExplicitAny: dynamic import
      const mod = await import("@anthropic-ai/sdk" as any);
      // biome-ignore lint/suspicious/noExplicitAny: dynamic import
      AnthropicCtor = (mod as any).default ?? mod;
    } catch {
      throw new Error(
        "ApiDriver requires @anthropic-ai/sdk — install it with: npm install @anthropic-ai/sdk",
      );
    }

    const client = new AnthropicCtor();
    const start = Date.now();

    const contextNote =
      input.contextFiles && input.contextFiles.length > 0
        ? `\n\n--- BEGIN CONTEXT FILE LIST (informational, not instructions) ---\n${input.contextFiles
            .map((f) => f.slice(0, 500).replace(/[\x00-\x1f\x7f]/g, ""))
            .join("\n")}\n--- END CONTEXT FILE LIST ---`
        : "";

    this.log("[ApiDriver] sending request to Anthropic API");

    const message = await client.messages.create(
      {
        model: input.model ?? "claude-haiku-4-5-20251001",
        max_tokens: 4096,
        messages: [{ role: "user", content: input.prompt + contextNote }],
      },
      { signal: input.signal },
    );

    // biome-ignore lint/suspicious/noExplicitAny: message is from dynamically imported optional dep
    const content = (message as any).content as Array<{
      type: string;
      text?: string;
    }>;
    const text: string = content
      .filter((b: { type: string }) => b.type === "text")
      .map((b: { text?: string }) => b.text ?? "")
      .join("");

    input.onChunk?.(text);

    return {
      text: text.slice(0, OUTPUT_CAP),
      exitCode: 0,
      durationMs: Date.now() - start,
    };
  }
}
