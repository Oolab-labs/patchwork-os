# Dogfood D — Template Engine + Output Registry parity (2026-05-01)

Bridge: `http://127.0.0.1:3101` (alpha.35, MCP `patchwork-local`).
Workspace: `/Users/wesh/Documents/Anthropic Workspace/Patchwork OS`.
Recipes dir: `~/.patchwork/recipes/`.
Probe scripts: `/Users/wesh/Documents/Anthropic Workspace/Patchwork OS/.tmp-dogfood/probe.mjs`,
`/Users/wesh/Documents/Anthropic Workspace/Patchwork OS/.tmp-dogfood/probe2.mjs`.
Method: imported compiled `dist/recipes/*.js` from a one-shot Node script,
fed inline fixtures, cross-checked vs runtime by hitting `GET /recipes` and
`GET /runs/:seq` on the live bridge.

---

## TL;DR — answers to the brief

1. **Linter and chained-runner disagree on the `{{steps.X.data}}` grammar.** PR #103
   did NOT fix this. The "camelCase aliases" in #103 are tool-name aliases
   (`linear.listIssues` → `linear.list_issues`), not template aliases. The two
   recipes flagged in the prior dogfood (`branch-health`, `triage-brief`) still
   produce 6/5 false-positive lint errors against templates that the chained
   runner resolves correctly.
2. **The same root-mismatch hits `{{env.X}}`.** Fixture `p3-env` and `p3b-env-no-context`
   both lint-fail with `Unknown template reference '{{env.HOME}}'`. None of the
   16 installed recipes that use `{{env.HOME}}` / `{{env.DATE}}` are flagged
   only because they are all `chained` recipes — and PROBE-4a / PROBE-5b show
   even chained recipes get `{{env.X}}` rejected; the live `/recipes` lint
   results are passing for `branch-health` only because the runner code path
   is generating the rejection at *step 3* (the agent.prompt) rather than at
   the env line in step 4 — *both* lint errors fire in reality, masking each
   other (see "false-positive density" below).
3. **`{{YYYY-MM-DD}}`, `{{ISO_NOW}}`, `{{YYYY-MM}}` are linter ghosts.** Linter
   advertises them as built-in keys (`validation.ts:357-362`). yamlRunner only
   seeds `date` and `time` into the runtime ctx (`yamlRunner.ts:407-412`).
   chainedRunner's templateEngine rejects them as compile errors because they
   lack a `steps.` / `env.` prefix.
4. **`{{steps.X.output}}` and `{{steps.X.result}}` are not supported.** Only
   `data`, `status`, and `metadata` are valid step accessors
   (`templateEngine.ts:193-202`).
5. **`output:` keyword is honored, but only via legacy normalization.**
   `legacyRecipeCompat.ts:160-165` renames `step.output` → `step.into` with a
   deprecation warning. No code path treats `output:` as a first-class alias
   — it's a deprecated synonym. The linter and chained runner both see
   `into:` after normalization. Recipes still using `output:` print a warning
   on every load.
6. **VD-2 capture parity bug from prior dogfood is unfixed.** `captureForRunlog`
   is imported only by `chainedRunner.ts:10`. yamlRunner emits the bare
   4-field shape (`id/tool/status/durationMs`). Confirmed empirically from
   live `GET /runs/3233` (yaml stale-branches) vs `GET /runs/3236` (chained
   branch-health). #65 added VD-2 captures only to the chained runner.
7. **`detectSilentFail` parity bug.** Imported only by `yamlRunner.ts:43`.
   chainedRunner does NOT call it. Confirmed: live chained `branch-health`
   run #3236 has step `stale` with `status: "ok"` while
   `output: "(git branches unavailable)"` — the silent-fail detector would
   have flagged that string as `error` if it had run.
