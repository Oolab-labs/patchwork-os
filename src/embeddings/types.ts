/**
 * Internal embeddings module — NOT an MCP tool.
 *
 * Turns text into vectors via an OpenAI-compatible /v1/embeddings endpoint
 * (Ollama, MLX, mlx-embeddings, vLLM, llama.cpp, LM Studio, etc.). Every
 * consumer is expected to fail soft: the factory returns `null` when no
 * endpoint is configured, and `embed()` returns `null` on any failure
 * (network / parse / non-ok / SSRF-rejected) rather than throwing — mirroring
 * the driver `run()`-never-rejects convention.
 */

/** A provider that turns text into embedding vectors. */
export interface EmbeddingsProvider {
  /**
   * Embed a batch of texts. Returns one vector per input (in order), or `null`
   * on ANY failure (network error, non-ok HTTP status, parse error,
   * SSRF-rejected endpoint). Never throws.
   */
  embed(texts: string[]): Promise<number[][] | null>;
}

/** Construction options for a {@link EmbeddingsProvider}. */
export interface EmbeddingsProviderOpts {
  /** OpenAI-compatible base URL, e.g. `http://localhost:11434/v1`. */
  endpoint?: string;
  /** Model id, e.g. `nomic-embed-text`. */
  model?: string;
  /** Bearer token for `Authorization`. Defaults to the `ollama` placeholder. */
  apiKey?: string;
  /** Injected fetch (for tests). Defaults to `globalThis.fetch`. */
  fetchImpl?: typeof fetch;
  /** Optional logger for fail-soft diagnostics. */
  log?: (msg: string) => void;
}
