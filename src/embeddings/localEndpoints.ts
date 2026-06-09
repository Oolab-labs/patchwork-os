/**
 * Shared endpoint/model precedence resolution for the embeddings module.
 * Kept tiny + import-free (besides env reads) so both the factory
 * (`index.ts`) and the provider (`localEmbeddings.ts`) agree on exactly the
 * same precedence chain.
 */
import type { EmbeddingsProviderOpts } from "./types.js";

/**
 * Treat empty / whitespace-only values as "unset" so the precedence chain is
 * not shadowed by a stale `export LOCAL_EMBEDDINGS_ENDPOINT=` or a blank
 * dashboard field — `??` alone would let `""` win over a real fallback. Also
 * trims, avoiding `http://host /embeddings`-style trailing-space URL bugs.
 */
function clean(v: string | undefined): string | undefined {
  const t = v?.trim();
  return t ? t : undefined;
}

/**
 * Resolve the embeddings endpoint, honoring (in order):
 *   1. `opts.endpoint`
 *   2. `LOCAL_EMBEDDINGS_ENDPOINT` env
 *   3. `LOCAL_ENDPOINT` env (reuse the chat endpoint when a dedicated
 *      embeddings endpoint isn't configured)
 * Returns `undefined` when none is set — the fail-soft hinge.
 */
export function resolveEmbeddingsEndpoint(
  opts?: EmbeddingsProviderOpts,
): string | undefined {
  return (
    clean(opts?.endpoint) ??
    clean(process.env.LOCAL_EMBEDDINGS_ENDPOINT) ??
    clean(process.env.LOCAL_ENDPOINT)
  );
}

/**
 * Resolve the embeddings model, honoring (in order):
 *   1. `opts.model`
 *   2. `LOCAL_EMBEDDINGS_MODEL` env
 *   3. `LOCAL_MODEL` env
 *   4. `nomic-embed-text` (sensible Ollama default)
 */
export function resolveEmbeddingsModel(opts?: EmbeddingsProviderOpts): string {
  return (
    clean(opts?.model) ??
    clean(process.env.LOCAL_EMBEDDINGS_MODEL) ??
    clean(process.env.LOCAL_MODEL) ??
    "nomic-embed-text"
  );
}