8. **schemaGenerator's recipe schema rejects `kind: prompt` JSON recipes.**
   `daily-status.json` produced 206 schema errors against the generated
   recipe schema, while the linter only flagged 1. Schema reject is correct
   for the YAML pipeline; the JSON recipe runs via a totally separate
   `loadRecipePrompt` path (`recipesHttp.ts:995`) that bypasses lint and
   schema entirely.

---

## Parity matrix

| Placeholder / keyword | parser.ts | validation.ts (lint) | yamlRunner | chainedRunner |
|---|---|---|---|---|
| `{{date}}` | N/A | pass — built-in (`validation.ts:357`) | pass — seeded by runner (`yamlRunner.ts:408`) | **fail** — `Invalid expression: date` (`templateEngine.ts:118`, requires `steps.`/`env.` root) |
| `{{time}}` | N/A | pass — built-in (`validation.ts:357`) | pass — seeded (`yamlRunner.ts:409`) | **fail** — same as above |
| `{{YYYY-MM-DD}}` | N/A | **pass — built-in** (`validation.ts:357`) | **fail** — never seeded into ctx; renders `""` | **fail** — compile error: `Invalid expression: YYYY-MM-DD` |
| `{{YYYY-MM}}` | N/A | **pass — built-in** (`validation.ts:357`) | **fail** — never seeded; renders `""` | **fail** — compile error |
| `{{ISO_NOW}}` | N/A | **pass — built-in** (`validation.ts:357`) | **fail** — never seeded; renders `""` | **fail** — compile error |
| `{{file}}` (on_file_save) | N/A | pass — added via `registerRecipeContextKeys` (`validation.ts:293`) | pass — runner injects via seed ctx | pass — passed via `options.env`/seed |
| `{{file}}` (file_watch) | N/A | pass — fixed in #103 (`validation.ts:293`) | pass | pass |
| `{{env.HOME}}` (with `context: [{type:env,keys:[HOME]}]`) | N/A | **fail** — `Unknown template reference` (root="env" not in availableKeys; PROBE-3) | pass at runtime via `envCtx` (`yamlRunner.ts:396-405`) — but only if accessed as flat `{{HOME}}` not `{{env.HOME}}` | pass — `templateEngine.ts:165-171` resolves `env.X` via `context.env` populated from `process.env` |
| `{{env.HOME}}` (no context block) | N/A | **fail** (PROBE-3b) | pass via flat key only — `{{env.HOME}}` is dot-notation; renders `""` because there's no `env` key in flat ctx | pass — chained ctx always has full `process.env` (`yamlRunner.ts:1366`) |
| `{{steps.X.data}}` (chained id) | N/A | **fail** — `Unknown template reference` (`validation.ts:395-401`; PROBE-4a, PROBE-5b) | **fail** — yamlRunner has no `steps` key in flat ctx; renders `""` (PROBE-4c) | **pass** — `templateEngine.ts:123-126` resolves; live run #3236 confirms |
| `{{steps.X.status}}` | N/A | **fail** (PROBE 2nd run, "chained {{steps.fetch.status}} lint") | **fail** — same as above | **pass** — `templateEngine.ts:193` allows |
| `{{steps.X.metadata}}` | N/A | **fail** | **fail** | **pass** — accepted but typically empty |
| `{{steps.X.output}}` | N/A | **fail** | **fail** | **fail** — `templateEngine.ts:193-202`: `Invalid step accessor 'output'` |
| `{{steps.X.result}}` | N/A | **fail** | **fail** | **fail** — same |
| `{{steps.X.data.field}}` | N/A | warning if tool has outputSchema (`validation.ts:406-415`); error otherwise | **fail** | pass — walks via `pathRest` (`templateEngine.ts:206-222`); array indices supported (PROBE-extra `{{steps.issues.data.items.0.title}}` → "first") |
| `{{ }}` (whitespace-only) | N/A | N/A | renders `""` then literal | preserved as literal (`templateEngine.ts:69-77`) |
| `{{HOME}}` (bare ident) | N/A | linter sees no root match → fail | pass via flat-key lookup (`yamlRunner.ts:818`) | **fail** — compile error: `Invalid expression: HOME` |
| `{{flat_into_key}}` (chained recipe with `into: stale_branches` referenced as `{{stale_branches}}`) | N/A | pass — `registerStepContextKeys` adds `intoKey` (`validation.ts:554`) | pass — yamlRunner stores at `ctx[step.into]` | pass at lint level; **at runtime chainedRunner does NOT support flat-key resolution** — only `{{steps.<id>.data}}` works (templateEngine has no flat-key path) |
| `output:` step keyword | N/A | only honored after `normalizeRecipeForRuntime` rewrites it to `into:` (`legacyRecipeCompat.ts:160-165`); fires deprecation warning | same — normalized before run | same |
| `into:` step keyword | parser ignores everything except `id`, `agent`, `tool`, `params`, `risk`, `output` (`parser.ts:131,145`) | first-class — `validation.ts:549-554` | first-class — `yamlRunner.ts:533,635` | first-class via per-step id and `output: alias` (`chainedRunner.ts:42-43`) |
| `chain:` (nested recipe alias) | N/A | accepted (`validation.ts:92`) | normalized to `recipe:` (`legacyRecipeCompat.ts:150-157`) | accepted directly (`chainedRunner.ts:36,144`) |
| `kind: prompt` step | **fail** — parser requires `agent: true|false` (`parser.ts:122-150`; PROBE-10b) | **fail** — `Step 1: Must have 'tool', 'agent', 'recipe', or 'chain' field` (`validation.ts:94-99`) | N/A — JSON `kind:prompt` recipes don't go through yamlRunner; routed to `runClaudeTask` via `loadRecipePrompt` (`recipesHttp.ts:995-1047`) | N/A |
| `params: { ... }` (legacy) | parsed (`parser.ts:140-143`) | accepted via normalization that flattens (`legacyRecipeCompat.ts:142-147`) | flattened before run | flattened before run |

