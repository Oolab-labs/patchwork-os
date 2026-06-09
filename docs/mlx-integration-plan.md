# MLX Integration & Local-AI Roadmap — Patchwork

> Status: **active.** Folds three research threads into one sequenced plan:
> (1) the original MLX integration (Tiers 0–3), (2) verified borrowable
> local-AI building blocks (GitHub/Reddit sweep), (3) automation-platform
> deltas grounded against the actual codebase (n8n/Windmill/Airflow/Temporal).
> Everything carries `file:line` seams. **Keystone:** one wire-up (`embedFn`)
> is simultaneously the MLX Tier-1 activation *and* the #1 automation-pattern
> quick win — three threads converge on it.

---

## 0. Where we are right now

| Tier | State |
|---|---|
| **Tier 0** — MLX behind the `local` driver | **Works today, config only.** No code change. |
| **Tier 1** — on-device embeddings + semantic trace search | **BUILT + committed** on `feat/mlx-integration` (`src/embeddings/`, the `ctxQueryTraces` semantic seam, `docs/mlx-integration.md`, `MLX_SMOKE` smoke test). 48 unit tests green, prod + `tests:core` typecheck clean. **Inert until the keystone wire-up** (§2). |
| **Tier 2 / 3** | Planned (below). |

The embeddings module + the opt-in semantic ranking path in `ctxQueryTraces`
are real and merged into the branch — but `embedFn` is never injected at the
tool registration site, so `semantic:true` silently falls back to substring
search. Activating it is the keystone.

---

## 1. Why MLX for Patchwork

