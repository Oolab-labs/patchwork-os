# Recipe Lifecycle Report — Reconciling Strategic Phase 2 with Dogfood Floor

> Source briefs: `docs/strategic/2026-05-02/strategic-plan.md` (Phase 2 only),
> `docs/dogfood/recipe-dogfood-2026-05-01/PLAN-MASTER-V2.md`,
> `docs/dogfood/recipe-dogfood-2026-05-01/HANDOFF-engineering-briefs.md`,
> `docs/dogfood/recipe-dogfood-2026-05-01/G-security.md`,
> `docs/dogfood/recipe-dogfood-2026-05-01/I-e2e.md`.
> Code references are absolute file:line.
> All "BUILT/PARTIAL/NOT BUILT" labels reflect `main` as of phase1-rollup
> (commit `be408a2`, A-PR1/A-PR2/A-PR4 landed; B-PR1a onward unshipped).

---

## 1. Verified-vs-aspirational matrix

| # | Phase 2 deliverable | Verdict | Evidence |
|---|---|---|---|
| 2.1 | Conversational Recipe Builder (NL → YAML, validate, dry-run, install) | **NOT BUILT** | `dashboard/src/app/recipes/new/page.tsx:1-50` is a hand-form UI (`Step`, `RecipeVar`, `TriggerState` typed inputs); no NL endpoint. `grep -rn "recipeBuilder\|nl2yaml\|generateRecipe" src/` returns 0 hits. Save path `saveRecipe` exists at `src/recipesHttp.ts:345` and `saveRecipeContent` at `src/recipesHttp.ts:492`, plus `validateRecipeDraft` at `src/recipesHttp.ts:265`, but no NL ingress. |
| 2.2 | Recipe Dry-Run UX (first-class UI) | **PARTIAL** | Backend complete: `runRecipeDryPlan` in `src/commands/recipe.ts:840-916` produces `RecipeDryRunPlan` (`src/commands/recipe.ts:775-802`) with `schemaVersion`, `steps[]`, `parallelGroups`, `connectorNamespaces`, `hasWriteSteps`, `lint.errors/warnings`, per-step `isWrite`/`isConnector`/`risk`/`resolved`. HTTP exposed via `GET /runs/:seq/plan` (`src/recipeRoutes.ts:531-548`). UI: none — no `dashboard/src/app/recipes/[name]/dry-run/` route exists; the only consumer is the JSON CLI output. CLI `recipe run --dry-run` exit-code unification still broken (B-cli #31, deferred to C-PR2). `hasWriteSteps` is currently blind to chained sub-recipe writes (F-07, fix in A-PR3+B-PR2). |
| 2.3 | Recipe Run Timeline (causal observability) | **PARTIAL** | Per-step capture exists: `RunStepResult` at `src/runLog.ts:34-53` carries `resolvedParams`, `output`, `registrySnapshot`, `startedAt`. `RecipeRunLog.startRun`/`updateRunSteps`/`completeRun` (`src/runLog.ts:299-380`) drives a live in-memory ring. Dashboard `dashboard/src/app/runs/[seq]/page.tsx:8` consumes `diffForStep` from `dashboard/src/lib/registryDiff.ts:147-168` to render per-step diff hover. But: (a) **no link from `RunStepResult` to `ActivityLog` ids** (`src/activityTypes.ts:9-18` has its own `id: number` namespace and there is no `activityIds[]` on a step); (b) **no link to `ApprovalQueue.callId`** (`src/approvalQueue.ts:20-38` — approval entries don't reference a recipe seq); (c) **chained nested recipes do not emit `RecipeRun` records** — `chainedRunner.ts:653,856,931,988` all gate `appendDirect` / `completeRun` on `depth === 0` (I-e2e #9). So `Webhook → recipe A → recipe B` is not recoverable from `runs.jsonl`. |
| 2.4 | Recipe Trust Graduation | **NOT BUILT** | `grep -rn "trustState\|trustLevel\|recipeTrust\|graduation\|approvalCount" src/` returns 0 hits. Closest substrate: per-recipe `.disabled` marker (`src/recipesHttp.ts:24` — binary on/off), `riskTier.ts:40` per-tool tier map, and `ApprovalQueue` (`src/approvalQueue.ts`) which holds **per-call** state and discards on resolve. No "this recipe has been approved 27 times" counter exists anywhere. `decision_traces.jsonl` (per `ctxQueryTraces`) is the only place rejection history lives, and it is unindexed by recipe. |
| 2.5 | Recipe Variants (duplicate → A/B → promote) | **NOT BUILT** | No variant model. `saveRecipe` (`src/recipesHttp.ts:345`) writes a single YAML keyed by `name`. The B-PR4 work (Phase 5) introduces a load-time hard error on YAML-vs-YAML name collisions per DP-14, which **closes the door** on the simplest variant approach (two YAMLs, same `name`) and requires variants to be modelled explicitly (separate `name` + lineage pointer, or sub-doc within one YAML). |

**Summary**: 0 BUILT, 2 PARTIAL (Dry-Run, Run Timeline), 3 NOT BUILT.
The strategic plan's claim that "Recipe/webhook/orchestration primitives exist"
is true at the substrate layer; the **lifecycle UX layer is almost entirely
unbuilt**.

---

## 2. Strategic deliverable → dogfood PR dependency graph

PR IDs match `PLAN-MASTER-V2.md §3`. Phase 1 (A-PR1, A-PR2, A-PR4) is landed
on `main` (commits `be408a2`, `c7b4169`, `2257dce`). Everything below
gates on the remaining 11 PRs.

| Lifecycle deliverable | HARD-blocking PRs | SOFT-blocking PRs | Independent of |
|---|---|---|---|
| **2.1 Conversational Recipe Builder** | **A-PR1** (vars + path jail — generated YAML can include user-controlled `path:` and HTTP `vars`; without the jail, NL→YAML is a sandbox-escape vector); **A-PR3+B-PR2** (atomic temp+rename write — the builder will install YAML; concurrent install + run from another process must not corrupt the file; covers F-06); **B-PR4+C-PR4** (single canonical resolver — builder must save through the same path the runner reads, otherwise install-then-run can hit the JSON-vs-YAML or YAML-vs-YAML shadow); **A-PR2** (install host allowlist + per-route body cap — the builder will also be the install path for marketplace packs); **C-PR1** (lint whitelist — builder uses lint as its acceptance gate; today's 100% false-positive rate would block every generation per #8). | **B-PR1a** (silent-fail floor — recipes generated by an LLM are extra likely to ship a `linear.createIssue` step that returns bare `{error}`; without the F6/F7/F8 generalized detector the demo "it ran successfully" lies). | **C-PR3** (trigger wiring — builder produces YAML; trigger firing is orthogonal). **B-PR3** (resolver unification for `kind:prompt` JSON — builder will only emit YAML). |
| **2.2 Recipe Dry-Run UX** | **C-PR1** (4-root lint whitelist — dry-run plan embeds `lint.errors[]`/`lint.warnings[]` per `src/commands/recipe.ts:798-801`; today's whitelist false-positives every recipe). **C-PR2** (`recipe run --dry-run` exit-code unification, B-cli #31 — without this, "would-have-run" output cannot be machine-checked in CI). **A-PR3+B-PR2** (`hasWriteSteps` blind to chained — `RecipeDryRunPlan.hasWriteSteps` at `src/commands/recipe.ts:790` is the headline "this will write" badge in dry-run UX; F-07 makes it a lie for the most interesting case). **C-PR5** (camelCase aliases — dry-run plan resolves tool ids via registry; F4/F9 mean alias collisions can show wrong `isWrite`/`isConnector`). | **B-PR1a** (silent-fail floor — dry-run UX should be able to say "this step would succeed silently and lose data" before the user runs). | **B-PR1b** (registrySnapshot delta — dry-run does not produce snapshots). **C-PR3** (triggers — dry-run is invocation-time). |
| **2.3 Recipe Run Timeline** | **B-PR1a** (post-step pipeline at all 4 sites — without it, the timeline lies about chained step status; #2, #11). **B-PR1b** (`runlogVersion: 2` + `registryFinalSnapshot` + dashboard branch reader — the per-step delta is what makes step rows tractable to render; today's full-snapshot-per-step is unbounded and `runs.jsonl` rotates oversized rows away per `src/runLog.ts:425-431`). **C-PR3** (nested child-run records — without this, `Webhook → recipe A → recipe B` is invisible at `/runs`; closes I-e2e #9). | **A-PR3+B-PR2** (atomic write + maxDepth/maxConcurrency clamps — timeline becomes meaningless if depth is unbounded). | **A-PR1**, **A-PR2** (security PRs — orthogonal to timeline). **B-PR3** (resolver — timeline reads `runs.jsonl`, not the resolver). |
| **2.4 Recipe Trust Graduation** | **B-PR1a** (silent-fail floor — auto-graduating a recipe whose chained step silently lost data is the worst-case regression; trust state must be derived from observed-true success). **C-PR3** (nested child-run records — graduation needs to know if nested calls succeeded; without I-e2e #9 fix, the parent recipe gets credit for a child failure). | **B-PR4+C-PR4** (single canonical resolver + collision hard error — trust state keyed on `recipe.name` requires names to be unique; DP-14). **A-PR4** (already landed — permissions sidecar deletion + dashboard copy honesty fix is the **prerequisite** for trust graduation to be honest UX, since the old "permissions" copy implied trust controls already existed). | **A-PR1/A-PR2** (security floor; orthogonal). **B-PR3** (resolver). **C-PR1** (lint). |
| **2.5 Recipe Variants** | **B-PR4+C-PR4** (load-time hard error on YAML-vs-YAML name collision per DP-14 — variants need a lineage model that does *not* rely on shared `name`). **C-PR3** (multi-yaml package registration per I-e2e #6 — variant promotion needs registry to track multiple YAMLs in one install dir). | **B-PR1b** (delta snapshots — variant A/B comparison reads per-step deltas). | Everything else. Variants are last in the chain. |

**Critical-path summary**: Lifecycle 2.3 (Run Timeline) is the densest
dependency — gates on **B-PR1a, B-PR1b, AND C-PR3**, spanning Phases 2 and 6
of the dogfood plan. Lifecycle 2.4 (Trust Graduation) shares those two but
is functionally optional until 2.3 lands. Lifecycle 2.1 (Builder) gates on
**five** PRs across four phases.

---

## 3. Sequencing recommendation

Dogfood phases (per `PLAN-MASTER-V2.md §9`): Phase 1 done (week 1, landed);
Phase 2 (week 2) = B-PR1a, B-PR1b; Phase 3 (week 3) = C-PR1, C-PR2, C-PR5,
C-PR6; Phase 4 (week 4) = A-PR3+B-PR2; Phase 5 (week 5) = B-PR3,
B-PR4+C-PR4; Phase 6 (week 6) = C-PR3, A-PR5.

Earliest credible ship dates **assuming dogfood holds its 6-week schedule
and lifecycle work starts in parallel at end of week 2**:

| Lifecycle deliverable | Earliest ship | Critical-path PR(s) | Lifecycle work eff. weeks |
|---|---|---|---|
| 2.2 Recipe Dry-Run UX (MVP, write-blind) | **end of week 4** | C-PR1, C-PR2, A-PR3+B-PR2 (for `hasWriteSteps` honesty) | ~2 weeks of UX work, can run weeks 3-4 |
| 2.3 Recipe Run Timeline (parent runs only, no nested) | **end of week 3** | B-PR1a, B-PR1b | ~1.5 weeks; can ship before C-PR3 if "child runs not yet visible" is acceptable |
| 2.3 Recipe Run Timeline (full, with nested + ActivityLog/Approval correlation) | **end of week 7** | C-PR3 (week 6) + 1 week wiring | ~3 weeks total |
| 2.1 Conversational Recipe Builder | **end of week 7** | A-PR3+B-PR2 (week 4), C-PR1 (week 3), B-PR4+C-PR4 (week 5) + 2 weeks builder work | ~2-3 weeks; LLM endpoint + UX |
| 2.4 Recipe Trust Graduation | **end of week 9** | C-PR3 (week 6) + state machine + dashboard work | ~3 weeks after C-PR3 |
| 2.5 Recipe Variants | **end of week 10+** | B-PR4+C-PR4 (week 5), C-PR3 (week 6) + lineage model design | ~4 weeks; defer to roadmap "10-16 week" bucket per strategic plan §"Recommended roadmap" |

**Ship order recommendation**: 2.3 (parent-only) → 2.2 → 2.1 → 2.3 (full) →
2.4 → 2.5. Ship 2.3-parent-only at week 3 to give users *something* before
the heavy week-6 C-PR3 work lands; iterate the timeline UI with nested
support when C-PR3 ships. Do not block 2.1 on 2.3-full — the builder
demo only needs the timeline to render parent runs.

**Critical-path dogfood PRs for lifecycle**: in dependency-cumulative order,
**B-PR1a → B-PR1b → C-PR1 → A-PR3+B-PR2 → B-PR4+C-PR4 → C-PR3**. If any
single one slips, the entire downstream chain pushes one week. C-PR3
("HIGH risk, 6-8 days, re-fire storms" per `PLAN-MASTER-V2.md §6`) is the
most likely slip point.

---

## 4. Conversational Recipe Builder — UX spec

### Surface

- **MCP tool**: `recipeBuilderDraft` (full mode) — input: `description: string, examples?: string[]`. Output: `{yaml: string, explanation: string, requiredConnectors: string[], missingConnectors: string[], lint: LintResult, dryRunPlan: RecipeDryRunPlan, riskSummary: {hasWriteSteps: boolean, externalConnectors: string[], maxConcurrency: number, estimatedRiskTier: RiskTier}, draftId: string}`. **Does not save.**
- **MCP tool**: `recipeBuilderInstall` — input: `{draftId: string, confirm: true}`. Output: `{installedAt: string, recipePath: string, name: string}`. Re-validates, re-runs jail check, then calls existing `saveRecipe` at `src/recipesHttp.ts:345` so existing storage path is reused (no new write site).
- **HTTP endpoint**: `POST /recipes/draft` (mirrors tool). Body: `{description, examples?}`. 32 KB cap, reuse the per-route helper from A-PR2. `POST /recipes/draft/:draftId/install` mirrors `recipeBuilderInstall`.
- **Dashboard**: replace today's hand-form `dashboard/src/app/recipes/new/page.tsx` with a two-pane view: left = chat textarea, right = generated YAML + explanation + "Install" button. Hand-form retained behind a "Show advanced" toggle.

### Prompt-engineering approach

Multi-turn, schema-constrained:

1. **Turn 1 (LLM, structured-output)**: pass `description`, full registered tool list
   (from `src/recipes/toolRegistry.ts` — `getTool` / `listTools`), the recipe JSON
   schema (from `src/recipes/schemaGenerator.ts` `generateSchemaSet`), and 3-5 in-context
   example YAMLs from `~/.patchwork/templates/recipes/`. Ask for `{recipe: <YAML
   string>, rationale: <string>, requiredTools: <string[]>, riskNotes: <string>}`.
2. **Turn 2 (deterministic)**: parse YAML, run `validateRecipeDefinition`
   (`src/recipes/validation.ts:24`). If lint errors → re-prompt LLM with the
   error list and YAML; max 2 repair iterations.
3. **Turn 3 (deterministic)**: run `runRecipeDryPlan` in-memory (without
   loading from disk — extend `src/commands/recipe.ts:840` to accept an
   in-memory `YamlRecipe`). Compute `requiredConnectors` from
   `dryRunPlan.connectorNamespaces`; cross-check against registered
   connectors via `getTool` to populate `missingConnectors`.

Single-shot fallback if Turn 1 lint passes on first try.

### Output contract (TypeScript)

```ts
interface RecipeBuilderDraft {
  draftId: string;            // 16-char hex; expires 15 min
  yaml: string;               // canonical YAML
  explanation: string;        // 1-paragraph plain English
  requiredConnectors: string[]; // namespaces (e.g. ["gmail", "linear"])
  missingConnectors: string[];  // subset not registered locally
  lint: LintResult;             // src/recipes/validation.ts:17
  dryRunPlan: RecipeDryRunPlan; // src/commands/recipe.ts:775
  riskSummary: {
    hasWriteSteps: boolean;     // honest after A-PR3+B-PR2 lands
    externalConnectors: string[];
    maxConcurrency: number;
    estimatedRiskTier: "low"|"medium"|"high";
  };
}
```

### Install confirmation flow

1. Draft returned with `draftId` (server-side TTL cache, `Map<draftId, {yaml, expiresAt}>`, 15-min TTL, max 100 entries).
2. Dashboard renders YAML + dry-run plan + risk summary.
3. User clicks "Install" → `POST /recipes/draft/:draftId/install` with `confirm: true`.
4. Server re-runs `validateRecipeDefinition` (defense in depth — never trust the cached draft) + a fresh path-jail check on any `path:` references.
5. On success, calls `saveRecipe` (`src/recipesHttp.ts:345`); the existing dashboard listing endpoint picks up the new file.
6. **Refuse install if any of**: `lint.errors.length > 0`; `riskSummary.hasWriteSteps && missingConnectors.length > 0`; YAML name collides with existing recipe (B-PR4+C-PR4 hard error per DP-14 — bubble through cleanly).

The crucial existing surface this reuses: `validateRecipeDefinition` +
`runRecipeDryPlan` + `saveRecipe`. The builder is purely an **orchestration
layer**; the runner-side surfaces (and their A-PR1 jail floor) do all the
heavy validation.

---

## 5. Recipe Run Timeline data model

### Schema

Extend `RunStepResult` (`src/runLog.ts:34-53`) with three optional, additive
fields (consumers ignore unknowns per the comment at `src/runLog.ts:21`):

```ts
interface RunStepResult {
  // ...existing fields...
  /** Activity-log entry ids touched by this step. */
  activityIds?: number[];   // joins to ActivityLog.entries[].id
  /** Approval calls created during this step. */
  approvalCallIds?: string[];  // joins to ApprovalQueue PendingApproval.callId
  /** If this step invoked a nested recipe, the child run's seq. */
  childRunSeq?: number;     // joins to RecipeRun.seq for the nested run
}
```

Extend `RecipeRun` (`src/runLog.ts:55-89`) with:

```ts
interface RecipeRun {
  // ...existing...
  /** Parent run's seq if this run was triggered by a nested-recipe step. */
  parentRunSeq?: number;
  /** Step id in parent that triggered this run. */
  parentStepId?: string;
  /** Trigger payload (webhook body, cron source, etc.) — already stored
   *  partially in outputTail; promote to a structured field. */
  triggerPayload?: { kind: "webhook"|"cron"|"recipe"|"manual"; data?: unknown };
  /** runlogVersion 2 from B-PR1b. */
  runlogVersion?: 1 | 2;
  /** Final OutputRegistry snapshot from B-PR1b — replaces per-step
   *  full snapshots with deltas + this end-of-run anchor. */
  registryFinalSnapshot?: Record<string, unknown>;
}
```

### What B-PR1b already delivers

Per `HANDOFF-engineering-briefs.md` B-PR1b section and `PLAN-MASTER-V2.md`
amendments R1-A1/R3-A1: `runlogVersion: 2`, `registryFinalSnapshot` on
`RecipeRun`, per-step `registrySnapshot` shifts from full snapshot to
delta, dashboard branch reader in
`dashboard/src/app/runs/[seq]/page.tsx` + `dashboard/src/lib/registryDiff.ts`.
3+ round-trip tests (v1-only, v2-only, mixed) per R3-#3.

**What's still missing after B-PR1b**: the three new join fields above
(`activityIds`, `approvalCallIds`, `childRunSeq`), plus `parentRunSeq`
/`parentStepId` on `RecipeRun`, plus the nested-recipe `appendDirect` call
that C-PR3 promises (per I-e2e #9). C-PR3 closes `childRunSeq` and
`parentRunSeq`; the ActivityLog + Approval joins are net-new lifecycle work.

### Wiring

- **ActivityLog join**: in `chainedRunner.ts:438-471` and `yamlRunner.ts:540-621`, snapshot `activityLog.size()` (or its private id counter) before/after the inner `executeTool` call; the diff is `[lo+1..hi]`. Stash on the step result. ActivityLog already exposes `subscribe()` (`src/activityLog.ts:60`) but no `markRange()` helper — would need a small addition: `getNextId(): number`.
- **ApprovalQueue join**: pass the run seq into the approval queue context. `ApprovalQueue.request()` (`src/approvalQueue.ts:113`) currently takes no run context; add an optional `originRecipeRunSeq` opt that gets stamped on the entry. On resolve, write back `approvalCallIds` to the matching step.
- **childRunSeq**: in `nestedRecipeStep.ts` (currently does **not** call `runLog.appendDirect` — see `src/recipes/chainedRunner.ts:653,931` gating on `depth === 0`), invoke the parent's runlog with `appendDirect`/`startRun` for `depth > 0`, capture the assigned seq, propagate up so the parent step gets `childRunSeq` populated. This is what C-PR3's I-e2e #9 fix delivers.

### Dashboard query

`GET /runs/:seq?include=tree` returns:

```jsonc
{
  "run": RecipeRun,
  "steps": RunStepResult[],
  "children": {
    [stepId]: { "run": RecipeRun, "steps": RunStepResult[] }
  },
  "activity": {
    [activityId]: ActivityEntry  // looked up via ActivityLog.query
  },
  "approvals": {
    [callId]: PendingApproval | { resolved: ApprovalDecision; resolvedAt }
  }
}
```

Implement at `src/recipeRoutes.ts:472` (existing `/runs/:seq` route)
behind an `?include=tree` opt-in to keep the simple 1-run shape backward
compatible.

---

## 6. Recipe Trust Graduation — state machine

### States

- **`draft`** — recipe saved but never run successfully end-to-end.
- **`manual`** — successfully run ≥ 1 time; every invocation requires explicit user trigger.
- **`ask-every-time`** — webhook/cron/file-watch eligible; every fire pauses for approval before any high-risk step.
- **`ask-on-novel`** — fires automatically when invocation pattern matches a previously-approved one (same trigger payload shape, same connector targets, same approximate input volume); novel patterns escalate to ask-every-time semantics for that fire only.
- **`mostly-trusted`** — fires automatically; only individual high-risk steps (per `riskTier.ts:40`) prompt.
- **`trusted-within-scope`** — fires automatically with no per-step prompt **as long as** invocation stays within the scoped envelope (declared at graduation: `{maxRunsPerHour, allowedConnectors, maxWritesPerRun}`); breaches drop one tier and notify.

### Transitions and backing data

| From → To | Trigger | Backing data |
|---|---|---|
| draft → manual | first successful run | `RecipeRun.status === "done"` for that recipe |
| manual → ask-every-time | user explicit opt-in via dashboard | dashboard POST sets state |
| ask-every-time → ask-on-novel | ≥ 5 successful auto-fires with no rejections **and** ≥ 14-day cooldown since recipe last edited | aggregate over `RecipeRun` + ApprovalQueue history |
| ask-on-novel → mostly-trusted | ≥ 20 successful approvals + ≤ 2 rejections in last 30 days **and** novelty heuristic stable (≥ 3 distinct invocation patterns each seen ≥ 3 times) | same |
| mostly-trusted → trusted-within-scope | user explicit opt-in **and** scope envelope declared | dashboard POST sets state + envelope |
| any → ask-every-time | scope breach OR new tool added to recipe OR recipe edited | recipe-edit detected via content hash; tool list change detected at lint time |
| any → draft | user explicit "reset trust" | dashboard POST |

### State storage

New file: `~/.patchwork/recipe-trust.jsonl` (append-only, same pattern as
`runs.jsonl`), keyed by `recipeName`. Latest row wins; rotation at
`MAX_PERSIST_LINES` matches `runLog.ts:102`. Schema:

```ts
interface RecipeTrustRecord {
  recipeName: string;
  state: "draft"|"manual"|"ask-every-time"|"ask-on-novel"
       | "mostly-trusted"|"trusted-within-scope";
  recipeContentHash: string;   // sha256 of canonical YAML
  successCount: number;
  rejectionCount: number;
  lastTransitionAt: number;
  scope?: { maxRunsPerHour?: number; allowedConnectors?: string[]; maxWritesPerRun?: number };
  updatedAt: number;
}
```

### Connection to existing ApprovalGate risk tiers

`riskTier.ts:40` already classifies every tool into `low/medium/high`.
The trust state determines **which prompts get suppressed**:

- `mostly-trusted`: high-tier tools still prompt; medium auto-approve.
- `trusted-within-scope`: all tiers auto-approve unless scope breaches.

Implement as an `ApprovalGate` decorator that reads `recipe-trust.jsonl`
before forwarding to `ApprovalQueue.request()`. The decorator is the
single point of trust enforcement; ApprovalQueue itself stays unchanged.

### Why this gates on B-PR1a + C-PR3

- B-PR1a: trust counts must reflect *honest* success. If chained
  silent-fail (#2) is uncaught, `successCount` increments on hidden
  failures — the worst possible case for an automated trust system.
- C-PR3: nested child runs must record `RecipeRun` rows so the parent
  recipe's `successCount` doesn't get credit for invisible nested
  failures (I-e2e #9, #12).

---

## 7. Recipe Dry-Run UX — spec

### Backend contract

Reuse `RecipeDryRunPlan` (`src/commands/recipe.ts:775-802`) — already
versioned (`schemaVersion: 1`) and stable. Extend with two fields:

```ts
interface RecipeDryRunPlanStep {
  // ...existing fields...
  /** Mocked output the step *would have* produced if the recipe was last
   *  successfully replayed; sourced from the most recent RecipeRun's
   *  RunStepResult.output. Absent if no prior successful run. */
  wouldHaveProduced?: { value: unknown; sourceRunSeq: number };
  /** Side-effect labelling: "mocked" if a prior run captured output,
   *  "would-mutate" if no capture and isWrite, "would-read" otherwise. */
  sideEffect?: "mocked"|"would-mutate"|"would-read"|"would-call-llm";
}
```

This bridges Recipe Dry-Run UX to `replayRun` (`src/recipes/replayRun.ts:1-60`)
which already builds `mockedOutputs` from prior runs. The UX surface
is the *plan view*; replayRun is the *execution view*.

### Dashboard view

New route: `dashboard/src/app/recipes/[name]/dry-run/page.tsx`. Layout:

1. **Trigger pane** — recipe trigger config + variable inputs (typed per
   recipe `vars:` block, validated client-side via the same regex A-PR1
   ships server-side: `/^[\w\-. :+@,]+$/u`).
2. **Steps tree** — render `dryRunPlan.steps`/`dryRunPlan.parallelGroups`
   as a DAG. Per step show: `id`, `tool`/`agent prompt`, resolved params
   (post-template), `into:`, dependencies, `risk` badge (color-coded
   per tier), `sideEffect` badge, `wouldHaveProduced` preview if present.
3. **Approval points** — overlay markers on steps with `risk: "high"`
   or `isWrite: true`; show "Approval: this user / not yet"
   based on trust state.
4. **Header summary** — `hasWriteSteps`, `connectorNamespaces`,
   `lint.errors[]`/`lint.warnings[]`. **Refuse "Run for real" if any
   `lint.errors[]`.**
5. **Mocked vs unmocked legend** — green dot = `mocked` (replay-safe),
   yellow = `would-read` (real read on run), red = `would-mutate`
   (write on run). Legend visible at all times.

### "Run mocked" button

Calls existing `POST /runs/:seq/replay` at `src/recipeRoutes.ts:495-526`
(VD-4 mocked replay) — already implemented, just needs UX surfacing.
Result panel shows the new run's seq + diff against the captured run.

### CLI parity

`patchwork recipe dry-run <name>` should emit the same JSON as the dashboard
consumes (single source: `runRecipeDryPlan`). Fixes B-cli #31 by exiting
non-zero when `lint.errors[]` is non-empty.

---

## 8. Bugs the lifecycle work depends on staying fixed

These are F-04 through F-09 from `G-security.md` (lines 101-204) plus their
adjacent runner-correctness bugs. Each is closed in dogfood phases 1, 2, or
4. **If any regress, the named lifecycle deliverables degrade as listed.**

| Bug | Fix PR | Lifecycle deliverable that regresses if reopened |
|---|---|---|
| **F-04** chained `recipe:` accepts arbitrary paths | A-PR2 (landed) | **2.1 Builder** — generated NL recipes that include nested calls become a sandbox-escape primitive; **2.5 Variants** — variant linking via nested-recipe pattern unsafe. |
| **F-05** install accepts arbitrary HTTPS URLs | A-PR2 (landed) | **2.1 Builder** — install confirmation flow re-runs install path; SSRF reopens; **Phase 5 marketplace bundles** (out of scope here but adjacent). |
| **F-06** concurrent runs race-overwrite output | A-PR3+B-PR2 (week 4) | **2.3 Run Timeline** — chained-run nodes show inconsistent state if two concurrent runs interleave registry writes; **2.4 Trust Graduation** — `successCount` increments on a run whose output got clobbered. |
| **F-07** `hasWriteSteps` blind to chained sub-recipe writes | A-PR3+B-PR2 (week 4) | **2.2 Dry-Run UX** — the headline "this will write" badge lies for the most interesting recipes (chained); **2.4 Trust** — a recipe declared "read-only" on the trust UI silently writes via nested call. |
| **F-08** request body unbounded | A-PR2 (landed) | **2.1 Builder** — `/recipes/draft` and `/recipes/draft/:id/install` are new POST surfaces; without per-route caps they reopen the body-cap class. |
| **F-09** `maxConcurrency` unbounded | A-PR3+B-PR2 (week 4) + maxDepth (R2-H1) | **2.3 Run Timeline** — DoS via `maxDepth: 100` self-call makes the tree view unrenderable; **2.4 Trust** — auto-fire of a `trusted-within-scope` recipe with hostile `maxConcurrency` can fork-bomb the bridge. |
| **#2** `detectSilentFail` not in chained | B-PR1a (week 2) | **2.4 Trust** — `successCount` increments on undetected silent failure. |
| **#11** silent agent skip | B-PR1a (week 2) | **2.3 Run Timeline** — step shows "ok" when agent never ran; **2.4 Trust** — same as #2. |
| **#1 / F-07** `hasWriteSteps` blind | A-PR3+B-PR2 | dup of F-07 above. |
| **F6/F7/F8** generalized silent-fail (linear/gmail/jira shapes) | B-PR1a [R3-#5] | **2.1 Builder** demos with these exact connectors (per the strategic-plan example NL prompt: "support email from VIP customer, find related Linear issues") will lie about success without the generalized detector. |
| **I-e2e #9** nested child failure invisible from `/runs` | C-PR3 (week 6) | **2.3 Run Timeline** — half the timeline literally not in the data store; **2.4 Trust** — child failure not counted. |
| **R2-H3** in-memory `FileLock` not cross-process | A-PR3+B-PR2 [R2-H3] | **2.1 Builder** — `recipeBuilderInstall` runs in the bridge process; cron scheduler in the same process; subprocess Claude driver in a different process. Without OS-level lock, install + concurrent run from cron corrupts the file. |

---

## 9. Open questions for the maintainer

1. **Builder LLM provider model**. Should `recipeBuilderDraft` use the same
   `--claude-driver` (`subprocess` / `api`) configured for `runClaudeTask`,
   or a separate flag? Risk: the user's CC subscription quota gets consumed
   by recipe authoring; for headless deployments (no CC subscription) the
   builder must support `api` mode. Recommend: reuse `--claude-driver` but
   add explicit cost-warning on first use.
2. **Builder output: structured outputs vs prose-then-parse**. Structured
   outputs are reliable but model-specific (Claude 4.7 supports it well).
   Prose-then-parse via YAML codeblock works on more drivers but has
   higher repair-loop cost. Recommend structured outputs with prose
   fallback; needs maintainer sign-off on driver-feature gating.
3. **Trust-graduation thresholds** (5/14d, 20/30d, 3-distinct-3-each).
   These numbers are placeholder. Are these defensible defaults for a
   single-user runtime, or should they be per-policy-tier (e.g.
   "developer" mode vs "regulated-industry" mode per strategic-plan
   Phase 4)?
4. **Trust state **per-recipe** vs **per-(recipe, trigger-source)****?
   A recipe may be trusted when fired by webhook from an authenticated
   iPhone Shortcut but not when fired by `recipe run` CLI from a shared
   VPS. Recommend the latter; doubles the state-machine surface.
5. **Variant lineage model** (post-DP-14). Three options: (a) `variantOf:
   <parent-name>` field on the YAML, treated as metadata only; (b)
   sub-document layout (`variants:` block within one YAML); (c) explicit
   variants directory with parent symlink. Pick before 2.5 work begins.
6. **Approval-runlog join when bridge restarts mid-approval**.
   `ApprovalQueue` state is in-memory (`src/approvalQueue.ts:1-30`); a
   bridge restart loses pending approvals. After 2.3 ships, the
   `RecipeRun.stepResults[i].approvalCallIds` field will dangle. Should
   the join field record the **resolved decision** at write time
   (immutable, rehydration-safe) instead of the callId? Recommend yes,
   plus `decisionAt` timestamp.
7. **Dashboard write semantics for trust transitions**. The "user
   explicit opt-in" transitions (manual → ask-every-time, mostly →
   trusted-within-scope) require an authenticated dashboard call. Today's
   dashboard auth is shared bridge-token; for trust transitions
   specifically, should we require a fresh approval-token round-trip
   (per the mobile oversight MVP wire shapes from prior work)? Trust
   downgrade is the inverse problem — should never require a token.
8. **Conversational builder: handle "modify existing recipe"**. The spec
   above is single-turn-from-scratch. The natural follow-up — "make this
   recipe also CC the security team" — needs the existing recipe in
   context. Cheap version: load the YAML and append to the system prompt.
   Expensive version: edit-mode with a structured diff. Recommend cheap;
   defer edit-mode to post-2.5.
9. **What runs first when**. Strategic-plan Phase 1 ("Live Toolsmithing")
   is independent of all of Phase 2 lifecycle work; the strategic-plan
   "Highest-leverage first moves" list ranks Conversational recipe
   authoring at #3. Should the lifecycle agent take "ship 2.3 parent-only
   at week 3" as a hard commitment, or block all lifecycle work until
   the dogfood floor is fully done at week 6? Recommend the former; the
   memo above assumes parallel execution starting end of week 2.
10. **Dependency on `RecipeOrchestrator` extraction** (per memory note
    `project_recipe_orchestrator.md`). The Phase 1 parity tests landed
    2026-04-25 but the bridge-wide concurrency cap (DP-3 follow-up) is
    deferred. Lifecycle 2.4's `scope.maxRunsPerHour` envelope is the
    natural place for that bridge-wide cap to live. Should 2.4 work
    drive that orchestrator extraction continuation, or wait?

---

## Appendix: file pin index

- Recipe runner internals: `src/recipes/yamlRunner.ts:1-1548`,
  `src/recipes/chainedRunner.ts:1-1060`,
  `src/recipes/replayRun.ts:1-144`,
  `src/recipes/nestedRecipeStep.ts:1-40`,
  `src/recipes/validation.ts:1-586`.
- Run log + types: `src/runLog.ts:34-89`, `src/activityTypes.ts:9-32`.
- HTTP surfaces: `src/recipeRoutes.ts:439-548`, `src/recipesHttp.ts:265-625`.
- Dry-run plan: `src/commands/recipe.ts:751-916`.
- Dashboard: `dashboard/src/app/runs/[seq]/page.tsx:1-986`,
  `dashboard/src/app/recipes/new/page.tsx:1-1074`,
  `dashboard/src/lib/registryDiff.ts:1-168`.
- Approval / risk: `src/approvalQueue.ts:1-264`, `src/riskTier.ts:1-40`.
- Dogfood master plan: `docs/dogfood/recipe-dogfood-2026-05-01/PLAN-MASTER-V2.md`.
- Per-PR engineering briefs: `docs/dogfood/recipe-dogfood-2026-05-01/HANDOFF-engineering-briefs.md`.
