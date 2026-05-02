# Patchwork Recipe Trigger Surface — Dogfood Audit (Agent C)

**Date:** 2026-05-01
**Bridge:** alpha.34 live on `127.0.0.1:3101`; source under audit is alpha.35.
**Method:** source read + live HTTP fires through the bridge + synthetic node-driven graph tests.
**Scope:** every recipe trigger type the runtime claims to honour.

---

## TL;DR (severity-ranked)

| # | Severity | Finding | Pin |
|---|---|---|---|
| **1** | **HIGH** | Recipe trigger types `on_file_save`, `on_test_run`, `on_recipe_save` are **purely descriptive**. Nothing in the bridge ever scans recipe files for these triggers and wires them. The schema accepts them; `lint-on-save` / `watch-failing-tests` recipes run only when manually fired. The CLAUDE.md description of these triggers as recipe trigger types is misleading — they're automation-policy hooks (separate JSON file), not recipe wiring. | `src/recipes/scheduler.ts:178` (only `cron` is loaded), `src/recipes/yamlRunner.ts:1359` (only `chained` branches), no `on_file_save` listener anywhere |
| **2** | **HIGH** | `git_hook` recipe trigger is also **descriptive only**. `compileRecipe` would emit `onGitCommit/onGitPush/onGitPull` AutomationProgram nodes but `compileRecipe` is *only* called from `installer.ts`, and even there it's bypassed for `manual/cron/webhook` and writes nothing that's wired to the runtime. Result: `ambient-journal.yaml` (`trigger: git_hook on: post-commit`) **never auto-fires** — only manual runs. | `src/recipes/compiler.ts:155-180`, `src/recipes/installer.ts:65-77`. compileRecipe call sites: only `installer.ts` |
| **3** | **HIGH** | Recipe schema/parser disagree on legal trigger types. `parser.ts:71-115` accepts only `webhook | cron | file_watch | git_hook | manual`. `validation.ts:57-66` accepts those plus `on_file_save | on_test_run | chained`. Real recipes use the validator-only set. So `parseRecipe` would reject every install-dir recipe in `~/.patchwork/recipes/`. The runtime path uses `dispatchRecipe` (which only checks `chained`) and bypasses `parseRecipe` entirely. | `src/recipes/parser.ts:111`, `src/recipes/validation.ts:57-66`, `src/recipes/schema.ts:11-16` |
| **4** | **MED** | `compileRecipe` doesn't recognize `on_file_save | on_test_run | on_recipe_save | chained` — only the `parser.ts` set. If anything ever started calling it for these recipes it would throw `RecipeCompileError("unknown trigger type")`. | `src/recipes/compiler.ts:154-180` (switch is exhaustive over the old union, falls through to throw) |
| **5** | **MED** | Cron scheduler runs in **system local time** with no `timezone` option passed to `node-cron`. Local TZ on this host is `Africa/Nairobi`. `morning-brief @ "0 8 * * 1-5"` therefore fires at 08:00 EAT, not 08:00 UTC. On a UTC VPS the same recipe shifts. Not documented; users can't override per-recipe. | `src/recipes/scheduler.ts:232` (`cron.schedule(parsed2.expression, () => {...})` — no third-arg) |
| **6** | **MED** | `nestedRecipeStep.validateNestedRecipe` is **off-by-one**: `currentDepth > recipeMaxDepth` allows `currentDepth === maxDepth` to recurse one more level. With `maxDepth: 2` the recipe nests **3** layers (root→1→2→3) before being blocked. Error message `at depth ${currentDepth + 1}` is also misleading — at currentDepth=3, maxDepth=2, it reports "at depth 4" when the user-facing semantics would be "depth 3 exceeded limit 2". | `src/recipes/nestedRecipeStep.ts:70-76` |
| **7** | **LOW** | `HookType` union (`src/fp/automationProgram.ts:10-31`) has NO ADT for `pass-after-fail`. CLAUDE.md claims `filter: any | failure | pass-after-fail` is a unified ADT (a `WithFilter` node was suggested), but the implementation uses a **string-rewrite** in `policyParser.ts:830-859`: `filter: failure → onFailureOnly: true`; `filter: pass-after-fail` re-routes to the legacy `onTestPassAfterFailure` policy slot. Works, but the docs/code mental model don't match. | `src/fp/automationProgram.ts:10-31` (union); `src/automation.ts:830-859` (rewrite) |
| **8** | **LOW** | Starter-pack `event` triggers (`inbox.new_message`, `calendar.upcoming`, `notification.incoming`, `inbox.draft_saved`) — confirmed `BROKEN-LIKELY` from the prior dogfood. Neither the parser, validator, scheduler, nor compiler mention `event`. They're vision-tier. | `src/recipes/validation.ts:57-66` (no `event`); `src/recipes/parser.ts:71-115` (no `event`) |
| **9** | **INFO** | The validation hopscotch around the `legacyType: "event"` channel hints that an old `event` trigger existed and was removed. The starter-pack hasn't caught up. | `src/recipes/validation.ts:305-307` |

