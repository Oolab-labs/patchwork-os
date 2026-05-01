# Recipe dogfood — Test suites + Dashboard UX (2026-05-01)

Bridge alpha.34 on :3101, source alpha.35. No live bridge restart. No commits.

## Part 1 — vitest results

### 1.1 Cluster A — `src/recipes/__tests__/`

```
npx vitest run src/recipes/__tests__/
Test Files  28 passed (28)
Tests       461 passed (461)
Duration    1.82s
```

All 28 files green, 0 fail, 0 skip. Per-file breakdown (every test passes):

| File | Tests | Notes |
|---|---:|---|
| RecipeOrchestrator.fire.test.ts | (covered in summary) | fire-and-forget contract |
| RecipeOrchestrator.test.ts | … | orchestrator core |
| agentExecutor.test.ts | … | provider-driver dispatch |
| allegedBugs.repro.test.ts | 4 | PR #103 reproducers (cycle, file_watch, dup stepId, file.write undef path — bug 5 here is bonus) |
| captureForRunlog.test.ts | 11 | redaction + 8 KB cap + cycles |
| chainedRunner.runLog.test.ts | … | run-log cycle leak guard |
| chainedRunner.test.ts | … | dependency runner |
| compiler.test.ts | … | recipe → AST |
| defaultGitLogSince.test.ts | 3 | PR #73 (no '(git log unavailable)' silent fail) |
| defaultGitStaleBranches.test.ts | **4** | **PR #70 fully covered** — incl. regression sentinel for the bogus `git branch --since` flag |
| dependencyGraph.test.ts | … | DAG builder |
| detectSilentFail.test.ts | **18** | **PR #72 fully covered** — placeholders, agent-step, list-tool antipattern, JSON passthrough, 120-char cap |
| dispatchRecipe.parity.test.ts | … | YAML vs chained parity |
| installer.test.ts | … | recipe install on disk |
| legacyRecipeCompat.test.ts | … | deprecation sink |
| manifest.test.ts | … | manifest schema |
| meetingNotes.test.ts | … | recipe-tool unit |
| migrations.test.ts | … | schema migrations |
| nestedRecipeStep.test.ts | … | PR #103 nested-recipe lint partially (path resolution; trigger-type-allow not directly asserted) |
| outputRegistry.test.ts | 8 | step-output store |
| parser.test.ts | … | parseRecipe + renderTemplate |
| recipeServers.test.ts | … | server-recipe load (`servers:` block) |
| replayRun.test.ts | 11 | VD-4 mocked replay (buildMockedOutputs + executeTool intercept + executeAgent intercept) |
| scheduler.test.ts | … | cron schedule |
| schemaGenerator.test.ts | … | tool schema gen |
| templateEngine.test.ts | 14 | `{{steps.x}}` + `{{env.X}}` + missing/eval errors |
| toolRegistry.killSwitch.test.ts | 5 | write-kill switch enforcement |
| yamlRunner.test.ts | ~120 | runner core, gmail/linear/github tool steps, expect block, transform, on_error |

### 1.2 Cluster B — top-level `src/__tests__/` recipe suites

```
npx vitest run src/__tests__/recipeOrchestration.test.ts src/__tests__/recipe-cli.integration.test.ts src/__tests__/server-recipes-content.test.ts
Test Files  3 passed (3)
Tests       18 passed (18)
```

`server-recipes-content.test.ts` is the **only** file that exercises `recipeRoutes.ts` HTTP dispatch directly (`tryHandleRecipeRoute(req, res, …)`). 9 route tests: GET/PUT /recipes/:name, POST /recipes/lint (incl. 503 when fn unwired), DELETE /recipes/:name (incl. 404 + 503).

### 1.3 Cluster C — `src/commands/__tests__/`

```
npx vitest run src/commands/__tests__/recipe*.test.ts
Test Files  4 passed (4)
Tests       152 passed (152) — recipe.test.ts alone has ~70
```

