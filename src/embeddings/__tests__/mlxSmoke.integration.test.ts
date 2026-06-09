/**
 * Opt-in MLX integration smoke test — exercises a REAL OpenAI-compatible local
 * server (mlx_lm.server / Ollama-on-MLX / mlx-embeddings) over the live
 * `globalThis.fetch`. There is intentionally NO fetch mock here — this is the
 * live smoke that proves a developer's on-device MLX stack actually answers.
 *
 * Gated by MLX_SMOKE === "1": skipped by default so the Linux CI run (no MLX,
 * no server) is a pure no-op with zero failures. Endpoints come from env — the
 * developer sets them on their Mac. No hardcoded URLs, no /tmp.
 *
 * Run on a Mac with MLX up:
 *   MLX_SMOKE=1 \
 *     LOCAL_ENDPOINT=http://localhost:8080/v1 LOCAL_MODEL=<chat-model> \
 *     LOCAL_EMBEDDINGS_ENDPOINT=http://localhost:8080/v1 \
 *     LOCAL_EMBEDDINGS_MODEL=<embed-model> \
 *     npx vitest run src/embeddings/__tests__/mlxSmoke.integration.test.ts
 *
 * See docs/mlx-integration.md (section 7) for setup.
 */
import { describe, expect, it } from "vitest";
import { LocalApiDriver } from "../../drivers/local/index.js";
import { cosineSimilarity, createEmbeddingsProvider } from "../index.js";

const SMOKE_ENABLED = process.env.MLX_SMOKE === "1";

// A small generous ceiling — local models on Apple Silicon are fast but the
// first request can pay a model-load cost. Kept finite so a wedged server
// surfaces as a timeout, not a hang.
const CHAT_TIMEOUT_MS = 60_000;

describe.skipIf(!SMOKE_ENABLED)("MLX smoke (opt-in, MLX_SMOKE=1)", () => {
  it(
    "chat: LocalApiDriver returns non-empty text from the live endpoint",
    async () => {
      if (!process.env.LOCAL_ENDPOINT) {
        throw new Error(
          "MLX_SMOKE=1 but LOCAL_ENDPOINT is unset — set it to your MLX chat " +
            "server, e.g. LOCAL_ENDPOINT=http://localhost:8080/v1",
        );
      }
      if (!process.env.LOCAL_MODEL) {
        throw new Error(
          "MLX_SMOKE=1 but LOCAL_MODEL is unset — set it to the chat model id " +
            "served by LOCAL_ENDPOINT.",
        );
      }

      // Real fetch inside the driver (OpenAI SDK / streaming) — no mock.
      const driver = new LocalApiDriver(() => {});
      const result = await driver.run({
        prompt: "Reply with a single short sentence so we know you are alive.",
        workspace: process.cwd(),
        timeoutMs: CHAT_TIMEOUT_MS,
        signal: AbortSignal.timeout(CHAT_TIMEOUT_MS),
      });

      expect(result.errorMessage).toBeUndefined();
      expect(result.wasAborted).not.toBe(true);
      expect(typeof result.text).toBe("string");
      expect(result.text.trim().length).toBeGreaterThan(0);
    },
    CHAT_TIMEOUT_MS + 5_000,
  );

  it(
    "embeddings: createEmbeddingsProvider embeds two strings with matching dims",
    async () => {
      if (
        !process.env.LOCAL_EMBEDDINGS_ENDPOINT &&
        !process.env.LOCAL_ENDPOINT
      ) {
        throw new Error(
          "MLX_SMOKE=1 but neither LOCAL_EMBEDDINGS_ENDPOINT nor LOCAL_ENDPOINT " +
            "is set — point one at your MLX /v1/embeddings server.",
        );
      }

      // Reads LOCAL_EMBEDDINGS_ENDPOINT/MODEL (falling back to LOCAL_*).
      // Real globalThis.fetch — no fetchImpl injected.
      const provider = createEmbeddingsProvider();
      expect(provider).not.toBeNull();
      // Type-narrow for the strict (noUnusedLocals + null-check) core gate.
      if (!provider) {
        throw new Error(
          "embeddings provider was null despite a configured endpoint",
        );
      }

      const vectors = await provider.embed([
        "the build is green and all tests pass",
        "the deployment succeeded without errors",
      ]);

      expect(vectors).not.toBeNull();
      if (!vectors) {
        throw new Error(
          "embed() returned null — check the embeddings endpoint/model and " +
            "that the server exposes an OpenAI-compatible /v1/embeddings route.",
        );
      }

      expect(vectors).toHaveLength(2);
      const a = vectors[0];
      const b = vectors[1];
      if (!a || !b) {
        throw new Error("expected two embedding vectors");
      }
      expect(a.length).toBeGreaterThan(0);
      expect(a.length).toBe(b.length);

      const sim = cosineSimilarity(a, b);
      expect(Number.isFinite(sim)).toBe(true);
      expect(sim).toBeGreaterThanOrEqual(-1);
      expect(sim).toBeLessThanOrEqual(1);
    },
    CHAT_TIMEOUT_MS + 5_000,
  );
});
