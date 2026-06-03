# ADR-0015: Cost-Aware Model Routing

**Status:** Accepted
**Date:** 2026-06-03

## Context

Recipes hand work to LLM drivers, and every call costs money (pay-as-you-go API) or a slice of a flat subscription. Before this work there was no way to **cap** a recipe's spend or to **route** a step to a cheaper model under budget pressure. A token budget (`tokensMax`, PR2b) existed but was silently broken in three ways and didn't measure most drivers. Full design + the multi-agent review that shaped it: [docs/design/cost-aware-routing.md](../design/cost-aware-routing.md).

The hard constraint throughout: the **default driver is a flat-rate subscription that reports no tokens**, so any USD cap that silently no-ops (or worse, *halts*) on it is a trap. Two product decisions framed the design: estimation is **warn-only** (never hard-stop on a guess), and a local per-recipe `usdMax` ships in the **free OSS core**.

## Decision

Five opt-in phases, each byte-identical when unconfigured:

1. **Phase 0 — substrate (#861/#862).** Fix the budget's dropped/guessed data: `parseRecipe` now passes `budget` through; `RunBudget.reconcile` attributes usage to the driver `executeAgent` *actually ran* (`AgentResult.servedBy`, stamped at the single driver-resolution point) instead of a guessed `"auto"`; the previously-discarded `RunBudget.warnings()` are threaded into the run log; the two duplicated agent-step schema blocks are deduped into one shared const.

2. **Phase 1 — driver token fidelity (#863).** API drivers actually report tokens now: `OpenAIApiDriver` requests `stream_options:{include_usage:true}`; `ApiDriver` forwards the `message.usage` it discarded; `makeProviderDriverFn` maps `providerMeta → usage` (pure `providerMetaToUsage`) and propagates the driver-resolved `providerMeta.model` via `servedBy`. Subscription/subprocess drivers report nothing and **fail open**.

3. **Phase 2 — price table (#864).** A `(model id → USD-per-million-tokens)` table as **data**: a built-in TS const (compiled into `dist`, so always available) overridable by `~/.patchwork/prices.json` and `PATCHWORK_PRICE_TABLE`. `costUsd` / `priceFor` fail open on an unknown model. **No runtime network calls.** `priceFor` uses `Object.hasOwn` (a model named `__proto__`/`constructor` must resolve to *unpriced*, not a prototype member → `NaN`).

4. **Phase 3 — `usdMax` enforcement (#865).** `RunBudget` gains a USD accumulator; `admit()` denies at `usd >= usdMax` (reusing the existing `budget_exceeded` halt category); `totals()` reports `usd`/`usdRemaining`. USD is enforced **only for genuinely-billed drivers** — `BILLABLE_DRIVERS = {anthropic, openai, grok}`. `local` (self-hosted, $0) and subscription drivers are **never** priced, so a run can never halt on notional money it didn't spend. The price table loads once, only when `usdMax` is set.

5. **Phase 4 — `downshift` routing (this ADR).** Per-step `agent.downshift: [{driver?, model?}]` — an author-ordered list of cheaper fallbacks. Before each agent dispatch, a **pure `costRouter`** ([src/recipes/pricing/costRouter.ts](../../src/recipes/pricing/costRouter.ts)) picks the most-preferred candidate whose estimated cost fits the remaining USD budget; a downshift entry inherits the preferred driver/model for any field it omits; an unpriced/free candidate (e.g. a local model) is always affordable. Wired at **both** agent dispatch sites — the main path and the judge→refine revise call — via the shared `resolveRouting` helper. Absent `downshift` (or no `usdMax`) ⇒ the preferred model is used unchanged.

## Key design points

- **Routing operates below the brake.** `admit()` still halts a breached run; `downshift` only chooses a cheaper model for a call that admission already passed. It slows the *rate* of spend; it never overrides a breach, and never "rescues" an already-exhausted cap.
- **Author asserts capability, engine checks affordability.** `downshift` is an ordered list the recipe author vouches for — the engine does not model whether the cheaper model is "good enough", only whether it fits. This is deliberate: a capability/tier taxonomy was rejected as premature surface area (see the design doc's killed approaches).
- **Pre-dispatch estimate is intentionally rough.** Cost can't be known before the call runs, so `resolveRouting` estimates `inputTokens ≈ promptChars/4` and `outputTokens ≈ inputTokens` (1:1). This only picks the gear; the real cost is reconciled after the call, and the next `admit()` enforces the cap precisely. A wrong estimate can pick a sub-optimal model but cannot overspend the cap.
- **Fail-open is the safe direction everywhere.** Unmeasured driver, unpriced model, non-billable driver, prototype-key model id, malformed price override — every one resolves to "not enforced, one-time warning", never a wrong halt.
- **Quote parity with reconcile.** `RunBudget.quoteUsd` (the router's affordability oracle) resolves the driver/model exactly as `executeAgent`/`reconcile` do — `api`/`claude` → the billable `anthropic` path, and an omitted model on that path → `DEFAULT_MODEL` — so a candidate the router calls "free" is precisely one `reconcile` would not charge. Two documented residuals, both fail-toward-preferred (never a wrong halt): an **omitted model on `openai`/`grok`** is quoted unpriced (the provider's internal default is unknowable pre-dispatch — specify the model for downshift to engage there), and an **undefined driver** is optimistically quoted as the metered anthropic path (if auto-detect lands on a subscription driver the call is simply free).

## Alternatives considered

- **Declarative cost tiers (`tier:`/`routing:` + inline `pricing:`).** Rejected: ~400 LOC of tier-dictionary that duplicates what per-step `driver`+`model` already expresses, and an inline `pricing:` field is a budget-evasion footgun (a recipe could under-price a model to dodge `usdMax`). The leaner per-step `downshift` + out-of-band price overrides get the value without the surface.
- **Estimate-and-halt for subscription drivers (`estimateUnmeasured: true` default).** Rejected as the default: it would hard-halt the token-blind subscription driver on a ~4-chars/token guess of notional spend — inverting fail-open. Deferred entirely; if it lands later it must default `false` and can only *warn*.
- **A wall-clock CI staleness gate on the price table.** Rejected: a time-based hard-fail eventually breaks an unrelated PR. Shipped instead as a pure `isPriceTableStale` helper + a structural test, ready for a scheduled (non-PR) check.

## Consequences

- Recipes get enforceable per-recipe USD caps for measured API drivers, an honest fail-open-with-warning story for subscription/local drivers, and opt-in cheaper-model downshift — all in the free core.
- The price table is **list-price data that drifts**; it is reviewable, dated, and overridable, and a USD cap on a subscription driver is explicitly *notional, not real money out* (documented in the hint text).
- `model_fallback` (a field that only ever existed in `examples/recipes/advanced-patterns/` docs) is reconciled to point at `downshift`.