Covers CLI: `recipe run`, `recipe fmt`, `recipe lint`, `recipe preflight`, `recipe test`, `recipe watch`, `recipe install/enable/uninstall/reinstall`, dry-run plan generator, expect-block evaluation, watcher debounce.

### 1.4 Cluster D — recipe-tool unit tests

```
npx vitest run src/recipes/tools/__tests__/
Test Files  1 passed (1)   sinceToGmailQuery.test.ts
Tests       10 passed (10)
```

**This is the entire recipe-tool unit test corpus.** Only `sinceToGmailQuery` (a Gmail helper) has dedicated tests.

### 1.5 Cluster E — extra route tests (discovered during audit)

```
npx vitest run src/__tests__/server-run-detail.test.ts src/__tests__/server-activation-metrics.test.ts src/__tests__/webhookRecipes.test.ts
Test Files  3 passed (3)
Tests       43 passed (43)
```

- `server-run-detail.test.ts` — `GET /runs/:seq/plan` (4 tests).
- `server-activation-metrics.test.ts` — `GET /activation-metrics` (6 tests).
- `webhookRecipes.test.ts` — webhook lookup, save/load/delete underlying fns, lint underlying fn (33 tests).

### 1.6 Cluster F — dashboard

```
cd dashboard && npx vitest run src/lib/__tests__ src/components/__tests__ src/app/api/push/subscribe/__tests__
Test Files  5 passed (5)
Tests       24 passed (24)
```

Files: `registryDiff.smoke`, `csrf`, `installSourceValidation`, `Skeleton.smoke`, `push/subscribe/route`.

### 1.7 Failures

Zero. All 461 + 18 + 152 + 10 + 43 + 24 = **708 tests pass** across the recipe + dashboard surface I exercised.

---

## Part 2 — Missing-test gaps mapped to PRs

| PR | Title | Status | Evidence |
|---|---|---|---|
| **#70** | `defaultGitStaleBranches actually finds stale branches` | **Covered** | `src/recipes/__tests__/defaultGitStaleBranches.test.ts` — 4 tests including a regression sentinel test that explicitly mentions `git branch --since=...` was never a valid flag. No gap to fill. |
| **#72** | silent-fail pattern detection in step runner | **Covered** | `src/recipes/__tests__/detectSilentFail.test.ts` — 18 tests across 5 describe blocks (placeholders, agent-step, list-tool antipattern, JSON-string passthrough, 120-char cap). Wired tests in `yamlRunner.test.ts` (`runYamlRecipe — silent-fail detection (P1)`) cover end-to-end opt-out + optional:true behaviour. |
| **#73** | close 3 silent-fail antipatterns | **Partial** | The 3 antipatterns: (a) `defaultGitLogSince` returning `'(git log unavailable)'` — covered by `defaultGitLogSince.test.ts` (3 tests, regression name explicit). (b) `defaultGitStaleBranches` — covered by `defaultGitStaleBranches.test.ts`. (c) **third antipattern unidentified** — PR description says "Three tools" but only commits diff of yamlRunner.ts. Likely covered indirectly via `detectSilentFail.test.ts`'s list-tool shape tests but no dedicated assertion ties to a specific connector tool. **Soft gap.** |
| **#102** | extract recipe + run-audit + templates routes | **Partial** | `server-recipes-content.test.ts` covers GET/PUT/DELETE `/recipes/:name` + POST `/recipes/lint` (9 route tests through actual `tryHandleRecipeRoute` dispatch). `server-run-detail.test.ts` covers `/runs/:seq/plan` (4 tests). `server-activation-metrics.test.ts` covers `/activation-metrics` (6). **Gap: no route tests for `POST /runs/:seq/replay`, `POST /recipes/install`, `GET /templates` (with the 5-min cache), `POST /recipes` (create), `POST /recipes/:name/run`.** `replayRun.test.ts` tests the underlying logic but not the HTTP path matching/status code mapping. |
| **#103** | 5 fixes in one PR | **4 of 5 covered** | (a) cycle run-log leak — `allegedBugs.repro.test.ts > BUG 4`. (b) file_watch `{{file}}` ctx — `allegedBugs.repro.test.ts > BUG 5`. (c) dup stepIds — `allegedBugs.repro.test.ts > BUG 2`. (d) nested-recipe lint (allow `recipe:` step under `manual` trigger, not just `chained`) — **no dedicated test**. (e) camelCase aliases (`slack.postMessage`, `linear.listIssues`) — **no test at all**. **2 gaps.** |
| **#93** | Jira + Sentry recipe-tool wrappers | **Zero coverage** | `src/recipes/tools/jira.ts` (392 lines) + `src/recipes/tools/sentry.ts` (78 lines) have **no `__tests__` files**. `grep -r "jira\|sentry" src/recipes/__tests__/` only finds fixture-name strings (`"sentry-autofix"`) — no actual tool-call tests. The existing `src/recipes/tools/__tests__/` directory contains exactly one file (`sinceToGmailQuery.test.ts`). **Major gap.** |

