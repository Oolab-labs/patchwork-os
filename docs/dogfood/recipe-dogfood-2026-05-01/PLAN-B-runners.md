# PLAN-B — Cross-runner contract drift remediation

**Scope**: bugs whose root cause is the divergent contracts of the four execution paths in alpha.35 — `yamlRunner`, `chainedRunner`, `RecipeOrchestrator`, and the JSON-prompt path through `loadRecipePrompt` + `runClaudeTask`.

**Bugs closed by this plan** (no others):

| # | Where it surfaces | Source pin |
|---|---|---|
| #1 / F-07 | chained `hasWriteSteps:false` on writes | `src/recipes/chainedRunner.ts:1028-1040`; `src/commands/recipe.ts:806`, `:824-837` |
| #2 / F3 | `detectSilentFail` not wired into chained or orchestrator | `src/recipes/chainedRunner.ts:10`, `:454-467`; `src/recipes/RecipeOrchestrator.ts:60-98` |
| #9 / F5 | VD-2 capture chained-only | `src/recipes/yamlRunner.ts:668-674` (4-field) vs `src/recipes/chainedRunner.ts:914-945` |
| JSON-prompt drift | `loadRecipePrompt` skips lint/schema/`recordRecipeRun` | `src/recipesHttp.ts:995-1047`; `src/recipeOrchestration.ts:344-365`, `:460` |
| `daily-status` two-layer disagreement | HTTP YAML-first, run JSON-first | `src/recipesHttp.ts:458-490` (`loadRecipeContent`) vs `src/recipeOrchestration.ts:344` |
| #11 (chained side) | silent agent skip on missing key | `src/recipes/yamlRunner.ts:469-484` (fixed) vs `src/recipes/chainedRunner.ts:438-453` (unfixed) |
| `registrySnapshot` bloat | 25 KB × N steps | `src/recipes/chainedRunner.ts:836-855`, `:914-945`; `src/recipes/captureForRunlog.ts:117-129` |

---

## 1. Diagnosis

Three runners exist for one logical operation (run a recipe end-to-end and persist a `RecipeRun`). They drifted because they were grown independently in time:

- `yamlRunner.runYamlRecipe` (`src/recipes/yamlRunner.ts:450-758`) is the original linear runner. It owns the silent-fail detection (lines `469-471`, `565-573`), the `{ok:false,error}` JSON short-circuit (`549-557`), the `outputs[]` write-tracking that's then surfaced to approval gating, and the Slack-notify-on-fail path (`712-747`). It does NOT capture VD-2 fields in its `finalStepResults` (`668-674`).
- `chainedRunner.runChainedRecipe` (`src/recipes/chainedRunner.ts:589-988`) was added for parallel/DAG execution. It owns VD-2 capture (`836-855`, `914-945`), the parallel-expansion sugar (`expandParallelSteps`, `532-586`), the dependency graph + `mockedOutputs` replay path (`331-349`), and recipe-level `on_error.fallback` semantics (`805-817`). It does NOT call `detectSilentFail`, has no JSON `{ok:false}` short-circuit, and its `generateExecutionPlan` (`991-1040`) emits a step shape MISSING the `tool` field — which makes downstream `enrichStepFromRegistry` (`src/commands/recipe.ts:806`) bail and `summarizePlanSteps` (`824-837`) report `hasWriteSteps:false` for every chained recipe.
- `RecipeOrchestrator` (`src/recipes/RecipeOrchestrator.ts:43-98`) is a thin wrapper — it owns inflight dedup and delegates to `dispatchRecipe`. Because everything flows through `dispatchFn`, it has zero post-step pipeline of its own. Whatever the inner runner does or fails to do, the orchestrator inherits.
- The JSON-prompt path (`loadRecipePrompt` at `src/recipesHttp.ts:995-1047`, called from `runRecipeFn` at `src/recipeOrchestration.ts:344-365`) is a **fourth** pseudo-runner. It builds a flat string prompt and enqueues it as a `runClaudeTask` task. It bypasses lint, schema, `recordRecipeRun` (the success branch at `:358` returns immediately, never hitting the `recordRecipeRun()` call site at `:460`), AND it has no per-step concept at all — so VD-2, silent-fail, and write-detection are all structurally inapplicable.