`parser.ts` column reads "N/A" for placeholder grammar because `parser.ts` only
checks structural fields; placeholder strings inside `path` / `content` /
`prompt` are not inspected at parse time (`renderTemplate` in `parser.ts:159`
is a different, untyped renderer used by tests, not by either runner).

---

## Detailed findings

### F1 — `{{steps.X.data}}` linter false-positive is unfixed

`extractTemplateDottedPaths` (`validation.ts:501-524`) splits on `.` and
returns `root="steps"` for `{{steps.stale.data}}`. Then `validateTemplateReferences`
(`validation.ts:392-405`) checks `if (!scopedKeys.has(root))` — `steps` is
not in `availableKeys` (the keys are `date`, `time`, `YYYY-MM`, `YYYY-MM-DD`,
`ISO_NOW` plus per-step `id` / `into`). Result: every chained recipe using
the canonical `{{steps.<id>.data}}` grammar gets a lint error per reference.

Live evidence (`/recipes` response captured 2026-05-01):
- `branch-health` → 6 lint errors, all `Step 3: Unknown template reference '{{steps.stale.data}}' in agent.prompt` shape.
- `triage-brief` → 5 lint errors of the same shape.

Runtime evidence (`GET /runs/3236` captured 2026-05-01):
- chained branch-health resolved `{{steps.stale.data}}` correctly: the
  `summarise.resolvedParams.agentPrompt` shows `STALE BRANCHES (no commits in
  14 days):\n(git branches unavailable)\n\nRECENT COMMITS (last 7 days):\n8f90817 fix(intellij)...`.
- The substituted commit log proves the chained runner read `registry["recent"].data`
  and inserted it at the placeholder.

**Severity: HIGH.** Anyone authoring a chained recipe that references prior
step output via the documented grammar gets a confusing lint error,
strongly implying their recipe is broken when it is correct.

### F2 — `{{env.X}}` linter false-positive

