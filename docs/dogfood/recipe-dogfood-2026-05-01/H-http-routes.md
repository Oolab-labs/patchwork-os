# H — Recipe HTTP API Surface Audit (Round 2)

**Bridge**: PID 68045, alpha.35, port 3101, fresh restart 2026-05-01 12:24 UTC.
**Workspace**: `/Users/wesh/Documents/Anthropic Workspace/Patchwork OS`.
**Method**: enumerated `src/recipeRoutes.ts`, fired every route with valid+invalid+unauth bodies, diffed WS vs HTTP MCP tool list, ran schema generator against installed recipes, inspected on-disk state.

---

## TL;DR — severity-ranked

### CRITICAL
1. **`PATCH /recipes/:name` is broken for every legacy top-level recipe.** Returns `{"ok":false,"error":"require is not defined"}` — `setRecipeEnabled()` falls into the legacy-config fallback and calls `require()` from ESM code. `src/recipesHttp.ts:200`. All 16 recipes returned by `GET /recipes` are top-level → dashboard's enable/disable toggle is silently dead. **No test covers the production path** (existing `dashboard-cli-state-unification.test.ts` injects `saveConfigFn:` that bypasses the require). [verified live: 400 `require is not defined`]

### HIGH
2. **`/recipes/install` accepts any HTTPS URL — SSRF risk.** `src/recipeRoutes.ts:619-625` accepts `source: "https://..."` with zero allowlist. Auth'd attacker can use the bridge to fetch arbitrary internal HTTPS endpoints, write the payload to a tmpfile, and pass it to the installer. Also when fetch returns 404, `/install` responds **HTTP 500** instead of 4xx. [verified: `{"ok":false,"error":"Fetch failed: 404 Not Found"}` HTTP 500]
3. **`POST /recipes/:name/run` body schema is unvalidated** — Round 1 finding stands.
   - `args: {...}` field silently dropped → 200 OK (`recipeRoutes.ts:128-138` only looks at `vars`/`inputs`).
   - `vars: ["a","b"]` (array) coerced to `undefined` → 200 OK.
   - No 4xx for unknown fields, wrong types, or non-string values inside vars.
   - [verified live: `{"args":{"x":"1"}}` → 200; `{"vars":["a","b"]}` → 200]
4. **`registrySnapshot` bloat is unfixed** — chained run #3236 = **45 KB**, of which **25 KB (56%)** is the same registry snapshot duplicated across 4 steps. `src/recipes/chainedRunner.ts:836-855` rebuilds the full `snapshot` for every step at depth 0 and passes it through `captureForRunlog` (each truncated to 8 KB MAX, so identical previews × 4). Each step keeps its own copy on disk, then the dashboard re-reads all of them.
   - **Fix**: emit registry snapshot ONCE at the run level and have each step record only `Δsnapshot` (newly written keys) — or move snapshot to `runs.jsonl` `outputs` and stop re-attaching per step. `dashboardRegistryDiff.test.ts:152` documents the diff but doesn't enforce per-step uniqueness. [verified: `wc -c run-3236.json` = 45 267 bytes]
5. **`/recipes/:name/runs` does NOT exist.** Round 1 confirmed; still missing. The only per-recipe filter is `GET /runs?recipe=:name`. No 410-Gone, no alias — clients that expect REST-style nesting just get `Not found`. [verified: 404]
6. **JSON-prompt recipes never bump activation metrics.** `runRecipeFn` line 358 returns immediately for `loadRecipePrompt` hits without calling `recordRecipeRun()`. Only the YAML chained path at `recipeOrchestration.ts:460` records. So `daily-status.json`, `greet.json`, every `kind: prompt` ever fired → metric stays at 0. (User has analytics opt-out here so on-disk file is missing entirely; bug is still present in code.)

### MEDIUM
7. **Round 1 `daily-status` shadowing is more than a runner-side bug — HTTP layer disagrees with orchestration layer.**
   - `GET /recipes/daily-status` returns the **YAML** variant (`loadRecipeContent` tries YAML first, `recipesHttp.ts:465-475`).
   - `POST /recipes/daily-status/run` resolves to the **JSON** variant (`runRecipeFn` tries `loadRecipePrompt` first, JSON-only, `recipeOrchestration.ts:344`).
   - Dashboard reads YAML, but firing the recipe runs JSON. The two variants have different `description` and one is `cron` and one is `manual`. Worst case: user edits the YAML, hits "Run", and the JSON runs instead. [verified: contents byte-different]