[Apple MLX](https://github.com/ml-explore/mlx) runs LLMs **and** embedding
models natively on Apple Silicon and exposes them over an
**OpenAI-compatible HTTP API**. For Patchwork specifically:

- **$0 marginal cost.** The `local` driver is excluded from `BILLABLE_DRIVERS`
  (`src/recipes/runBudget.ts:43`). At `reconcile()` it emits a one-time
  `notbilled:local` notice and never increments spend or blocks `admit()`;
  `quoteUsd()` returns `undefined`, so `costRouter`
  (`src/recipes/pricing/costRouter.ts:49-69`) always treats it as affordable.
  → **unmetered judge→refine, all-day automation, bulk classification.**
- **Privacy.** Prompts + context never leave the Mac, enforced by the same
  `isLoopbackOrPrivateEndpoint` guard (`src/localEndpointGuard.ts:25`) the
  `local` driver already uses; embeddings traffic inherits it.
- **No key churn.** `LocalApiDriver.apiKey()` (`src/drivers/local/index.ts:57`)
  sends the conventional `"ollama"` placeholder.

### 1b. High-memory Apple Silicon sizing — run a *team* of models

A high-memory Mac (64 GB+, ideally 128 GB) lets you hold **three roles resident at once** (verified community picks,
2026):

| Role | Example model (MLX) | Footprint | Why |
|---|---|---|---|
| Judge / refine | Qwen3.5-35B-A3B (MoE, 4-bit) or Qwen3-27B dense | ~24 GB | Credible reviewer; dense variant is the safer **strict-JSON** pick. |
| Triage / classify | Qwen3-7B / Llama-3.2-3B (4-bit) | ~3–5 GB | Fast first-pass labelling, routing, summarize. |
| Embeddings | `nomic-embed-text` / `bge` / `qwen3-embed` | <1 GB | Powers semantic trace + file search. |

**Small-for-triage / big-for-judge** is the operating pattern: the big model is
*smart but not instant*, so reserve it for reasoning steps; let the small model
handle volume. Keeping all three resident is itself a borrowable pattern (§3.4).

---

## 2. ⭐ The keystone — activate semantic memory (`embedFn`)

**One change closes three gaps at once.** Wire the already-built embeddings
provider into the trace-search registration:

- **Seam:** `src/tools/index.ts:781` and `src/bridge.ts:1272` both call
  `createCtxQueryTracesTool({...})` with no `embedFn`. Add
  `embedFn: createEmbeddingsProvider()?.embed.bind(provider)` (via the
  `getLocalEmbedFn()` helper). Fail-soft: provider `null` ⇒ unchanged substring
  behavior.
- **Plus** the embeddings env injection: add `localEmbeddingsEndpoint` /
  `localEmbeddingsModel` to `PatchworkConfig` (`src/patchworkConfig.ts:39-40`),
  seed `LOCAL_EMBEDDINGS_ENDPOINT/MODEL` at startup
  (`src/config.ts:589-592` mirror), and add the two fields to
  `config.schema.json` (the `configSchemaAlignment.test.ts` gate requires it).
- **Bonus seam:** in `recentTracesDigest.ts`, pass the current task hint as
  `q` with `semantic:true` so the session-start digest is **relevance-sorted**,
  not recency-sorted.

**Why it's the keystone:** it activates MLX Tier 1 *and* the #1 automation
"knowledge-linking" delta (§4) *and* is the foundation the RAG/fine-tune tracks
build on. Smallest change, widest unlock.

---

## 3. Thread A — verified local-AI building blocks to borrow

All repos below were **independently confirmed to exist** (the research agents
over-reported "verified"; these were re-checked by hand). See the appendix (§6)
for the full table + links.

### 3.1 Persistent vector cache — completes Tier 1
Today `ctxQueryTraces` re-embeds the candidate set **every query**. Add
[sqlite-vec](https://github.com/asg017/sqlite-vec) (Node via `better-sqlite3`,
**zero new process** — Patchwork already uses SQLite) with
`INSERT OR REPLACE` keyed on `(content_hash, model_hash)` → embed only on change.
[LanceDB](https://github.com/lancedb/lancedb) is the upgrade if metadata queries
are later needed. *Effort low, impact high — natural follow-up to §2.*

### 3.2 Constrained decoding — fix the judge→refine JSON halts
The judge step depends on the local model emitting parseable verdict JSON; the
session's live halts (`expect_failed`, `agent_silent_fail`) are partly this.
**Zero bridge logic** needed: when `LOCAL_ENDPOINT` points at vLLM
([XGrammar](https://github.com/mlc-ai/xgrammar)) or a
[llama.cpp server](https://github.com/ggml-org/llama.cpp), add
`response_format: {type:"json_schema"}` / `guided_json` / `grammar` to the local
driver request body — the model physically cannot emit a token that breaks
`JSON.parse()`. Export the existing `JudgeVerdict` type as JSON Schema. No-sidecar
path: [node-llama-cpp](https://github.com/withcatai/node-llama-cpp) (TS, Metal,
in-process). *Effort low, impact high — targets a live failure mode.*

### 3.3 oMLX as the recommended local backend
[oMLX (jundot/omlx)](https://github.com/jundot/omlx) — **verified real, 16.3k★**,
Apache-2.0. Drop-in for the `local` driver base URL (OpenAI+Anthropic compatible).
Unique value: a **block-based KV cache tiered to SSD with prefix sharing that
survives restarts** — repeated recipe runs sharing a long system prompt pay
prefill *once* (reported TTFT 30–90s → 1–3s on long context), plus multi-model
LRU residency and token-level JSON output. Caveat: new, ships as a menu-bar app.

### 3.4 Multi-model "team" → maps to the cost-router downshift
Three effort tiers, all hitting the existing `local` driver:
- **Lowest friction:** [Ollama](https://ollama.com/blog/mlx)
  `OLLAMA_MAX_LOADED_MODELS=3` + `keep_alive=-1` on embedder + judge (no new code).
- **Drop-in proxy:** [llama-swap](https://github.com/mostlygeek/llama-swap)
  (`swap:false` for always-resident embedder/judge).
- **Best:** oMLX (LRU + pin).

### 3.5 Hybrid local→cloud escalation
[LiteLLM](https://github.com/BerriAI/litellm) as a transparent proxy gives
`context_window_fallbacks` + per-request spend logs feeding the cost ledger —
expressing the downshift list (local Qwen → local Llama → cloud Claude) at the
transport layer. Rapid-MLX's `--cloud-threshold` escalates on *actual* new-token
prefill cost, a sharper signal than the current budget estimate.

### 3.6 Personal-files RAG — "your digital life stops expiring"
Borrow [Khoj](https://github.com/khoj-ai/khoj)'s hash-per-chunk incremental
indexing (parse→chunk→hash→diff→embed deltas→upsert) + LlamaIndex's
filename-as-stable-id `RefDocInfo` pattern (~100 lines, not a dependency) to
extend memory from traces to the user's Markdown/Obsidian vault. Pairs with the
existing `onFileSave` / `watchFiles` hooks. [mem0](https://github.com/mem0ai/mem0)
(Node SDK) adds hybrid BM25+semantic+entity retrieval if wanted.

### 3.7 Fine-tune on the user's traces — compounding personalization
Export `ctxQueryTraces` as JSONL → [mlx-lm](https://github.com/ml-explore/mlx-lm)
`mlx_lm.lora` (or DPO from judge approve/reject pairs) → ~10 MB adapter loaded
via `--adapter-path` on the local endpoint. ~90 min on high-end Apple Silicon; re-train every few
weeks. The model learns the user's style + verdict preferences. *Research track.*

### Community gotchas worth encoding as rules
- **MLX tok/s is decode-only.** Judge steps (big context in, short JSON out) are
  *prefill*-bound, where GGUF + llama.cpp FlashAttention beats MLX — so the ideal
  is two local endpoints (GGUF for judge, MLX for generative), *unless* oMLX's KV
  cache neutralizes it. The per-step `driver`/`model` config already supports this.
- **Ollama prefix-caching needs a byte-stable system prompt.** Recipe-authoring
  rule: keep per-run vars (step id, timestamp, attempt #) out of the *system*
  prefix (pass as user-turn messages) or every refine iteration pays 8–16× TTFT.
  Worth a `recipe lint` warning.

---

## 4. Thread B — grounded automation-platform deltas

Verified against the codebase: **Patchwork already ships partial-to-strong
versions of all of these, and is *ahead* of n8n on approvals.** The value is the
precise delta, not the generic pattern.

| Pattern | Have (level) | Real gap | Borrow (seam) | Effort/Impact |
|---|---|---|---|---|
| Sub-recipes | **partial** — `nestedRecipeStep.ts`, `chainedRunner.ts:481` (chained-only) | no declared `outputs:` contract; no version pin | add top-level `outputs:` block (schemaGenerator + validation + `formatNestedOutput`) | med / med |
| Approval + audit | **strong** (ahead of n8n) — tiers, queue, 12 signals, phone push, decision-replay | no per-*step* gate; no `channel` on audit row | add `channel` at `approvalHttp.ts:779` (`phone` vs `dashboard`) | **low / med** |
| History + replay | **partial** — `runs.jsonl` + mocked replay `POST /runs/:seq/replay` | replay can't sub inputs; chained-only | add `varsOverride` to `replayMockedRun()` (`replayRun.ts:109`) | **low / HIGH** |
| Knowledge linking | **partial** — semantic path **built but dead** | `embedFn` never injected; no "see also" surface | **= the keystone (§2)** + populate `RelatedPanel` from a semantic query | **low / med** |
| Visual builder | **partial** — YAML/Form/Flow editor; Flow is read-only | no diagram→YAML, no drag; `stepStatuses` unwired | wire live run status into `FlowSvg` (`_edit/page.tsx:1209`) → live monitor | **low / med** |
| Connector ecosystem | **partial** — 46 connectors + plugin system | plugins can't read stored tokens | add `getCredential(id)` to `PluginContext` (`plugin.ts:74`) | med / **HIGH** |
| Durable execution | **partial** — write-tool ledger, interrupted-sweep, checkpoint | agent/LLM steps re-run on crash; cron runs in-memory-only | extend the ledger to **agent steps** (`yamlRunner.ts:1633`) | med / **HIGH** |

---

## 5. Unified sequenced roadmap

Ordered by dependency + ROI. `[A]` = local-AI thread, `[B]` = automation thread.

### Phase 0 — Keystone ✅ DONE (2026-06-09, commit `00902265`)
1. **Wire `embedFn` + embeddings env injection** (§2). `[A+B]` — activated Tier 1
   semantic memory *and* the knowledge-linking delta. Also hardened the resolver
   so an empty/whitespace env var no longer shadows the `LOCAL_ENDPOINT` fallback.

### Phase 1 — re-assessed after investigation (only one was a true quick win)
> Lesson: the grounding sweep's "low effort" labels were optimistic. Each item
> below was opened up; here is the *real* effort/risk. Sequence by readiness.

- ✅ **Approval `channel` field** (§4) `[B]` — **DONE** (commit `a8d30223`). The
  one genuinely-clean backend win: phone-vs-dashboard provenance on every
  `approval_decision` row. +4 tests.
- **Replay `varsOverride`** (§4) `[B]` — **needs a security design**, not a patch.
  `replayMockedRun`'s `env` is the *hardened declared-keys allowlist* (audit
  recipe-support-3: never spread `process.env`). An input override must be scoped
  to *declared* trigger vars, or it reopens an injection vector.
- **sqlite-vec vector cache** (§3.1) `[A]` — **adds a native dependency**
  (sqlite-vec + better-sqlite3) + needs a cache-invalidation design. Dep sign-off
  first.
- **Constrained-decoding judge JSON** (§3.2) `[A]` — **conflicts with the current
  judge format.** `JUDGE_PROMPT_SUFFIX` asks for "prose assessment + a trailing
  JSON line"; `response_format: json_object` forces the *whole* response to be
  JSON. Proper fix = redesign the judge to emit pure structured JSON (assessment
  as a field) + update `parseJudgeVerdict` + re-verify the refine loop. The
  driver seam is clean (`ProviderTaskInput.providerOptions` is already a
  passthrough; add `response_format` in `openai/index.ts`'s `create()` body) —
  the *judge-contract* change is the real work. Sensitive path; design first.
- **FlowSvg live run status** (§4) `[B]` — contained, but dashboard/React: needs
  visual verification (no unit test). A frontend session, not a backend one.

### Phase 2 — Bets (medium effort, high impact)
7. **Agent-step durability ledger** (§4) `[B]` — crash-resume of expensive LLM
   steps.
8. **`PluginContext.getCredential`** (§4) `[B]` — unlocks community connectors.
9. **Sub-recipe `outputs:` schema** (§4) `[B]` — typed contracts for big
   compositions.
10. **oMLX / multi-model backend** (§3.3–3.4) `[A]` — docs + recommended default;
    multi-model team config.

### Phase 3 — Bigger / research
11. **Personal-files RAG** over the user's vault (§3.6) `[A]`.
12. **LiteLLM hybrid local→cloud escalation** (§3.5) `[A]`.
13. **Fine-tune-on-traces** house-style judge (§3.7) `[A]`.
14. **Tier 2** dashboard embeddings card + free local helpers (§ below).
15. **Tier 3** VLM photo-trigger, Whisper voice, iPhone/iPad LM-Link companion
    (§ below).

---

## Tier 2 — Free in-dashboard AI helpers + embeddings config UI

- **Local-LLM card embeddings fields** — surface `embeddingsEndpoint/Model` in
  `GET /status` + `POST /config/patchwork` with the **same SSRF validation** as
  `localEndpoint`, two new rows in `dashboard/src/app/settings/page.tsx:887-933`
  using the `localDirtyRef`→`embeddingsDirtyRef` poll-guard.
- **Free dashboard helpers** (`driver: local`, $0): recipe-draft assist,
  "explain this halt", trace summarization, "explain this step".

## Tier 3 — Beyond text

- **VLM photo-trigger recipes** — MLX vision (Qwen-VL) reads images; new
  `onPhoto`/image-input trigger feeds a screenshot/photo to a VLM step
  (recipe-schema work).
- **Whisper voice** — MLX-Whisper for voice-dictated tasks / voice-note triggers.
- **iPhone/iPad companion (LM Link pattern)** — phone hits the Mac's MLX server
  over LAN (RFC1918 already allowed by `isLoopbackOrPrivateEndpoint`); pairs with
  the existing mobile-oversight push path.

---

## WWDC 2026 — system-MCP readiness (watch + light prep)

> Added 2026-06-09, one day after WWDC. This is a **forward-looking watch item**,
> not a re-sequencing of the build plan above. The capability is confirmed; the
> exact registration mechanism is **not yet documented** (in dev-beta + session
> videos). Treat the Apple-side specifics below as *informed inference* until
> confirmed from Apple's docs.

**What changed.** iOS 27 / macOS 27 ship **system-wide MCP**: Siri 2.0 can invoke
**registered MCP servers**, and Core AI routes to MCP as a first-class call
target. Direction is **OS → server** — the system reaches out and calls tools on
a server the user registers (apps pushing tools *into* the OS is not open yet).
Dev beta now; public ~September 2026.

**Why Patchwork is already positioned.** MCP registration only comes in two
shapes, and the bridge already implements **both**:
- **Local / stdio:** `claude-ide-bridge shim` is the stdio MCP entrypoint — the
  exact `{command, args}` registration form.
- **Remote / HTTP:** the Streamable HTTP `/mcp` endpoint (Bearer) + the full
  **OAuth 2.0 mode** (`--issuer-url`; authorize/token/dynamic-registration/PKCE)
  — exactly what an OS-level MCP client uses to connect to a running server with
  user consent.

Whatever Apple's registration config turns out to be, Patchwork most likely
already speaks it. Effort ≈ *register + grant consent + expose a safe surface*,
not *build MCP support*.

**Nice property:** a Siri-triggered **write** still passes through Patchwork's
own approval gate (`src/approvalHttp.ts`), so the two safety layers compose —
Siri convenience + Patchwork's human-approval net on risky actions.

**The one thing worth doing now (small, independent):** define a **slim,
Siri-safe tool surface**. Do NOT expose all 177 tools (shell/write/git) to Core
AI. Reuse `--slim` + tool-capability filtering to register a deliberately narrow
read-mostly set (e.g. run-recipe, status, a few reads). This is buildable today
and is the only part not gated on Apple's timeline.

**Confirm from Apple before any real wiring:** (a) the exact registration
file/settings location; (b) whether it accepts remote+OAuth or **local-stdio
only** (Apple likely favors local first → the `shim`); (c) any notarization /
entitlement requirement for the registered server binary.

**Roadmap placement:** a **Phase 3+ watch item**. Do not block the Phase 0
keystone on it. Track Apple's docs; ship the slim tool surface opportunistically.

---

## Dev test-bench value

A free, real local model is a high-fidelity test bench: exercise
`OpenAIApiDriver` streaming + the 50 KB `OUTPUT_CAP`/abort
(`src/drivers/openai/index.ts:137-177`), the flat (`yamlRunner.ts:991`) +
chained (`chainedRunner.ts:838`) runners, the judge→refine loop, and the cost
router with a $0 driver — all day, no rate limits, no bill. The dashboard
Local-LLM card round-trips against a live server.

---

## 6. Verified external building blocks (appendix)

Independently confirmed to exist (hand-checked; the research workflow's blanket
"verified" was not trusted):

| Tool | What | Borrow for | Verified |
|---|---|---|---|
| [oMLX](https://github.com/jundot/omlx) | MLX server, SSD-tiered KV cache, multi-model LRU, JSON output | §3.3 backend; §3.4 team | ✅ 16.3k★ |
| [Rapid-MLX](https://github.com/raullenchai/Rapid-MLX) | fast MLX server, 17-parser tool-calling, cloud routing | §3.5 escalation | ✅ 2.7k★ |
| [vllm-mlx](https://github.com/waybarrios/vllm-mlx) | continuous batching, OpenAI+Anthropic, embeddings | §3.4 | ✅ 1.3k★ |
| [mlx-omni-server](https://github.com/madroidmaq/mlx-omni-server) | MLX server w/ structured output + tool calling | §3.2 judge JSON | ✅ 723★ |
| [qwen3-embeddings-mlx](https://github.com/jakedahn/qwen3-embeddings-mlx) | MLX embedding REST server, 44K tok/s | §3.1 sidecar (early — fork, don't depend) | ✅ 15★ |
| [sqlite-vec](https://github.com/asg017/sqlite-vec) | SQLite vector ext (Node) | §3.1 cache (pin v0.1.9, pre-v1) | ✅ |
| [node-llama-cpp](https://github.com/withcatai/node-llama-cpp) | in-process llama.cpp + grammar (TS) | §3.2 no-sidecar JSON | ✅ |
| [XGrammar](https://github.com/mlc-ai/xgrammar) / [llama.cpp](https://github.com/ggml-org/llama.cpp) | constrained decoding backends | §3.2 | ✅ |
| [llama-swap](https://github.com/mostlygeek/llama-swap) | model swap proxy | §3.4 team | ✅ |
| [LiteLLM](https://github.com/BerriAI/litellm) | routing proxy + fallbacks | §3.5 hybrid | ✅ |
| [Khoj](https://github.com/khoj-ai/khoj) / [mem0](https://github.com/mem0ai/mem0) | personal-file RAG patterns | §3.6 | ✅ |
| [mlx-lm](https://github.com/ml-explore/mlx-lm) / [mlx-embeddings](https://github.com/Blaizzy/mlx-embeddings) | official MLX LLM + embedding libs | §3.7 / §3.1 | ✅ |

---

## 7. Honest caveats

- **Apple-Silicon only.** MLX needs an M-series Mac. The integration is
  config-gated + fail-soft; non-Mac installs never configure
  `LOCAL_EMBEDDINGS_ENDPOINT` and keep substring search.
- **CI runs on Linux.** Live-model tests can't run there. Unit tests inject a
  mock `fetchImpl`; the smoke test is opt-in, skipped unless `MLX_SMOKE === "1"`.
- **MLX embedding/server tools are Python** → the Node bridge needs a
  `child_process` sidecar, *or* use Ollama `nomic-embed-text` (already supported,
  zero new code) for the lowest-friction path.
- **Pin pre-v1 deps.** sqlite-vec → v0.1.9; qwen3-embeddings-mlx (15★) is a
  reference to fork, not a dependency; prefer
  [mlx-embeddings (Blaizzy)](https://github.com/Blaizzy/mlx-embeddings) over the
  stale taylorai one.
- **oMLX is new** despite the star count — pilot before defaulting.
- **Ollama constrained decoding is weaker** than vLLM/llama.cpp (its `format`
  param doesn't expose grammar/`guided_json` the same way) — prefer vLLM or
  llama.cpp for the judge JSON guarantee.
- **Big models are smart-but-not-instant.** Keep the small-for-triage /
  big-for-judge split.
- **Usage capture depends on the server** emitting an OpenAI `usage` chunk;
  missing ⇒ budgets fail open (fine for a $0 driver).
- **Embedding dims must match** across a corpus; re-embed on model change
  (in-memory today — §3.1 fixes this with a keyed persistent cache).