### 2.1 Deterministic test for #70 — already exists

The brief asked: *"Add a deterministic test if missing (do not commit; just report)."* — already there. `defaultGitStaleBranches.test.ts` builds a real temp git repo with backdated commits via `child_process.execFileSync("git", …)` and asserts the function lists exactly the right branches. No need to add.

### 2.2 Other gaps surfaced

- **Dashboard**: zero tests targeting `/recipes` page or `/api/bridge/recipes/*` routes. The 5 dashboard test files cover only library helpers (csrf, registryDiff, installSourceValidation), one component smoke, one push-API CSRF guard. No render/data-shape tests for `recipes/page.tsx`, `runs/[seq]/page.tsx`, `traces/page.tsx`.
- **`recipeRoutes.ts` dispatcher** — no test calls `tryHandleRecipeRoute` for the install/templates/replay/create/run paths. Only the GET/PUT/PATCH/DELETE/lint quartet has direct dispatcher tests.
- **`detectSilentFail` JSON-stringified `null`** — the `parses a stringified silent-fail object` test covers JSON shape, but the false-positive risk on a raw `"null"` string is not asserted.

---

## Part 3 — Dashboard parity findings

### 3.1 Recipe list page (`dashboard/src/app/recipes/page.tsx`)

- **Recipe count**: brief said 17 recipes. Live bridge `GET /recipes` returns **16** (one trigger=git_hook, two trigger=cron with the same `daily-status` name from a `.json` and a `.yaml` so both list, one chained, etc.). Either the brief miscounted or one was uninstalled since the briefing. Not a bug.
- **Lint surfacing**: ✓ confirmed.
  - `branch-health` — bridge returns `{ok:false, errorCount:6, firstError:"Step 3: Unknown template reference '{{steps.stale.data}}' in agent.prompt"}`. Page renders pill `✗ 6 errors` with `firstError` as `title=` (line 598-606). Detail row also shows full `firstError` in red.
  - `triage-brief` — `errorCount:5`, same render path. ✓ correct.
  - `daily-status (.json)` — `errorCount:1` (`"Must have 'tool' or 'agent' field"`). Page renders correctly.
  - Warnings render via separate amber pill (line 607-615) but no live recipe currently has warnings, so this branch is untested in production.
- **Data shape parity** between live bridge and `Recipe` interface in page.tsx:

| Bridge field | Page field | Match |
|---|---|---|
| `name` | `name` | ✓ |
| `description` | `description` | ✓ |
| `trigger` (string) | `trigger?: string` | ✓ |
| `stepCount` | `stepCount?: number` | ✓ |
| `path` | `path?: string` | ✓ |
| `installedAt` | `installedAt?: number` | ✓ |
| `hasPermissions` | `hasPermissions?: boolean` | ✓ |
| `source` | `source?: string` | ✓ |
| `enabled` | `enabled?: boolean` | ✓ |
| `lint.{ok,errorCount,warningCount,firstError}` | matching nested shape | ✓ |
| (not returned) | `webhookPath?: string` | Page expects but bridge doesn't include for non-webhook recipes — defensive, fine. |
| (not returned) | `vars?: RecipeVar[]` | Page expects but bridge doesn't include in list endpoint. Run-modal works only for recipes with vars; no live recipe has them so untested in production. |
| (not returned) | `id?` | unused in render |