8. **`GET /runs/:seq/plan` 503 path looks wrong.** When `runPlanFn` is null, returns 503 `{error: "plan_unavailable"}` — but for runs whose recipe file no longer exists on disk (the very thing dry-run plan relies on) the catch block returns 404 ONLY if the error message contains "not found"/"ENOENT". Other parse errors (malformed YAML, etc.) return 500.  Replay endpoint already returns `recipe_file_missing` cleanly — plan should match.
9. **Recipe count fresh: 16.** Matches Agent E. Round 1's "17" included `local-noop` from a legacy install dir that was unstable. Confirmed: 14 unique names + 2 `daily-status` entries (yaml + json shadow). Listed below.
10. **`/templates` 5-min cache is unauthenticated to GitHub.** Single-flight not implemented — concurrent first-misses each fire a separate fetch (`recipeRoutes.ts:572-598`). Low risk (5-min window) but worth noting if templates cache TTL ever shrinks.
11. **`/activation-metrics` reports as if no opt-out.** Returns zeros indistinguishable from "user opted out" vs "no runs yet" vs "fresh install". Add `enabled: boolean` flag to response or 204 when `getAnalyticsPref() === false`.
12. **`POST /recipes/run` (legacy form) accepts the same lenient body parsing** as `/recipes/:name/run`. Same fix needed in two places.

### LOW
13. **`POST /recipes/lint` returns 200 with `ok: false`** rather than 400 for content that fails validation. Consistent with the rest of the surface but inconsistent with HTTP semantics. Dashboard handles it; raw API consumers may not.
14. **`/runs?status=bogus`** returns `{runs: []}` HTTP 200 — silently ignores the unknown status filter. Same with `trigger=bogus`. Should 400 invalid enum.
15. **`/recipes/install` writes to `os.tmpdir()` with predictable filename pattern** `patchwork-install-${Date.now()}-${recipeName}.yaml` — TOCTOU window if attacker can write `/tmp/`. Low risk on macOS user tmpdir, real on shared Linux multi-user systems.

