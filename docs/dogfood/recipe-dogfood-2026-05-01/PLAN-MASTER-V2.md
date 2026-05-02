# Master Fix Plan V2 — Recipe Dogfood 2026-05-01

Synthesis of [PLAN-MASTER.md](PLAN-MASTER.md) (V1) with amendments from [REVIEW-1-architecture.md](REVIEW-1-architecture.md), [REVIEW-2-security.md](REVIEW-2-security.md), and [REVIEW-3-completeness.md](REVIEW-3-completeness.md).

Each amendment is tagged **[R1]**, **[R2]**, **[R3]** so each change traces back to its source review.

---

## 1. Changelog from V1

### CRITICAL severity (correctness / security)

1. **[R2-C1]** PR-1 must cover a **third** template-substitution site at `chainedRunner.ts:194-205` (`resolveStepTemplates` → `executeTool`). V1 only covered yamlRunner template + HTTP `vars`. Without this, a chained `tool: file.write, path: "{{user_var}}"` step bypasses jail if the file.ts floor regresses.
2. **[R2-C2]** Default jail-roots must NOT include `os.tmpdir()`. V1's plan defaulted to always-on `/tmp` which on Linux is shared multi-tenant. New default: `~/.patchwork/` + workspace ONLY; `/tmp` opt-in via `CLAUDE_IDE_BRIDGE_RECIPE_TMP_JAIL=1`.
3. **[R2-C3]** `vars` HTTP validation must reject `..`, path separators, `~` after URL-decode. V1's "no control chars, ≤ 1 KB" rule is a no-op against `vars: {target: "../../../etc/passwd"}`. New rule: values match `/^[\w\-. :+@,]+$/u`, type-strict to string-only.
4. **[R1-Q1a]** B-PR1 must wire post-step pipeline at **FOUR points**, not two: yamlRunner tool branch (`:540-621`), yamlRunner agent branch (`:450-529`), chainedRunner (`:438-467`), and chainedRunner parallel-execution merge. V1 said "wire observeStep" without enumerating these.
5. **[R1-Q1b/R1]** B-PR1 must specify `observeStep` runs BEFORE `chainedRunner.ts:820-829`'s `registry.set` so the registry sees the corrected status. Move `chainedRunner.ts:464` success determination AFTER pipeline runs. V1 left ordering ambiguous → silent-fail-detected steps would still feed bad data downstream.
6. **[R1-Q2/R3-A1]** Split B-PR1 into B-PR1a (post-step pipeline, no shape change) + B-PR1b (registrySnapshot delta + `runlogVersion:2` + dashboard branch reader). V1's "version-branched dashboard reader" claim is fictional — the reader does NOT exist in `dashboard/src/app/runs/[seq]/page.tsx` or `dashboard/src/lib/registryDiff.ts:142-168` today.
7. **[R1-Q3/R1-R3]** B-PR3 must update **all 3** `loadRecipePrompt` callers, not 2: HTTP route (`recipesHttp.ts`), webhook handler (`recipeOrchestration.ts:306`), AND scheduler (`scheduler.ts:327`). V1 missed the latter two. Without this, post-B-PR3 the cron scheduler will fail to fire JSON-prompt cron recipes.
8. **[R1-Q3/R1-R4]** B-PR3 taskId format change is a **public-API break**. V1 silently changed `task_abc123` → `daily-status-1777627780016`. New plan: preserve orchestrator-task-id surfacing AND emit equivalent legacy id alongside (DP-13 below).
9. **[R3-#1]** Promote **A-PR4 (permissions sidecar delete)** from Phase 2 → **Phase 1**. V1's "Phase 1 stops the bleed" claim is partially false: F-03 is CRITICAL and lives in Phase 2 in V1. Independent of A-PR1/A-PR2; ships same week.
10. **[R3-#2/I-e2e #3]** Add explicit **inter-recipe NAME cycle detection** to C-PR3. V1 (and PLAN-A:120) claim "cycle detection already exists at `chainedRunner.ts:993-1009`" — **MATERIALLY WRONG**: existing detector is intra-recipe DAG, not inter-recipe call cycle. Pin to `loadNestedRecipe` or `chainedRunner` runtime.
11. **[R3-#5/F6+F7+F8]** Generalize silent-fail detector to catch `linear.createIssue` bare `{error}` envelope (no `ok` field, no `count/items`) and `gmail.getMessage`/`jira.get_issue` scalar error envelopes. V1's B-PR1 `detectSilentFail` wiring does NOT catch these; the detector requires `count`/`items`/`results` plus `error`.

### HIGH severity (residual exploit / coverage gap)

12. **[R2-H1/R2-M3]** Add `maxDepth` runtime clamp (`Math.min(maxDepth ?? 3, 5)`) AND runtime cycle check tracking visited `(recipePath, recipeName)` set in `runChainedRecipe`. V1 only clamped `maxConcurrency`; recursive DoS via `maxDepth: 100` + self-call is open.
13. **[R2-H2]** PR-3 must include startup-time temp-file sweeper for `*.tmp.<pid>.*` files left by atomic-write crashes. V1 had no sweeper.
14. **[R2-H3]** Replace in-memory `FileLock` with OS-level filesystem advisory lock (`proper-lockfile` or `fcntl`). V1's `FileLock` is in-process only — three independent processes (cron, CLI, subprocess driver) all see empty Map and proceed concurrently.
15. **[R3-#4/H-routes Bug 3]** PR-1 must add an **unknown-body-keys rejector** to recipe routes. V1 covered `vars` content but not unknown top-level keys → `args:` silently dropped on `POST /recipes/:name/run`.
16. **[R1-Q4/R3-#1]** B-PR4 same-`name:`-different-dir uniqueness check at recipe load. V1's resolver fixed JSON-vs-YAML same-name; did NOT fix YAML-vs-YAML same-name. Add load-time hard error.
17. **[R3-#1/I-e2e #4]** C-PR3 must explicitly pin cron-installed-post-startup hot-reload via `scheduler.addRecipe(name)` or `scheduler.restart()` from `recipeInstall.ts`. V1's PLAN-C C3 only had timezone + nestedRecipeStep + automation registry — no scheduler-reload mechanism.
18. **[R3-#2/I-e2e #6]** C-PR3 must extend `installRecipeFromFile` to register every YAML in dir, not just one (multi-yaml package drop). V1 mentioned in master but not pinned in PLAN-C C-PR3 scope.
19. **[R3-#2/I-e2e #9]** Add child-run record emission for nested recipes. V1 didn't address. Either chainedRunner emits `RecipeRun` per nested call OR post-hoc reconstruction. Add to C-PR3 or new B-PR5.
20. **[R3-#3]** B-PR1 backwards-compat tests under-budgeted. V1 listed 1 round-trip test; reality needs 3+ (v1-only file, v2-only file, mixed-row file).
21. **[R2-M2]** PR-2 must validate `owner`/`repo` in `parseGithubShorthand` via `isSafeBasename`. V1 relied on URL-arm allowlist only; CLI-side `gh:foo@bar:bad/repo` shorthand bypasses.
22. **[R2-I2]** PR-2 must constrain `httpsGet` redirect targets to allowlist (or pass validator callback). V1 missed redirect-chase SSRF.

### MEDIUM severity (correctness / hygiene)

23. **[R1-Q4/R1-R5]** PLAN-MASTER must pick **either** per-extension URLs (PLAN-C) OR canonical-name-only (PLAN-B). V1 silently combined the two contradictory positions. Recommendation: ship URL extension form alongside YAML-wins so dashboard JSON-variant access isn't dropped (R3-DP-6).
24. **[R1-R7/B-PR3]** Schema/lint after B-PR3: `daily-status.json` lowers to YAML at load; schema generator advertises YAML-only `oneOf`. JSON `kind:prompt` recipes will see schema-validation failures via dashboard/linter even though they run. Document or add `kind:prompt` JSON schema branch.
25. **[R1-R6]** B-PR3 inflight dedup change. After B-PR3 the JSON-prompt and YAML variants both share a `name`; `RecipeOrchestrator.fire` dedups by name → users firing JSON-prompt-style recipes back-to-back will get `already_in_flight` errors they never got before. Document.
26. **[R2-M4]** Tests must assert against `err.code` (e.g. `"recipe_path_jail_escape"`), not error message strings. V1's "throws contains 'escapes jail'" couples tests to message wording.
27. **[R2-M5]** Resolve "bundled templates dir" path before PR-2 review. V1 left as open question; jail roots include "bundled templates dir" but resolution method (require.resolve vs `__dirname`) is unspecified.
28. **[R2-M1]** Replace flat 256 KB body cap with per-route caps: `/install` 4 KB, `/:name/run` 32 KB, `/lint`+`PUT`+`PATCH` 256 KB.
29. **[R2-I3]** `vars` values must be `Record<string, string>` (no numbers, no booleans, no arrays, no objects) — type rule explicit at HTTP entry.
30. **[R1-Q1c]** Per-branch parallel snapshot fix: snapshot `prevRegistry` BEFORE awaiting `executeChainedStep` and `currentRegistry` AFTER, both per-step. V1's signature allowed this but wiring section didn't enforce.
31. **[R3-DP-5]** Verify `$result` is a real runtime root before whitelisting in C-PR1 lint. None of the four reports cite a recipe using `$result`. If absent in templateEngine + yamlRunner, drop to 4-root set (`{steps, env, vars, recipe}`).
32. **[R3-#3/Bug B-cli #31]** Add `recipe run --dry-run` exit-code unification (currently exits 0 even when `lint.errors` populated). V1 dropped finding. Add to C-PR2 (or C-PR6).

### LOW severity (deferred / sequencing / cleanup)

33. **[R1-Q5/R3-§3]** Phase 4 (A-PR3+B-PR2) does NOT depend on Phase 2 B-PR1. V1's dependency arrows were partially fictional. Phase 4 PRs MAY land in Phase 2-3 if maintainer wants. Honest dep graph in §6.
34. **[R3-§3.5]** Remove false dep arrows from V1 graph: `A-PR1 → B-PR1`, `A-PR2 → B-PR1`, `B-PR1 → A-PR3+B-PR2`, `B-PR1 → B-PR4+C-PR4`, `B-PR1 → C-PR3` (the last is convenience, not correctness).
35. **[R3-§4.2]** B-PR1 LOC realism: V1 estimated ~350 LoC; reality is ~1,000 LoC across 8 files (incl. dashboard reader). Reflected in split + revised PR table.
36. **[R3-§4.3]** C-PR2 size: V1 bundled 7 bugs in one PR; reasonable to split into C-PR2a (enumeration parity), C-PR2b (scaffold UX), C-PR2c (log hygiene). Optional split — flag for maintainer.
37. **[R1-R8]** Rename Phase 4 to "Phase 3b" or fold into Phase 3 to flatten schedule by one week.
38. **[R3-DP-3]** Add bridge-wide concurrency cap note to A-PR3 description. Per-recipe 16 + multiple recipes = 64+ in-flight.
39. **[R3-DP-7]** Drop `POST /recipes/:name/permissions` from C-PR4 land-set if DP-1 = Option B. V1 had this inconsistency — sidecar deleted but route still wired.
40. **[R1-Q2-ctxQueryTraces]** Document that `body.stepResults[i].registrySnapshot` exposes new shape to LLM consumers via ctxQueryTraces (V1 incorrectly claimed unaffected). Practical impact low (most callers read `summary` only) but flag.
41. **[R1-Q3-dispatch]** B-PR3 changes `triggerSource` tag from `recipe:${name}` → `recipe:${name}:agent`. Audit `/tasks` filtering and ctxQueryTraces queries by triggerSource.
42. **[R1-R7/L-1+2]** Add deprecation-warning emission point/format for Option B sidecar removal: once per bridge boot, count-only (`Found N stale .permissions.json sidecars …`), suppress in `NODE_ENV=test`.
43. **[R3-§4.5]** Total LoC reality: 1,620 source / 2,340 tests is plausible at ~330 LoC/PR. With splits → ~14 PRs at ~285 LOC each.
44. **[R2-L4]** PR-5 cleanup must add lint rule for new tools importing `child_process` + using `params` directly (G-security F-11 future-proofing).
45. **[R3-DP-2]** SSRF DNS-resolution check must run AFTER env-var allowlist match, not before. Make explicit in PR-2 tests.
46. **[R3-DP-4]** Trigger wiring (C-PR3) realistic estimate is **6-8 days, not 3-4**. Tag as **HIGH risk** in §7 risk section (re-fire storms on file-watch hot-reload, race between scheduler and registry on cron triggers).
47. **[R2-M2/R2-I2-cont]** SSRF guard helper `validateSafeUrl(urlString)` extract to `src/ssrfGuard.ts` (or `src/tools/utils.ts`); shared between `sendHttpRequest` and recipe install. Prevents drift.
48. **[R3-DP-1-Option-C]** Add Option C for permissions decision: delete sidecar **AND** add 30-line dashboard-copy honesty fix ("Patchwork does not enforce per-recipe permissions; configure tool gating in `~/.claude/settings.json`"). Without copy change, Option B silently shifts safety to operator.
49. **[R3-DP-8]** C-PR5 camelCase property test must include collision case (e.g. two tools named `foo_bar` and `fooBar` both register, one wins silently).
50. **[R3-DP-9]** `parser.test.ts` 14 cases must be re-pointed to `legacyRecipeCompat.normalizeRecipeForRuntime` before deletion. Verify edge-case parity.

---

## 2. Phased rollout (revised)

Six phases. Each has been adjusted per reviewer findings. Boundaries are real but Phase 4-5 dep arrows on Phase 2 are now correctly relaxed.

### Phase 1 — Stop the bleed (security CRITICALs) — week 1

Three PRs in parallel; all small-blast-radius.

- **A-PR1** — `resolveRecipePath` jail helper applied at:
  - `file.ts` tool layer (read/write/append) **[R2-C1]**
  - yamlRunner dep-injection defaults (`yamlRunner.ts:976-994`)
  - **chainedRunner template substitution site `chainedRunner.ts:194-205`** **[R2-C1]** — third site, missed in V1.
  - yamlRunner post-render re-validation (`yamlRunner.ts:642`)
  - HTTP `vars` validation at `recipeRoutes.ts:128-138` with **rejection of `..`, `/`, `\`, `~`, null bytes after URL-decode** **[R2-C3]**
  - Type-strict `vars` values: `Record<string, string>` only **[R2-I3]**
  - **Unknown body-keys rejector** on `POST /recipes/:name/run` so `args:` cannot be silently dropped **[R3-#4]**.
  - Default jail-roots: `~/.patchwork/` + workspace ONLY; `/tmp` opt-in via `CLAUDE_IDE_BRIDGE_RECIPE_TMP_JAIL=1` **[R2-C2]**.
  - Bundled-templates dir resolved at bridge boot via `path.resolve(__dirname, '../templates/recipes')` **[R2-M5]**.
  - Tests assert `err.code = "recipe_path_jail_escape"`, not message strings **[R2-M4]**.
  - Closes **F-01, F-02, F-10**, plus residual H-routes Bug 3 (unknown-key body).

- **A-PR2** — `loadNestedRecipe` jail + install host allowlist + per-route body cap.
  - `parseGithubShorthand` validates `owner`/`repo` via `isSafeBasename` **[R2-M2]**.
  - `httpsGet` redirect targets re-checked against allowlist **[R2-I2]**.
  - SSRF DNS resolution AFTER env-var allowlist match **[R3-DP-2]**.
  - Per-route body caps: `/install` 4 KB, `/:name/run` 32 KB, `/lint`+`PUT`+`PATCH` 256 KB **[R2-M1]**.
  - `validateSafeUrl(urlString)` extracted to shared helper **[R2-I1]**.
  - Closes **F-04, F-05/H-SSRF, F-08**.

- **A-PR4** *(PROMOTED FROM PHASE 2)* **[R3-#1]** — permissions decision: delete `*.permissions.json` sidecar (Option B) PLUS dashboard-copy honesty fix per Option C. Closes **F-03**. ~50 LOC removal + ~30 LOC dashboard copy. Independent; ships parallel.
  - Once-per-boot deprecation warning: `Found N stale .permissions.json sidecars under ~/.patchwork/recipes/. These are no longer enforced.` **[R1-L2]**
  - Suppress in `NODE_ENV=test`.

**Outcome**: live-PoC traversal exploits blocked. SSRF closed. Recipe-runner is no longer a sandbox-escape primitive. **F-03 permissions theatre genuinely closed** (V1 falsely claimed Phase 1 stopped the bleed without this). Honest end-state.

### Phase 2 — Architectural foundation — week 2

Sequential. **B-PR1 split into a + b** per [R1-A1] / [R3-Amend-3].

- **B-PR1a** **[R1/R3]** — extract `src/recipes/stepObservation.ts`; wire into yamlRunner (TWO branches: tool + agent) and chainedRunner (with parallel-merge per R1-Q1c); BEFORE `registry.set` per R1-A2; convert `chainedRunner.ts:464` success determination to AFTER pipeline runs **[R1-Q1b]**.
  - **Generalize silent-fail detector** to catch `linear.createIssue` bare `{error}`, `gmail.getMessage` scalar error envelopes **[R3-#5]**.
  - NO shape change. `registrySnapshot` stays full snapshot.
  - Closes **#2, #9, #11-chained, half of #1**, plus **F6, F7, F8** from F-tools.
  - ~500 LoC source + ~400 LoC tests; 13 tests across 3 new test files.

- **B-PR1b** **[R1-A1/R3-A1]** — registrySnapshot delta + `runlogVersion: 2` + **dashboard branch reader** in `dashboard/src/app/runs/[seq]/page.tsx` + `dashboard/src/lib/registryDiff.ts`.
  - Add run-level `RecipeRun.registryFinalSnapshot`.
  - Dashboard accumulates deltas left-to-right OR walks deltas backward from final snapshot.
  - 3+ round-trip tests: v1-only file, v2-only file, mixed-row file **[R3-#3]**.
  - Document `body.stepResults[i].registrySnapshot` shape change for ctxQueryTraces consumers **[R1-Q2]**.
  - Closes **#25, registrySnapshot bloat**.
  - ~350 LoC source + ~250 LoC tests + ~80 LoC dashboard.

**Outcome**: post-step pipeline unified. Chained gains silent-fail floor INCLUDING `linear.createIssue`/`gmail.getMessage` shapes. yamlRunner gains VD-2. registrySnapshot bloat ends. Dashboard renders both v1 and v2 cleanly. Permissions model honest (already in Phase 1).

### Phase 3 — Cleanup wins (independent, parallelizable) — week 3

Four PRs, can land same week. **A-PR3+B-PR2 from V1 Phase 4 may also land here per [R1-Q5]/[R3-§3.5]** — they don't actually depend on B-PR1.

- **C-PR1** — lint whitelist `{steps, env, vars, recipe}` (drop `$result` if not runtime-recognized per [R3-DP-5]) + delete dead `parser.ts` (rewrite tests to target `legacyRecipeCompat.normalizeRecipeForRuntime` per [R3-DP-9]) + built-in template keys.
- **C-PR2** *(may split into C-PR2a/b/c per [R3-§4.3])* — CLI: list/run subdir resolver, `recipe new` template fix + dash-prefix guard, install preflight, dedup migration warnings, help text, **`recipe run --dry-run` exit-code unification** **[R3-#3/B-cli #31]**.
- **C-PR5** — camelCase auto-emit in `registerTool` + Jira/Sentry test backfill + collision property test **[R3-DP-8]**.
- **C-PR6** — `quick-task` try/catch, `replayRun` CLI, schema `maxConcurrency` cap.

**Outcome**: linter trustworthy. CLI usable. Aliases consistent. Tests cover #93 / #103.

### Phase 4 — Coordinated runner fixes — week 4

(May be folded into Phase 3 per [R1-Q5]/[R3-§3.5]; kept here for clarity.)

- **A-PR3 + B-PR2** *(combined, but flag as largest Phase-4 PR)* **[R3-§3.3]** — `chainedRunner.generateExecutionPlan` emits `tool:` field + atomic temp+rename write + `maxConcurrency` runtime clamp at 16.
  - **`maxDepth` runtime clamp** `Math.min(maxDepth ?? 3, 5)` **[R2-H1]**.
  - **Runtime cycle check**: `Set<(recipePath, recipeName)>` tracking in `runChainedRecipe` **[R2-H1/M-3]**.
  - **Startup-time temp-file sweeper** for `*.tmp.<pid>.*` **[R2-H2]**.
  - **OS-level filesystem advisory lock** (`proper-lockfile`) replacing in-memory `FileLock` **[R2-H3]**.
  - Bridge-wide concurrency cap note in PR description **[R3-DP-3]**.

**Outcome**: chained recipes truthfully report writes. Concurrent runs no longer race-overwrite. `maxConcurrency` AND `maxDepth` bounded. Cross-process locking real.

### Phase 5 — Resolver unification + remaining HTTP — week 5

- **B-PR3** — delete `loadRecipePrompt`; lower `kind:prompt` JSON to synthetic single-agent-step YAML at load time. Eliminates the third runner.
  - **Update all 3 callers**: HTTP route + `recipeOrchestration.ts:306` (webhook) + `scheduler.ts:327` (cron) **[R1-A3]**.
  - **taskId backwards-compat** per DP-13 below: preserve `<recipeName>:<startTs>` AND emit equivalent legacy orchestrator id alongside in response **[R1-R4]**.
  - Document `triggerSource` change `recipe:${name}` → `recipe:${name}:agent` **[R1-Q3]**.
  - Document inflight-dedup change (R6: users firing back-to-back may see new `already_in_flight` error) **[R1-R6]**.
  - Add lint deprecation warning for `kind:prompt` JSON files **[R1-C3]**.
  - Depends on B-PR1a (silent-fail) — **NOT** B-PR1b (dashboard).
  - **Greppable test**: `grep -rn "loadRecipePrompt" src/` after PR returns zero hits except deprecation comment **[R3-§7]**.

- **B-PR4 + C-PR4** *(combined)* — new `src/recipes/resolveRecipe.ts` as single canonical resolver.
  - **YAML-vs-YAML same-name collision** → load-time hard error per DP-14 **[R1-Q6/A5]**.
  - Per-extension URL form `/recipes/daily-status.json` SHIPS alongside YAML-wins per DP-6 **[R3-DP-6]**.
  - Resolver covers ALL 7 callsites, not 4: `loadRecipeContent`, `runRecipeFn`, webhook dispatch, scheduler `fire`, `loadRecipePrompt`, recipeRoutes PATCH/DELETE/PUT, CLI commands **[R1-Q4]**.
  - PATCH `/recipes/:name` ESM `require` bug fix.
  - **Drop `POST /recipes/:name/permissions` route** since DP-1 = Option B → no sidecar to update **[R3-DP-7]**.
  - Land 3 of remaining 4 missing nested HTTP routes: `/runs`, `/permissions GET`, `/activation-metrics`.

**Outcome**: third runner gone; one canonical recipe resolver across HTTP/lint/run/delete/scheduler/webhook/CLI; dashboard enable/disable toggle works; YAML-vs-YAML collisions error loudly.

### Phase 6 — Trigger wiring + repo hygiene — week 6

**Realistic estimate: 6-8 days, not 3-4** **[R3-DP-4]**. Tagged HIGH risk.

- **C-PR3** — wire YAML-declared `on_file_save` / `on_test_run` / `on_recipe_save` / `git_hook` into orchestrator's automation hooks; fix scheduler `timezone`; fix `nestedRecipeStep` off-by-one. Now expanded:
  - **Inter-recipe NAME cycle detection** **[R1-A5/R3-#2/I-e2e #3]** — name-stack tracker in `loadNestedRecipe` (NOT the existing intra-recipe DAG detector; that does NOT cover this case per [R3-§7]).
  - **Cron-installed-post-startup hot-reload** **[R1-B1/R3-#2/I-e2e #4]** — `recipeInstall.ts` calls `scheduler.addRecipe(name)` or `scheduler.restart()` on successful install of any recipe with non-`manual` trigger. Currently no `reload()` method exists; add one.
  - **Multi-yaml package registration** **[R3-#2/I-e2e #6]** — `installRecipeFromFile` registers every YAML in dir, not just one. Address one-per-dir limit at registry layer.
  - **Nested child-run records** **[R3-#2/I-e2e #9]** — chainedRunner emits `RecipeRun` per nested call (depth>0 path) so `/runs` shows child entries.
  - Tagged HIGH risk; day-1 risks: re-fire storms on file-watch hot-reload, race between scheduler and registry on cron triggers.
  - Closes **#3, #6, #10, #13, #28** + **I-e2e #3, #4, #6, #9**.

- **A-PR5** — promote `/tmp/dogfood-G2/` exploit YAMLs to `docs/dogfood/recipe-dogfood-2026-05-01/security-fixtures/`. Plus PR-5 cleanup: lint rule for new tools importing `child_process` + using `params` directly **[R2-L4]**.

**Outcome**: dormant trigger types live. Cron honors per-recipe timezone AND hot-reloads on install. Recursion limits hold. **All 4 I-e2e seams pinned to actual files** (V1 had paper coverage). Security regression tests in repo.

---

## 3. PR table (revised)

| PR ID | Phase / Wk | Bugs closed | Files touched | LoC est | Test inv | Cross-bundle deps |
|---|---|---|---|---|---|---|
| **A-PR1** | P1 / W1 | F-01, F-02, F-10 (G-sec); H-routes Bug 3 (unknown-key); R2-C1 (3rd template site); R2-C2 (jail roots); R2-C3 (vars validation); R2-I3 (type-strict) | `src/tools/utils.ts` (new helper), `src/recipes/tools/file.ts`, `src/recipes/yamlRunner.ts:642,976-994`, **`src/recipes/chainedRunner.ts:194-205`**, `src/recipeRoutes.ts:128-138`, `src/commands/recipe.ts:1080-1102` | ~250 src / ~250 tests | High; symlink + jail + decode tests | None |
| **A-PR2** | P1 / W1 | F-04, F-05, F-08 (G-sec); R2-M1 (per-route caps); R2-M2 (owner/repo); R2-I2 (redirect-chase) | `src/recipeRoutes.ts:600-650`, `src/commands/recipeInstall.ts:50-280`, `src/recipes/yamlRunner.ts` (loadNestedRecipe), new `src/ssrfGuard.ts` | ~200 src / ~200 tests | Medium; SSRF + body-cap tests | None |
| **A-PR4** | **P1** / W1 *(PROMOTED [R3-#1])* | F-03 (G-sec) | `src/recipeInstall.ts` (-50 LOC sidecar write), `dashboard/src/components/RecipeBadge.tsx` (+30 LOC copy) | ~80 src / ~30 tests | Low; deprecation warning test | None |
| **B-PR1a** | P2 / W2 *(SPLIT [R1-A1/R3-A1])* | #2, #9, #11-chained, half-#1; F6/F7/F8 (silent-fail bypass) | New `src/recipes/stepObservation.ts`, `src/recipes/yamlRunner.ts:450-621` (TWO branches), `src/recipes/chainedRunner.ts:438-471,820-860`, `src/recipes/captureForRunlog.ts`, `src/recipes/detectSilentFail.ts` | ~500 src / ~400 tests | 13+ tests across 3 new files | None (independent of B-PR1b) |
| **B-PR1b** | P2 / W2 *(SPLIT [R1-A1/R3-A1])* | #25, registrySnapshot bloat, dashboard reader gap | `src/recipes/captureForRunlog.ts` (delta), `src/runLog.ts:34-53` (`runlogVersion`, `registryFinalSnapshot`), `dashboard/src/app/runs/[seq]/page.tsx`, `dashboard/src/lib/registryDiff.ts:142-168` | ~350 src / ~250 tests + ~80 dash | 3+ round-trip tests (v1/v2/mixed) | After B-PR1a |
| **C-PR1** | P3 / W3 | #8, #23, partial #24 | `src/recipes/lint/validation.ts`, delete `src/recipes/parser.ts`, rewrite `parser.test.ts` | ~120 src / ~150 tests | Re-point 14 cases | None |
| **C-PR2** | P3 / W3 *(may split per [R3-§4.3])* | #4, #5 (install half), #7, #17, #20, #26, #27, **B-cli #31** *(R3-#3 dropped finding)* | `src/commands/recipe.ts`, `src/recipeInstall.ts`, `src/legacyRecipeCompat.ts`, `src/migrations/*` | ~280 src / ~220 tests | Medium | None |
| **C-PR5** | P3 / W3 | #18, #19, F4, F9 | `src/tools/registerTool.ts`, alias auto-emit; new tests for Jira/Sentry; collision property test | ~50 src / ~600 tests | Heavy test PR | None |
| **C-PR6** | P3 / W3 | #21, #22, half-F-09 (schema cap) | `src/cli/quickTask.ts`, `src/cli/replayRun.ts`, `src/recipes/lint/schema.ts` | ~150 src / ~120 tests | Medium | None |
| **A-PR3 + B-PR2** | P4 / W4 *(may fold to P3)* **[R1-Q5]** | #1, F-06, F-07, F-09 (runtime); R2-H1 (maxDepth+cycle); R2-H2 (sweeper); R2-H3 (file-lock) | `src/recipes/chainedRunner.ts:991-1040,420-426,367`, `src/recipes/yamlRunner.ts:976-994`, `src/recipes/RunOptions.ts`, `src/commands/recipe.ts:803-822`, `src/recipes/lint/validation.ts`, `src/recipes/replayRun.ts:111`, **`src/fileLock.ts` → flock-based** | ~400 src / ~400 tests | Highest in plan; cycle + concurrent-write tests | None (independent of B-PR1; was V1 false dep) |
| **B-PR3** | P5 / W5 | #16; H-routes Bug 6 (recordRecipeRun) | `src/recipesHttp.ts:995-1068`, **`src/recipeOrchestration.ts:306,344-358`**, **`src/recipes/scheduler.ts:327`**, `src/recipes/yamlRunner.ts` (synthetic single-step) | ~300 src / ~300 tests | Greppable test for `loadRecipePrompt` callers | After B-PR1a (NOT B-PR1b) |
| **B-PR4 + C-PR4** | P5 / W5 | #14, #15 (3 routes), PATCH-ESM, R3-#1/I-e2e #5 (YAML-vs-YAML) | New `src/recipes/resolveRecipe.ts`, `src/recipesHttp.ts`, `src/recipeOrchestration.ts`, `src/recipes/scheduler.ts`, `src/commands/recipe.ts` | ~350 src / ~300 tests | Resolver round-trip 7 callsites | None (independent of B-PR1 [R3-§3.5]) |
| **C-PR3** | P6 / W6 *(HIGH risk, 6-8 days)* | #3, #6, #10, #13, #28; **I-e2e #3, #4, #6, #9** | `src/recipes/compileRecipe.ts`, new `src/recipes/RecipeAutomationRegistry.ts`, `src/recipes/scheduler.ts` (+`reload()`), `src/recipeInstall.ts` (multi-yaml + scheduler hook), `src/recipes/nestedRecipeStep.ts` (off-by-one + name cycle), `src/recipes/chainedRunner.ts` (child-run record) | ~500 src / ~400 tests | New automation registry + 4 I-e2e seam tests | After B-PR1a (convenience only [R3-§3.5]) |
| **A-PR5** | P6 / W6 | Security fixtures + R2-L4 (lint rule) | New `docs/dogfood/.../security-fixtures/`, `src/recipes/lint/validation.ts` (+1 lint rule) | ~50 src / ~80 tests | Low | After A-PR1, A-PR2 |

**Total**: 14 PRs (V1: 12 PRs after B-PR1 split + A-PR4 promotion). ~3,600 src / ~3,700 tests. ~1.0:1 ratio. Median PR ~270 LoC.

**Notable corrections from V1 PR table**:
- B-PR1 was ~350 LoC; reality with dashboard reader is ~1,000 across 8 files **[R3-§4.2]** → split.
- C-PR2 is a 7-bug bundle; consider 3-way split for review burden.
- A-PR4 moved from Phase 2 → Phase 1 (Option B = 50 LoC removal).
- A-PR3+B-PR2 has new dep on B-PR2 (B-PR2's `tool:` field) but NOT on B-PR1 — V1's claim was false.

---

## 4. Coverage matrix (final)

Status legend: **C** = covered (PR pinned), **PARTIAL** = covered with caveats noted, **DEFERRED** = explicit owner + sprint named.

### Round-1 (28 bugs)

| # | Bug | Final PR placement | Status |
|---|---|---|---|
| 1 | Chained `hasWriteSteps:false` | A-PR3+B-PR2 (P4) | C |
| 2 | `detectSilentFail` not in chained | B-PR1a (P2) | C |
| 3 | Schema/parser/validator triggers | C-PR3 (P6) | C |
| 4 | `recipe list` 1-of-N | C-PR2 (P3) | C |
| 5 | Install/test exit codes | C-PR2 (P3); dry-run half added per [R3-#3] | C |
| 6 | YAML-trigger never auto-fire | C-PR3 (P6) | C |
| 7 | `recipe new` template fails own lint | C-PR2 (P3) | C |
| 8 | 100% lint false-positive | C-PR1 (P3) | C |
| 9 | VD-2 chained-only | B-PR1a (P2) | C |
| 10 | Cron uses local TZ | C-PR3 (P6) | C |
| 11 | `morning-brief` silent agent skip | B-PR1a (P2) | C |
| 12 | Bridge staleness | n/a — operational | n/a |
| 13 | `nestedRecipeStep` off-by-one | C-PR3 (P6) | C |
| 14 | `daily-status` shadow | B-PR4+C-PR4 (P5) | C |
| 15 | `/recipes/:name/runs` (+5) | B-PR4+C-PR4 lands 3; 2 deferred to docs (DP-7) | PARTIAL (docs only for `/preflight`+`/lint`) |
| 16 | `kind:prompt` JSON | B-PR3 (P5) + lint deprecation [R1-C3] | C |
| 17 | `recipe run <name>` subdir | C-PR2 (P3) | C |
| 18 | PR #93 Jira+Sentry tests | C-PR5 (P3) | C |
| 19 | PR #103 camelCase aliases | C-PR5 (P3) | C |
| 20 | `recipe new --help` | C-PR2 (P3) | C |
| 21 | `quick-task` raw `DOMException` | C-PR6 (P3) | C |
| 22 | `replayRun` no CLI | C-PR6 (P3) | C |
| 23 | `parser.ts` dead | C-PR1 (P3) | C |
| 24 | `output:` deprecation per load | C-PR2 dedup [R3-§1.1] | PARTIAL (symptom hidden; recipes still emit `output:`) |
| 25 | `registrySnapshot` per-step bloat | B-PR1b (P2) | C |
| 26 | `recipe`/`recipe --help` silent | C-PR2 (P3) | C |
| 27 | apiVersion warning 3× | C-PR2 (P3) | C |
| 28 | starter-pack `event:` | C-PR3 (P6) | C |
| **B-cli #31** | `recipe run --dry-run` exit 0 on lint errors *(R3 dropped)* | C-PR2 (P3) [R3-#3] | C |

**Round-1: 26/29 C, 2 PARTIAL, 0 N, 0 DEFERRED.**

### F-tools (13)

| F# | Bug | Final PR placement | Status |
|---|---|---|---|
| F1 | file.read/write/append no jail | A-PR1 (P1) | C |
| F2 | 7 connector files no try/catch | **DEFERRED to PLAN-D, owner: connector-hygiene team, target sprint: post-Phase-6** | DEFERRED |
| F3 | Chained no `detectSilentFail` | B-PR1a (P2) | C |
| F4 | PR #103 camelCase 2-of-36 | C-PR5 (P3) | C |
| F5 | PR #93 zero unit tests | C-PR5 (P3) | C |
| **F6** | `linear.createIssue/updateIssue` bare `{error}` | B-PR1a generalized detector [R3-#5] | **C (was N in V1)** |
| **F7** | Scalar-read error envelopes | B-PR1a generalized detector [R3-#5] | **C (was N in V1)** |
| **F8** | yamlRunner JSON requires `ok===false` | B-PR1a `observeStep` re-checks contract [R3-#5] | **C (was P/N in V1)** |
| F9 | PR #103 alias mechanism naïve | C-PR5 (P3) | C |
| **F10** | `notify.push` doesn't exist | **DEFERRED to PLAN-D; owner: tool-registry-cleanup; target: Sprint+1** | DEFERRED |
| **F11** | `meetingNotes.flatten` weak input validation | **DEFERRED to PLAN-D; owner: connector-hygiene team; target: post-Phase-6** | DEFERRED |
| F12 | `github.list_issues` 2348ms perf | **DEFERRED to perf backlog; owner: platform; target: TBD** | DEFERRED |
| F13 | `diagnostics.get` placeholder | **DEFERRED to docs; owner: dev-experience; target: Sprint+1** | DEFERRED |

**F-tools: 8/13 C, 5 DEFERRED (with owners). 0 NOT-COVERED.**

### G-security (13)

| F# | Sev | Bug | Final PR placement | Status |
|---|---|---|---|---|
| F-01 | CRITICAL | file.* path traversal | A-PR1 (P1) | C |
| F-02 | CRITICAL | template-driven traversal | A-PR1 (P1) [+ R2-C1 third site] | C |
| F-03 | CRITICAL | permissions sidecar theatre | A-PR4 (P1, PROMOTED) | C |
| F-04 | HIGH | chained `recipe:` arbitrary | A-PR2 (P1) | C |
| F-05 | HIGH | `/recipes/install` SSRF | A-PR2 (P1) | C |
| F-06 | HIGH | concurrent runs race-overwrite | A-PR3+B-PR2 (P4) | C |
| F-07 | HIGH | hasWriteSteps blind to chained | A-PR3+B-PR2 (P4) | C |
| F-08 | MED | request body unbounded | A-PR2 (P1) | C |
| F-09 | MED | maxConcurrency unbounded | A-PR3+B-PR2 (P4) + maxDepth | C |
| F-10 | MED | CLI accepts arbitrary path | A-PR1 (P1) | C |
| F-11 | LOW | template serialize unscaped | A-PR5 lint rule (P6) | C *(was D in V1)* |
| F-12 | LOW | install master-fallback | n/a — INFO/safe | n/a |
| F-13 | INFO | stream-HTTP register parity | n/a — already fixed | n/a |

**G-security: 11/13 C, 2 n/a. 0 N, 0 DEFERRED.**

### H-routes (15 distinct bugs + 6 missing routes)

| Bug | Final PR placement | Status |
|---|---|---|
| **NEW CRITICAL** PATCH ESM | B-PR4+C-PR4 (P5) | C |
| HIGH 2 — `/recipes/install` SSRF | A-PR2 (P1) | C |
| **HIGH 3** — body schema unvalidated (`args:` dropped) | **A-PR1 unknown-key rejector [R3-#4]** | **C (was P in V1)** |
| HIGH 4 — registrySnapshot bloat | B-PR1b (P2) | C |
| HIGH 5 — `/recipes/:name/runs` missing | B-PR4+C-PR4 (P5) | C |
| HIGH 6 — JSON-prompt no `recordRecipeRun()` | B-PR3 (P5) | C |
| MED 7 — daily-status two-layer | B-PR4 (P5) | C |
| **MED 8** — `/runs/:seq/plan` 503-vs-404 | **DEFERRED to PLAN-D HTTP hygiene; owner: routes-team; target: Sprint+1** | DEFERRED |
| MED 9 — recipe count fresh | n/a | n/a |
| **MED 10** — `/templates` 5-min cache no single-flight | **DEFERRED to PLAN-D; owner: dashboard-perf; target: Sprint+2** | DEFERRED |
| **MED 11** — `/activation-metrics` opt-out | **DEFERRED to privacy-review; owner: platform; target: Sprint+1** | DEFERRED |
| MED 12 — POST `/recipes/run` lenient | A-PR1 unknown-key rejector covers [R3-#4] | C |
| **LOW 13** — `/recipes/lint` 200 not 400 | **DEFERRED to PLAN-D HTTP hygiene; owner: routes-team; target: Sprint+2** | DEFERRED |
| **LOW 14** — `/runs?status=bogus` silent 200 | **DEFERRED to PLAN-D; owner: routes-team; target: Sprint+2** | DEFERRED |
| **LOW 15** — install predictable `/tmp/` TOCTOU | A-PR2 sweeper covers (similar primitive) [R2-H2] | C |
| Missing routes (6) | B-PR4+C-PR4 lands 3; 2 docs-only (per DP-7+R3-DP-7); 1 dropped (`POST permissions` per DP-1=B) | PARTIAL by design |

**H-routes: 9/15 C, 4 DEFERRED with owners, 2 n/a.**

### I-e2e (16 seams)

| # | Sev | Seam | Final PR placement | Status |
|---|---|---|---|---|
| 1 | CRIT | chained `hasWriteSteps:false` | A-PR3+B-PR2 (P4) | C |
| 2 | CRIT | nested-recipe maxDepth off-by-one | C-PR3 (P6) | C |
| **3** | CRIT | inter-recipe call cycle | **C-PR3 explicit name-stack tracker [R1-A5/R3-#2]** | **C (was N in V1)** |
| **4** | HIGH | cron-installed-post-startup | **C-PR3 `scheduler.reload()` from `recipeInstall` [R1-B1/R3-#2]** | **C (was N in V1)** |
| **5** | HIGH | duplicate `name:` both unreachable | **B-PR4 load-time hard error [R1-A5/R3-#2]** | **C (was N in V1)** |
| **6** | HIGH | multi-yaml package drops recipes | **C-PR3 `installRecipeFromFile` registers all [R3-#2]** | **C (was N in V1)** |
| 7 | HIGH | VD-2 missing yamlRunner | B-PR1a (P2) | C |
| 8 | HIGH | install accepts malformed YAML | C-PR2 (P3) | C |
| **9** | HIGH | nested child runs absent from `/runs` | **C-PR3 `RecipeRun` per nested call [R3-#2]** | **C (was N in V1)** |
| **10** | MED | `--allow-write` sing/plural | **DEFERRED to C-PR2c follow-up; owner: CLI team; target: Sprint+1** | DEFERRED |
| 11 | MED | examples bare `{{threads}}` | C-PR3 (event triggers); flat-key D-templates F10 deferred | PARTIAL |
| **12** | MED | nested child failure → `childOutputs:{}` | **DEFERRED to nestedRecipeStep error propagation; owner: recipes-runtime; target: Sprint+1** | DEFERRED |
| **13** | MED | CLI `recipe enable <yaml-name>` rejects | **C-PR2 subdir resolver covers (same root cause) [R1-Q6]** | C |
| 14 | MED | registrySnapshot duplicated (=#25) | B-PR1b (P2) | C |
| **15** | LOW | manual fire of cron logs `trigger:cron` | **DEFERRED to C-PR3 follow-up; owner: recipes-runtime; target: Sprint+1** | DEFERRED |
| 16 | LOW | replay yaml-rejected | n/a — working as designed | n/a |

**I-e2e: 10/16 C, 1 PARTIAL, 4 DEFERRED with owners, 1 n/a. Seams 3/4/5/6/9 — V1's biggest paper-coverage gap — now pinned.**

### Coverage matrix totals

| Source | Total | C | PARTIAL | DEFERRED | n/a |
|---|---:|---:|---:|---:|---:|
| Round-1 | 29 | 26 | 2 | 0 | 1 |
| F-tools | 13 | 8 | 0 | 5 (owners + targets) | 0 |
| G-security | 13 | 11 | 0 | 0 | 2 |
| H-routes | 15 | 9 | 0 | 4 (owners + targets) | 2 |
| I-e2e | 16 | 10 | 1 | 4 (owners + targets) | 1 |
| **TOTAL** | **86** | **64** | **3** | **13** | **6** |

**0 NOT-COVERED. Every deferred finding has named owner + target sprint.**

---

## 5. Maintainer decisions (revised)

### Original 9 (carried from V1, with [R3] amendments)

**DP-1. F-03 permissions** *(PLAN-A DP-1 + R3-DP-1)*
- V1: Option B (delete) recommended.
- **R3 added Option C**: delete + 30-line dashboard-copy honesty fix ("Patchwork does not enforce per-recipe permissions; configure tool gating in `~/.claude/settings.json`"). **Recommend Option C** per [R3-§2-DP-1]. ~80 LoC total. Without copy change, Option B silently shifts safety responsibility to operator.

**DP-2. F-05 install allowlist** *(PLAN-A DP-2)*
- V1: env-var-default-empty (effectively github-only).
- **R3 sub-issue**: SSRF DNS-resolution check must run AFTER env-var allowlist match, not before (per [R3-DP-2]).
- **Recommend** env-var-default-empty + explicit DNS-AFTER-allowlist test in PR-2.

**DP-3. F-09 maxConcurrency cap** *(PLAN-A DP-3 + C-PR6)*
- V1: 16, warn above 8.
- **R3 flagged**: silent on bridge-wide concurrency. 16/recipe × N recipes → 64+ in-flight.
- **Recommend** 16 per-recipe + add bridge-wide cap note + DP-3-followup ticket for orchestrator-wide semaphore (RecipeOrchestrator extraction is natural home; per memory note `project_recipe_orchestrator.md`).

**DP-4. #6 trigger wiring** *(PLAN-C DP-1 + R3-DP-4)*
- V1: Option A (wire to orchestrator), 3-4 days.
- **R3**: realistic estimate is 6-8 days, not 3-4. HIGH risk explicitly tagged.
- **Recommend** Option A with HIGH-risk tag + 8-day budget. Day-1 risks: re-fire storms, scheduler-vs-registry race.

**DP-5. #8 lint whitelist** *(PLAN-C DP-2 + R3-DP-5)*
- V1: explicit 5-root `{steps, env, vars, recipe, $result}`.
- **R3**: verify `$result` runtime existence before whitelisting. None of the 4 reports cite a recipe using `$result`.
- **Recommend** confirm `$result` via grep on templateEngine + yamlRunner; if absent, drop to 4-root set.

**DP-6. #14 daily-status precedence** *(PLAN-C DP-6 + R3-DP-6)*
- V1: YAML-wins.
- **R3 wants URL-extension half preserved**: ship `/recipes/daily-status.json` URL form alongside YAML-wins. Without it, dashboard JSON-variant access dropped silently.
- **Recommend** YAML-wins + URL-extension form together (no longer "either/or" — per R3 they coexist).

**DP-7. #15 missing routes** *(PLAN-C DP-3 + R3-DP-7)*
- V1: 4 land, 2 skip, 1 docs.
- **R3**: `POST /recipes/:name/permissions` is in 4-land set but DP-1=Option B → no sidecar to update. **Inconsistent.**
- **Recommend** drop `POST /recipes/:name/permissions` from land-set; ship 3 routes instead.

**DP-8. #19 camelCase strategy** *(PLAN-C DP-4 + R3-DP-8)*
- V1: auto-emit in `registerTool`.
- **R3**: add property test for collision case (e.g. `foo_bar` and `fooBar` both register).
- **Recommend** auto-emit + collision property test.

**DP-9. #23 dead `parser.ts`** *(PLAN-C DP-5 + R3-DP-9)*
- V1: delete.
- **R3**: `parser.test.ts` 14 cases — verify edge-case parity in re-pointed tests before deletion.
- **Recommend** delete + re-point tests to `legacyRecipeCompat.normalizeRecipeForRuntime`.

### New decisions from reviews

**DP-10 [R2-C2]. Jail-roots default — opt-in or always-on `/tmp`?**
- V1 default: always include `os.tmpdir()`.
- R2: Linux `/tmp` is multi-tenant; on Pro relay hosting, recipe A can write to path recipe B reads. Tenant isolation broken.
- **Recommend** opt-in via `CLAUDE_IDE_BRIDGE_RECIPE_TMP_JAIL=1` env var. Migrate `synthetic-readonly.yaml` test fixture to `~/.patchwork/test-sandbox/`.

**DP-11 [R2-C3]. `vars` validation — reject `..` after URL-decode?**
- V1: "no control chars, ≤ 1 KB" (no-op against `..`).
- R2: rule must be `/^[\w\-. :+@,]+$/u` + null-byte + control-char + length ≤ 1 KB + type-strict to string.
- **Recommend** yes, reject `..`/`/`/`\`/`~`/null/control chars after URL-decode. Type-strict to `Record<string, string>`.

**DP-12 [R2-H3]. Cross-process FileLock — filesystem advisory lock, in-memory + cross-bridge IPC, or both?**
- V1: in-memory `FileLock` (in-process only).
- R2: three independent processes (cron, CLI, subprocess driver) all see empty Map and proceed.
- Options:
  - (a) `proper-lockfile` npm pkg — filesystem advisory lock.
  - (b) `O_EXCL` create-and-keep-open pattern.
  - (c) IPC layer through bridge process.
- **Recommend** filesystem advisory lock (a). Atomic rename remains primary defence; lock provides "stronger guarantee" claim that V1's DP-3 promised but couldn't deliver.

**DP-13 [R1-R4]. taskId format change in B-PR3 — preserve legacy id alongside?**
- V1: implicitly changed `task_abc123` → `daily-status-1777627780016`. Public-API break.
- R1: any caller polling `/tasks/<taskId>` after `POST /recipes/<name>/run` breaks for every JSON-prompt recipe.
- Options:
  - (a) Surface yamlRunner-emitted single-step orchestrator task id.
  - (b) Keep new label format AND emit equivalent legacy id alongside.
  - (c) Bump bridge protocol/major version.
- **Recommend** (b): preserve `<recipeName>:<startTs>` AND emit equivalent legacy orchestrator id alongside in response. Document migration in release notes.

**DP-14 [R1-Q6]. YAML-vs-YAML same-name collision — load-time error or last-installed-wins?**
- V1: not addressed (only fixed JSON-vs-YAML).
- R1: I-e2e Seam #5 — two recipes both `name: p1-hello` → both unreachable.
- Options:
  - (a) Load-time hard error: refuse second registration with clear message + path of conflicting file.
  - (b) Last-installed-wins (silent overwrite — same as today's broken state).
  - (c) Reject both (today's behaviour).
- **Recommend** (a): load-time hard error. Message: `Recipe name '${name}' is already registered from '${existingPath}'; rename '${newPath}' or remove the duplicate.`

---

## 6. Risk and rollback (revised)

### Phase 1 risks

- **A-PR1 + A-PR2 + A-PR4** are isolated to recipe runner, HTTP route handlers, and installer. **Revert by reverting one commit each.**
- **A-PR4 (sidecar delete) is metadata-destructive** — keep migration script in PR description so users can restore from `~/.patchwork/recipes/.permissions-archive/` if they relied on those files. Once-per-boot count-only warning logged for stale sidecars.
- **[R3-#1] Phase 1 cannot honestly stop bleed without A-PR4.** V1 claimed it could; that's wrong. With A-PR4 promoted, claim is now true.

### Phase 2 risks

- **B-PR1a is the new load-bearing PR** **[R3-A1]**. Touches both runners + new module + detector generalization. Independent of B-PR1b. Carries the silent-fail floor.
- **B-PR1b is the rollback-risky PR** **[R1-A1/R3-A1]**. Crosses bridge/dashboard boundary. Format change to `runlogVersion: 2`. **Tag `runlogVersion: 2`** + add dashboard branch reader IN THE SAME PR — old rows continue to work via the version-branched reader (now real, not invented).
- B-PR1a → B-PR1b ordering is sequential within Phase 2. Roll B-PR1b back independently if dashboard fails.

### Phase 3 risks

- C-PR1 (parser delete) — re-point tests before merge, verify 14 test-cases in re-pointed file.
- C-PR2 — large bundle; consider splitting at maintainer's discretion **[R3-§4.3]**.
- C-PR5 — test-heavy; collision property test must run.

### Phase 4 risks

- **A-PR3+B-PR2 combined PR is largest in plan** **[R3-§3.3]**. Cycle-detection test, maxDepth clamp test, concurrent-write test, and atomic-rename sweeper test all in one PR.
- File-system advisory lock (`proper-lockfile`) introduces new dependency — vet for security.

### Phase 5 risks

- **B-PR3 caller sweep needs explicit greppable test** **[R3-§7]**. After PR: `grep -rn "loadRecipePrompt" src/` returns zero hits except deprecation comment.
- B-PR3 changes `triggerSource` tag — audit `/tasks` filter consumers + ctxQueryTraces queries before merge.
- **DP-13 taskId backwards-compat** must ship in B-PR3 PR description (not deferred) to avoid breaking external Dispatch/CLI scripts.
- B-PR4 collision check is load-time hard error — operators with existing dup `name:` recipes will see boot fail. Migration: print clear error + path; require rename.

### Phase 6 risks

- **C-PR3 is HIGH risk** **[R3-DP-4]**. 6-8 days budget. Day-1 risks: re-fire storms on file-watch hot-reload, race between scheduler and registry on cron triggers.
- New `RecipeAutomationRegistry` is ~150 LoC of new infrastructure with hot-reload + dedup.
- Document migration: any starter-pack users with newly-firing triggers should review `cooldownMs` defaults (min 5000 honored).
- **A-PR5 fixtures** are repo additions; LOW risk.

### Cross-cutting risks

- **[R1-Q4/R3-DP-6] Per-extension URL form must ship together with YAML-wins**, otherwise dashboard JSON-variant access drops silently.
- **[R1-R7] `kind:prompt` JSON schema-validation gap**: post-B-PR3, JSON files fail schema check via dashboard/linter even though they run. Document or add `kind:prompt` JSON schema branch.
- **[R3-DP-7] DP-1=Option B forces `POST /recipes/:name/permissions` drop from C-PR4 land-set**.

---

## 7. Pre-ship checklist

Verify each before Phase 1 starts. Maintainer signs off.

1. **Confirm `$result` runtime support**. Run: `grep -rn "\\$result" src/recipes/templateEngine.ts src/recipes/yamlRunner.ts src/recipes/chainedRunner.ts`. If zero hits → drop `$result` from C-PR1 lint whitelist (4-root set). **[R3-DP-5]**

2. **Resolve bundled-templates dir path**. Decide between `path.resolve(__dirname, '../templates/recipes')` vs `require.resolve(...)` based on npm-global vs local-dev install paths. Hard-code in A-PR1's helper before review. **[R2-M5]**

3. **Confirm Option C for permissions** (delete + dashboard copy). Ship the 30-line dashboard component change in A-PR4 SAME PR; otherwise Option B silently shifts safety to operator. **[R3-DP-1]**

4. **Audit `/tasks` filter consumers + ctxQueryTraces queries by triggerSource**. Pre-flight grep: `grep -rn "triggerSource" src/ dashboard/`. Identify any consumer that filters on `recipe:${name}` exact prefix vs `recipe:${name}:agent` — coordinate B-PR3 release notes. **[R1-Q3]**

5. **Choose cross-process lock primitive** for DP-12. `proper-lockfile` (recommended) requires npm dep add. Alternative: handcrafted `O_EXCL` pattern. **[R2-H3]**

6. **Confirm dashboard reader location** for `runlogVersion: 2`. Today: zero hits in `dashboard/` for `runlogVersion`. Confirm B-PR1b PR includes:
   - `dashboard/src/app/runs/[seq]/page.tsx` version branch
   - `dashboard/src/lib/registryDiff.ts:142-168` delta-aware logic
   - 3+ round-trip tests **[R1-Q2/R3-#3]**

7. **Verify RecipeOrchestrator inflight semantics post-B-PR3**. Pre-flight test: fire `daily-status` twice in 100ms, confirm second returns `already_in_flight` cleanly. Document in release notes. **[R1-R6]**

8. **Confirm taskId backwards-compat shape** for DP-13. Pre-flight check: identify any external consumers (Dispatch hooks, CLI scripts) that POST then poll `/tasks/<taskId>`. Document migration. **[R1-R4/DP-13]**

9. **Run pre-flight migration on dup-name recipes**. Before B-PR4 merge: `grep -rn "^name:" ~/.patchwork/recipes/*.yaml` — if any duplicate `name:` values exist, rename one BEFORE B-PR4 lands or boot will fail loud. **[R1-A5/DP-14]**

10. **Verify `proper-lockfile` (or chosen DP-12 primitive) cross-FS behaviour**. If `~/.patchwork/inbox/` is on a different FS than the lock-target dir (uncommon but possible on Linux), test the lock path explicitly. **[R2-H2/R2-H3]**

---

## 8. What this plan still does NOT cover

(Carried + amended from V1, with explicit owners + targets for everything deferred.)

- **Connector-side wrappers** (F2: 7 connector files no try/catch) — **DEFERRED to PLAN-D**, owner: connector-hygiene team, target: post-Phase-6.
- **F10 `notify.push` doesn't exist** — **DEFERRED to PLAN-D tool-registry-cleanup**, owner: tool-registry-cleanup, target: Sprint+1.
- **F11 `meetingNotes.flatten` weak input validation** — DEFERRED to PLAN-D, target: post-Phase-6.
- **F12 `github.list_issues` 2348ms perf** — DEFERRED to perf backlog, target: TBD.
- **F13 `diagnostics.get` placeholder** — DEFERRED to docs, target: Sprint+1.
- **H-routes MED 8 (`/runs/:seq/plan` 503-vs-404)**, **MED 10 (`/templates` cache no single-flight)**, **MED 11 (`/activation-metrics` opt-out)**, **LOW 13 (`/recipes/lint` 200 not 400)**, **LOW 14 (`/runs?status=bogus` silent 200)** — DEFERRED to PLAN-D HTTP hygiene, target: Sprint+1 to Sprint+2.
- **I-e2e #10 `--allow-write` singular/plural** — DEFERRED to C-PR2c follow-up, target: Sprint+1.
- **I-e2e #12 nested child failure → `childOutputs:{}`** — DEFERRED to nestedRecipeStep error propagation work, target: Sprint+1.
- **I-e2e #15 manual fire of cron logs `trigger:cron`** — DEFERRED to C-PR3 follow-up, target: Sprint+1.
- **D-templates F10 (template engine rejects bare `{{name}}` in chained context)** — PARTIAL via C-PR1 lint, runtime fix DEFERRED.
- **Bridge-wide orchestrator concurrency cap** — DEFERRED to RecipeOrchestrator extraction continuation, target: Sprint+1.
- **Dashboard UI changes** beyond `runlogVersion: 2` reader — out of scope; dashboard already gracefully degrades.
- **Plugin authoring docs** for camelCase aliases — separate docs PR.

---

## 9. Schedule summary (revised)

| Phase | Week | PRs | Closes |
|---|---|---|---|
| 1 — Stop bleed | 1 | A-PR1, A-PR2, **A-PR4** *(promoted)* | 7 G-sec findings + F-03 + H-routes Bug 3 + R2-C1/C2/C3 |
| 2 — Foundation | 2 | **B-PR1a**, **B-PR1b** *(split)* | 5 runner-contract + F6/F7/F8 + dashboard reader |
| 3 — Cleanup | 3 | C-PR1, C-PR2, C-PR5, C-PR6 | 13+ lint/CLI/test bugs + B-cli #31 |
| 4 — Coordinated | 4 | A-PR3+B-PR2 *(may fold to P3)* | #1 + F-06 + F-07 + F-09 + maxDepth + sweeper + flock |
| 5 — Resolver | 5 | B-PR3, B-PR4+C-PR4 | #14 + #16 + PATCH-ESM + 3 routes + I-e2e #5 + 3-caller sweep |
| 6 — Triggers | 6 | C-PR3 *(HIGH risk)*, A-PR5 | #6 + #10 + #13 + I-e2e #3/#4/#6/#9 + fixtures + lint rule |

**14 PRs, 6 weeks. Phase boundaries honest. 0 NOT-COVERED bugs; 13 deferred with owners + sprints.**

V1 → V2 deltas: +2 PRs (B-PR1 split + A-PR4 standalone), 4 false dep arrows removed, 5 I-e2e seams promoted from N → C, 3 F-tools findings (F6/F7/F8) promoted from N → C via detector generalization, 1 H-routes bug (Bug 3) promoted from P → C.

---

## 10. Trace tags index

Every amendment in §1 carries a `[R1]`, `[R2]`, or `[R3]` tag pointing back to the source review. Reviewer can verify each by grepping the corresponding REVIEW-N file for the cited line/section. Critical bug-class amendments cross-reference both the V1 plan claim and the source-of-truth file:line.

| Tag | Source | Count |
|---|---|---|
| [R1] | REVIEW-1-architecture.md | 17 amendments |
| [R2] | REVIEW-2-security.md | 16 amendments |
| [R3] | REVIEW-3-completeness.md | 17 amendments |

Total: 50 amendments tracked across the plan.
