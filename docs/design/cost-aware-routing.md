# Design: Cross-driver cost-aware model routing

**Status:** ACCEPTED (direction) — Phase 0 in progress. Two product decisions made 2026-06-03: estimation is **warn-only** (`estimateUnmeasured` defaults to `false`); a local per-recipe `usdMax` **ships free in OSS core**. (The implementing ADR is written in the final phase.)
**Date:** 2026-06-03
**Author:** generated from a grounded design workflow (6 subsystem maps → 3 independent design stances → adversarial critique → synthesis), then fact-checked against source.

---

## 1. Problem

Recipes can already name a `model` and a `driver` per agent step, and a recipe can set a **token** budget (`budget.tokensMax`, `onBreach: halt|warn`). What's missing:

- **No USD cost model.** `RunBudget` is token-only. `usdMax` was deliberately deferred — the comment in [`runBudget.ts`](../../src/recipes/runBudget.ts) says it "needs a price table; subscription drivers complicate."
- **No cost-aware routing.** There's no way to say "use the cheap model for the draft, the strong model for the judge" or "downshift to a cheaper model when the budget is running low."
- **Provider drivers silently fail open.** Even the *token* budget doesn't work for `openai`/`grok`/`gemini` because those drivers never surface usage (see §3).

> A prior memory claimed a `model_fallback` field "exists but is ignored." **It does not exist in `src/`** — it appears only in `examples/recipes/advanced-patterns/` docs (4 refs, 0 in code). That doc-drift is reconciled in Phase 0.