### CONFIRMED FIXED (regressions to watch for)
- **WS == HTTP tool list: identical 193 tools each.** `ctxSaveTrace`, `ctxQueryTraces`, `ctxGetTaskContext` present on both. PR #71 verified shipped. Diff returned empty in both directions.
- **Schema generator validates 13/16 recipes cleanly.** 3 fails are known: 2 are `kind: prompt` JSONs (Round 1 Bug #16) + 1 is the broken `recipe new` template (Round 1 Bug #7).
- **All routes correctly require auth.** Tested 16 routes × no-auth → all 401.
- **Path traversal blocked.** `/recipes/..%2F..%2Fetc%2Fpasswd` → 404. `/recipes/etc%2Fhosts` (PUT) → 400 invalid name.
- **Replay still works on chained runs.** seq 3236 → newSeq 3263 OK with `unmockedSteps: ["recent"]`.

---

## Full route inventory

All routes via `src/recipeRoutes.ts` `tryHandleRecipeRoute()`. Tested? = vitest covers it. Works? = lives behavior matches expectations.

| # | Method | Path | Handler | Tested? | Works? |
|---|---|---|---|---|---|
| 1 | POST | `/recipes/:name/run` | recipeRoutes.ts:116-162 | partial | YES (lenient body) |
| 2 | POST | `/recipes/run` | recipeRoutes.ts:164-210 | partial | YES (same lenient body) |
| 3 | GET | `/activation-metrics` | recipeRoutes.ts:212-227 | YES (`activationMetrics.test.ts`) | YES |
| 4 | GET | `/runs` | recipeRoutes.ts:229-258 | YES (`server-recipes-content.test.ts`) | YES (filter validation gap) |
| 5 | GET | `/runs/:seq` | recipeRoutes.ts:260-283 | YES | YES |
| 6 | POST | `/runs/:seq/replay` | recipeRoutes.ts:285-319 | YES (`replayRun.test.ts` 11 tests) | YES (chained only) |
| 7 | GET | `/runs/:seq/plan` | recipeRoutes.ts:321-355 | partial | YES (504 wording inconsistent) |
| 8 | POST | `/recipes` | recipeRoutes.ts:357-390 | YES | YES |
| 9 | PATCH | `/recipes/:name` | recipeRoutes.ts:392-428 | partial (mocked) | **NO — `require is not defined` for legacy recipes** |
| 10 | POST | `/recipes/lint` | recipeRoutes.ts:430-467 | YES | YES (200 not 400 for invalid) |
| 11 | GET | `/recipes/:name` | recipeRoutes.ts:469-488 | YES | YES (yaml-first dispatch) |
| 12 | PUT | `/recipes/:name` | recipeRoutes.ts:490-530 | YES | YES |
| 13 | DELETE | `/recipes/:name` | recipeRoutes.ts:532-553 | YES | YES |
| 14 | GET | `/recipes` | recipeRoutes.ts:555-569 | YES | YES (16 recipes) |
| 15 | GET | `/templates` | recipeRoutes.ts:571-598 | partial | YES |
| 16 | POST | `/recipes/install` | recipeRoutes.ts:600-682 | partial | YES (SSRF risk + 500-on-404) |
| — | POST | `/hooks/*` | server.ts:811-850 | YES (in webhook tests) | YES (404 when no match) |
| — | GET | `/schemas/*` | server.ts:455-502 | YES (`schemaGenerator.test.ts`) | YES (unauth) |

### Routes that DO NOT exist (tested, returned 404)

| Path | Status |
|---|---|
| `GET /recipes/:name/runs` | 404 — Round 1 finding still true |
| `GET /recipes/:name/permissions` | 404 — no permissions endpoint despite sidecar files on disk |
| `POST /recipes/:name/permissions` | 404 |
| `POST /recipes/:name/preflight` | 404 (only via CLI `recipe preflight`) |
| `POST /recipes/:name/lint` | 404 (only `POST /recipes/lint` w/ content body) |
| `GET /recipes/:name/activation-metrics` | 404 (only `/activation-metrics` workspace-wide) |
| `GET /recipes/templates` | 404 (correct path is `GET /templates`, not nested) |

---

## Round-1 verifications

| Round-1 claim | This round |
|---|---|
| `daily-status` JSON-vs-YAML shadowing at `recipeOrchestration.ts:344` | **CONFIRMED + WIDER**: HTTP layer reads YAML, run layer reads JSON — two layers disagree. |
| `args:` silently dropped, `vars: []` coerced to undefined | **CONFIRMED**: live tests above. |
| `/recipes/:name/runs` does not exist | **STILL MISSING**: 404. |
| Recipe count: 17 vs 16 disagreement | **16** matches Agent E. Likely round-1 saw a transient extra recipe. |
| `registrySnapshot` 49KB for 4-step `branch-health` | **CONFIRMED**: 45 KB now (likely smaller registry today). 25 KB of duplicated snapshots × 4 steps. |
| ctxSaveTrace / ctxQueryTraces missing on HTTP MCP | **FIXED**: present on both transports (193 tools each, identical). |

---

## Schema generator output check

Generated via `dist/recipes/schemaGenerator.js` then validated every file in `~/.patchwork/recipes/` with AJV, pre-registering all 22 namespace tool schemas to resolve `$ref`s.

```
PASS ambient-journal.yaml
PASS branch-health.yaml
PASS ctx-loop-test.yaml
FAIL daily-status.json   — kind:prompt recipe; schema expects steps[i].tool|agent|recipe|chain
PASS daily-status.yaml
PASS debug-env.yaml
PASS debug-flatten.yaml
PASS google-meet-debrief.yaml
FAIL greet.json          — kind:prompt recipe; same as above
PASS lint-on-save.yaml
PASS morning-brief-slack.yaml
PASS morning-brief.yaml
PARSE-FAIL my-test-recipe.yaml — `description: Recipe: <name>` compact-mapping syntax error
PASS stale-branches.yaml
PASS triage-brief.yaml
PASS watch-failing-tests.yaml

TOTAL pass=13  fail=2  parse-fail=1
```

3 fails confirm Round 1 Bugs #7 + #16.

---

## WS vs HTTP MCP tool-list diff

Initialized both transports, called `tools/list`, sorted names, diffed.

```
HTTP tools count: 193
WS tools count:   193
HTTP unique: (empty)
WS unique:   (empty)
```

`ctxGetTaskContext`, `ctxQueryTraces`, `ctxSaveTrace`, `enrichStackTrace`, `testTraceToSource` all present on both. Round 1's HTTP gap is closed.

---

## Activation-metrics grounding

`/activation-metrics` returned all-zero. Reality:
- `~/.patchwork/runs.jsonl` has **825 entries** (latest seq 3273).
- Bridge returned 500 most-recent runs over `/runs?limit=5000`.
- Successful `branch-health` (chained, seq 3274) ran during this audit — telemetry.json still missing.
- Cause: user has `~/.claude/ide/analytics.json` set to `{"enabled": false}` — `recordRecipeRun()` is a no-op via `isRecordingAllowed()` short-circuit (`activationMetrics.ts:219`).

**Endpoint is not lying — the user opted out**. But the response shape doesn't surface that distinction; consumers can't tell zero-runs from opt-out from no-bridge-config. Suggest adding `recording: false` to the metrics block when opt-out detected.

---

## File references

- `/Users/wesh/Documents/Anthropic Workspace/Patchwork OS/src/recipeRoutes.ts` — all 16 routes
- `/Users/wesh/Documents/Anthropic Workspace/Patchwork OS/src/recipesHttp.ts:157-210` — `setRecipeEnabled` w/ broken `require()` at line 200
- `/Users/wesh/Documents/Anthropic Workspace/Patchwork OS/src/recipeOrchestration.ts:344-358` — JSON-prompt path returns w/o `recordRecipeRun()`
- `/Users/wesh/Documents/Anthropic Workspace/Patchwork OS/src/recipeOrchestration.ts:460` — only `recordRecipeRun()` call site
- `/Users/wesh/Documents/Anthropic Workspace/Patchwork OS/src/recipes/chainedRunner.ts:836-855` — registrySnapshot duplicated per step
- `/Users/wesh/Documents/Anthropic Workspace/Patchwork OS/src/recipes/captureForRunlog.ts:117-129` — 8 KB cap that stamps identical truncation marker each step
- `/Users/wesh/Documents/Anthropic Workspace/Patchwork OS/src/activationMetrics.ts:204-219` — opt-out short-circuit
- `/Users/wesh/Documents/Anthropic Workspace/Patchwork OS/src/__tests__/dashboard-cli-state-unification.test.ts:85-130` — bypasses production `require` path via `saveConfigFn:` injection

---

## Suggested next actions (ordered)

1. **Fix `setRecipeEnabled` ESM `require`** — replace `const mod = require("./patchworkConfig.js")` with a top-level `import` or `import("./patchworkConfig.js")`. Add a test that exercises the legacy fallback path WITHOUT injecting `saveConfigFn:` (per Bug Fix Protocol — test must fail first).
2. **Add zod/AJV schema for `POST /recipes/:name/run` body** — reject unknown fields, require `vars` to be `Record<string,string>`, return 400 with field list.
3. **De-dup registrySnapshot per chained run** — emit once at run level, store per-step `delta` only.
4. **Wire `recordRecipeRun()` into JSON-prompt path** in `recipeOrchestration.ts:358` (success guarantee comes when the orchestrator task completes — needs lifecycle hook).
5. **Add SSRF allowlist on `/recipes/install`** — only `raw.githubusercontent.com/patchworkos/recipes/...` and `https://github.com/patchworkos/recipes/...`.
6. **Decide and document `daily-status` shadowing** — either disambiguate by extension in the URL (`/recipes/daily-status.yaml`) or normalize to one canonical variant.
7. **Add the missing nested routes** — `/recipes/:name/runs`, `/recipes/:name/permissions`, `/recipes/:name/preflight` — or document that they're intentionally absent.
