# Recipe Dogfood — 2026-05-01

Two rounds of agent fan-out + plan synthesis.

**Round 1** (alpha.34 bridge — stale Node V8 cache masked some fixes):

| Report | Surface |
|---|---|
| [A-live-runs.md](A-live-runs.md) | Live HTTP runs — grounding, VD-2, silent fail |
| [B-cli.md](B-cli.md) | `recipe` CLI subcommands (alpha.35 fresh build) + `quick-task` |
| [C-triggers.md](C-triggers.md) | Trigger types: cron / chained / git_hook / on_file_save / on_test_run / on_recipe_save / events |
| [D-templates.md](D-templates.md) | Template engine, output registry, lint↔runtime parity matrix |
| [E-tests-dashboard.md](E-tests-dashboard.md) | Vitest suites (708/0/0), PR coverage gaps, dashboard parity, replayRun |

**Round 2** (alpha.35 fresh bridge — PR #70 confirmed live):

| Report | Surface |
|---|---|
| [F-tools.md](F-tools.md) | 97 tools / 23 namespaces; PR #93 deep dive; camelCase aliases (only 2 of 36 shipped) |
| [G-security.md](G-security.md) | Recipe runner security audit — 3 CRITICAL exploits live-confirmed |
| [H-http-routes.md](H-http-routes.md) | HTTP route audit — PATCH ESM bug, SSRF in /recipes/install, 6 missing routes |
| [I-e2e.md](I-e2e.md) | End-to-end pipeline lifecycle for 4 recipe shapes — 16 new seams |
| [K-verify.md](K-verify.md) | Re-verification of 28 round-1 bugs on fresh bridge |

**Fix planning** (V1 → review → V2):

| Plan | Bundle | PRs |
|---|---|---|
| [PLAN-A-security.md](PLAN-A-security.md) | Path traversal, SSRF, atomic write, permissions | 5 |
| [PLAN-B-runners.md](PLAN-B-runners.md) | Cross-runner contract (shared post-step pipeline) | 4 |
| [PLAN-C-schema-cli.md](PLAN-C-schema-cli.md) | Lint, CLI, triggers, missing routes, tests | 6 |
| [PLAN-MASTER.md](PLAN-MASTER.md) | V1 master — 12 PRs / 6 phases | — |

**Reviews** (each independent, read-only):

| Review | Lens | Verdict |
|---|---|---|
| [REVIEW-1-architecture.md](REVIEW-1-architecture.md) | PLAN-B stress test — 4 wiring points, runlogVersion reader gap, taskId API break, 5 I-findings unfolded | amend |
| [REVIEW-2-security.md](REVIEW-2-security.md) | PLAN-A bypass scenarios — 3 CRITICAL (3rd template site, `/tmp` shared, vars rule misses `..`), 3 HIGH | amend |
| [REVIEW-3-completeness.md](REVIEW-3-completeness.md) | Coverage matrix — 24 dropped findings, 9 maintainer-decision challenges, PR-size reality check | amend-and-ship |
| [REVIEW-4-signoff.md](REVIEW-4-signoff.md) | Independent pre-ship sign-off, contradiction matrix, 7 missed-by-all-reviews | SIGN-OFF-WITH-CONDITIONS (9 blockers) |

**Final-sweep deliverables**:

| Doc | Purpose |
|---|---|
| **[PLAN-MASTER-V2.md](PLAN-MASTER-V2.md)** | **Canonical revised plan** — 14 PRs, 50 amendments tagged `[R1]`/`[R2]`/`[R3]`, 0 NOT-COVERED entries, 5 new DPs (10–14) |
| **[HANDOFF-engineering-briefs.md](HANDOFF-engineering-briefs.md)** | Per-PR briefs (14 PRs × 10 sections), implementation order, fixture-sharing map, 19-decision deadline calendar |

**Did not exercise (per safety rules):** `morning-brief-slack`, `triage-brief`, both `google-meet-debrief` (WRITE-EXTERNAL — would post to real Slack / create real Linear issues).

---

## Cross-cutting bugs (deduped, severity-ranked)

### CRITICAL — safety-gate bypassed

1. **Chained recipes report `hasWriteSteps: false` even when they write.** `chainedRunner.generateExecutionPlan` omits the `tool` field; `enrichStepFromRegistry` (`src/commands/recipe.ts:806-820`) bails when `step.tool` is undefined → no `isWrite` tag → approval gating that trusts the flag is wrong for **every chained recipe with a write step**. (A)
   - Repro: `branch-health` plan has `hasWriteSteps: false` despite writing to `~/.patchwork/inbox/`.
2. **`detectSilentFail` runs only on the YAML runner, not the chained runner.** `chainedRunner.ts:10` doesn't import it. Live evidence: chained `branch-health` step `stale` has `status: "ok"` while `output: "(git branches unavailable)"` — yamlRunner would have flagged it. (D)
3. **Schema / parser / validator disagree on legal trigger types.** `parser.ts:71-115` accepts `{webhook, cron, file_watch, git_hook, manual}`; `validation.ts:57-66` adds `{on_file_save, on_test_run, chained}`. The dispatch path bypasses `parseRecipe` entirely. Recipes pass install-time validation but never dispatch. (C)

### HIGH — broad correctness / discoverability

4. **`recipe list` shows 1 of 17 recipes.** `listInstalledRecipes` walks subdirs only, not top-level YAML/JSON. (B `src/commands/recipeInstall.ts:667-720`)
5. **`recipe install` accepts malformed YAML; `recipe test` exits 0 even with errors; `recipe run --dry-run` exits 0 with `lint.errors` populated.** CI silently passes broken recipes. (B)
6. **YAML-trigger recipes never auto-fire.** `on_file_save`, `on_test_run`, `on_recipe_save`, `git_hook` are descriptive only — no code reads them from the recipe to wire a hook. The actually-firing hooks live in `automation-policy.json`. `lint-on-save`, `watch-failing-tests`, `ambient-journal` recipes are dormant. (C)
7. **`recipe new` default template fails its own `recipe lint`.** Auto-generated `description: Recipe: <name>` is a YAML compact-mapping parse error. (B `src/index.ts:1228`)
8. **100% linter false-positive rate on the live recipe set.** All 12 lint errors across `branch-health`, `triage-brief`, `daily-status.json` are spurious. Root cause: `validation.ts:501-524` rejects `{{steps.X.data}}` and `{{env.X}}` because it splits the dotted path and looks up only the root. Chained runner resolves them at runtime. (A, D)
9. **VD-2 capture (`resolvedParams`/`output`/`registrySnapshot`/`startedAt`) is chained-runner-only.** YAML runner used by ~85% of recipes still emits the bare 4-field stepResult shape. Same as 2026-04-29. (A, D — `captureForRunlog` only imported by `chainedRunner.ts:10`)
10. **Cron scheduler uses system local TZ.** No `timezone` option to `node-cron` and no per-recipe override. `morning-brief @ "0 8 * * 1-5"` fires 08:00 EAT here, not UTC. (C `src/recipes/scheduler.ts:232`)
11. **`morning-brief` silently skips agent step when `ANTHROPIC_API_KEY` unset.** Writes `[agent step skipped: ANTHROPIC_API_KEY not set]` placeholder, reports `status: ok`, `durationMs: 0`. Same as 2026-04-29. (A)

### MEDIUM

12. **Bridge staleness masks PR #70/#71/#72 fixes.** Running PID 56865 started 2026-04-29 11:17, before the fixes merged. `dist/` has the new code but V8 cached the old modules. Restart required to validate live. (A)
13. **`nestedRecipeStep.validateNestedRecipe` off-by-one.** `currentDepth > recipeMaxDepth` permits `currentDepth === maxDepth` to recurse one more layer. `maxDepth: 2` actually allows 3 layers. (C `src/recipes/nestedRecipeStep.ts:70`)
14. **`daily-status` name shadowing root cause is dispatch ordering.** `src/recipeOrchestration.ts:344` resolves JSON-first; YAML variant is silently unreachable. Different precedence than `findYamlRecipePath` uses elsewhere. (A)
15. **`/recipes/:name/runs` route does not exist.** Per-recipe runs only via `/runs?recipe=:name`. (A)
16. **`kind: prompt` JSON recipes lint-fail and schema-fail but execute correctly.** They take a wholly separate `loadRecipePrompt` path (`recipesHttp.ts:995-1047`) that bypasses both. `daily-status.json` produces 206 schema errors at lint time. (D)
17. **`recipe run <name>` cannot resolve recipes in subdirs** even when CLI's broken `recipe list` (would) show them. (B)

### LOW

18. **PR #93 (Jira + Sentry recipe-tool wrappers) has zero unit tests.** Only tool test in repo is `sinceToGmailQuery`. (E)
19. **PR #103 camelCase aliases (`slack.postMessage`, `linear.listIssues`) untested.** (E)
20. **`recipe new --help` creates `~/.patchwork/recipes/--help.yaml`** — no `-` prefix guard on recipe name. (B `src/index.ts:1203`)
21. **`quick-task` throws raw `DOMException [TimeoutError]`** when bridge fetch times out — bare `await fetch` with no try/catch. (B `src/commands/task.ts:174-181`)
22. **`replayRun` has no CLI subcommand.** Only HTTP `POST /runs/:seq/replay` and dashboard button. (E)
23. **`parser.ts:parseRecipe` is dead/divergent code** — not called by either runner; rejects every YAML recipe in `~/.patchwork/recipes/`. (D)
24. **`output:` keyword emits deprecation warning on every load** for `branch-health` and `triage-brief`. (D `src/recipes/legacyRecipeCompat.ts:160-165`)
25. **Run-detail `registrySnapshot` duplicated at every chained step** (49KB for 4-step recipe). (A)
26. **`recipe`, `recipe --help`, `recipe new --help` print nothing.** Silent exit 0. (B)
27. **`apiVersion` migration warning printed 3× per preflight; deprecation warnings printed 2× per param block.** (B)
28. **Starter-pack `event:` triggers** (`inbox.new_message`, `calendar.upcoming`, etc.) — confirmed BROKEN-LIKELY. Not recognized by parser, validator, scheduler, or compiler. (C, matches prior inventory prediction)

---

## Confirmed working (regressions to watch for)

- `cron` trigger dispatches reliably (verified live: morning-brief, stale-branches, daily-status all show `taskIdPrefix=yaml:<name>:<startTs>`).
- Chained `parallel:` / `awaits:` block — `branch-health` run #3236: `stale.startedAt=1777626233052` and `recent.startedAt=1777626233066` overlap; `summarise` waits for both; `write` waits for `summarise`.
- `maxConcurrency` enforced (synthetic 4 free steps + cap 2 → max in-flight = 2).
- Cycle detection (synthetic `{a→b, b→a}` returns `hasCycles: true, topologicalOrder: []`). PR #103 fix verified.
- `onRecipeSave` default-prompt fallback at `src/fp/policyParser.ts:315`.
- Dashboard `/recipes`, `/runs/:seq`, `/traces` — shapes match live bridge perfectly. VD-2 fields all optional with graceful degrade.
- `replayRun` HTTP path: chained run #3236 → `ok newSeq=3248`; YAML run correctly rejected as `replay_only_supported_for_chained_recipes` (11 unit tests pass).
- Agent grounding remained good when upstream data was real. Five separate agents flagged broken upstream data instead of fabricating: branch-health (cited 12 PR numbers + 3 SHAs that all verify), daily-status (last-3 commit SHAs match), watch-failing-tests, ctx-loop-test, morning-brief.
- 708 / 0 / 0 vitest results across 44 recipe-related files.

---

## Recommended next actions (suggested order)

1. **Restart the live bridge** — unblocks live validation of #70/#71/#72 fixes (Bug #12).
2. **Fix the silent-safety-bypass triplet (#1, #2, #6)** — chained `hasWriteSteps`, chained silent-fail detection, dormant trigger types. These are the bugs that cost users data integrity.
3. **Fix CLI foundations (#4, #5, #7)** — `recipe list` enumeration, `recipe install`/`test` exit codes, `recipe new` template. The CLI is foundationally unreliable today.
4. **Land linter fix for `{{steps.X.data}}` + `{{env.X}}` (#8)** — kills 100% of false positives in one change to `validation.ts:501-524`.
5. **Port `captureForRunlog` to yamlRunner (#9)** — same VD-2 shape across both runners.
6. **Decide and document trigger-type strategy (#3, #6, #28)** — either wire YAML-declared hooks to the orchestrator, or drop the trigger type from the schema.
7. **Backfill tests for #93 / #103 camelCase (#18, #19)** — net 18 alias pairs untested.
