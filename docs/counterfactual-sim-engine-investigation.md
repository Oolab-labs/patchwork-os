# Counterfactual Simulation Engine — Final Investigation Report

> Investigation date: 2026-06-04. Produced by a 31-agent workflow (map 7 subsystems →
> 4 design proposals → 3-lens judge panel → adversarial verification of the winner's
> load-bearing assumptions → synthesis). All 6 verified assumptions came back **breaks**.

## 1. Verdict

**Yes — but scoped, phased, and renamed in the UI.** Patchwork should build this. It is the single most defensible "AI-native trust" feature on the roadmap: "see exactly what this recipe would do before you arm it" is the natural capstone of the dry-run plan, trace memory, cost ledger, and approval-gate work the team has already shipped. The architecture genuinely supports it — the FP `Backend`/`TestBackend` seam (`src/fp/interpreterContext.ts`) is a textbook simulation seam, and the chained runner's `dryRun` + `mockedOutputs` paths are a working partial implementation. **However**, the adversarial verification falsifies the winner's load-bearing assumptions, and one of them — "show which approvals WOULD trigger" — is not just incomplete but *actively misleading* if shipped as proposed, because the approval gate (`src/transport.ts:1408`) does not gate recipe-runner tools at all. Build it, but lead with the dimensions that hold (actions, structural side-effects, derived risk over the chained DAG), gate the approval and cost dimensions behind real prerequisite work, and make incompleteness loud in the output schema rather than papered over with a tooltip.

## 2. Why it fits Patchwork

This feature is a *composition layer*, not a new runtime. Almost every primitive it needs already exists as a pure, side-effect-free function:

- **Dry-run plan / static skeleton.** `runRecipeDryPlan` (`src/commands/recipe.ts:1569`) and `generateExecutionPlan` (`src/recipes/chainedRunner.ts:1195`) already produce the full step DAG with parallel groups, dependencies, and per-step `isWrite`/`isConnector`/`risk` via `enrichStepFromRegistry` (`src/commands/recipe.ts:1344`). `RecipeDryRunPlan`/`RecipeDryRunPlanStep` (`src/commands/recipe.ts:1315`/`1279`) are stable wire types a sim result can superset, and `generateDryRunPlanSchema` (`src/recipes/schemaGenerator.ts:59`) already has a stable `$id`.
- **The simulation seam.** The automation DSL's `Backend` interface (`src/fp/interpreterContext.ts:49-62`) routes *all* side effects through one injectable surface, and `TestBackend` (`src/fp/interpreterContext.ts:248-289`) is already a recording mock — a `SimulationBackend` is a renamed, annotated `TestBackend`. On the recipe side, `ExecutionDeps` (`src/recipes/chainedRunner.ts:145-152`) is the chained runner's injection point, and `executeTool` (`src/recipes/toolRegistry.ts:113-138`) is the *single* tool-dispatch choke point, branching on `isWrite`.
- **Mocked replay.** `replayMockedRun`/`buildMockedOutputs` (`src/recipes/replayRun.ts:92`/`58`) already re-run a recipe with captured historical outputs and zero external I/O — the direct ancestor of a sim engine.
- **Cost.** The price table trio is clean and pure: `costUsd`/`priceFor` (`src/recipes/pricing/priceTable.ts:162`/`145`), `RunBudget.quoteUsd` (`src/recipes/runBudget.ts:282`), and `costRouter` (`src/recipes/pricing/costRouter.ts:49`).
- **Risk & approval primitives.** `classifyTool`/`requiresApproval` (`src/riskTier.ts:153`/`162`), `computeRiskSignals` (`src/approvalHttp.ts:636`), `computePersonalSignals` (`src/approvalSignals.ts:200`), and the `ToolMetadata.riskDefault` field already populated on every recipe tool (`src/recipes/toolRegistry.ts:28`).
- **Trace memory & taxonomy.** `RecipeRunLog` (`src/runLog.ts:71`), `categoriseHaltReason`/`summariseHalts` + `HALT_CATEGORY_HINTS` (`src/recipes/haltCategory.ts`), `computePercentiles` (`src/fp/activityAnalytics.ts:51`), and the read APIs `ctxQueryTraces`/`ctxSaveTrace` (`src/tools/ctxQueryTraces.ts:108`, `src/tools/ctxSaveTrace.ts:20`).
- **Dashboard.** `RecipePlanPage` already renders a per-step table with risk badges, write flags, connectors, and token/cost columns (`dashboard/src/app/recipes/[...name]/_plan/page.tsx`); the Decision Replay page (`dashboard/src/app/insights/replay/page.tsx`) is a *working* narrow counterfactual ("what would current policy decide on past approvals"); the mocked-replay confirm modal (`dashboard/src/app/runs/[seq]/page.tsx`) is a working "simulate-before-enable" UX prototype; `DoctorPanel`'s `autoRun` + `?diagnose=1` deep-link pattern (`dashboard/src/app/recipes/[...name]/_components/DoctorPanel.tsx`) is the exact trigger mechanism.

