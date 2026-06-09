import { isLoopbackOrPrivateEndpoint } from "../localEndpointGuard.js";
import {
  resolveEmbeddingsEndpoint,
  resolveEmbeddingsModel,
} from "./localEndpoints.js";
import type { EmbeddingsProvider, EmbeddingsProviderOpts } from "./types.js";

/**
 * OpenAI-compatible embeddings client (Ollama / MLX / mlx-embeddings / vLLM).
 *
 * POSTs `{ model, input }` to `${endpoint}/embeddings` and parses the OpenAI
 * shape `{ data: [{ embedding: number[] }, ...] }`.
 *
 * Fail-soft contract — `embed()` returns `null` (never throws) on:
 *   - a public/non-loopback endpoint when LOCAL_ENDPOINT_ALLOW_REMOTE !== "1"
 *     (anti-exfiltration — the texts we send are prompts/context)
 *   - non-ok HTTP status
 *   - JSON parse / unexpected shape
 *   - any network throw inside fetch
 *
 * Configuration precedence (see {@link resolveEmbeddingsEndpoint} /
 * {@link resolveEmbeddingsModel}):
 *   endpoint: opts.endpoint ?? LOCAL_EMBEDDINGS_ENDPOINT ?? LOCAL_ENDPOINT
 *   model:    opts.model ?? LOCAL_EMBEDDINGS_MODEL ?? LOCAL_MODEL ?? nomic-embed-text
 *   apiKey:   opts.apiKey ?? LOCAL_API_KEY ?? "ollama"
 */
export class LocalEmbeddingsProvider implements EmbeddingsProvider {
  private readonly endpoint: string | undefined;
  private readonly model: string;
  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;
  private readonly log: (msg: string) => void;

  constructor(opts: EmbeddingsProviderOpts = {}) {
    this.endpoint = resolveEmbeddingsEndpoint(opts);
    this.model = resolveEmbeddingsModel(opts);
    this.apiKey = opts.apiKey ?? process.env.LOCAL_API_KEY ?? "ollama";
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch;
    this.log = opts.log ?? (() => {});
  }

  async embed(texts: string[]): Promise<number[][] | null> {
    const endpoint = this.endpoint;
    if (!endpoint) {
      this.log("embeddings: no endpoint configured — returning null");
      return null;
    }
    // Anti-exfiltration guard. The texts we POST are prompts/context — a
    // public host would leak them. Mirror src/drivers/local/index.ts, but
    // fail SOFT (return null) instead of throwing.
    if (
      process.env.LOCAL_ENDPOINT_ALLOW_REMOTE !== "1" &&
      !isLoopbackOrPrivateEndpoint(endpoint)
    ) {
      this.log(
        `embeddings: endpoint="${endpoint}" is not loopback/private — refusing ` +
          `to send prompt/context (set LOCAL_ENDPOINT_ALLOW_REMOTE=1 to override)`,
      );
      return null;
    }
    if (texts.length === 0) return [];

    const url = `${endpoint.replace(/\/$/, "")}/embeddings`;
    try {
      const res = await this.fetchImpl(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({ model: this.model, input: texts }),
      });
      if (!res.ok) {
        this.log(`embeddings: non-ok status ${res.status} from ${url}`);
        return null;
      }
      const body = (await res.json()) as unknown;
      const vectors = parseEmbeddings(body);
      if (!vectors) {
        this.log(`embeddings: unexpected response shape from ${url}`);
        return null;
      }
      return vectors;
    } catch (err) {
      this.log(
        `embeddings: request failed — ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }
  }
}

/**
 * Parse the OpenAI embeddings response shape `{ data: [{ embedding: [...] }] }`.
 * Returns `null` on any structural mismatch (so the caller can fail soft).
 */
function parseEmbeddings(body: unknown): number[][] | null {
  if (typeof body !== "object" || body === null) return null;
  const data = (body as { data?: unknown }).data;
  if (!Array.isArray(data)) return null;
  const out: number[][] = [];
  for (const row of data) {
    if (typeof row !== "object" || row === null) return null;
    const embedding = (row as { embedding?: unknown }).embedding;
    if (!Array.isArray(embedding)) return null;
    if (!embedding.every((n) => typeof n === "number")) return null;
    out.push(embedding as number[]);
  }
  return out;
}