Page polls every 5 s (`setInterval(load, 5000)`). Connectors panel inferred from prefix-match heuristic on name + description (line 23-39) — `slack`/`gmail`/`gemini` recipes won't surface their connector since `gemini_` isn't in `TOOL_PREFIX_MAP`. **Soft cosmetic gap — not blocker.**

### 3.2 Run-detail page (`dashboard/src/app/runs/[seq]/page.tsx`)

- **VD-2 capture render**: ✓ `StepResult` interface (line 12-23) marks `resolvedParams`, `output`, `registrySnapshot`, `startedAt` all optional with the comment `// VD-2 capture (all optional — pre-VD-2 runs don't have these)`. `StepDiffHover` (line 305-310) only renders when capture present. Old (pre-VD-2) runs degrade to no hover panel — graceful.
- **Empty-state for runs without `stepResults`**: ✓ lines 891-899 render *"No step-level data for this run. Step results are captured for recipes run via `patchwork recipe run` — older runs in the log do not carry step detail."*
- Tested live: `seq=3232` (yaml runner local-noop) returned only summary level results (`stepResults` array but no `output`/`resolvedParams`). Run-detail page would render the rows in StepRow without VD-2 hover — graceful.
- Tested live: `seq=3236` (chained branch-health) returned full VD-2 capture (`resolvedParams` + `output` per step). Replay button at line 692 calls `POST /api/bridge/runs/:seq/replay` and shows `unmockedSteps` count — verified live.

### 3.3 Replay endpoint live-probed

```bash
POST /runs/3232/replay → 500 {"ok":false,"error":"replay_only_supported_for_chained_recipes"}
POST /runs/3236/replay → 200 {"ok":true,"newSeq":3248,"unmockedSteps":["recent"]}
```

Bridge correctly rejects YAML-runner runs (replay only re-runs chained recipes). `unmockedSteps` for #3236 = `["recent"]` because the original run lacked output capture for that step (failed mid-execution). New run seq is appended to the run-log.

### 3.4 `/traces` page parity

- Source: `dashboard/src/app/traces/page.tsx` line 232 — `fetch("/api/bridge/traces"+qs)`.
- Live bridge `GET /traces?limit=3` returns:
  ```
  {
    "traces": [...],
    "count": 3,
    "sources": {"approval": true, "enrichment": true, "recipe_run": true, "decision": true}
  }
  ```
- Page interface `TracesResponse` (line 17-26) matches exactly. `validateTraces` (line 28-45) shape-checks at runtime (good — no `proxy<T>()` blind cast).
- Trace types (`approval | enrichment | recipe_run | decision`) and the colour/pill theme map (line 54-62) cover all 4 sources.

### 3.5 RECENT DECISIONS digest source

CLAUDE.md says: *"On every session connect, the bridge prepends a digest of the last 12h of decisions to its MCP instructions block (top 5, ≤2 KB)."*

- Source: `src/tools/recentTracesDigest.ts`. Reads from `deps.decisionTraceLog` (line 117). Header literal `"RECENT DECISIONS (last 12h):"` at line 144 — exact match for the system-prompt text.
- Same `decisionTraceLog` instance is wired into:
  - `src/tools/ctxQueryTraces.ts` (line 218) — what `/traces` page calls.
  - `bridge.ts` (line 926-1435) — initialised once and shared.
- ✓ Confirmed parity: dashboard `/traces` page and the session-start digest pull from the same store. The MEMORY.md auto-memory shown to me at session start in the system prompt also derives from this — five `recipe_run` lines with `46m ago / 1h ago` matches recent runs of `watched-valid`, `single-step-by-tool/into/id`.

---

## Part 4 — Replay status