The conceptual framing already lives in the codebase — `decisionReplay.ts` and `shadowRun.ts` (`src/testing/shadowRun.ts`) both think in "what would policy X predict for event Y." The sim engine *composes* this, it does not invent it.

## 3. The honest hard parts

Driven directly by the adversarial verification verdicts. Each graded **holds / partial / breaks** as of today.

### 3a. Side-effect interception completeness — **PARTIAL (holds for chained, breaks for flat)**
The zero-IO short-circuit fires before the write gate **only for chained recipes**: `chainedRunner.ts:319-331` returns `{dryRun:true}` before `deps.executeTool`/`deps.executeAgent`, with `mockedOutputs` as a second intercept (`375-393`). **Flat YAML recipes break the safety guarantee entirely.** `runYamlRecipe` → `executeStep` has *no* `dryRun` flag and *no* `mockedOutputs` map; the only gate before real dispatch is `assertWriteAllowed` (the kill-switch, not a sim gate). `resolveStepDeps` bakes in real `writeFileSync`/`appendFileSync` and inline `spawnSync` as defaults, and flat agent steps call real LLMs. `runRecipeDryPlan` for non-chained recipes routes to `buildSimpleRecipeDryRunSteps` — a *static analyzer* that never touches the runner. **The plan path and execution path are fully disjoint for flat recipes.**
**Mitigation:** Hard-scope Phase-2 mocked execution to **chained recipes only** at v1. For flat recipes, ship Phase-1 *static* projection (never executes anything) and a visible "flat recipe — structural projection only, no sandbox" badge. The full fix (add `dryRun` + `mockedOutputs` to `RunnerDeps`, short-circuit `executeStep`, thread through `dispatchRecipe`) is real refactoring; defer behind a feature flag, never let it leak real I/O silently.

### 3b. Projecting approvals without executing — **BREAKS (the single most dangerous claim)**
The approval gate (`src/transport.ts:1408`) is a live-blocking await on **MCP bridge tool calls** (`gitPush`, `githubCreatePR`). It is **not wired into the recipe runner at all** — grepping `src/recipes/` for `approvalGate`/`classifyTool`/`queue.request` returns zero hits. Worse, `TIER_MAP` in `riskTier.ts` holds flat camelCase bridge names; recipe tool IDs are namespaced (`github.create_pr`, `file.write`, `git.log_since`) and match neither `TIER_MAP` nor the `^`-anchored `inferTierFromName` regexes — **every recipe tool falls through to `medium`.** A user who sees "2 approvals would trigger" and runs the recipe will see **zero** approvals fire. That is the opposite of trust-building.
**Mitigation:** Two paths, pick one per phase. (1) **Honest-scoped projection** — use `ToolMetadata.riskDefault` (already correct per-tool) as the tier source, *not* `classifyTool`, and label the column unambiguously: *"would gate IF the approval gate were applied to recipe steps — it is not today."* (2) **Make it real** — wire an injectable approval predictor into `executeTool` (`deps.approvalPredictor?`) so `riskDefault` actually feeds a gate. Do **not** ship the approval column using `classifyTool` against namespaced IDs — it returns uniform `medium` and is confidently wrong.