**One-sentence summary:** the only recipe triggers that actually fire automatically are `cron` (via `RecipeScheduler`) and `webhook` (via HTTP `/hooks/*`); `chained` is a runner-selector for manual/HTTP fires. Every other declared trigger (`on_file_save`, `on_test_run`, `on_recipe_save`, `git_hook`) is documentation that never reaches the dispatch loop. Real wiring for those events lives in `automation-policy.json`, not in the recipe YAML.

---

## Per-trigger detail

| # | Trigger type | Recipe(s) tested | Wiring location | Tested via | Result | Bug ref |
|---|---|---|---|---|---|---|
| 1 | `manual` | n/a (Agent A coverage) | `recipeOrchestration.ts:327` `runRecipeFn` → `RecipeOrchestrator.fire` | live-fire (Agent A) | works | — |
| 2 | `cron` | `morning-brief` (`0 8 * * 1-5`), `daily-status.yaml` (`0 8 * * *`), `stale-branches` (`0 9 * * MON`), `morning-brief-slack` (skipped — WRITE-EXTERNAL) | `src/recipes/scheduler.ts:232` `cron.schedule()` | live-fire records (`/runs?trigger=cron`); both `morning-brief` (seq 3243) and `stale-branches` (seq 3239) found with `trigger:cron` taskId-prefix `yaml:<name>:<startTs>` matching the scheduler's `enqueue → runRecipeFn → fireYamlRecipe` path | works | TZ ambiguity (#5) |
| 3 | `chained` | `branch-health` (parallel awaits + maxConcurrency:2 + maxDepth:2), `triage-brief` (skipped — WRITE-EXTERNAL), `chained-followup-demo` (parse-only — broken tools) | `src/recipes/yamlRunner.ts:1359` dispatch → `src/recipes/chainedRunner.ts:589` `runChainedRecipe` → `src/recipes/dependencyGraph.ts:120` `executeWithDependencies` | live record seq 3236 (`branch-health`): `stale.startedAt=1777626233052`, `recent.startedAt=1777626233066` — overlap window `[233066..233090]` (24ms). `summarise.startedAt=1777626233090` (waits for both). `write.startedAt=1777626245798` (waits for summarise). Parallel awaits ✓, sequential awaits ✓ | works | maxDepth off-by-one (#6) |
| 4 | `git_hook` (`post-commit`) | `ambient-journal` | `src/recipes/compiler.ts:157-165` (defines hookType mapping) — but `compileRecipe` only called from installer; **no runtime listener iterates installed recipes for `git_hook` and fires them on `gitCommit`** | source read (no live fire — refused commit on main per task instructions) | **descriptive only — never auto-fires** | #2 |
| 5 | `on_file_save` | `lint-on-save` (`**/*.{ts,tsx}`) | nominal: `src/automation.ts:1537` `handleFileSaved` → `_enqueueRun("onFileSave", ...)`. Actual: this fires the **automation-policy** `onFileSave` hook (lives in `automation-policy.json`), NOT recipes whose `trigger.type === "on_file_save"`. No code reads recipe YAMLs and matches glob. | source read; live `/runs?recipe=lint-on-save` shows 1 hit (seq 3231) with `trigger: recipe` (manual fire), no `trigger: file_save` records exist | **descriptive only — never auto-fires from recipe YAML** | #1 |
| 6 | `on_test_run` (`filter: failure`) | `watch-failing-tests` | nominal: `src/automation.ts:1601` `handleTestRun` → `_enqueueRun("onTestRun", ...)`. Same gap as #5 — fires the policy hook, not the recipe. | source + live `/runs?recipe=watch-failing-tests` shows manual fires only (`trigger: recipe`) | **descriptive only — never auto-fires from recipe YAML** | #1 |
| 7 | `on_recipe_save` | none in user installs (default-only path) | `src/automation.ts:1542-1544` (fires for `.yaml`/`.yml` saves). Default prompt fallback at `src/fp/policyParser.ts:315`. Only fires the **policy** hook. | source read; default-prompt fallback path verified (`policyParser.ts:310-317` injects `patchwork recipe preflight {{file}}` when no explicit prompt) | works **as a policy hook** (not as a recipe trigger) | #1 |
| 8 | `event` (`inbox.new_message`, etc.) | starter-pack: `compliment-archive`, `meeting-prep`, `quiet-hours-enforcer`, `disagreement-cooldown`, etc. | nowhere — string is unknown to parser, validator (sometimes), scheduler, compiler | source read | **broken — schema rejection only happens via `validation.ts` if invoked, otherwise silently never fires** | #8 |

---

## Specific checks

### maxDepth / maxConcurrency

- **maxConcurrency** — verified via synthetic graph: 4 awaits-free steps + `maxConcurrency: 2` → max-in-flight observed = 2. `src/recipes/dependencyGraph.ts:208-228` enforces with `while (executing.length < options.maxConcurrency && queue.length > 0)`. Defaults to 4 in `src/recipes/yamlRunner.ts:1371` when recipe omits the field.
- **maxDepth** — enforcement exists at `src/recipes/nestedRecipeStep.ts:70` but uses `>` instead of `>=`. With `maxDepth: 2`, you can nest 3 layers before block. Off-by-one — see **bug #6**. Defaults to 3 in `src/recipes/yamlRunner.ts:1372`.

### Cron timezone

- `cron.schedule(expr, cb)` with no third-arg → `node-cron` defaults to **system local TZ**. Confirmed live: host TZ is `Africa/Nairobi`. So `morning-brief @ "0 8 * * 1-5"` fires at 08:00 EAT (UTC+3), not 08:00 UTC. Pin: `src/recipes/scheduler.ts:232`.
- No `tz:` field on the recipe trigger schema. Per-recipe TZ override is **not supported**.

### Cooldowns — same-file spam guard?

- Min cooldown floor: 5000 ms — clamped at parse time via `Math.max(rec.cooldownMs, MIN_COOLDOWN_MS)` (`src/automation.ts:540, 981`).
- Per-key cooldown is keyed off the **policy wrapper** `WithCooldown.key`, not the event subject — see `src/fp/automationInterpreter.ts:496-527`. For `onFileSave`, the wrapper key per-recipe is `recipe:<name>:cooldown` (`src/recipes/compiler.ts:140`). Multiple files saved in quick succession all hit the same cooldown bucket → spam-suppressed correctly. But: the recipe's `trigger.cooldownMs` is never read because the recipe never reaches the interpreter.
- Actual file-save cooldowns come from `automation-policy.json:onFileSave.cooldownMs: 600000` (10 min on this host) — works.

### Chained DAG — cycle detection

- `src/recipes/dependencyGraph.ts:46-66` — DFS with `visiting` set marks cycles. Verified live with `{a awaits [b], b awaits [a]}` synthetic graph: `hasCycles: true, topologicalOrder: []`. `runChainedRecipe` then short-circuits with `errorMessage: "Recipe has circular dependencies"` and writes a `status: "error"` run-log entry (`src/recipes/chainedRunner.ts:647-686`). PR #103's "cycle run-log leak" is fixed — the early-return path correctly opens AND closes the run via `startRun`/`completeRun`.

### nestedRecipeStep depth limit

- See bug #6. The `examples/recipes/chained-followup-demo.yaml` has `maxDepth: 2`. Synthetic check: `validateNestedRecipe({recipeMaxDepth: 2, currentDepth: 2})` → returns `valid: true` (allows recursion). Should be `valid: false`.

### `parallel:` block expansion (chained sugar)

- `src/recipes/chainedRunner.ts:532-586` — verified: each child gets id `<groupId>_<index>`, inherits group `awaits`, post-pass rewrites `awaits` of downstream steps from group id to all child ids.
- Note: the chained-recipe `parallel:` is a different mechanism from the `Parallel` AutomationProgram node (PR #107 sequentialized that one). The chained `parallel:` still actually parallelizes via `dependencyGraph.executeWithDependencies` + `maxConcurrency`.

---

## Recommendations

1. **Decide the contract for descriptive triggers.** Either:
   - (a) wire them — the bridge should walk `~/.patchwork/recipes/*.{yaml,yml}` at startup, find triggers other than `cron/webhook`, and synthesize automation-policy hooks per-recipe; OR
   - (b) document them as docs-only — drop `on_file_save`, `on_test_run`, `git_hook`, `on_recipe_save` from `validation.ts`, schema generator, and the recipe-authoring guide so users don't author non-firing recipes.
   Prefer (a). The starter-pack and the templates already write recipes that expect (a).
2. **Reconcile `parser.ts` and `validation.ts`** trigger-type unions. Pick one source of truth.
3. **Fix the `nestedRecipeStep` off-by-one** — change `>` to `>=` and update the error message to drop `+ 1`.
4. **Pass an explicit `timezone` option** to `cron.schedule(...)` — read from `cfg.recipes.timezone` (default `UTC`) so behaviour is deterministic across hosts.
5. **Document or remove `event` triggers** in the starter-pack — the `# requires:` markers shipped in PR #74 should also flag `BROKEN — trigger type unknown` for the seven `event:` recipes.
