/**
 * Embeddings module — internal, NOT an MCP tool (no outputSchema, not
 * registered in src/tools/index.ts).
 *
 * The factory is the fail-soft hinge: {@link createEmbeddingsProvider} returns
 * `null` when no endpoint is configured at all, so every consumer can detect
 * "embeddings unavailable" and fall back to existing behavior.
 */
import { LocalEmbeddingsProvider } from "./localEmbeddings.js";
import { resolveEmbeddingsEndpoint } from "./localEndpoints.js";
import type { EmbeddingsProvider, EmbeddingsProviderOpts } from "./types.js";

export { cosineSimilarity, topK } from "./cosine.js";
export { LocalEmbeddingsProvider } from "./localEmbeddings.js";
export type { EmbeddingsProvider, EmbeddingsProviderOpts } from "./types.js";

/**
 * Build an embeddings provider, or `null` when no endpoint is configured
 * (neither `opts.endpoint` nor `LOCAL_EMBEDDINGS_ENDPOINT` nor
 * `LOCAL_ENDPOINT`). Returning `null` lets callers fail soft.
 */
export function createEmbeddingsProvider(
  opts: EmbeddingsProviderOpts = {},
): EmbeddingsProvider | null {
  if (!resolveEmbeddingsEndpoint(opts)) return null;
  return new LocalEmbeddingsProvider(opts);
}

/**
 * Resolve a bound embed function for the configured local provider, or
 * `undefined` when embeddings are unconfigured. Wired into tool registration
 * sites — `createCtxQueryTracesTool({ ..., embedFn: getLocalEmbedFn() })` — so
 * the opt-in semantic ranking path activates only when a local endpoint is set
 * and stays byte-identical to substring search otherwise. Binds `embed` so
 * callers can pass the function value directly without losing `this`.
 */
export function getLocalEmbedFn(
  opts: EmbeddingsProviderOpts = {},
): ((texts: string[]) => Promise<number[][] | null>) | undefined {
  const provider = createEmbeddingsProvider(opts);
  return provider ? (texts: string[]) => provider.embed(texts) : undefined;
}