Same root cause as F1. `root="env"`, not in `availableKeys`. Even when the
recipe declares `context: [{type: env, keys: ["HOME"]}]`, the `availableKeys`
set picks up the literal string `"HOME"` (`validation.ts:331-336`), not `"env"`.
So `{{env.HOME}}` lint-rejects, but bare `{{HOME}}` lint-passes — the inverse
of what the recipe authoring docs imply.

PROBE-3 captured both shapes:
- `{ context: [{type:env,keys:["HOME"]}], steps:[{...content:"{{env.HOME}}"}] }` → 1 lint error.
- `{ steps:[{...content:"{{env.HOME}}"}] }` (no context block) → 1 lint error.

Why don't `branch-health` and `triage-brief` show this in their `firstError`?
Because the linter stops at the first error per template (`validation.ts:401`
`break`) and the `{{steps.X.data}}` references in earlier steps fire first.
After fixing F1, F2 will surface as a new wave of false-positives on
`branch-health.yaml:39`, `triage-brief.yaml:48`, `morning-brief.yaml`,
`debug-env.yaml`, etc.

### F3 — Linter advertises ISO_NOW / YYYY-MM-DD / YYYY-MM but no runner supplies them

`validation.ts:357-362`:
```
const builtinKeys = new Set<string>([
  "date", "time", "YYYY-MM", "YYYY-MM-DD", "ISO_NOW",
]);
```

yamlRunner only seeds `date` (line 408) and `time` (line 409). chainedRunner
seeds `DATE` and `TIME` (uppercase) into env (`yamlRunner.ts:1367-1369`)
plus the full `process.env`, then surfaces them only via `{{env.DATE}}`
shape — which lint-rejects per F2 anyway.

`{{YYYY-MM-DD}}`, `{{YYYY-MM}}`, `{{ISO_NOW}}` lint-pass and resolve to `""`
at runtime in both runners. `chainedRunner` makes it worse — they're
compile-rejected by `templateEngine.parseExpression` because they have no
`steps.`/`env.` prefix, so the *whole template string* errors out (PROBE-1c).

### F4 — `output:` is a legacy alias, not a first-class field

`legacyRecipeCompat.ts:160-165`:
```
if (typeof normalized.into !== "string" && typeof step.output === "string") {
  warn?.("Deprecated recipe step field: output — rename to into ...");
  normalized.into = step.output;
}
```

Every recipe using `output:` (which today includes `branch-health.yaml` and
`triage-brief.yaml`, the only two failing-lint chained recipes) prints a
deprecation warning on every load. The schema generator
(`schemaGenerator.ts:118-200`) does NOT include `output` in
`chainedStepMetadataProperties` — only `chainedRecipeStep` (the nested-
recipe variant) has it (`schemaGenerator.ts:192-200`). So a strict JSON
Schema check would reject `output:` on tool/agent steps.

### F5 — VD-2 capture is chained-runner-only

`captureForRunlog.ts` is imported by exactly one file:
`chainedRunner.ts:10`. yamlRunner emits 4-field stepResults
(`yamlRunner.ts:670-674`) with `id`, `tool`, `status`, `error`, `durationMs`
only. Live confirmation:

`GET /runs/3233` (yaml stale-branches):
```
"stepResults": [
  { "id": "stale", "tool": "git.stale_branches", "status": "ok", "durationMs": 14 },
  { "id": "file.write", "tool": "file.write", "status": "ok", "durationMs": 0 }
]
```

`GET /runs/3236` (chained branch-health):
```
"stepResults": [
  { "id": "stale", ..., "resolvedParams": {...}, "output": "...", "registrySnapshot": {...}, "startedAt": ... }
]
```

The dashboard's per-step diff hover and replay UI silently degrade for
yaml-runner recipes (which is most of the bundled set). Replay
(`POST /runs/:seq/replay`) only works for chained runs because it needs
`stepResultsList[i].output` — yaml steps don't have it.

### F6 — `detectSilentFail` is yamlRunner-only