The brief: design **cross-driver cost-aware model routing** that is opt-in, composes with everything we just shipped (judge→refine #859, fail-open `on_error`, augment-only judges), and is honest about the fact that the **default driver is a flat-rate subscription that reports no tokens.**

## 2. Ground truth (verified against source)

The authors left a **forward-compatible socket** and wrote down exactly why they stopped:

| Fact | Location (verified) |
|---|---|
| `RunBudget` is token-only; `usdMax` explicitly out of scope ("needs a price table; subscription drivers complicate") | `runBudget.ts:24` |
| `BudgetPolicy` is a **nested** object specifically so `usdMax` can be added as a sibling | `schema.ts:146` ("future siblings — `usdMax` …") |
| Subscription drivers **fail open** (record driver once, warn, never block) — called a non-negotiable invariant | `runBudget.ts:12–15`, `reconcile()` |
| `budget_exceeded` halt category + `/budget[_ ]?exceeded/i` regex already exist (reusable for usdMax) | `haltCategory.ts:24,119` |

…and three **latent bugs / gaps** any cost work must fix anyway (all verified):

1. **`parseRecipe` drops `budget`.** The normalized object it returns (`parser.ts:69–82`) carries `name/version/description/trigger/context/steps/on_error` — **no `budget`**. Any recipe that round-trips through the parser loses its token budget. *(Pure pre-existing bug — must not be gated behind the cost feature.)*
2. **`reconcile` mis-attributes the driver.** Both call sites (`yamlRunner.ts:1040`, `:1321`) pass the *configured* `driver ?? "auto"`, not the driver that actually served the call. So per-driver warnings/accounting are keyed on a guess.
3. **Provider usage is thrown away.** `makeProviderDriverFn` returns a **bare string** (`yamlRunner.ts:~2379`, `return result.text`), so even when a driver *could* report tokens, `usage` never reaches `reconcile`. `RunBudget.totals()`/`warnings()` have **zero production call sites** — token warn-mode breaches and unmeasured-driver warnings are computed and silently discarded.

## 3. Per-driver cost fidelity (the make-or-break constraint)

| Driver | Mode | Reports tokens today? | Notes |
|---|---|---|---|
| `subprocess` (Claude CLI) — **the default** | subscription | ❌ none | stream-json `result` event *does* carry `usage` + `total_cost_usd`; `streamParser` ignores it |
| `gemini` (CLI) | subscription | ❌ none | same shape, discarded |
| `api` (Anthropic SDK) | API key | ❌ (but trivially fixable) | `messages.create` returns `usage`; driver discards it |
| `openai` / `grok` / `gemini-api` / `local` | API key | ❌ (fixable) | `providerMeta` only carries `{model}`; needs `stream_options:{include_usage:true}` |

**The trap:** a `usdMax` that silently no-ops for the default subscription driver is worse than no feature — it looks enforced but isn't. The design resolves this honestly (§5.3): **fail open with a loud warning by default; estimation is opt-in and can only WARN, never halt.**

## 4. Approaches considered

| Stance | Idea | Verdict |
|---|---|---|
| **A — resilience fallback chain** | per-step ordered `fallback: [{driver?,model}]`, retry next on error/budget-deny; no price table | **Cleanest scores, but answers the wrong question** — it's resilience, not cost. Its substrate fixes are harvested. |
| **B — declarative cost tiers** | `(driver,model)→USD` price table + `tier:`/`routing:` map picking cheapest-capable upfront + `usdMax` | **Core (price table + usdMax) is right; the `routing`/`tier`/`escalate` dictionary + inline `pricing:` are cut** (schema bloat; inline pricing is a budget-evasion footgun). |
| **C — USD ledger drives routing** | extend `RunBudget` into a USD ledger; estimate tokens for subscription drivers; downshift as budget shrinks | **Backbone of the recommendation, with one fix**: its `estimateUnmeasured: true` default inverts the fail-open invariant — flip it to **false**. Its `downshift` primitive is kept. |

## 5. Recommendation — the hybrid

> **Cost-ledger core + opt-in downshift routing, estimation off by default.**
> Take B's minimal core (driver token capture + static price table + `budget.usdMax`) as the spine; graft A's `servedBy` reconcile fix and additive-`AgentResult` telemetry as the substrate; graft C's per-step `downshift` as the routing layer and its `usage.estimated`/`usdEstimatedPortion` honesty labels — **but with `estimateUnmeasured` defaulting to `false`** so opting into a cap never silently opts the subscription default driver into estimation-driven halts.

All three critiques converged on the same minimal core and disagreed only about the bundled layers — the signature of a hybrid.

### 5.1 Config surface (all opt-in; absent = byte-identical)

```yaml
# Recipe-level budget — extends today's token-only block
budget:
  tokensMax: 200000          # existing
  usdMax: 2.50               # NEW — enforced for *measured* (API) drivers
  onBreach: halt             # existing enum reused (halt | warn)
  estimateUnmeasured: false  # NEW, DEFAULT false — when true, estimate tokens
                             #   for subscription drivers; estimated spend can
                             #   only WARN, never halt (renders "≈$X")

steps:
  - id: draft
    agent:
      prompt: ...
      model: claude-sonnet-4-6
      # NEW — author-ordered cheaper alternatives, tried pre-dispatch when the
      # remaining USD budget is too tight for the preferred model. Absent =>
      # the preferred model is always used (byte-identical).
      downshift:
        - { model: claude-haiku-4-5-20251001 }
        - { driver: gemini-api, model: gemini-2.5-flash }
```

Price table — **data, not code**, overridable, never hot-path network:
```
src/recipes/pricing/priceTable.json   # checked-in list prices, dated _meta, CI staleness ratchet
~/.patchwork/prices.json              # workspace override
PATCHWORK_PRICE_TABLE=/path.json       # env override
# precedence: env > file > checked-in ; fail-open on unknown (driver,model)
```
**Dropped from B:** the inline recipe `pricing:` field (a recipe could under-price a model to dodge `usdMax`). The two out-of-band overrides get ~95% of the value safely.

### 5.2 Data model & integration points (verified anchors)

- **`AgentResult`** (`agentExecutor.ts`): widen *additively* with `servedBy?: {driver, model, attempt}` and keep `usage?`. Unset ⇒ byte-identical.
- **Drivers:** `ApiDriver` reads the `message.usage` it discards; `OpenAIApiDriver` adds `stream_options:{include_usage:true}` (covers openai/grok/gemini-api/local in one place); standardize a typed `providerMeta {model, inputTokens, outputTokens}`.
- **`makeProviderDriverFn`** (`yamlRunner.ts:~2379`): return `AgentResult` (map `providerMeta → usage`) instead of a bare string — this is what stops openai/grok/gemini from silently failing open.
- **`RunBudget`** (`runBudget.ts`): extend **in place** — `usdSpent` accumulator, `reconcile(driver, usage, model?)` computes USD via the price table, `admit()` gains a usd branch mirroring `tokensMax`, `totals()` gains `usd`/`usdRemaining`/`usdEstimatedPortion`. Reuse the `budget_exceeded` halt category (hint-text update only).
- **`costRouter`** (new pure fn): `resolve(preferred, downshift, remainingUsd, promptText) → {driver, model}`; returns `preferred` unchanged when `downshift` is absent. Wired at **both** agent sites (`:1308` main, `:1031` refine loop) via one shared resolve+reconcile closure (the two-site hazard #859 also had to handle).
- **Schema:** extract a **shared `agentStepProperties` const** before adding any agent-step field — the leaf (`~266–318`) and top-level (`~520–587`) blocks in `schemaGenerator.ts` are duplicated and a field added to only one is rejected inside parallel blocks.

### 5.3 Failure & budget semantics (the honesty rules)

- **Measured (API) drivers:** real `usage` → real USD → `usdMax` enforced; breach halts at the next `admit()` (never retroactively, same as tokens today).
- **Subscription drivers (`subprocess`/`gemini`):** **fail open** with a *loud, per-driver* warning (now actually surfaced via the Phase 0 `completeRun` fix). A `usdMax` here measures **notional list-equivalent** spend, not real money out — docs/hint must say so.
- **`estimateUnmeasured: true` (opt-in):** estimate tokens (~4 chars/token heuristic) → `usage.estimated = true`; estimated spend renders **"≈$X"** and can **only WARN, never halt**.
- **Layering:** a `usdMax` admission denial **halts** (a run-level decision — a cheaper model can't rescue an exhausted cap). `downshift` operates **below** the admit gate, picking a cheaper model for a call admission already passed. So downshift slows the *rate* of spend; it never overrides a breach. *(Whether a denied admission may instead retry a cheaper entry is a deferred stretch flag — see decisions.)*

### 5.4 Invariants honored

Opt-in (absent config ⇒ byte-identical) · composes with judge→refine (router + reconcile wired at the refine site too) · augment-only judges untouched · fail-open preserved (estimation is opt-in, warn-only) · no hot-path network, no secrets, prices are reviewable data.

## 6. Phased rollout (each phase an independently shippable, opt-in PR)

- **Phase 0 — substrate & latent-bug fixes (no new user config).** `servedBy` reconcile fix + additive `AgentResult`; fix `parser.ts` to pass `budget` through; thread `RunBudget.totals()/warnings()` into `completeRun` (~1753) so dead warnings surface; extract shared `agentStepProperties` const; reconcile `model_fallback` doc-drift (alias or delete). *Valuable even if the cost feature is never built.*
- **Phase 1 — driver token fidelity.** Make API drivers report tokens; `makeProviderDriverFn` returns `AgentResult`. **One behavior shift to changelog:** recipes that *already* set `tokensMax` AND use openai/grok/gemini start being measured (they fail open today) and could begin halting — a scoped correctness fix.
- **Phase 2 — static price table asset.** `priceTable.json` + loader + override precedence + CI staleness ratchet. Consumed by nobody yet; lands so prices can be reviewed for accuracy independently.
- **Phase 3 — `budget.usdMax` enforcement (the headline).** Extend `RunBudget` in place; add `usdMax` + `estimateUnmeasured` (default **false**) to schema/validation/parser; reuse `budget_exceeded`; dashboard renders `$`/`≈$`. **This alone closes the deferred-usdMax gap and is a reasonable stopping point if routing is descoped.**
- **Phase 4 — opt-in per-step `downshift` routing.** Add the field + pure `costRouter`, wire at both agent sites, cross-field validation mirroring #859, parser passthrough. **+ write the ADR** (price-table source/refresh, fail-open USD semantics, estimate-warns-never-halts, `estimateUnmeasured=false`, OSS-vs-Pro boundary).

## 7. Decisions for you (recommended answer in **bold**)

1. **Price-table source & refresh:** ship list prices as a checked-in `priceTable.json`, PR-refreshed, with a CI staleness ratchet on `_generatedAt` (fail-loud at build, never a runtime network call). → **Yes; confirm who owns the refresh PR and cadence.**
2. **Default-driver estimation:** `estimateUnmeasured` defaults to **`false`** (preserve fail-open; estimation is opt-in and warn-only). → ✅ **DECIDED (2026-06-03): warn-only.** Never hard-stop work on an estimate.
3. **`downshift` semantics:** author-ordered list (the recipe author asserts each fallback is "good enough"), **no engine capability/tier taxonomy.** → **Recommend author-ordered.**
4. **Breach vs downshift layering:** admission denial **halts**; `downshift` only picks a cheaper model below the admit gate. → **Recommend this layering** (retry-cheaper-on-denial deferred as a stretch flag).
5. **Subscription USD framing:** docs/hint state plainly that `usdMax` on a subscription driver is **notional list-equivalent**, not real money. → **Recommend explicit wording.**
6. **OSS vs Pro boundary:** does a *local, per-recipe* `usdMax` ship in the free OSS core? → ✅ **DECIDED (2026-06-03): ships free in OSS core.** Only cross-recipe / centralized billing is reserved for Pro.
7. **Chained-runner scope:** the chained-runner wrapper (`yamlRunner ~2560`) discards `.usage` and bypasses the budget today. Cover sub-recipe/chained calls in this work, or document as out-of-scope for now? → **Recommend out-of-scope for v1, documented.**

## 8. Test plan (per phase)

- Phase 0: parser round-trip preserves `budget` (regression); `reconcile` receives the served driver; `completeRun` surfaces token warn/unmeasured warnings; schema const-extraction leaves both blocks identical.
- Phase 1: each API driver populates typed `providerMeta` usage; `makeProviderDriverFn` maps to `AgentResult.usage`; tokensMax now enforced for openai/grok/gemini.
- Phase 3: `usdMax` halts a measured run at the right point; subscription run fails open with exactly one warning; `estimateUnmeasured:true` warns but never halts; `usdEstimatedPortion` populated; unknown (driver,model) fails open.
- Phase 4: `downshift` absent ⇒ preferred model unchanged (byte-identical); tight budget picks the first fitting candidate; router fires at both main and refine sites; invalid `downshift` entries rejected by validation.
