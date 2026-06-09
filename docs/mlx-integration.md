# MLX Integration — Setup Guide

> How to run Apple [MLX](https://github.com/ml-explore/mlx) on-device models
> behind Patchwork's existing `local` chat driver **and** the new embeddings
> env, plus how to exercise the dev test-bench and run the opt-in `MLX_SMOKE`
> integration test.
>
> Architecture, rationale, and the sequenced build order live in the companion
> roadmap: [docs/mlx-integration-plan.md](mlx-integration-plan.md). This file is
> the operational how-to.

MLX runs LLMs and embedding models natively on Apple Silicon and exposes them
over an **OpenAI-compatible HTTP API**. Patchwork's `local` driver already
speaks that surface, so chat works with config alone; embeddings add two env
vars. Everything is fail-soft: a non-Mac install that never configures these
vars is unaffected.

---

## 1. Install + launch an MLX server

You need an OpenAI-compatible server listening on loopback. Any of the three
below work — pick the one that matches what you want resident.

### Option A — `mlx_lm.server` (chat / judge / triage)

```bash
pip install mlx-lm
# Serve a chat model on :8080 (OpenAI-compatible /v1/chat/completions)
mlx_lm.server \
  --model mlx-community/Qwen2.5-32B-Instruct-4bit \
  --host 127.0.0.1 --port 8080
```

Endpoint base URL: `http://localhost:8080/v1`

### Option B — Ollama-on-MLX (chat **and** embeddings on one port)

```bash
# Ollama uses an MLX-accelerated backend on Apple Silicon.
ollama serve                       # listens on :11434
ollama pull qwen2.5:32b            # chat / judge
ollama pull nomic-embed-text       # embeddings
```

Endpoint base URL: `http://localhost:11434/v1` — serves both
`/v1/chat/completions` and `/v1/embeddings`, so one endpoint covers chat +
embeddings.

### Option C — `mlx-embeddings` (dedicated embeddings server)

```bash
pip install mlx-embeddings
# Serve an embedding model on its own port (OpenAI-compatible /v1/embeddings)
python -m mlx_embeddings.server \
  --model mlx-community/nomic-embed-text-v1.5 \
  --host 127.0.0.1 --port 8081
```

Endpoint base URL: `http://localhost:8081/v1`

> Run a chat server (A) **and** a dedicated embeddings server (C) side by side,
> or a single Ollama instance (B) that does both. The config below supports
> either topology.

---

## 2. Point the chat driver at MLX

The `local` driver subclasses `OpenAIApiDriver` with a swapped `baseURL` +
`defaultModel` (`src/drivers/local/index.ts:29-62`). It reads `LOCAL_ENDPOINT`
+ `LOCAL_MODEL` at construction.

### Via `~/.patchwork/config.json` (recommended)

```jsonc
// ~/.patchwork/config.json
{
  "localEndpoint": "http://localhost:8080/v1",
  "localModel": "mlx-community/Qwen2.5-32B-Instruct-4bit"
}
```

At bridge startup these flow into the env vars **non-destructively** — only set
when the env var is unset (`src/config.ts:589-592`):

```ts
if (pw.localEndpoint && !process.env.LOCAL_ENDPOINT)
  process.env.LOCAL_ENDPOINT = pw.localEndpoint;
if (pw.localModel && !process.env.LOCAL_MODEL)
  process.env.LOCAL_MODEL = pw.localModel;
```

### Via env vars (headless / CI / scripts)

```bash
export LOCAL_ENDPOINT=http://localhost:8080/v1
export LOCAL_MODEL=mlx-community/Qwen2.5-32B-Instruct-4bit
# LOCAL_API_KEY is optional — defaults to the "ollama" placeholder
```

### Use it in a recipe

```yaml
steps:
  - id: triage
    agent:
      driver: local                # $0, on-device
      model: mlx-community/Qwen2.5-7B-Instruct-4bit  # per-step override
      prompt: "Classify this inbound message: {{input}}"
```

`driver: local` is intentionally excluded from `BILLABLE_DRIVERS`
(`src/recipes/runBudget.ts:43`), so the step never increments `usdSpent` and
never trips a budget halt — judge→refine loops and bulk classification run
unmetered.

---

## 3. Point embeddings at MLX

Embeddings are an internal module (`src/embeddings/`) — **not** an MCP tool.
The factory reads, in precedence order
(`src/embeddings/localEndpoints.ts:17-41`):

| Setting    | 1st         | 2nd                         | 3rd (fallback)     | default            |
|------------|-------------|-----------------------------|--------------------|--------------------|
| Endpoint   | `opts.endpoint` | `LOCAL_EMBEDDINGS_ENDPOINT` | `LOCAL_ENDPOINT`   | _(unset ⇒ null)_   |
| Model      | `opts.model`    | `LOCAL_EMBEDDINGS_MODEL`    | `LOCAL_MODEL`      | `nomic-embed-text` |

So if your MLX server (Ollama-on-MLX) serves chat **and** embeddings on the
same port, `LOCAL_ENDPOINT` alone is enough. To use a dedicated embeddings
server (Option C), set the embeddings vars explicitly:

```bash
export LOCAL_EMBEDDINGS_ENDPOINT=http://localhost:8081/v1
export LOCAL_EMBEDDINGS_MODEL=mlx-community/nomic-embed-text-v1.5
```

The factory POSTs to `<endpoint>/embeddings` with the OpenAI-compatible shape
`{ model, input: string[] }` and reads back `{ data: [{ embedding: number[] }] }`.

### How `ctxQueryTraces semantic:true` uses it

By default `ctxQueryTraces` `q` search is substring-only
(`src/tools/ctxQueryTraces.ts:238-248`), sorted by recency. With an embeddings
endpoint configured, the opt-in `semantic: true` arg embeds the query once,
cosine-scores each pooled trace's richest text against it
(`cosineSimilarity`, `src/embeddings/cosine.ts:17`), drops anything below a
floor, and sorts by score DESC instead of `b.ts - a.ts`. A past fix worded
differently ("auth token leak" vs "credential exposure") then surfaces.

**Fail-soft:** if no embeddings endpoint is configured the factory returns
`null`, and `ctxQueryTraces` falls straight back to substring matching. It
never throws.

---

## 4. SSRF note — loopback / RFC1918 only

Both the chat driver and the embeddings provider stream your prompt + context
to the configured URL. To stop a phishy "free local LLM" link from exfiltrating
that data, the endpoint is checked with the shared guard
`isLoopbackOrPrivateEndpoint` (`src/localEndpointGuard.ts:25`). Allowed hosts:

- `localhost` / `127.0.0.1` / `::1`
- RFC1918 private space — `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`
- link-local `169.254.0.0/16`, `fe80::/10`; unique-local `fc00::/7`
- single-label `.local` / `.lan` / `.home` / `.internal` mDNS forms

A **public** endpoint is rejected unless you explicitly opt out:

```bash
export LOCAL_ENDPOINT_ALLOW_REMOTE=1   # only for audited internal clusters
```

The same override applies to the embeddings endpoint — it shares the guard and
the env flag with the chat driver (`src/drivers/local/index.ts:39-49`).

---

## 5. High-memory Apple Silicon sizing

A high-memory Apple Silicon Mac (64 GB+, ideally 128 GB of unified memory) lets
you hold **three models resident at once** and route per role:

| Role               | Example model (MLX)                  | Approx footprint | Why |
|--------------------|--------------------------------------|------------------|-----|
| Judge / refine     | Qwen2.5-32B / Llama-3.3-70B (4-bit)  | ~20–40 GB        | Big enough to be a credible reviewer in the judge→refine loop. |
| Triage / classify  | Qwen2.5-7B / Llama-3.2-3B (4-bit)    | ~2–5 GB          | Fast first-pass labelling, routing, summarize. |
| Embeddings         | `nomic-embed-text` / `bge-small`     | <1 GB            | Powers semantic trace search. |

The "small-for-triage / big-for-judge" split is the practical pattern: the big
model is **smart but not instant**, so reserve it for steps that need reasoning
(judge verdicts, refinement) and let the small model handle high-volume triage.
All three share the OpenAI-compatible surface, so a recipe just sets `model:`
per step. Worst case all three fit at once with headroom for the OS — start the
chat server (A), a triage server, and an embeddings server (C) on three ports.

> Don't mix embedding models across one trace corpus — cosine over
> mismatched-dimension vectors is meaningless. Re-embed if the model changes.

---

## 6. Dev test-bench — exercise Patchwork against a free local server

A real, $0 local model is a high-fidelity test bench. With the chat env vars
set (section 2):

- **Driver streaming + output cap.** Run any `driver: local` recipe step and
  watch `OpenAIApiDriver` stream, apply the 50 KB `OUTPUT_CAP` / mid-stream
  abort (`src/drivers/openai/index.ts`), and capture the usage chunk — without
  spending a cent.

  ```bash
  patchwork recipe run <name> --driver local
  ```

- **Recipe runner — flat + chained.** Exercise the flat path
  (`src/recipes/yamlRunner.ts:991`) and the chained DAG path
  (`src/recipes/chainedRunner.ts:838`) with a `driver: local` recipe.

- **Judge → refine loop, unmetered.** Set `kind: judge` + `max_revisions: N`
  on a `driver: local` step and run the self-correction loop all day with no
  budget halt and no rate limit.

- **Cost router fails open for `local`.** Confirm `local` flows through budget
  as free: `quoteUsd()` returns `undefined` and `reconcile()` emits the
  one-time `notbilled:local` notice (`src/recipes/runBudget.ts:201`) without
  ever blocking `admit()`.

---

## 7. Run the `MLX_SMOKE` integration test

The smoke test (`src/embeddings/__tests__/mlxSmoke.integration.test.ts`) hits a
**real** local server — chat + embeddings — over the live `globalThis.fetch`.
It is **skipped unless `MLX_SMOKE === "1"`**, so the Linux CI run is a no-op and
never tries to reach a server that doesn't exist there.

### Default (CI, no MLX) — all skipped

```bash
npx vitest run src/embeddings/__tests__/mlxSmoke.integration.test.ts
# → all tests skipped, 0 failures
```

### On your Mac with MLX running — assertions execute

```bash
MLX_SMOKE=1 \
  LOCAL_ENDPOINT=http://localhost:8080/v1 \
  LOCAL_MODEL=mlx-community/Qwen2.5-7B-Instruct-4bit \
  LOCAL_EMBEDDINGS_ENDPOINT=http://localhost:8080/v1 \
  LOCAL_EMBEDDINGS_MODEL=nomic-embed-text \
  npx vitest run src/embeddings/__tests__/mlxSmoke.integration.test.ts
```

The test then:

1. **Chat** — runs a one-shot prompt through `LocalApiDriver` against
   `LOCAL_ENDPOINT` / `LOCAL_MODEL` and asserts non-empty text comes back.
2. **Embeddings** — builds a provider via `createEmbeddingsProvider()`
   (reads `LOCAL_EMBEDDINGS_ENDPOINT` / `LOCAL_EMBEDDINGS_MODEL`), embeds two
   short strings, and asserts two vectors of matching dimension with a cosine
   similarity in `[-1, 1]`.

If a required env var is missing while `MLX_SMOKE=1`, the corresponding test
fails with a clear message telling you which var to set — there are no
hardcoded URLs.

---

## See also

- [docs/mlx-integration-plan.md](mlx-integration-plan.md) — architecture +
  sequenced build (Tier 0 chat, Tier 1 embeddings + semantic trace search,
  Tier 2 dashboard config, Tier 3 VLM / Whisper / mobile).
- `src/drivers/local/index.ts` — the `local` chat driver.
- `src/embeddings/` — the embeddings provider, cosine math, and endpoint
  precedence.
- `src/localEndpointGuard.ts` — the shared SSRF guard.