`detectSilentFail.ts` is imported by exactly one runtime file:
`yamlRunner.ts:43`. chainedRunner doesn't call it. So
`(git branches unavailable)`, `[agent step skipped: ...]`, and
`{count:0,error:"..."}` placeholders pass through chained recipes silently
and feed downstream agents.

Live evidence: `GET /runs/3236` shows `stale.status: "ok"` despite
`output: "(git branches unavailable)"`. The `summarise` agent caught the
problem in its output ("data unavailable — `git for-each-ref` failed"),
but only because it was clearly a string saying "unavailable". A more
plausible-looking placeholder (e.g. an empty list `[]` returned by a
broken connector) would not be caught at all.

### F7 — Schema generator rejects `kind: prompt` JSON recipes

PROBE-8 ran `Ajv` against the generated `schemas.recipe` for every file
in `~/.patchwork/recipes/`. All YAML recipes pass except:

- `daily-status.json` (`kind: prompt` shape) — 206 schema errors;
  first: `must have required property 'tool'` against the
  `oneOf[0]` branch.
- `my-test-recipe.yaml` — pre-empted by YAML parse error
  (unrelated to schemas).

The 206-errors-vs-1-lint-error gap is because the generated schema's
`steps.items` is an `oneOf` over many tool schemas; AJV reports a
violation against every branch. The linter checks one structural
predicate (`hasTool || hasAgent || hasNestedRecipe`).

This is correct behavior for the YAML/chained runner, but the JSON-
`kind:prompt` shape runs via a wholly separate path (`loadRecipePrompt`
at `recipesHttp.ts:995`) that doesn't go through validation OR
schema. Result: `daily-status.json` works fine end-to-end despite being
rejected by both the linter and the schema validator — a third recipe
runtime that nobody documents.

### F8 — `parser.ts` is dead-or-divergent code

`parseRecipe` (`parser.ts:20-59`) is not called by either yamlRunner or
chainedRunner. It is exported and used only by `__tests__/parser.test.ts`
and `compiler.ts`. It implements a stricter subset:
- requires `version` field (none of the bundled recipes have one).
- requires `step.agent: true|false` (none of the bundled recipes have boolean `agent`).
- has its own `renderTemplate` (`parser.ts:159-175`) that resolves
  bare nested keys but doesn't handle `steps.X.data` or `env.X` either.

PROBE-10 / PROBE-10b confirm: parser.ts rejects every YAML recipe in
`~/.patchwork/recipes/`. Recommend either deleting parser.ts or
documenting that it's an alternative-DSL parser unrelated to the
runtime path.

### F9 — Legacy normalization shapes (PROBE-9)

`normalizeRecipeForRuntime` correctly handles these legacy shapes
(verified end-to-end via PROBE-9):

| Legacy shape | Migrated shape | Warning emitted |
|---|---|---|
| `agent: true` + step-level `prompt` + step-level `output` | `agent: { prompt, into }` | yes (3 separate warns) |
| `trigger: { type: cron, schedule: "..."  }` | `trigger: { type: cron, at: "..." }` | yes |
| `step.params: { path, content }` | params flattened onto step | yes |
| `step.chain` | `step.recipe` | yes |
| `file.append` with `step.line` | `step.content` | yes |
| `trigger: { type: event, on: "..." }` | NOT migrated for runtime — only validation-side normalization rewrites this to `webhook+legacyType:event` (`validation.ts:166-196`) | no |

The `event`-trigger case is asymmetric: validation accepts it (rewrites it
to `webhook`), but `normalizeRecipeForRuntime` does not — runtime trigger
type stays `"event"` and `dispatchRecipe` (`yamlRunner.ts:1357-1399`)
will dispatch it to the YAML runner without ever firing the webhook
machinery. Probably benign because the scheduler/file-watch/webhook plumbing
checks `trigger.type` directly elsewhere, but it's a real divergence.

### F10 — chainedRunner has no flat-key fallback