- `src/recipes/replayRun.ts` — yes, exists. `replayMockedRun(seq)` is the entrypoint.
- **Wiring**:
  - HTTP route: `POST /runs/:seq/replay` in `src/recipeRoutes.ts:285-319`. Returns 503 when fn unwired, 404 when run missing, 500 otherwise.
  - Dynamic import: `src/recipeOrchestration.ts:217` — `const { replayMockedRun } = await import("./recipes/replayRun.js")`.
  - Dashboard call: `dashboard/src/app/runs/[seq]/page.tsx:468` — `fetch("/api/bridge/runs/"+seq+"/replay", { method:"POST" })`.
- **Unit tests**: 11 tests in `src/recipes/__tests__/replayRun.test.ts` covering `buildMockedOutputs` (4) + `runChainedRecipe — mockedOutputs interception` (7).
- **No CLI subcommand**. There is no `patchwork recipe replay <seq>` — only HTTP route + dashboard button + programmatic import. Could be a worthwhile addition.
- **Live replay test**: `POST /runs/3236/replay → ok:true newSeq:3248 unmockedSteps:["recent"]`. Replay completed in <1 s. New run row appears in `~/.patchwork/runs.jsonl` (now 1569+ lines).

---

## TL;DR — ranked by severity

1. **[P1] Zero unit tests for `src/recipes/tools/jira.ts` (392 lines) and `sentry.ts` (78 lines).** PR #93 added these wrappers but skipped tests. The only test in `src/recipes/tools/__tests__/` is `sinceToGmailQuery.test.ts`. Action: add at least happy-path + connector-failure tests for each of the 7 jira tools + 1 sentry tool.
2. **[P1] No tests for the camelCase tool aliases** (`slack.postMessage`, `linear.listIssues`) introduced by PR #103. A simple `executeTool('slack.postMessage', …)` regression check would catch a future rename. Action: add to `toolRegistry.test.ts` or a new `aliases.test.ts`.
3. **[P2] No test for PR #103's nested-recipe lint relaxation** (allow `recipe:` step under `trigger.type === "manual"`, not just `chained`). The bug-4 reproducer in `allegedBugs.repro.test.ts` does not assert this. Action: 5-line test passing a `manual`-trigger recipe with a nested-recipe step through `validateRecipeDefinition`.
4. **[P2] `recipeRoutes.ts` route surface partially tested.** `tryHandleRecipeRoute` dispatch is exercised for GET/PUT/PATCH/DELETE `/recipes/:name`, POST `/recipes/lint`, GET `/runs/:seq/plan`, GET `/activation-metrics`. **Missing:** POST `/runs/:seq/replay`, POST `/recipes/install`, GET `/templates` (with 5-min cache invariant), POST `/recipes`, POST `/recipes/:name/run`, GET `/runs`, GET `/runs/:seq`. Underlying functions are tested; the route layer (path matching, status codes, error mapping) is not.
5. **[P3] Dashboard has zero tests for `/recipes`, `/runs/:seq`, `/traces` pages.** Pure source-read parity audit showed shapes match the live bridge — but a snapshot/render test would catch silent regressions if either side's contract drifts.
6. **[P3] PR #73 third antipattern unidentified.** PR description says "Three tools" but I could only map two from the diff (`defaultGitLogSince`, `defaultGitStaleBranches`). The third may be the connector list-shape (covered by `detectSilentFail.test.ts > list-tool antipattern`) — non-blocking but worth tracing.
7. **[P3] No `patchwork recipe replay <seq>` CLI** — replayRun is HTTP + dashboard only. Worth adding for headless usage.
8. **[P4] Connector-prefix heuristic on `/recipes` page** misses prefixes not in `TOOL_PREFIX_MAP` (e.g. no `gemini_`, `notion_`, `discord_`, `pagerduty_`). Cosmetic.
9. **[P4] Recipe count mismatch.** Brief said 17 recipes, live bridge serves 16. Two `daily-status` entries (one .json, one .yaml) are intentional — possibly one was uninstalled since briefing.

**Test totals confirmed: 708 passing across recipe + dashboard surface (28 + 3 + 4 + 1 + 3 + 5 = 44 test files). Zero failures, zero skips.**