Why drift happened: VD-2 (PR #65) was scoped "chained only" because chained was the new path. PR #72 wired `detectSilentFail` into yamlRunner because the offending recipe (`morning-brief`) is YAML-driven. Plan generator parity was assumed but never verified — the chained code emits `(s) => ({ id, type, dependencies, condition, risk, optional })` while the YAML simple-plan code (`buildSimpleRecipeDryRunSteps`, called in the non-chained branch of `runRecipeDryPlan`) DOES include `tool`. Each runner solves the local problem with no shared post-step seam.

**End state — pick one runner with a strategy interface, OR three runners sharing one post-step pipeline?**

**Recommendation: one shared post-step pipeline, NOT one runner.** Reasoning:

1. The two real runners have genuinely different inner mechanics — yamlRunner is sequential with imperative `outputs[]` tracking, chainedRunner is a dependency-graph executor with `OutputRegistry` + parallel slots + nested-recipe recursion + mockedOutputs. Folding both into one strategy interface forces every behavior into the union of all surfaces (parallel sequential steps, sequential depgraph, etc.) — a refactor of that scale is high-risk per the Bug Fix Protocol's blast-radius warning.
2. The drift bugs are ALL post-step (or pre-persist): silent-fail check, VD-2 capture, write-detection from registry. None of them touch the inner execution mechanics.
3. The fourth runner (JSON-prompt) is genuinely different — it has no steps. The right fix is to ELIMINATE it (#5d below) by routing JSON-prompt recipes through yamlRunner with a single synthetic agent step. After that, three runners → two runners → one shared pipeline.

So: keep yamlRunner and chainedRunner as separate engines; extract a **`stepObservation`** module that both call after each step; eliminate the JSON-prompt runner by lowering `kind:prompt` JSON to a synthetic YAML recipe at load time.

---

## 2. Target architecture

```
                            ┌─ dispatchRecipe (yamlRunner.ts:1349) ──┐
HTTP /recipes/run ───┐      │   trigger.type === "chained"?          │
CLI recipe run ──────┼──► RecipeOrchestrator.fire                    │
scheduler ───────────┘      │      yes ──► chainedRunner             │
                            │      no  ──► yamlRunner                │
                            └────────────────────────────────────────┘
                                          │
                                  per-step boundary
                                          │
                                          ▼
            ┌──────────────────  src/recipes/stepObservation.ts  ─────────────────┐
            │  observeStep({ rawResult, resolvedParams, stepDef, registry, … })   │
            │    1. detectSilentFail   (runs FIRST so JSON {ok:false} stays fatal)│
            │    2. JSON {ok:false,error} short-circuit                           │
            │    3. captureForRunlog(resolvedParams / output / Δsnapshot)         │
            │    4. classifyStep      (tool? agent? recipe? isWrite?)             │
            │  returns { status, error?, capture, isWrite }                       │
            └──────────────────────────────────────────────────────────────────────┘
                                          │
                                          ▼
                     RunStepResult (uniform shape — both runners)
                                          │
                                          ▼
                     RecipeRunLog.completeRun / appendDirect

JSON-prompt recipes (kind:prompt):
   loadRecipePrompt → DELETED. recipeOrchestration.runRecipeFn detects
   kind:prompt at load time, lowers to a synthetic YAML recipe with one
   agent step (prompt = same body), feeds through yamlRunner. Lint, schema,
   recordRecipeRun, VD-2, silent-fail all apply for free.

generateExecutionPlan (chained dry-run):
   emits `tool: s.tool` when present so summarizePlanSteps' write-detection
   works. plan-step shape is unified between simple-plan and chained-plan
   builders.

registrySnapshot:
   captured ONCE at run level (RecipeRun.registrySnapshotFinal) instead
   of N times per step. Per-step capture stores only Δkeys (the keys
   newly written by THIS step) — typically a single entry.
```

The unifying guarantee: any step running through either real runner produces a `RunStepResult` of the same shape, with the same status semantics, with the same VD-2 fields available, with the same silent-fail enforcement, with the same write-detection signal. `replayRun` (`src/recipes/replayRun.ts:58-84`) already only reads `step.output` and `step.status`, so it works against either runner once both produce VD-2.

---

## 3. Sequencing — four PRs, single conceptual change

The constraint says bias toward fewer larger PRs because the contract is one architectural concept. The split below is the minimum that lets each PR ship independently with green tests, **not** four separate features.

| Order | PR title | Bugs closed |
|---|---|---|
| B1 | `feat(recipes): unify post-step pipeline across yaml + chained runners` | #2, #9, #11 (chained), #1 (write-detection half), bloat (snapshot dedup) |
| B2 | `fix(recipes): chained dry-run plan emits tool field for write-detection` | #1 remaining half (plan-builder side) |
| B3 | `refactor(recipes): lower kind:prompt JSON recipes through yamlRunner` | JSON-prompt drift; resolves `daily-status` shadow as a side effect |
| B4 | `fix(recipes): canonical recipe resolver — single source of truth for daily-status` | `daily-status` two-layer disagreement (final fix even if B3 already removed JSON dispatch) |

B1 is the load-bearing PR. B2 is small but separable (pure plan-builder). B3 is the architectural simplification — it could be deferred but folds in cleanly because once the post-step pipeline exists, JSON-prompt is the only outlier. B4 cleans the resolver layer that B3 leaves behind.

---

## 4. Per-PR detail

### PR B1 — Unify post-step pipeline across yaml + chained runners

**Bugs closed**: #2 (silent-fail in chained + orchestrator), #9 (VD-2 in yaml), #11 chained-half, registrySnapshot bloat. Half of #1 (the runtime side — chained writes get tagged `isWrite`).

**Files touched**:
- NEW `src/recipes/stepObservation.ts` — exports `observeStep`. Inputs: `{ rawResult, resolvedParams, stepDef: {tool?, agent?, recipe?, optional?, silentFailDetection?}, registryDelta, prevRegistryKeys }`. Output: `{ status: "ok"|"skipped"|"error", error?, capture: {resolvedParams, output, registryDelta, startedAt}, classification: {kind, isWrite, isConnector, namespace} }`. Pulls in `detectSilentFail`, JSON `{ok:false}` short-circuit, `captureForRunlog`, and `getTool` lookup for write/connector classification.
- `src/recipes/yamlRunner.ts:540-674` — replace inline silent-fail/JSON-error logic with `observeStep` call; populate VD-2 fields in `finalStepResults` (currently bare 5 fields at `:668-674`). Also replace agent-step inline detector at `:469-484`.
- `src/recipes/chainedRunner.ts:438-471` — wrap `executeAgent`/`executeTool` returns through `observeStep`; replace the unconditional `{success: true}` returns. Replace per-step full-snapshot capture at `:836-855` with a delta capture (registry delta = keys whose value changed since the step started).
- `src/recipes/captureForRunlog.ts` — add `captureRegistryDelta(prevSnapshot, currentSnapshot)` so the per-step capture stores only newly written keys.
- `src/runLog.ts:34-53` — add optional `registryFinalSnapshot?: Record<string, unknown>` on `RecipeRun` (run-level, not step-level). Per-step `registrySnapshot` becomes `registryDelta` semantically; field name kept for backwards compat with dashboard consumers — see §7.
- `src/recipes/__tests__/` — new `stepObservation.test.ts` (silent-fail, JSON-err, capture, classification matrix), `yamlRunner-vd2.test.ts` (yamlRunner emits resolvedParams/output/registryDelta/startedAt now), `chainedRunner-silentfail.test.ts` (chained branch-health-style step with `(git branches unavailable)` flips status to `error`).

**Approach**:
1. Extract pure `observeStep` first; cover with unit tests; verify it can run identically against shapes from both runners.
2. Wire into yamlRunner. Result-shape change is additive (extra fields on `RunStepResult`); existing tests stay green.
3. Wire into chainedRunner. Replace the `success: true` shortcut at `chainedRunner.ts:453, :464`; downstream `effectiveSuccess` (`:809`) consumes the unified status.
4. Convert `registrySnapshot` to `registryDelta`. Old field name preserved in the JSON for dashboard compat (see §7), but value is the delta. Run-level `registryFinalSnapshot` carries the once-per-run full registry.

**Regression tests** (Bug Fix Protocol — fail first):
- T1: chained `branch-health`-clone with `executeTool` mock that returns `(git branches unavailable)`. Pre-fix: step status `ok`. Post-fix: step status `error`, `errorMessage` includes `silent-fail detected`.
- T2: yaml `morning-brief`-clone, fire under `runYamlRecipe`, assert `stepResults[i].output !== undefined`, `stepResults[i].resolvedParams !== undefined`, `stepResults[i].startedAt > 0`.
- T3: chained 4-step recipe (write-step at end), assert `RecipeRun.registryFinalSnapshot` size ≈ 25 KB ONCE; sum of `stepResults[i].registrySnapshot` (delta) bytes < 5 KB.
- T4: yaml step where tool returns `{ok:false, error:"x"}` — observation MUST classify as `error` (existing yamlRunner behavior preserved).
- T5: chained agent step where `executeAgent` returns `[agent step skipped: …]` — observation flips to `error`. Closes #11 chained-side.

**Blast radius**:
- Direct callers of `RecipeRun.stepResults[i]` — dashboard `app/runs/[seq]/page.tsx`, `replayRun.ts:58-84`, `dashboardRegistryDiff.test.ts:152`. Diff hover reads `registrySnapshot`; with delta semantics the hover shows ONLY newly-written keys per step, which is arguably what users want anyway. Backfill the full prior-step view by reading `runs[i-1].registrySnapshot` ⊕ … ⊕ `runs[0]` if needed. See §7 for full compat plan.
- `replayRun.buildMockedOutputs` (`src/recipes/replayRun.ts:58-84`) reads `step.output` only — unchanged.
- `ctxQueryTraces` reads decision-trace shape, not run-detail shape — unchanged.
- `getDiagnostics`-via-recipe consumers — unchanged.

**Known not-in-scope**: yamlRunner's `outputs[]` write tracking (`yamlRunner.ts:641-643`) is independent of step classification; we don't touch it here. `runRecipeDryPlan`'s yamlRunner branch already produces `tool` field — not part of this PR.

---

### PR B2 — Chained dry-run plan emits `tool` field

**Bugs closed**: remaining half of #1 (`hasWriteSteps:false` on chained recipes with writes).

**Files touched**:
- `src/recipes/chainedRunner.ts:991-1040` — `generateExecutionPlan` step output. Add `...(typeof s.tool === "string" ? { tool: s.tool } : {})` and `...(typeof s.into === "string" ? { into: s.into } : {})` to the step shape. Update the function's return-type signature.
- `src/commands/recipe.ts:874-883` — the `chainedRunner.generateExecutionPlan` consumer at `:880-882` already does the unsafe-cast read for `tool`/`into`; once the plan emits them, the cast becomes safe. Tighten the type instead of leaving `as unknown`.
- `src/recipes/__tests__/chainedRunner-plan.test.ts` — new file. Build a chained recipe with a `file.write` step, call `generateExecutionPlan`, assert `step.tool === "file.write"`.
- `src/__tests__/recipe-dry-run.test.ts` (extension to existing) — assert `summarizePlanSteps` returns `hasWriteSteps:true` for chained branch-health-style recipe.

**Regression tests**:
- T6 (fail first): chained recipe with `file.write` step → `runRecipeDryPlan` returns `hasWriteSteps:true`. Bug #1 reproducer.
- T7: chained recipe with no writes → `hasWriteSteps:false`. Negative case.

**Blast radius**: tiny. `RecipeDryRunPlanStep` type already has optional `tool`/`into`. The dashboard's plan view will start showing tool names where it previously showed blanks for chained recipes — improvement, not breakage.

---

### PR B3 — Lower `kind:prompt` JSON recipes through yamlRunner

**Bugs closed**: JSON-prompt drift (lint/schema/`recordRecipeRun` bypass), `daily-status` shadow root cause (third runner eliminated).

**Approach**: at load time, when the resolver finds a `kind:prompt` JSON recipe, synthesize a `YamlRecipe` like:

```
{
  name: parsed.name,
  description: parsed.description,
  trigger: { type: "manual" },
  steps: [{
    agent: { prompt: <flatten same prompt loadRecipePrompt currently builds> },
    into: "agent_output"
  }]
}
```

and dispatch through `runYamlRecipe`. The synthetic recipe automatically gets:
- lint (validation.ts) — currently the JSON path bypasses it (Round 1 D F7).
- schema validation — same.
- `recordRecipeRun` — called from `recipeOrchestration.ts:460` in the YAML branch. Round 2 H bug 6 closed.
- VD-2 capture (post-B1).
- silent-fail detection on the agent step (PR #72 behavior, post-B1 also for chained).

**Files touched**:
- DELETE `loadRecipePrompt` from `src/recipesHttp.ts:995-1047`. Replace with `loadJsonPromptAsYamlRecipe(recipesDir, name): YamlRecipe | null` (same file, same input, returns `YamlRecipe`).
- `src/recipeOrchestration.ts:344-365` — replace the `loadRecipePrompt` branch with a call to `loadJsonPromptAsYamlRecipe`; if it returns a recipe, dispatch through the existing yamlRunner path at `:381-388` (`fireYamlRecipe`). Single dispatch path. The "JSON first" precedence at `:344` becomes irrelevant — see B4.
- `src/recipesHttp.ts` — `loadRecipeContent` (`:458-490`) needs to know it can return a synthesized YAML for kind:prompt JSON if the dashboard ever asks. Out of scope here unless tests demand; for now, leave kind:prompt JSON's GET response as the raw JSON file content.
- TESTS: `src/__tests__/jsonPromptLowering.test.ts` — load `daily-status.json`, assert returned `YamlRecipe` shape, dispatch end-to-end, assert `recordRecipeRun` called once, assert run appears in `RecipeRunLog` with `stepResults` populated.

**Regression tests**:
- T8 (fail first): `daily-status.json` fired via `runRecipeFn` → `recordRecipeRun` is invoked. Round 2 H Bug 6 reproducer.
- T9: `kind:prompt` JSON gets linted; introduce a malformed JSON test recipe with no `name` and assert lint surfaces it.
- T10: `greet.json` end-to-end — the `runClaudeTask` orchestrator still receives a single agent invocation (not a multi-step plan); output identical to current behavior.

**Blast radius**:
- The orchestrator subprocess invocation goes via the agent step's `claudeCodeFn` rather than `orchestrator.enqueue`. Same orchestrator instance under the hood (`fireYamlRecipe` builds `claudeCodeFn` on `orch.runAndWait` at `:414-421`). Behavior compatible — the `runAndWait` path waits and returns `task.output` whereas the old `enqueue` returned a `taskId` and the API caller polled. Since the API contract returns `{ ok: true, taskId }` (`:358`), we keep that response shape by wiring synth-recipe dispatch to also produce a taskId. yamlRunner's logging path already emits a `taskId: yaml:${recipe.name}:${recipeStartedAt}` (`:692`) — surface that.
- Removes the third runtime entirely; from this PR onward there are exactly two ways a recipe can run.

**Tradeoff**: the JSON-prompt path's "fire and forget the prompt to a Claude Code subprocess" semantics is preserved (it's still a single agent step). What's lost: the original was `enqueue` (returns immediately, task runs in background); the new path is `runAndWait` inside `claudeCodeFn` (yamlRunner blocks until the agent returns). For long prompts this changes the response-time profile of `POST /recipes/:name/run` for kind:prompt recipes. **Recommendation**: keep the response-shape contract (`{ ok: true, taskId }`) by having `fireYamlRecipe` enqueue-and-detach via the existing `dispatch(...).finally(...)` pattern in `RecipeOrchestrator.fire` (`src/recipes/RecipeOrchestrator.ts:84-87`) — yamlRunner already runs as a fire-and-detach when called through orchestrator. Confirmed safe.

---

### PR B4 — Canonical recipe resolver

**Bugs closed**: `daily-status` two-layer disagreement (final fix). Even after B3 eliminates the JSON dispatch path, the underlying resolver layer still has YAML-first vs JSON-first inconsistency between `loadRecipeContent` (YAML first, `recipesHttp.ts:465-475`) and any future code that wants to find a recipe.

**Files touched**:
- NEW `src/recipes/resolveRecipe.ts` — exports `resolveRecipe(recipesDir, name): { kind: "yaml"|"json-prompt", path, parsed } | null`. Single function. Precedence rule: **YAML wins** if both exist, with a warning logged on collision (`Recipe name "${name}" has both .yaml and .json variants; using .yaml`). Documents the rule once and binds every call site.
- `src/recipesHttp.ts:458-490` — `loadRecipeContent` calls `resolveRecipe`.
- `src/recipeOrchestration.ts:344-388` — same.
- DELETE the duplicated name-resolution helpers (`findYamlRecipePath`, `resolveJsonRecipePathByName`) — they become private to `resolveRecipe.ts`.
- `src/__tests__/resolveRecipe.test.ts` — collision case, YAML-only, JSON-only, neither.

**Regression tests**:
- T11: install both `daily-status.yaml` AND `daily-status.json` in a temp recipesDir. `resolveRecipe(dir, "daily-status").kind === "yaml"`. `loadRecipeContent` returns YAML. `runRecipeFn` dispatches the YAML. Single source of truth.
- T12: log warning emitted exactly once on collision (use a `logger.warn` spy).

**Blast radius**:
- Inverts current run-precedence — YAML wins. This is correct per Round 1 A's recommendation ("reverse the precedence so YAML (the actively maintained format) wins"). One user-visible behavior change: anyone with both `daily-status.yaml` and `daily-status.json` who was relying on the JSON variant firing now gets the YAML variant. We log a clear collision warning so the user can rename one.
- All downstream resolution surfaces (lint, content GET, run, delete, dry-run plan) now use the same rule. No more two-layer disagreement.

**Tradeoff**: a "rename one" warning vs hard error on collision. Recommendation: warning only. Hard error blocks legitimate users mid-flight; warning gives them a session to clean up.

---

## 5. Specific design decisions

### 5a. Where the shared post-step pipeline lives

NEW module `src/recipes/stepObservation.ts`. Reasons:

- `captureForRunlog.ts` is too narrow a name to host classification + silent-fail logic.
- `detectSilentFail.ts` is a pure detector — should stay pure, called BY observeStep, not absorbed into it.
- Putting it inside either runner reintroduces the drift problem we're solving.
- A new module forces test coverage of the seam (`stepObservation.test.ts`) instead of letting per-runner tests imply coverage by accident.

Public surface (single export):

```
observeStep({
  rawResult: unknown,
  thrownError: unknown | undefined,
  resolvedParams: unknown,
  stepDef: { id: string, tool?: string, agent?: AgentCfg, recipe?: string, optional?: boolean, silentFailDetection?: boolean },
  prevRegistry: ReadonlyMap<string, unknown>,  // before this step
  currentRegistry: ReadonlyMap<string, unknown>, // after this step
  startedAt: number,
}): {
  status: "ok" | "skipped" | "error",
  error?: string,
  capture: {
    resolvedParams?: unknown,
    output?: unknown,
    registryDelta?: Record<string, unknown>,
    startedAt: number,
  },
  classification: {
    kind: "tool" | "agent" | "recipe" | "noop",
    namespace?: string,
    isWrite: boolean,
    isConnector: boolean,
  },
}
```

Both runners call this exactly once per step, after their inner execution. The inner-run mechanics (sequential vs parallel, registry vs flat ctx) stay in their respective files; only the seam crosses the module boundary.

### 5b. `daily-status` shadowing — single canonical resolver

See PR B4. Rule: **YAML wins**, JSON falls back, collision logs a warning. Implemented in `resolveRecipe.ts` and used by every call site (lint, content GET, run, delete, dry-run plan, install, replay).

Existing call sites that get migrated:
- `src/recipesHttp.ts:465-475` (`loadRecipeContent`)
- `src/recipeOrchestration.ts:344-368` (`runRecipeFn`)
- `src/recipes/scheduler.ts` (recipe enumeration — not currently broken but uses its own enumeration; should align)
- CLI `src/commands/recipe.ts` (multiple call sites)

Tradeoff considered and rejected: introducing per-extension URL routing (`/recipes/daily-status.yaml/run`). Rejected because (a) breaks the existing API contract; (b) doesn't fix the underlying ambiguity for CLI/scheduler.

### 5c. registrySnapshot — diff vs cap?

**Diffing wins.** Cap-only would still mean a 25 KB run-level snapshot at every step; truncation just blunts the symptom. Delta semantics give:
- Per-step storage scaled to actual writes (typically 1-2 keys per step → bytes, not KB).
- One run-level snapshot (`RecipeRun.registryFinalSnapshot`) for replay/dashboard.
- Same dashboard-visible info (any prior step's full registry can be reconstructed by replaying deltas; the dashboard already iterates step results in order to render the diff hover, so the inverse-delta walk is one extra reduce).

The cap stays in place as a safety net (`captureForRunlog.ts:117-129`) — both for runaway deltas and for the final snapshot.

Storage win, conservatively: branch-health 4-step run goes from ~25 KB × 4 = ~100 KB of redundant snapshot down to ~25 KB final + ~1 KB total deltas = ~26 KB. Round 2 H reported 45 KB total run size dropping to ~20 KB. Per-recipe-run storage halves.

### 5d. JSON-prompt as a thin wrapper over yamlRunner — eliminate the third runner?

**YES — recommended.** PR B3 above. The `loadRecipePrompt` text-builder becomes a `loadJsonPromptAsYamlRecipe` that returns a YamlRecipe with one synthetic agent step. Once that lands:

- Three runners → two runners (yamlRunner, chainedRunner). RecipeOrchestrator still wraps them.
- Lint, schema, `recordRecipeRun`, VD-2, silent-fail all apply to JSON-prompt recipes for free.
- `daily-status.json` no longer "intentionally checked first" because there's only one dispatch path.
- The 206-schema-errors-vs-1-lint-error gap from Round 1 D F7 closes — the synthetic recipe satisfies the YAML schema, so no schema errors at all (the JSON file itself can still fail a `kind:prompt`-specific schema if we want a JSON-side validator; recommend doing that as a separate future PR if the user keeps `kind:prompt` as a public format).

Tradeoff: the synthetic recipe's single agent step is `kind: agent`, not `kind: prompt`. The `kind:prompt` shape becomes a load-time concept only — it never reaches the runner. Recipe authors can still write `kind:prompt` JSON; it just means "lower me to a one-step YAML at load time" implicitly. Document this in `documents/data-reference.md` and `documents/styleguide.md`.

---

## 6. Cross-bundle dependencies

| PR | Depends on |
|---|---|
| B1 | none |
| B2 | none (independent of B1; can ship in either order) |
| B3 | **B1** must land first — synthesizing a YAML-style agent step into yamlRunner only gives the JSON-prompt path silent-fail and VD-2 if B1 has already wired those into yamlRunner. Without B1 the JSON-prompt path gains lint/schema/recordRecipeRun (still useful) but not VD-2. Sequencing B1 → B3 closes both at once. |
| B4 | **B3** ideally before B4 — once the JSON dispatch path is gone, B4 cleans the resolver layer that B3 leaves behind. B4 shippable without B3 but the test scenarios are simpler post-B3. |

PLAN-A-security: independent. Connector try/catch wrapping (Round 2 F F2) doesn't intersect — those bugs are inside per-tool files, not the runner. The 7 unwrapped connector files (notion/confluence/zendesk/intercom/hubspot/datadog/stripe) need the same `tryWithConnectorEnvelope()` helper PLAN-A would deliver, but PLAN-B doesn't block on it.

PLAN-C-schema-cli: independent. The `tool/agent/recipe/chain` step-shape lint rule (Round 1 D F7) is orthogonal to the runner pipeline. Recipe lint upgrades sit one layer up.

**Cross-cutting note**: the `ctxSaveTrace` integration described in CLAUDE.md (decision traces for fixed bugs) should record one trace per bug-bundle PR — `ctxSaveTrace("PR-B1", "Cross-runner contract drift: VD-2 + silent-fail + bloat", "Extracted shared stepObservation pipeline at src/recipes/stepObservation.ts; both runners now produce uniform RunStepResult shape", ["recipes","runners","contract"])`.

---

## 7. Backwards compatibility

Run-record consumers that read the `RecipeRun` shape (`src/runLog.ts:55-89`):

| Consumer | What it reads | Impact |
|---|---|---|
| Dashboard `/runs/[seq]` page | `stepResults[i].{id, tool, status, error, durationMs, output, resolvedParams, registrySnapshot, startedAt}` | After B1: yamlRunner runs gain `output/resolvedParams/startedAt/registrySnapshot` (was missing). Existing chained runs' `registrySnapshot` becomes a delta instead of full — dashboard's diff hover continues to work because the diff is **what it was already trying to show**. We add a top-level `RecipeRun.registryFinalSnapshot` for callers that want the full state. |
| Dashboard `/runs` list | `stepResults.length`, `status`, `outputTail` | Unchanged. |
| `replayRun` (`src/recipes/replayRun.ts:58-84`) | `step.output`, `step.status`, the truncation envelope marker | Unchanged. After B1, yamlRunner runs become replayable too (currently rejected with `replay_only_supported_for_chained_recipes`); explicitly OUT OF SCOPE for this plan but a free incidental improvement worth noting. |
| `ctxQueryTraces` | own decision-trace store, not run records | Unchanged. |
| `runs.jsonl` on disk (1 MB rotation, `src/runLog.ts:101-103`) | append-only persistence | Older rows pre-dating B1 round-trip unchanged — every new field on `RunStepResult` is optional (`src/runLog.ts:42-52`). Schema is additive. |
| `dashboardRegistryDiff.test.ts:152` | per-step delta semantics | Already tests the diff; B1 makes the value match the test's intent. |
| HTTP `GET /runs/:seq` | full run object | Pure pass-through of `RecipeRun`. Callers that JSON-stringify the response see new optional fields — non-breaking. |
| HTTP `GET /runs/:seq/plan` | dry-run plan, not a run record | After B2, chained plans gain `step.tool` field. Additive. |

**Old chained-runner runs already in `runs.jsonl`**: their `registrySnapshot` is a full snapshot, not a delta. Dashboard logic that re-derives prior state by walking deltas backward must tolerate a starting-row that's ALREADY full state — recommend a one-liner heuristic: if `registrySnapshot.length` ≈ all currently-known step keys → treat as snapshot, else treat as delta. Tag new-format rows with `RecipeRun.runlogVersion: 2` so downstream code can branch cleanly. (Add the field in B1.)

**Old yamlRunner runs**: did not capture VD-2 at all. `replayRun` already excludes them (`step.output === undefined` → unmocked). Post-B1 yamlRunner runs gain VD-2 and become replayable. No regression for old runs.

**JSON-prompt run records** (post-B3): become regular YAML-runner records with one agent step. Pre-B3 records had no `stepResults` because the path bypassed the run-log entirely. Round 2 H Bug 6 reported `recordRecipeRun()` not being called — same root cause; B3 fixes it. Old JSON-prompt records simply don't exist in `runs.jsonl`; they were enqueued via `runClaudeTask` and only show up in `/tasks`. Post-B3, every JSON-prompt run shows up in both places. No row migration needed.

---

## Summary

Four PRs total, biased toward landing as a single conceptual change:

- **B1** (largest): extract `stepObservation.ts`, wire into both runners, convert per-step `registrySnapshot` to delta with run-level full snapshot. Closes #2, #9, #11 chained-half, half of #1, snapshot bloat.
- **B2**: chained `generateExecutionPlan` emits `tool` field. Closes the other half of #1.
- **B3**: lower `kind:prompt` JSON to synthetic yamlRunner agent step. Closes JSON-prompt drift; eliminates the third runner.
- **B4**: canonical `resolveRecipe.ts`, YAML-wins on collision. Closes `daily-status` two-layer disagreement.

Post-plan: two runners (yaml, chained), one shared post-step pipeline, one canonical resolver, one uniform `RunStepResult` shape, one source of truth for write-detection, silent-fail enforcement, and VD-2 capture.