PROBE-4e showed the linter accepts `{{stale_branches}}` (a flat `into:` key)
in a chained recipe. But chainedRunner's templateEngine
(`templateEngine.ts:118-133`) requires *either* `steps.<id>.<field>` *or*
`env.<key>`. There is no flat-key path. A chained recipe authoring `into:
log_data` and referencing `{{log_data}}` will lint-pass but **runtime-fail
with `Invalid expression: log_data` compile error**.

This is the inverse of F1: linter accepts something the runner rejects.

---

## False-positive density

`/recipes` lint summary (live):
- `branch-health` — 6 errors. All F1 (`{{steps.stale.data}}` shape). 0 real bugs.
- `triage-brief` — 5 errors. All F1. 0 real bugs.
- `daily-status.json` — 1 error. F7 (lint applied to a recipe that runs via separate path). 0 real bugs.

12/12 lint errors across the workspace are false-positives. **The recipe linter
in alpha.35 has a 100% false-positive rate.** This is consistent with
the prior dogfood note from 2026-04-29.

---

## Ranked bug list

| # | Severity | Bug | File:line | Fix surface area |
|---|---|---|---|---|
| 1 | HIGH | Linter rejects `{{steps.X.data}}`, the canonical chained-runner template grammar (F1). 100% false-positive rate on the live recipe set. | `src/recipes/validation.ts:501-524`, `:392-405` | Teach `extractTemplateDottedPaths` (or its caller) that `steps` and `env` are reserved roots and skip the availableKeys check for them. ~10-line change. Add regression test for `branch-health.yaml`. |
| 2 | HIGH | Linter rejects `{{env.X}}` (F2). Will surface as a new wave of false-positives once #1 is fixed. | `src/recipes/validation.ts:501-524` | Same fix as #1 (treat `env` as a reserved root). |
| 3 | HIGH | `detectSilentFail` does not run on chained recipes (F6). Live `branch-health` shows `(git branches unavailable)` flowing into agent prompts undetected. | `src/recipes/chainedRunner.ts` (no detectSilentFail import) | Mirror `yamlRunner.ts:570` in `executeChainedStep` — wrap tool result before storing in registry. ~15 lines. |
| 4 | MED | VD-2 captures missing on yamlRunner (F5). Dashboard diff hover and replay degrade silently for the majority of installed recipes. | `src/recipes/yamlRunner.ts:670-674` (no captureForRunlog import) | Import `captureForRunlog`; capture `params` (post-render), `result`, and a snapshot of `ctx` per step. Schema-side: `RecipeRunLog.RunStepResult` already has the optional fields. |
| 5 | MED | Linter advertises `{{YYYY-MM-DD}}`, `{{YYYY-MM}}`, `{{ISO_NOW}}` as built-ins but neither runner provides them (F3). chainedRunner runtime-rejects them as compile errors, so a recipe using them will lint-pass and break at run start. | `src/recipes/validation.ts:357-362` vs `yamlRunner.ts:407-412` and `templateEngine.ts:117-118` | Either (a) seed all five into the runtime ctx for both runners, or (b) drop the three unsupported names from the linter's `builtinKeys`. (a) is more useful. |
| 6 | MED | chainedRunner has no flat-key template fallback (F10). Linter accepts `{{into_alias}}` in a chained recipe, runtime breaks with `Invalid expression`. | `src/recipes/templateEngine.ts:117-133` vs `validation.ts:554` | Either teach templateEngine to fall back to flat env keys (probably wrong — it'd silently swallow typos), or update the linter to require `steps.<id>.data` for chained recipes. |
| 7 | LOW | `output:` step keyword fires deprecation warnings on every load for `branch-health.yaml` and `triage-brief.yaml` (F4). | `legacyRecipeCompat.ts:160-165` + recipe YAML files | Migrate the two failing-lint recipes to `into:` syntax. Independent of #1 — even after fixing the linter, these recipes pollute logs. |
| 8 | LOW | Schema generator's recipe schema rejects `kind:prompt` JSON recipes (F7). Strict consumers will reject `daily-status.json`. | `src/recipes/schemaGenerator.ts:399-462` | Add a fourth `oneOf` branch for the `kind:prompt` shape, OR document the JSON path as schema-exempt and have `loadRecipePrompt` validate against a separate schema. |
| 9 | LOW | `parser.ts:parseRecipe` is dead code that disagrees with the runners (F8). Anyone reading the source assumes `parser.ts` is the parser; in reality `loadYamlRecipe` is. Confusing. | `src/recipes/parser.ts` | Delete or clearly comment as "alternative DSL — not used by runtime". |
| 10 | LOW | `{{steps.X.output}}` and `{{steps.X.result}}` rejected by templateEngine (F1 detail). User-facing surprise — `output` is intuitive given the field is named `output:` in the YAML. | `src/recipes/templateEngine.ts:193-202` | Either alias `output→data` and `result→data`, OR add explicit error message "use `data`, not `output`". Currently the message says `'data', 'status', or 'metadata'` so it's discoverable but feels arbitrary given the field's persistent name is `output`. |
| 11 | LOW | `event`-type trigger is normalized only in validation, not in runtime (F9). | `src/recipes/legacyRecipeCompat.ts` | Mirror `validation.ts:166-196` in `normalizeRecipeForRuntime`. |

---

## Surface NOT verified

- `nestedRecipeStep.ts` template variable resolution under recursion. Did
  not test maxDepth gating or vars merging.
- `generateExecutionPlan` (chainedRunner.ts:991) dry-run schema fidelity.
- `dependencyGraph.ts` cycle detection on parallel-expanded steps.
- The migrations dir (`src/recipes/migrations/`) was not exercised. Only
  the apiVersion warning was observed (from
  `migrateRecipeToCurrent`).

---

## Source citations cheat sheet

| Behavior | File | Line |
|---|---|---|
| linter `availableKeys` built-ins | `src/recipes/validation.ts` | 357-362 |
| linter `extractTemplateDottedPaths` | `src/recipes/validation.ts` | 501-524 |
| linter root-not-in-keys rejection | `src/recipes/validation.ts` | 393-401 |
| linter registers step.id (chained) | `src/recipes/validation.ts` | 537-538 |
| linter registers step.into | `src/recipes/validation.ts` | 549-554 |
| chainedRunner uses `compileTemplate` | `src/recipes/chainedRunner.ts` | 193, 213 |
| `compileTemplate` `parseExpression` | `src/recipes/templateEngine.ts` | 114-134 |
| step accessor whitelist (`data\|status\|metadata`) | `src/recipes/templateEngine.ts` | 193-202 |
| yamlRunner ctx seed `date`,`time` | `src/recipes/yamlRunner.ts` | 407-412 |
| yamlRunner `render` flat-key resolver | `src/recipes/yamlRunner.ts` | 809-841 |
| yamlRunner stepResults shape | `src/recipes/yamlRunner.ts` | 668-674 |
| yamlRunner `detectSilentFail` calls | `src/recipes/yamlRunner.ts` | 471, 570 |
| chainedRunner stepResults shape (VD-2) | `src/recipes/chainedRunner.ts` | 920-945 |
| chainedRunner registry snapshot capture | `src/recipes/chainedRunner.ts` | 836-855 |
| `captureForRunlog` import (only) | `src/recipes/chainedRunner.ts` | 10 |
| `legacyRecipeCompat` output→into rename | `src/recipes/legacyRecipeCompat.ts` | 160-165 |
| `legacyRecipeCompat` chain→recipe rename | `src/recipes/legacyRecipeCompat.ts` | 150-157 |
| `loadRecipePrompt` JSON path | `src/recipesHttp.ts` | 995-1047 |
| `parseRecipe` strict parser | `src/recipes/parser.ts` | 20-59 |
| `detectSilentFail` patterns | `src/recipes/detectSilentFail.ts` | 38-63 |
