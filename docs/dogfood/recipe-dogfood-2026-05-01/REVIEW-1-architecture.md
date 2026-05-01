# REVIEW-1 — Architectural review of PLAN-B-runners + dependent claims in PLAN-MASTER

Read-only review. Source pins refer to alpha.35 HEAD.

---

## 1. Verdicts per question

### Q1 — Shared post-step pipeline shape (PLAN-B B-PR1)

**Verdict: seam is correct in spirit but mis-located in two places, and the plan
silently changes chained semantics.**

#### a. Are the post-step seams in the same logical place?

No — they're in structurally different places.

- `yamlRunner.runYamlRecipe` runs **two** "post-step" pipelines, not one. Tool
  steps execute at `src/recipes/yamlRunner.ts:540-621` (single retry loop +
  silent-fail at `:570-574` + JSON `{ok:false}` short-circuit at `:551-557` +
  fallback handling at `:584-621`). Agent steps run a parallel branch at
  `src/recipes/yamlRunner.ts:450-529` with its OWN silent-fail call at `:469-471`,
  its own narration-stripping at `:486-487`, its own JSON-output parse at
  `:498-503`, and its own error-shape construction. The two paths share nothing
  but `stepResults.push(...)` at the end. PLAN-B's `observeStep` would have to
  unify these two paths AS WELL AS the chained one.
- `chainedRunner` has step execution centralised in `executeChainedStep` at
  `src/recipes/chainedRunner.ts:438-467`. Tool/agent/recipe branches all return
  `{success, data, resolvedParams}` and the post-step seam lives at
  `src/recipes/chainedRunner.ts:777-861` (`stepExecutor` closure inside
  `runChainedRecipe`). Capture happens at `:836-855` AFTER `registry.set(...)`
  at `:820-829` — i.e. AFTER the registry has already absorbed the result and
  the step-status has been finalised.
- The two "post-step" points are NOT equivalent. yamlRunner's post-step is
  before any registry/state-mutation; chainedRunner's is after. This matters
  for error-promotion semantics: if `observeStep` flips a chained step from
  `ok` → `error`, the result has ALREADY been written to the registry (`:820`)
  and `effectiveSuccess` (`:809`) has ALREADY been computed. Promoting after-
  the-fact requires either a registry rollback or a post-pass that overwrites
  step status — neither is in the plan.

The plan's "wire `observeStep` exactly once per step, after the inner
execution" is a single-sentence statement covering three structurally
different code paths. **Real cost is 2-runner × 2-yaml-branch × 1-chained-
seam = 4 wiring points, not 2.**

#### b. Does silent-fail detection actually become available "for free"?

**No.** `chainedRunner.ts:464` returns `{success: true, data: result}` for any
non-throwing tool result. That `success: true` then flows through:

1. `withRetry` (`src/recipes/chainedRunner.ts:484-498`) — retry loop
   short-circuits on `success`. If `observeStep` runs AFTER `withRetry`,
   silent-fail-detected steps don't get retried. If it runs INSIDE
   `withRetry` (which the plan doesn't say), retry behavior changes silently
   — a placeholder string would now consume all retries.
2. `effectiveSuccess` calculation at `src/recipes/chainedRunner.ts:809`.
3. `registry.set(stepId, {status: ..., data: ...})` at `:820-829` — the
   registry stores `success` regardless of detector verdict. Downstream
   templates `{{steps.X.data}}` keep returning the placeholder string.
4. The throw at `:858-860` only fires when `effectiveSuccess` is false.

So unless `observeStep` is wired BEFORE `withRetry`'s success check AND
BEFORE `registry.set`, the chained runner gains a silent-fail label on
the step result but downstream steps still get fed the bad data. The plan
diagram at PLAN-B-runners.md:55-62 places `observeStep` AFTER inner
execution but doesn't address the registry-write ordering. **Bug #2 is
not closed by the plan as written.**

#### c. Single-threaded vs per-branch instance?

The plan's `observeStep` signature (PLAN-B-runners.md:241-266) takes
`prevRegistry` + `currentRegistry` as `ReadonlyMap` parameters. In the
chained runner, parallel steps execute under
`executeWithDependencies(depGraph, stepExecutor, execOptions)` at
`chainedRunner.ts:863-867` with `maxConcurrency` parallel slots. Each
parallel branch reads the SAME `OutputRegistry` instance
(`chainedRunner.ts:607`).

If `observeStep` snapshots `currentRegistry` after `registry.set(stepId,
...)` (which is what PLAN-B-runners.md:84 implies via "Δkeys (the keys
newly written by THIS step)"), two concurrent steps `A` and `B` both
finishing at roughly the same time will each compute their delta against
a registry that already contains the OTHER step's keys. Step A's delta
appears to include B's writes; step B's delta appears to include A's
writes. **This is not addressed in the plan and is a correctness bug
specific to parallel branches.**

The fix is to snapshot `prevRegistry` before `await`-ing `executeChainedStep`
and `currentRegistry` after, both on a per-step basis. The plan's signature
allows this but the wiring section (PLAN-B-runners.md:115) says only
"replace per-step full-snapshot capture at `:836-855` with a delta capture"
— it doesn't capture the prev-registry-before-step requirement.

---

### Q2 — `runlogVersion: 2` rollback claim

**Verdict: dashboard does NOT have a version branch hook today; PLAN-MASTER's
"old rows continue to work via the version-branched dashboard reader" is
unfounded. ctxQueryTraces is mostly safe but the body field exposes the new
shape to LLM consumers.**

#### Where dashboard parses run records

`dashboard/src/app/runs/[seq]/page.tsx:21-45` declares the `StepResult`
interface inline (with `registrySnapshot?: Record<string, unknown>`,
`output?`, `resolvedParams?`, `startedAt?`) and reads `step.output`,
`step.status`, `run.stepResults` directly. There is **no version branch
hook** in either `dashboard/src/app/runs/[seq]/page.tsx` or
`dashboard/src/lib/registryDiff.ts`.

The diff renderer at `dashboard/src/lib/registryDiff.ts:142-168` walks
backward through `steps[i-1].registrySnapshot, steps[i-2]...` and computes
`diffSnapshots(prev, current)`. **It assumes both `prev` and `current` are
full registry snapshots.** If B-PR1 changes them to deltas, the diff is
delta-vs-delta which is meaningless: a key that's in the current step's
delta but not the prior step's delta appears in `added` even when it
existed at run start.

PLAN-B-runners.md:328-338 acknowledges this in the backwards-compat table
("dashboard's diff hover continues to work because the diff is what it
was already trying to show") but this is incorrect: the diff function
takes the FULL prior snapshot (`prev`) and computes the full diff
against `current`. Replacing both with deltas requires the dashboard
either to (a) accumulate deltas left-to-right before diffing, or (b)
read the new run-level `RecipeRun.registryFinalSnapshot` and walk
deltas backward from that. Neither is in the plan.

The "version-branched dashboard reader" PLAN-MASTER.md:132 references
**does not exist in the codebase today** — `grep -rn "runlogVersion"
src dashboard` returns zero hits. PLAN-B-runners.md:338 says "Tag
new-format rows with `RecipeRun.runlogVersion: 2` so downstream code can
branch cleanly. (Add the field in B1.)" — that's the only place the
field is introduced, and the plan does NOT include the corresponding
dashboard-side branch.

#### ctxQueryTraces

`src/tools/ctxQueryTraces.ts:86-96` (`recipeRunTraces`) maps each
`RecipeRun` to `{traceType, ts, key, summary, body: r as unknown}`. The
**body field includes the entire run record**, including `stepResults[]`
with all VD-2 fields. PLAN-B-runners.md:332 claims "ctxQueryTraces
reads its own decision-trace store, not run records — Unchanged". This
is **wrong** — `ctxQueryTraces` reads from `deps.recipeRunLog.query()`
at `src/tools/ctxQueryTraces.ts:215-216` and aggregates over all four
stores including the recipe-run log. The shape change DOES propagate
to LLM callers via `body`.

Practical impact is low — `recentTracesDigest` only reads `summary`
(`src/tools/recentTracesDigest.ts:88`), and most LLM consumers will
look at `summary` too. But any caller that opens `body.stepResults[i]
.registrySnapshot` will see deltas without warning.

#### replayRun

`src/recipes/replayRun.ts:64-82` reads `step.status`, `step.output`,
and the truncation-envelope marker `out["[truncated]"]`. **None of
these change under B-PR1** — `output` stays at `step.output`, status
stays at `step.status`. The plan's claim at PLAN-B-runners.md:331
("Unchanged") is correct. **One snag**: `step.output` is captured
post-`captureForRunlog` (i.e. potentially as `{[truncated]: true,
preview, bytes}` envelope). If the new `observeStep` capture pipeline
re-applies `captureForRunlog`, double-truncation risk exists; the plan
should call this out explicitly.

---

### Q3 — B-PR3 "delete `loadRecipePrompt`, synthesize JSON `kind:prompt` as YAML"

**Verdict: high-risk simplification. Plan undercounts callers (3 in source,
not 2) and changes observable response shapes.**

#### Behavioral differences `loadRecipePrompt` vs `runYamlRecipe`

1. **Caller count**: PLAN-B-runners.md:12 lists two callsites
   (`recipesHttp.ts:995-1047` and `recipeOrchestration.ts:344-365`). Source
   has THREE production callers:
   - `src/recipeOrchestration.ts:306` — webhook handler (not in plan).
   - `src/recipeOrchestration.ts:344` — `runRecipeFn` (in plan).
   - `src/recipes/scheduler.ts:327` — cron scheduler (not in plan).

   The webhook caller wraps the prompt with `renderWebhookPrompt`
   (`src/recipesHttp.ts:1054-1068`) to interpolate the webhook payload
   before enqueueing. The scheduler caller calls `this.opts.enqueue(...)`
   directly. **Neither is mentioned in PLAN-B section §4 PR B3.**

2. **Response shape — taskId format diverges**:
   - JSON-prompt path returns `{ok: true, taskId}` where `taskId` is the
     orchestrator's enqueue-id (`src/recipeOrchestration.ts:354-358`),
     which downstream code can pass to `/tasks/<id>`.
   - YAML path returns `{ok: true, taskId, name}` from
     `RecipeOrchestrator.fire` (`src/recipes/RecipeOrchestrator.ts:81-88`)
     where `taskId = ${name}-${Date.now()}`. This taskId is a label, NOT
     a Claude orchestrator id; it's not addressable via `/tasks/<id>`.

   Plan's tradeoff section (PLAN-B-runners.md:198) acknowledges this and
   recommends "surface that yamlRunner-emitted taskId" — but doesn't
   address that **the format changes from `task_abc123` to
   `daily-status-1777627780016`**. Any client that today calls
   `GET /tasks/<id>` after `POST /recipes/daily-status/run` will receive
   404 after B-PR3. The dashboard's run-details page already side-steps
   this by using `seq` not `taskId`, but external Dispatch/CLI users
   may have scripts.

3. **Per-step structure**: today's JSON-prompt run has NO `stepResults` at
   all — `recordRecipeRun()` is never called (`src/recipeOrchestration.ts:344
   -358` short-circuits before `:460`). Post-B3, the synthetic 1-step
   YAML emits `stepResults: [{id: "agent_output", tool: "agent",
   status: "ok"|"error", durationMs, ...}]`. Consumers that detect
   "JSON-prompt path was used" by `stepResults.length === 0` will break.

4. **Activation metrics asymmetry**: `recordRecipeRun()`
   (`src/activationMetrics.ts:215`) is called only from
   `src/recipeOrchestration.ts:460` (YAML path). JSON-prompt paths today
   never bump it (H-http-routes.md:24 finding 6). After B3 they do, which
   may surprise users who rely on activation-metrics to count "real" YAML
   recipe runs separately from prompt-style invocations. Worth a release
   note.

5. **Background semantics**: today's JSON-prompt `enqueue` returns
   immediately and the prompt runs as a background Claude task. yamlRunner's
   single-agent step uses `runAndWait` inside `claudeCodeFn`
   (`src/recipeOrchestration.ts:414-421`). The plan
   (PLAN-B-runners.md:201) says yamlRunner is "fire-and-detach when called
   through orchestrator" because of `dispatch(...).finally(...)` at
   `RecipeOrchestrator.ts:84-87` — true at the orchestrator level, but
   `claudeCodeFn` itself awaits `runAndWait` inside the dispatched
   coroutine. The two are equivalent in async terms, but the underlying
   orchestrator task surfaces differently in `/tasks` listings. Verify by
   running both before/after.

#### Dispatch attribution

Today's JSON-prompt path tags with `triggerSource: \`recipe:${name}\``
(`recipeOrchestration.ts:356`). YAML-path uses `recipe:${name}:agent`
(`recipeOrchestration.ts:417`). After B3 the JSON-prompt-style recipes
will get the YAML pattern. Any `/tasks` filtering on the `recipe:`
prefix (e.g., dashboard charts, ctxQueryTraces queries by triggerSource)
needs to be audited for prefix specificity.

---

### Q4 — B-PR4 + C-PR4 "single canonical resolver, YAML-wins"

**Verdict: plan's call-site enumeration is incomplete (misses scheduler,
webhook, JSON-prompt's own resolver). YAML-wins behavior change is
broader than the plan describes; the user has BOTH variants installed,
and the JSON variant is the one currently firing.**

#### Recipe-name resolution sites in the codebase

| Caller | Today's behavior | After plan |
|---|---|---|
| `loadRecipeContent` (`src/recipesHttp.ts:458-490`) | YAML first, JSON fallback | YAML-wins (no change) |
| `runRecipeFn` (`src/recipeOrchestration.ts:344-388`) | JSON-prompt first via `loadRecipePrompt`, YAML fallback | YAML-wins via `resolveRecipe` |
| Webhook dispatch (`src/recipeOrchestration.ts:297-318`) | YAML if matched filePath, else `loadRecipePrompt` against same name | UNCLEAR in plan — webhook path resolves by `match.filePath`, not by name; `loadRecipePrompt` only fires for legacy JSON-prompt webhook recipes. Plan's `resolveRecipe` doesn't address the `match.filePath`-based path at all. |
| Scheduler `fire` (`src/recipes/scheduler.ts:286-340`) | YAML first via `findYamlRecipePath`, then JSON via `loadRecipePrompt` | Plan doesn't mention scheduler. |
| `loadRecipePrompt` itself (`src/recipesHttp.ts:1002`) | Calls `resolveJsonRecipePathByName` (JSON-only) | Slated for deletion in B-PR3. |
| `recipeRoutes.ts` PATCH/DELETE/PUT | Uses `findYamlRecipePath` (YAML-only) | Should align with `resolveRecipe` |
| CLI `recipe enable`/`disable`/`run` (`src/commands/recipe.ts`) | Uses `listInstalledRecipes` walks dir-only | Plan B-PR4 mentions "should align" but doesn't list. |

PLAN-B-runners.md:274-279 lists 4 migration sites; source has at least
7 distinct paths.

#### "Does YAML-wins change CURRENTLY WORKING flows?"

**Yes, for the user.** Per A-live-runs.md:32 and K-verify.md `daily-status`:
the user has BOTH `daily-status.json` and `daily-status.yaml` installed.
Today, `POST /recipes/daily-status/run` resolves to JSON (legacy path
fires first) and reports `Cited last 3 commits 8f90817, 3328e79,
97c9cd0 - verified against git log -3 exactly` — i.e. **the JSON variant
works correctly**. The YAML variant is a separate cron recipe with 4
steps that has NEVER been the active dispatch target.

After B-PR4, firing `daily-status` will run a recipe the user has never
fired through this name. Behavior change is real, even though both
variants share a name. Plan B-PR4 (PLAN-B-runners.md:221) says "anyone
with both...who was relying on the JSON variant firing now gets the YAML
variant. We log a clear collision warning so the user can rename one."
The user IS that "anyone" — this is an immediate breaking change for
the user firing this audit.

#### Migration path — startup warning

Plan PLAN-B-runners.md:210 already specifies "Recipe name '...' has
both .yaml and .json variants; using .yaml". This is correct but
**should fire at bridge start** AND on every `loadRecipeContent` call
(rate-limited per name) so the user sees it both at boot and during
dashboard interactions. The plan PLAN-C-schema-cli.md:445-448 elaborates
the same warning ("Use the explicit /recipes/daily-status.json URL to
address the JSON variant") — but PLAN-C also proposes by-extension URL
forms (`/recipes/daily-status.json`) as override, which PLAN-B does
NOT. The two plans collide here:

- PLAN-B-runners.md:280 explicitly **rejects** per-extension URL routing
  ("Rejected because (a) breaks the existing API contract; (b) doesn't
  fix the underlying ambiguity for CLI/scheduler.")
- PLAN-C-schema-cli.md:431-448 explicitly **recommends** per-extension
  URL routing (Option C).

The two plans are saying opposite things about the same fix. PLAN-MASTER
combines them at line 56 ("B-PR4 + C-PR4 (combined) — new
src/recipes/resolveRecipe.ts as single canonical resolver
(YAML-wins-on-collision; closes #14) + PATCH /recipes/:name ESM require
bug + four missing nested HTTP routes") — without addressing the
extension-URL conflict. **Maintainer needs to pick one before Phase 5
ships.**

---

### Q5 — Phase ordering: Phase 4 dependency on Phase 2

**Verdict: dependency is partially fictional. A-PR3+B-PR2 do not need
B-PR1's stepObservation. Could land in Phase 3 alongside cleanup.**

PLAN-MASTER.md:79-87 shows the dependency tree:

```
B-PR1 ──── A-PR3+B-PR2  (Phase 4)
       └── B-PR3        (Phase 5)
       └── B-PR4+C-PR4  (Phase 5)
```

PLAN-B-runners.md:309-312 gives the actual dependency reasoning:
- B-PR1: none
- B-PR2: none (independent of B-PR1)
- B-PR3: B-PR1 must land first (so synthesised YAML-recipe gets VD-2)
- B-PR4: B-PR3 ideally before B-PR4 (test scenarios simpler post-B3)

PLAN-A-security has its own A-PR3 (atomic-write fix + maxConcurrency
clamp). A-PR3 does NOT depend on stepObservation — atomic write is in
`recipeInstall.ts`, concurrency clamp is in chainedRunner.ts:RunOptions
construction. PLAN-MASTER combines A-PR3 with B-PR2 (because both
edit chainedRunner) but B-PR2 itself is "feat: emit `tool` field in
generateExecutionPlan" — pure plan-builder, no runner mechanics.

**Verdict on phase ordering:** A-PR3+B-PR2 (combined) is independent of
B-PR1. PLAN-MASTER's claim that "Phase 4 depends on Phase 2" is true
only because Phase 5 depends on Phase 2 and the master ordered phases
sequentially. Phase 4 could ship in Phase 3 alongside C-PR1/C-PR2/C-PR5/
C-PR6 (which all explicitly land in Phase 3 per PLAN-MASTER.md:42-43).

**Recommendation**: rename Phase 4 to "Phase 3b" (post-Phase 1 security)
to flatten the schedule by one week.

The actual Phase 2 → Phase 5 dependency is real (B-PR3 needs B-PR1's
stepObservation to give synthesized recipes silent-fail and VD-2). Don't
collapse that.

---

### Q6 — Cross-check against I-e2e.md (16 seams)

| Seam (I-e2e severity) | Where addressed in plan? | Verdict |
|---|---|---|
| #1 Chained `hasWriteSteps:false` | PLAN-B B-PR2 (Phase 4) | **CLOSED** — generateExecutionPlan emits `tool` field. |
| #2 Nested-recipe maxDepth off-by-one | PLAN-C C-PR3 (Phase 6) — `nestedRecipeStep.ts:70` `>` → `>=` | **CLOSED** |
| #3 No cycle detection for nested-recipe calls | **NOT ADDRESSED** in any plan. PLAN-MASTER folds I findings into Phase 6 (line 112) but lists "nested cycle detection" without naming I-e2e #3. PLAN-C C-PR3 only fixes the off-by-one. | **GAP** |
| #4 Cron-installed-post-startup never auto-fires | PLAN-MASTER.md:64,112 mentions "cron-installed-post-startup" folded into C-PR3. PLAN-C-schema-cli.md C3 section does not explicitly list this. Searching PLAN-C: "scheduler hardening" implied at line 250, but the scheduler-restart-on-install hook is not specified. | **PARTIAL** — listed in master, not detailed in plan. |
| #5 Same-name conflict — both unreachable | **NOT ADDRESSED**. B-PR4's resolver picks one variant; doesn't address `name:` field collisions where two recipes in different DIRS have the same `name:`. The bug is in install/registration, not resolution. | **GAP** |
| #6 Multi-YAML package drops recipes silently | **NOT ADDRESSED**. `listInstalledRecipes` in `recipeInstall.ts` registers one recipe per dir per I-e2e.md:16. PLAN-C C-PR2 fixes "list/run subdir resolver" (PLAN-MASTER.md:42) but the I-e2e finding is about INSTALL/REGISTRY, not LIST. Need verification this is the same fix. | **PARTIAL** |
| #7 VD-2 missing from yamlRunner | PLAN-B B-PR1 | **CLOSED** |
| #8 Install accepts malformed YAML | PLAN-C C-PR2 (`install preflight`) | **CLOSED** per PLAN-C-schema-cli.md:209 |
| #9 Nested child runs absent from `/runs` | **NOT ADDRESSED**. No mention in PLAN-B or PLAN-C. PLAN-MASTER doesn't list it. | **GAP** |
| #10 `--allow-write` plural/singular silent swallow | **NOT ADDRESSED**. Belongs to CLI surface (PLAN-C C-PR2) but plan doesn't explicitly list. | **GAP** |
| #11 Template engine rejects bare `{{name}}` | PLAN-C C-PR1 lint root whitelist — but C-PR1 fixes the LINTER, not the template engine. The seam is that chainedRunner's templateEngine REJECTS bare aliases that the linter accepts. PLAN-C-schema-cli.md C1 step 3 adds 5 builtins to template engine but doesn't add flat-key fallback. PLAN-D-templates F10 (the bug) recommends the fix go to validation.ts (require `steps.X.data` for chained recipes), which would tighten lint not loosen runtime. Plan acknowledges this gap (D-templates.md:317) but defers. | **PARTIAL** (deferred) |
| #12 Nested child failure surfaces zero step-level info | **NOT ADDRESSED**. Belongs to nestedRecipeStep error propagation. | **GAP** |
| #13 CLI `recipe enable <yaml-name>` rejects | PLAN-C C-PR2 (CLI: list/run subdir resolver) — likely same root cause. | **PARTIAL** |
| #14 registrySnapshot duplicated per chained step | PLAN-B B-PR1 (delta semantics) | **CLOSED** |
| #15 Manual fire of cron recipe logs `trigger:cron` | **NOT ADDRESSED**. | **GAP (LOW)** |
| #16 Replay correctly rejects YAML | NOT A BUG — confirmed working. | n/a |

#### Specifically requested cross-checks

- **Cron-installed-post-startup never fires (round-2 I)**: PARTIAL.
  PLAN-MASTER.md:64,112 lists it; PLAN-C-schema-cli.md C3 (line 250-385)
  describes scheduler hardening for trigger types but does NOT specify
  the hot-reload-on-install hook. Should be explicit: `recipeInstall`
  should call `scheduler.restart()` (or `scheduler.addRecipe(name)`) on
  successful install of any recipe with a non-`manual` trigger. The plan
  should call this out as a `recipeInstall.ts` change in C-PR3.
- **Multi-YAML packages drop recipes silently**: PARTIAL.
  PLAN-MASTER.md:42 mentions "list/run subdir resolver" but doesn't
  match the I-e2e finding's "registry only registers one entry per dir".
  Confirm by reading `recipeInstall.ts` `scanDir` — the bug is in walk
  semantics, not resolver, and `listInstalledRecipes` (per K-verify.md
  bug #4) skips top-level files entirely. Two different fixes overlap;
  the plan should disambiguate.
- **Duplicate-name conflict makes BOTH unreachable**: GAP. No plan
  addresses recipes-with-same-`name:`-in-different-dirs. B-PR4's
  resolver fixes JSON-vs-YAML same-name; it does NOT fix YAML-vs-YAML
  same-name. Add either a load-time uniqueness check (reject second
  recipe with already-registered name with a clear error) or a
  registration-by-canonical-key fix.
- **Template engine rejects bare `{{name}}`**: PARTIAL. PLAN-C C-PR1
  changes the lint whitelist but the runtime template engine
  (`templateEngine.ts:114-134`) still rejects bare identifiers. The
  user-facing impact (examples in `examples/recipes/morning-inbox-
  triage.yaml:33` use bare `{{threads}}` and would runtime-fail) is
  described in I-e2e.md:21 and D-templates.md F10 as MEDIUM. Plan
  defers; acknowledge explicitly in PLAN-MASTER.
- **Nested child runs missing from `/runs`**: GAP. Not in any plan.
  Plumbing a child-run record requires either: (a) chainedRunner emits
  a separate `RecipeRun` per nested recipe (today nested calls run
  inline at `chainedRunner.ts:420-426` with `existingRegistry` and
  depth+1, never calling `startRun`), or (b) post-hoc reconstruction
  from parent `childOutputs`. Add to PLAN-B as B-PR5 or to
  PLAN-MASTER's Phase 6 backlog explicitly.

---

## 2. Architectural risks the plan doesn't acknowledge

### R1 — `observeStep` as pure post-step is incompatible with the chained runner's registry-write ordering

The chained runner's `stepExecutor` writes to the registry at
`chainedRunner.ts:820-829` BEFORE capture at `:836-855`. If `observeStep`
changes a step's status from `success` → `error` (silent-fail detected),
either:
1. `registry.set` runs first with `status: success`, then `observeStep`
   fires and we have an inconsistent (registry says success, runlog
   says error) — propagating wrong data downstream.
2. We move `observeStep` BEFORE `registry.set` — but then capture
   semantics change (the registry snapshot we capture is for the PRIOR
   state, not the AFTER state). The plan signature
   (`prevRegistry, currentRegistry`) implies capture takes BOTH, but
   the wiring section doesn't specify which runs first.

**Recommend**: PLAN-B-runners.md §4 PR B1 should specify that
`observeStep` runs AFTER inner execution but BEFORE `registry.set`,
with `currentRegistry` being a synthetic post-step snapshot computed
from `prevRegistry + {stepId: result.data}`. This avoids the parallel-
branch race in §Q1c and the registry-write-ordering issue here.

### R2 — `registryDelta` semantics change without dashboard-side change

Section §Q2 above. Calling out as a separate risk: the plan's blast
radius table at PLAN-B-runners.md:328-338 acknowledges dashboard impact
("hover shows ONLY newly-written keys per step, which is arguably what
users want anyway") but `dashboard/src/lib/registryDiff.ts:142-168`
will literally compute wrong diffs without modification. The "version-
branched dashboard reader" is invented in PLAN-MASTER, not in the
codebase.

**Recommend**: split B-PR1 into two:
- B-PR1a: extract `stepObservation`, wire silent-fail + VD-2 into both
  runners. Keep `registrySnapshot` as full snapshot (don't change
  dashboard-readable shape).
- B-PR1b: convert to delta + add run-level final snapshot + add
  `runlogVersion: 2` field + dashboard branch reader.

This isolates the dashboard-breaking change from the silent-fail floor
fix.

### R3 — Webhook + scheduler paths are missed in B-PR3

§Q3 above. `loadRecipePrompt` has 3 production callers, plan addresses 1.
After B-PR3 deletes `loadRecipePrompt`, the scheduler will fail to fire
JSON-prompt cron recipes, and the webhook handler will fail on JSON-
prompt webhook recipes.

**Recommend**: PLAN-B-runners.md §4 PR B3 should explicitly list:
- `src/recipes/scheduler.ts:327` — replace `loadRecipePrompt` call with
  `loadJsonPromptAsYamlRecipe` + dispatch through `runYaml` callback.
- `src/recipeOrchestration.ts:306` — same in webhook handler.

### R4 — taskId format change is a public-API break

§Q3 above. The JSON-prompt path's taskId is a Claude orchestrator id.
yamlRunner's is a string label. Any caller that polls
`/tasks/<taskId>` after `POST /recipes/<name>/run` will break for every
JSON-prompt recipe after B-PR3. Plan should either:
- Continue surfacing the orchestrator-id from the synthetic single-step
  YAML's agent step (yamlRunner emits `taskId: yaml:${recipe.name}:
  ${recipeStartedAt}` per `yamlRunner.ts:432` — this is NOT the
  orchestrator's enqueue-id), OR
- Document the breaking change and bump bridge protocol/major.

### R5 — Per-extension URL routing — PLAN-B and PLAN-C disagree

§Q4 above. PLAN-B-runners.md:280 rejects per-extension URLs;
PLAN-C-schema-cli.md:431-448 recommends them. PLAN-MASTER combines
them silently. **Maintainer must pick one before either ships.**

### R6 — chained-runner inflight dedup vs B-PR3's synthesized YAML

`RecipeOrchestrator.fire` (`src/recipes/RecipeOrchestrator.ts:64-69`)
dedups by recipe `name`. After B-PR3 the JSON-prompt and YAML variants
will both share a `name` (post-B-PR4 they'll resolve to the same
canonical, but that canonical is the YAML). The synthesised wrapper
yamlRunner-recipe gets dedup; today the JSON-prompt path goes through
`orchestrator.enqueue(...)` which has its OWN dedup (none — every call
spawns). After B-PR3 a user firing JSON-prompt-style recipes back-to-
back will get `already_in_flight` errors they never got before. Worth
documenting.

### R7 — Schema generator and lint after B-PR3

After B-PR3, `daily-status.json` (and `greet.json`) lower to YAML at
load time. The schema generator (`src/recipes/schemaGenerator.ts`) is
exported via `GET /schemas/recipe`; it advertises the YAML-only
`oneOf[tool|agent|recipe|chain]` shape. JSON files on disk continue
to fail this schema (D-templates.md F7, H-http-routes.md schema-check
table). Recipe authors using the JSON `kind:prompt` shape will see
schema-validation failures via dashboard / linter even though the
recipe runs. Either:
1. Add a separate `kind:prompt` JSON schema branch, OR
2. Document that JSON `kind:prompt` is a load-time-only shape and
   lint/schema check the LOWERED YAML, not the raw JSON.

Plan section 5d (PLAN-B-runners.md:294-303) acknowledges this with
"Recipe authors can still write `kind:prompt` JSON; it just means
'lower me to a one-step YAML at load time' implicitly. Document
this..." but doesn't fix the lint/schema gap.

### R8 — Phase ordering inflates schedule

§Q5 above. A-PR3+B-PR2 don't depend on B-PR1. Phase 4 → Phase 3b.

### R9 — Cycle detection for nested recipes (I-e2e #3) and child run visibility (I-e2e #9) are missing

§Q6 above. Both are missing entirely from the plan.

---

## 3. Concrete amendments — ranked by importance

### Most important

#### A1. Split B-PR1 into 1a (silent-fail+VD-2 wiring, no shape change) + 1b (delta+runlogVersion+dashboard branch reader)

Cuts blast radius. Lets silent-fail floor (the actual safety fix) ship
first without coupling to a dashboard-format change. B-PR1b can be
explicitly versioned and released with dashboard-side branch reader at
the same time.

Source impact: B-PR1a touches yamlRunner.ts (~50 LoC) +
chainedRunner.ts (~30 LoC) + new `stepObservation.ts` (~150 LoC).
B-PR1b adds delta walker + `runlogVersion: 2` field + dashboard
branch reader (~100 LoC + ~80 LoC dashboard).

#### A2. PLAN-B-runners.md §4 B-PR1 must specify `observeStep` ordering w.r.t. `registry.set`

Current plan diagram (PLAN-B-runners.md:55-62) puts `observeStep`
between inner execution and result-write. Source wiring requires it to
run BEFORE `chainedRunner.ts:820-829`'s `registry.set` so the registry
sees the corrected status. Add explicit ordering note.

#### A3. PLAN-B-runners.md §4 B-PR3 must list ALL `loadRecipePrompt` callers

Three callers, plan lists one. Add `src/recipeOrchestration.ts:306`
(webhook handler) and `src/recipes/scheduler.ts:327` (cron scheduler)
explicitly to the migration list.

#### A4. PLAN-MASTER must pick: per-extension URLs (PLAN-C) OR canonical-name-only (PLAN-B). Cannot ship both.

Current state: PLAN-B rejects per-extension URLs with rationale; PLAN-C
recommends them; PLAN-MASTER folds them together silently. Decide
before Phase 5.

#### A5. Add B-PR5 (or new C-PR7): same-`name:`-different-dir uniqueness check at recipe load

Currently nothing addresses I-e2e #5 (two recipes both `name:
p1-hello` → both unreachable via run dispatch). Add a uniqueness check
at `listInstalledRecipes` / `loadRecipeContent` time that errors loudly
on collision.

### Important

#### B1. Add cron scheduler hot-reload-on-install hook to C-PR3

I-e2e seam #4 is listed in PLAN-MASTER.md:64,112 but not detailed in
PLAN-C-schema-cli.md C3. Add explicit `scheduler.addRecipe(name)` /
`scheduler.restart()` call from `recipeInstall.ts` install path.

#### B2. Address taskId format change in B-PR3

Document the breaking change. Either preserve orchestrator-task-id
surfacing (yamlRunner-emitted single-step exposes the agent's task id)
or bump bridge protocol version.

#### B3. Address the registryDelta dashboard reader gap explicitly

PLAN-MASTER.md:132's "version-branched dashboard reader" doesn't
exist — it's invented for the rollback story. Either ship the reader
in B-PR1b (per A1) or ship the format change as a major-version
incompat with explicit upgrade docs.

#### B4. Address ctxQueryTraces body-shape exposure

PLAN-B-runners.md:332 incorrectly says ctxQueryTraces is unaffected.
It is (mostly) correct in practice but `body` exposes the new shape.
Add a note or mask.

#### B5. Cycle detection for nested recipes (I-e2e #3)

Add to PLAN-MASTER Phase 6 explicitly. nestedRecipeStep.ts should
track call-stack of recipe names and reject when name reappears.
Maxdepth-only is a stop, not a guard.

#### B6. Document fix for I-e2e #9 (nested child runs absent from `/runs`)

Either separately log child runs to `RecipeRunLog` (depth>0 path) or
make it a documented limitation.

### Lower-priority

#### C1. Move A-PR3+B-PR2 from Phase 4 to Phase 3b

Saves a week. Real dependency is on Phase 1 (security).

#### C2. PLAN-C C-PR1's templateEngine builtin-keys extension may break existing chained runs

`templateEngine.ts:114-134` rejects bare identifiers. PLAN-C-schema-cli.md
C1 step 3 says "extend `parseExpression` to recognize the bare-identifier
built-in keys (whitelist of 5 names; do not open up arbitrary bare
idents)". That's safe. But the same plan in step 1 says "lint accepts
`{{steps.X.data}}` and `{{env.X}}`" — chained recipes pass; yamlRunner
doesn't seed `steps`/`env` in flat ctx. The asymmetry persists.
Document.

#### C3. Add lint deprecation warnings for `kind:prompt` JSON files post-B3

If the plan's intent is "JSON `kind:prompt` is a load-time-only shape,"
the linter should explicitly warn (NOT error) on JSON `kind:prompt`
recipes saying "consider migrating to YAML single-agent-step form".

---

## 4. What the plan got right (don't waste effort changing)

1. **`stepObservation` as new module rather than extending `captureForRunlog`
   or `detectSilentFail`** (PLAN-B-runners.md:230-237). Correct call —
   keeping the pure detector pure makes per-runner unit tests possible
   and reduces blast radius.

2. **Registry delta over snapshot cap as the right abstraction**
   (PLAN-B-runners.md:282-291). Cap-only would still emit 25 KB at
   every step. Delta scales per-step storage with actual writes. The
   plan correctly identifies the storage win (~100 KB → ~26 KB for
   branch-health) and correctly retains the cap as safety net.

3. **Eliminating the JSON-prompt runner via load-time lowering**
   (PLAN-B-runners.md:293-302). This is the right architectural move —
   three runners → two runners → one shared pipeline. The risk
   surfacing is in the migration details (R3, R4, R7), not the design.

4. **Two-runner-with-shared-seam over one-runner-with-strategy-interface**
   (PLAN-B-runners.md:32-39). Correct. Folding sequential-imperative
   yamlRunner and parallel-DAG chainedRunner into one strategy interface
   would force union-of-all-mechanics. The drift bugs are post-step,
   not in inner mechanics.

5. **Plan B-PR2 (chained dry-run plan emits `tool` field)** is small,
   correct, and independently shippable. Nothing to change.

6. **PLAN-MASTER Phase 1 (security CRITICALs first) sequencing**
   (PLAN-MASTER.md:18-26). Correct. A-PR1+A-PR2 are independent,
   small-blast-radius, and unblock everything else.

7. **PLAN-MASTER's overlap deduplication table** (PLAN-MASTER.md:7-13).
   Correct calls on combining A-PR3+B-PR2 (same edit) and B-PR4+C-PR4
   (resolveRecipe IS the daily-status fix).

8. **C-PR6 schema cap one PR ahead of A-PR3 runtime clamp** so authors
   see lint warnings first (PLAN-MASTER.md:43). Good UX call.

9. **`recordRecipeRun()` activation-metrics fix as B-PR3 side effect**
   (PLAN-B-runners.md:178-180). Correctly identified and folded in.

10. **VD-2 schema additivity claim** (PLAN-B-runners.md:333). Schema
    actually IS additive — `RunStepResult` fields are all optional
    (`src/runLog.ts:34-53`). The runlogVersion concern is about
    semantics (delta vs snapshot in `registrySnapshot`), not field
    presence.

---

## File pin reference (every claim above)

- `src/recipes/yamlRunner.ts:407-412, 432, 450-529, 540-621, 668-674`
- `src/recipes/chainedRunner.ts:10, 438-467, 484-498, 589-988, 820-829, 836-855, 991-1040`
- `src/recipes/RecipeOrchestrator.ts:31, 60-69, 81-88`
- `src/recipes/captureForRunlog.ts:117-129`
- `src/recipes/replayRun.ts:64-82`
- `src/recipes/detectSilentFail.ts:38-63, 71-116`
- `src/recipes/scheduler.ts:178, 193, 232, 286-340, 327`
- `src/recipesHttp.ts:155-210, 200, 458-490, 995-1047, 1054-1068`
- `src/recipeOrchestration.ts:25, 297-318, 306, 344-388, 414-421, 460`
- `src/commands/recipe.ts:803-822, 824-836, 867-898`
- `src/runLog.ts:34-53, 55-89, 101-103`
- `src/tools/ctxQueryTraces.ts:86-96, 215-216`
- `src/tools/recentTracesDigest.ts:88, 144-156`
- `src/activationMetrics.ts:215`
- `dashboard/src/app/runs/[seq]/page.tsx:21-45, 308, 562-595, 880`
- `dashboard/src/lib/registryDiff.ts:10-13, 39-65, 82-88, 94-118, 142-168`