### 3c. Non-determinism of LLM/agent steps — **BREAKS for output content (inherent)**
Agent steps call a real LLM; output content cannot be projected. A second simulation produces different outputs, different downstream templates, potentially a different DAG path. Synthetic/median outputs can mislead downstream template propagation. There is no `synthesizeMockedOutputs`; the real mechanism `buildMockedOutputs` requires a *single concrete prior run* and **drops truncated outputs** (>8 KB via `captureForRunlog`, `src/recipes/stepObservation.ts`) to `unmocked[]` — which then *fall through to real execution*. The large, useful payloads (PR bodies, file contents) are exactly the ones dropped.
**Mitigation:** **Never execute agent steps in sim.** Resolve them to a historical-median output (when traces exist) or a clearly-labeled schema stub, each annotated with `confidence` + `sampleN`. Mark every agent output `"sampled from history, not predictive."` Accept that sim of an agent-heavy recipe projects *one plausible run*, not *the* run — and say so in the schema.

### 3d. Cost/risk estimation accuracy — **BREAKS for cost as a data-driven number; PARTIAL for risk**
**Cost:** `RunStepResult` has no token/cost fields; `RunBudget.totals()` (`BudgetTotals`) is computed but **never persisted** — only text `budgetWarnings` reach the run log. `quoteUsd` returns `undefined` for non-billable drivers, and **all shipped templates use `driver: claude-code` → `"subprocess"`**, outside `BILLABLE_DRIVERS = {anthropic, openai, grok}`. So `quoteUsd` returns `undefined` for the recipes users actually run, and there is no historical token corpus to fall back to — every projection is the `chars/4` heuristic the codebase itself calls "deliberately rough." The dashboard's "Min. cost" is already a hardcoded `$3/1M` lower-bound display heuristic.
**Risk:** `aggregateRunRisk` does not exist. Per-step `risk` is `s.risk ?? "low"` with **no propagation** along dependencies. The DAG with dependencies exists only for chained recipes (`generateExecutionPlan`); flat recipes get a flat list with no edges.
**Mitigation (cost):** Persist per-step tokens first (add `inputTokens`/`outputTokens`/`costUsd` to `RunStepResult`, persist `BudgetTotals` on `RecipeRun`) — a hot-path, augment-only schema change and a prerequisite, not a nice-to-have. Until that lands and runs accrue, present cost as `{minUsd, maxUsd, basis: "chars/4 heuristic", confidence: "low"}` and mark subprocess/claude-code steps explicitly **"notional — not billed"** (never `$0`, which reads as "free"). **Mitigation (risk):** Implement `aggregateRunRisk` as topological max-wins propagation over the chained DAG; for flat recipes either model the linear sequence as a chain or document "no blast-radius propagation."

### 3e. False-confidence danger — **THE central UX risk, applies to all of the above**
A polished panel showing "$0.04–$0.12, 80% approve" over `n=0` samples is worse than no panel. The existing dashboard primitives (`RiskMeter`, `EntityTimeline`, the DryRunPlan renderer) have **no low-confidence / ghost rendering mode**. The when-condition evaluator treats `[dry-run:fetch.result]` sentinels as **truthy** (`chainedRunner.ts:265-272`), so a `when: '{{ fetch_emails.count }}'` that should be `0` (false) will evaluate **true** in sim — silently predicting a step runs that the real run skips. "Rejected paths" built on sentinel branch evaluation is built on a broken foundation.
**Mitigation:** Make confidence a first-class, *loud* field in the schema and the UI — `sampleN`, `basis`, and an `undetermined` outcome for any branch whose condition depends on un-projected agent/connector output. Never silently resolve a sentinel-driven `when:` as taken/skipped — emit `"undetermined: depends on <stepId> output not available in simulation."`

