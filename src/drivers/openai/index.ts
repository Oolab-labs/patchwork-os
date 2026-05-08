import type {
  ProviderDriver,
  ProviderTaskInput,
  ProviderTaskResult,
} from "../types.js";

const OUTPUT_CAP = 50 * 1024;

export interface OpenAIDriverOpts {
  /** Override API base URL — used by Grok and other OpenAI-compatible endpoints. */
  baseURL?: string;
  /** Default model when input.model is not set. */
  defaultModel?: string;
}

/**
 * OpenAI API driver — streams via chat.completions.create.
 * Dynamic import: openai package is an optional peer dep (not in package.json).
 * Install: npm install openai
 *
 * Limitation: single-turn only — no agentic tool-use loop.
 * providerOptions: { maxTokens?: number, temperature?: number }
 */
export class OpenAIApiDriver implements ProviderDriver {
  readonly name: string = "openai";

  constructor(
    private readonly log: (msg: string) => void,
    private readonly opts: OpenAIDriverOpts = {},
  ) {
    if (!process.env.OPENAI_API_KEY && !opts.baseURL) {
      throw new Error(
        "OpenAIApiDriver requires OPENAI_API_KEY environment variable",
      );
    }
    // Subclasses (Grok, Gemini, Local) MUST set their own defaultModel —
    // a bare OpenAI driver defaults to gpt-4o here, but a subclass that
    // overrides baseURL without defaultModel would otherwise silently dial
    // the foreign endpoint asking for gpt-4o (which doesn't exist on Grok,
    // Gemini, or local LLMs) and surface as a confusing 404 / phantom-model
    // error far from the actual misconfiguration.
    if (opts.baseURL && !opts.defaultModel) {
      throw new Error(
        "OpenAIApiDriver: subclass must set defaultModel when baseURL is " +
          "overridden — bare 'gpt-4o' fallback only applies to OpenAI's API.",
      );
    }
  }

  async run(input: ProviderTaskInput): Promise<ProviderTaskResult> {
    // biome-ignore lint/suspicious/noExplicitAny: dynamic import of optional peer dep
    let OpenAICtor: new (opts: any) => any;
    try {
      // biome-ignore lint/suspicious/noExplicitAny: dynamic import
      const mod = await import("openai" as any);
      // biome-ignore lint/suspicious/noExplicitAny: dynamic import
      OpenAICtor = (mod as any).default ?? mod.OpenAI ?? mod;
    } catch {
      throw new Error(
        "OpenAIApiDriver requires openai — install it with: npm install openai",
      );
    }

    const opts = input.providerOptions ?? {};
    const maxTokens =
      typeof opts.maxTokens === "number" ? opts.maxTokens : 4096;
    const temperature =
      typeof opts.temperature === "number" ? opts.temperature : undefined;

    const contextNote =
      input.contextFiles && input.contextFiles.length > 0
        ? `\n\n--- BEGIN CONTEXT FILE LIST ---\n${input.contextFiles
            .map((f) => f.slice(0, 500).replace(/[\x00-\x1f\x7f]/g, ""))
            .join("\n")}\n--- END CONTEXT FILE LIST ---`
        : "";

    const messages: Array<{ role: string; content: string }> = [];
    if (input.systemPrompt) {
      messages.push({ role: "system", content: input.systemPrompt });
    }
    messages.push({ role: "user", content: input.prompt + contextNote });

    const clientOpts: Record<string, unknown> = {};
    if (this.opts.baseURL) clientOpts.baseURL = this.opts.baseURL;
    // Use provider-specific API key env var if set, fall back to OPENAI_API_KEY
    const apiKey = this.apiKey();
    if (apiKey) clientOpts.apiKey = apiKey;

    const client = new OpenAICtor(clientOpts);
    const start = Date.now();
    const model = input.model ?? this.opts.defaultModel ?? "gpt-4o";

    this.log(
      `[${this.name}] streaming: model=${model} workspace=${input.workspace}`,
    );

    let text = "";
    let firstChunkAt: number | undefined;

    try {
      // biome-ignore lint/suspicious/noExplicitAny: dynamic import shape
      const stream = await (client.chat.completions as any).create(
        {
          model,
          max_tokens: maxTokens,
          ...(temperature !== undefined ? { temperature } : {}),
          messages,
          stream: true,
        },
        { signal: input.signal },
      );

      // biome-ignore lint/suspicious/noExplicitAny: stream shape from dynamic import
      for await (const chunk of stream as AsyncIterable<any>) {
        const delta: string = chunk.choices?.[0]?.delta?.content ?? "";
        if (delta) {
          if (firstChunkAt === undefined) firstChunkAt = Date.now();
          if (text.length < OUTPUT_CAP) {
            // Cap accumulation in-loop to bound memory under runaway streams
            // (e.g. local LLMs that loop). Once we hit the cap, stop appending
            // and abort the upstream stream so sockets and decoder buffers
            // are released. onChunk is gated by the same cap so partial
            // listeners stop receiving deltas.
            text += delta;
            input.onChunk?.(delta);
          } else {
            // biome-ignore lint/suspicious/noExplicitAny: stream shape
            const ctrl = (stream as any).controller;
            if (ctrl && typeof ctrl.abort === "function") {
              try {
                ctrl.abort();
              } catch {
                /* best effort */
              }
            }
            break;
          }
        }
      }
    } catch (err) {
      const isAbort =
        (err instanceof Error && err.name === "AbortError") ||
        input.signal.aborted;
      if (isAbort) {
        return {
          text: text.slice(0, OUTPUT_CAP),
          durationMs: Date.now() - start,
          wasAborted: true,
          startupMs:
            firstChunkAt !== undefined ? firstChunkAt - start : undefined,
        };
      }
      return {
        text: text.slice(0, OUTPUT_CAP),
        durationMs: Date.now() - start,
        errorMessage: err instanceof Error ? err.message : String(err),
      };
    }

    return {
      text: text.slice(0, OUTPUT_CAP),
      durationMs: Date.now() - start,
      startupMs: firstChunkAt !== undefined ? firstChunkAt - start : undefined,
      providerMeta: { model },
    };
  }

  /** Override in subclasses to use a different env var. */
  protected apiKey(): string | undefined {
    return process.env.OPENAI_API_KEY;
  }
}