## 4. Recommended approach

**Winner: "Patchwork What-If" (the hybrid design).** It won the judge panel (3.33/5) because it is the only proposal that (a) treats the engine as a thin composition over five proven subsystems rather than a new runtime, (b) explicitly phases static-predictive (P1) before mocked-sandbox (P2) before automation-DSL extension (P3), and (c) refuses to execute agent steps — sidestepping the non-determinism trap that sank the SimBackend proposal.

**Why it beat the others:**
- **vs. Static-Analysis-First (3.00):** What-If keeps the static layer as its P0 but adds the trace-seeded `mockedOutputs` sandbox for realistic downstream template propagation — the static-only proposal degrades to "undetermined" on exactly the data-driven branches that matter most, and the judges flagged its sentinel-truthiness branch bug as "the highest-confidence false-confidence risk in the entire design."
- **vs. Full Mocked Sandbox / SimBackend (2.33):** Its agent "no-write jail" is architecturally infeasible without threading sim state into `transport.ts` — agent MCP write calls go through the *bridge* transport gate, a different dispatch path than the recipe runner's `executeTool`. The jail leaks or the feature collapses to trace-mock anyway. What-If sidesteps this by never running agents live.
- **vs. Monte-Carlo "Crystal Ball" (2.33):** Its two headline dimensions (cost, approval likelihood) are *data-starved at launch* — no persisted tokens, ephemeral approval history. Polished probability numbers over `n=0` are the exact hazard. What-If shares the data-starvation problem but doesn't *brand itself* on statistics it can't back.

**Best ideas to graft from the runners-up:**
- From **Crystal Ball**: the historical-median seeding of `mockedOutputs` (vs. one verbatim prior run), the `sampleN`/confidence-band discipline, and `summariseHalts`-derived per-step halt-probability with `HALT_CATEGORY_HINT` display. *Adopt these once token/trace persistence lands.*
- From **Static-Analysis-First**: the stateless `POST /recipes/simulate` body shape (`{vars, policyOverrides, budgetOverride, approvalGate}`) for the instant re-sim loop, and the honest `SideEffect[]` taxonomy (read | local-write | connector-write | external-http).
- From **SimBackend**: `costRouterCandidates()` returning *all* candidates + verdicts (today `costRouter` discards rejected ones) — the cleanest real "alternative paths considered" data source, and the `recipe_step_simulated` activity event so SSE subscribers distinguish sim from real runs.

## 5. Phased implementation plan

Each phase is independently shippable and independently valuable.

### P0 — Honest static projection (chained + flat), no execution. **Effort: M**
The minimal *honest* slice. Pure composition over `runRecipeDryPlan`. Per step: tool/type/resolved-params (already in the plan), structural `SideEffect[]` from `isWrite`/`isConnector` + `detectRequiredConnectors` (`src/recipes/connectorPreflight.ts:157`), per-step risk tier from `ToolMetadata.riskDefault`, and `aggregateRunRisk` (new) over the chained DAG. Cost shown as `chars/4` range explicitly badged "low confidence / heuristic." Approval column shows tier **only**, labeled "not gated on recipe steps today." Stateless `POST /recipes/simulate`.
- *Extend:* `src/commands/recipe.ts` (add `runRecipeSimulate` + `RecipeSimulationReport` superset of `RecipeDryRunPlan`), `src/recipes/schemaGenerator.ts` (new `generateSimulationSchema`, **new `$id`** — never repurpose the dry-run `$id`), `src/recipeRoutes.ts` (add route via `deps.simulateFn`, mirror `runPlanFn`), `src/bridge.ts` (wire deps).
- *New:* `src/recipes/simulation/simulate.ts`, `src/recipes/simulation/aggregateRunRisk.ts`, `src/recipes/simulation/types.ts`, `src/recipes/simulation/__tests__/*.test.ts`.
- *Dashboard:* extend `dashboard/src/app/recipes/[...name]/_plan/page.tsx` renderer, new `SimulatePanel.tsx`, new dedicated proxy `dashboard/src/app/api/bridge/recipes/simulate/route.ts` (the dynamic `[...name]` proxy swallows the body — same lesson as the doctor proxy), Simulate button in the Controls PatchCard.

### P1 — Cost-data persistence (prerequisite for any real cost number). **Effort: M**
Augment-only, round-trip-safe schema change to the hot capture path. Add `inputTokens?`/`outputTokens?`/`costUsd?` to `RunStepResult` (`src/runLog.ts:37`), add `budgetTotals?: BudgetTotals` to `RecipeRun`, persist `RunBudget.totals()` at completion, add a `RunBudget.lastStepUsage()` accessor and capture per-step deltas after each `reconcile()` in `yamlRunner.ts` and `chainedRunner.ts`. **No projection logic yet** — this just builds the corpus future sims project from. Mark subprocess/claude-code as "notional" explicitly. Tests for old-row compatibility.

### P2 — Trace-seeded mocked sandbox (chained recipes only). **Effort: L**
Realistic downstream template propagation. New `synthesizeMockedOutputs(recipeName)` queries `RecipeRunLog` across runs, picks most-recent non-truncated output per stepId, falls back to `seedToolOutputPreviewContext` sentinels. Drives the existing `chainedRunner` `dryRun` + `mockedOutputs` seam. Agent steps resolve to historical-median or labeled stub — **never executed.** `when:` conditions emit `"undetermined"` when they depend on un-projected output (fixes the sentinel-truthiness bug). Add `costRouterCandidates()` for honest rejected-path data. Hard guard: **flat recipes get P0 static projection only**, with a visible badge.
- *Extend:* `src/recipes/replayRun.ts` (multi-run seeding), `src/recipes/pricing/costRouter.ts` (`costRouterCandidates`), `src/recipes/chainedRunner.ts` (sim hook, no behavior change when absent), `src/recipes/toolRegistry.ts` (generalize `seedToolOutputPreviewContext` → `synthesizeOutput`), `src/activityLog.ts` (`recipe_step_simulated` event).
- *New:* `src/recipes/simulation/synthesizeMockedOutputs.ts`, `src/recipes/simulation/branchEnumerator.ts`.

### P3 — Real cost projection from accrued history + confidence UX. **Effort: M**
Once P1 has accrued runs: pre-run estimator walks plan steps, uses historical per-step median tokens when `sampleN ≥ threshold`, else `chars/4`. Returns `{minUsd, maxUsd, basis, confidence, sampleN, unmeasuredSteps}`. Add a low-confidence/ghost rendering mode to the dashboard (the primitives lack one today). Replace the hardcoded `$3/1M` constant in `_plan/page.tsx`.

### P4 — Real approval prediction (optional, requires gate wiring). **Effort: L**
Only if the team decides recipe steps *should* be gated. Wire `deps.approvalPredictor?` into `executeTool`, feed `riskDefault` + `computePersonalSignals` (against recipe-tool ActivityLog history, which must first exist). Until this ships, P0's tier-only labeled column stands.

### P5 — Automation-DSL "what would fire" + sim history/compare. **Effort: L (deferred)**
Apply a `SimulationBackend` (copy of `TestBackend`) to `executeAutomationPolicy` for "what would fire on file save." Add `sim_run` trace type, A/B compare, sim job lifecycle. Explicitly deferred to keep P0–P4 at sane effort.

## 6. Risk score & approval-prediction design (given today's code)

**Risk score — buildable now, derived not oracular.** Implement `aggregateRunRisk(plan)`:
1. Source per-step tier from `ToolMetadata.riskDefault` (already populated and correct), not `classifyTool` (which mis-classifies namespaced IDs to uniform `medium`).
2. For chained recipes, walk `steps[].dependencies` / `parallelGroups` in topological order, max-wins: a step inherits the highest tier among its transitive upstreams. Add an `effectiveRisk` field distinct from the author literal.
3. Map to a 0–100 workflow score weighting count of high-tier steps, unacknowledged writes (reuse the `runPreflight` write-ack check), and connector blast-radius. **Always show the inputs** — a derived score with components, not a black box.
4. For flat recipes, model the linear sequence as a chain (step N depends on N−1) and propagate forward, or document "no propagation."

**Approval prediction — two honest options, never `classifyTool`-on-namespaced-IDs:**
- *Option A (P0, no code-path change):* tier from `riskDefault`; column header reads *"Risk tier — recipe steps are NOT gated by the approval queue today; this is the tier that would apply if they were."* Attach `computeRiskSignals` (content-level, pure) per step. Add `computePersonalSignals` **only** when ActivityLog has matching history, degrade to tier-only on cold start.
- *Option B (P4, real):* wire `riskDefault` → injectable `approvalPredictor` inside `executeTool`, so the gate actually fires and the prediction matches runtime. The live gate (`transport.ts:1408`) cannot be reused — it is a blocking human await, not a predictor.

Non-negotiable: the output schema must carry a `gatedOnRecipeSteps: boolean` field so the UI can never imply a gate that doesn't exist.

## 7. What NOT to do / scope traps

- **Do NOT ship the approval column using `classifyTool` against recipe tool IDs.** It returns uniform `medium` and predicts a gate that never fires. The verification's most damning finding — sim can *actively erode trust*.
- **Do NOT present cost as a precise dollar figure or `$0`.** `quoteUsd` returns `undefined` for the default `claude-code`/subprocess driver; the only data is `chars/4`. Always a labeled range; subprocess steps are "notional," never "free."
- **Do NOT let flat-recipe sim touch the runner.** Flat `executeStep` has no dry-run short-circuit; a Phase-2 attempt invokes real `writeFileSync`/`spawnSync`/LLM calls. Static-only for flat at v1, hard-guarded.
- **Do NOT resolve sentinel-driven `when:` branches as taken/skipped.** Sentinels are truthy; emit `"undetermined"` instead.
- **Do NOT brand it "Monte-Carlo" / statistical** until token persistence (P1) has accrued real data. Polished probabilities over `n=0` are the central UX hazard.
- **Do NOT try to mock every connector for value-level fidelity.** Projecting *which* connector fires (namespace) is cheap and reliable; projecting *what payload* it sends requires per-connector simulators that drift from reality. Stay at the taxonomy level.
- **Do NOT mutate the dry-run plan `$id`.** Superset with a new `$id`/schemaVersion or break pinned consumers.
- **Do NOT build agent no-write jails.** Agent write calls route through the bridge transport gate, not `executeTool`. Resolve agents to history/stub, never run live.
- **Do NOT scope-creep into sim job lifecycle / A/B compare / `sim_run` traces** at v1. Keep `POST /recipes/simulate` stateless; defer to P5.

## 8. Open questions for the team

1. **Should recipe-runner tools actually be gated by the approval queue?** The strategic fork. If yes, P4 becomes a priority and the approval column becomes literally true. If no, the column stays a clearly-labeled "tier-if-applied" projection forever.
2. **Flat-recipe sandbox: refactor or document the limitation?** Acceptable to ship "chained recipes get the sandbox, flat recipes get static projection" at v1, or is flat-recipe parity a hard requirement?
3. **How aggressive on cost-data persistence?** P1 touches the hot capture path (`yamlRunner`/`runLog`). Comfortable adding token/cost fields to `RunStepResult` now (augment-only), or defer cost projection entirely?
4. **Naming.** "Counterfactual Simulation Engine" over-promises given the honest fidelity ceiling. "What-If Preview" / "Pre-flight" / "Dry-Run+" set expectations lower.
5. **Confidence-rendering investment.** The dashboard primitives lack a low-confidence/ghost mode. Build that affordance (the antidote to false confidence), or ship plain numbers with text caveats at v1?
6. **Trace-corpus floor.** What `sampleN` threshold gates "data-driven projection" vs. "heuristic estimate"? (Suggest ≥5 for cost/latency, ≥10 for approval likelihood.)
