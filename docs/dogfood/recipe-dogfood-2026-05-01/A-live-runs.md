# Recipe Dogfood — 2026-05-01 (Agent A, live runs)

Bridge: `http://127.0.0.1:3101` (PID 56865 — process started **2026-04-29 11:17:21 +0300** per `ps -o lstart=`).
Bridge package version reported in MCP instructions: `claude-ide-bridge v0.2.0-alpha.35`.
Workspace: `/Users/wesh/Documents/Anthropic Workspace/Patchwork OS`.
Agent A — runs prefixed `dogfood-A-` *would* require recipe edits; we did NOT modify recipes, so output filenames retain their default date-stamped form. Run window for this dogfood: **seq 3231 → 3260**, wall clock ~ 12:02 → 12:08 EAT (09:02 → 09:08 UTC).

---

## Task 1 — `GET /recipes` count

**Reported: 16, not 17.** `my-test-recipe.yaml` exists on disk but is excluded from the listing because it fails YAML parse (`description: Recipe: my-test-recipe` — bare colon breaks the parser). Fail-soft on the listing endpoint, hard 400 on `/recipes/my-test-recipe/run`. The recipe FILE is still readable via `GET /recipes/my-test-recipe`.

So the 17 in the prior dogfood and the 17 implied by the task are the disk count; the runtime registry has 16 because of the parse failure. (Optional improvement: surface unparseable recipes in the listing with a `lint.firstError` so users see them in the dashboard.)

---

## Task 2 + 3 — Per-recipe live runs (SAFE-READ + WRITE-LOCAL)

| # | Recipe | Run seq | Runner | Status | durationMs | VD-2 captured? | Notes |
|---|---|---|---|---|---|---|---|
| 1 | `greet` (json, manual) | 3231 | `runClaudeTask` (single-prompt) | done | 4 182 | n/a (no stepResults) | Output: `Current UTC timestamp: 2026-05-01T00:00:00Z`. Real `date -u` was `2026-05-01T09:02:41Z`. **Agent fabricated a midnight timestamp** rather than reading the system clock. Mild grounding miss — the prompt asks for "current UTC" but Claude has no tool call, so it fills with a placeholder. |
| 2 | `local-noop` (yaml, manual) | 3232 | YAML | done | 3 225 | **NO** — bare `{id, tool, status, durationMs}` only | Spawned a sub-task `local-noop:agent` (seq 3235, 3 175 ms) — useful but undocumented. Output `Hello world.`. |
| 3 | `stale-branches` (yaml, cron) | 3233 | YAML | done | **14 ms** | NO | **BUG-A2** — file content `(git branches unavailable)`. Same bug PR #70 was supposed to fix. **See Task 3 below for root-cause confirmation.** |
| 4 | `debug-env` (yaml, manual) | 3234 | YAML | done | 0 ms | NO | Wrote `/tmp/debug-env-output.txt` = `SLACK_CHANNEL_ENGINEERING=C0AUZEY8Y0Y`. Env-var resolution works. (Recipe-author issue: leaks SLACK channel ID to world-readable `/tmp` — same note as 2026-04-29 dogfood.) |
| 5 | `branch-health` (yaml, chained) | 3236 | chained | done | 12 747 | **YES** — `resolvedParams`/`output`/`registrySnapshot`/`startedAt` per step | `stale` step output `(git branches unavailable)` again. `summarise` agent step is **MISSING `tool` field** (only step without one — confirms agent-vs-tool detection works in the chained capture). 3 chained steps + the 4-step recipe → registrySnapshot is duplicated at every step (~14 KB each). Total run-detail JSON ~ 49 KB. **Agent grounding good** — cited PRs `#104, #108, #110-115, #117, #111, #97-102` and SHAs `7056229, cfc0e70, cca29e8` all verify against `git log`. |
| 6 | `ambient-journal` (yaml, git_hook) | 3237 | YAML | done | 0 ms | NO | Manual fire (no git commit context) — wrote `~/.patchwork/journal/2026-05-01.md` = `- 12:03  committed  — ` (placeholders blank, but step still reports `status: ok`). Same silent-fail antipattern. |
| 7 | `lint-on-save` (yaml, on_file_save) | 3238 | YAML | done | 1 ms | NO | Manual fire — `{{file}}` unbound — wrote `lint.md` = `- 12:03   —  errors,  warnings`. Silent-fail antipattern. |
| 8 | `watch-failing-tests` (yaml, on_test_run) | 3239 | YAML | done | 7 259 | NO | Manual fire — `{{failures}}` unbound. Agent (seq 3242) honestly flagged: "The failure payload is empty … Likely cause is an automation hook firing `onTestRun` with an unpopulated event". Good agent grounding. |
| 9 | `morning-brief` (yaml, cron) | 3240 | YAML | done | 3 479 | NO | All 7 steps `status: ok`, but `brief` (agent) `durationMs: 1` → silent skip. Wrote `~/.patchwork/inbox/morning-brief-2026-05-01.md` = `[agent step skipped: ANTHROPIC_API_KEY not set]`. **Same bug as 2026-04-29 dogfood. Detection module exists in source (`src/recipes/detectSilentFail.ts`) and is wired into yamlRunner — but the running bridge process predates PR #72 (#72 landed 2026-04-29 12:56; bridge started 11:17 same day).** |
| 10 | `ctx-loop-test` (yaml, manual) | 3241 | YAML | done | 29 965 | NO | Result: **FAIL**. Agent reports `ctxSaveTrace tool not available in this session` — same issue PR #71 was supposed to fix (Streamable-HTTP tool registration parity). PR #71 landed 2026-04-29 12:27; bridge started 11:17. **Bridge restart required.** |
| 11 | `daily-status` (resolves to JSON variant, manual) | 3244 | `runClaudeTask` (single-prompt) | done | 12 558 | n/a | Grounded: cited last 3 commits `8f90817, 3328e79, 97c9cd0` — verified against `git log -3` exactly. **YAML variant (cron, 4-step) shadowed unreachably.** New root cause confirmed at `src/recipeOrchestration.ts:344` — JSON path checked first via `loadRecipePrompt` even when recipe resolver `findYamlRecipePath` would prefer YAML. |
| 12 | `debug-flatten` (yaml, manual) | 3243 | YAML | done | 501 | NO | All 5 steps OK; `gmail.search` 498 ms, rest ≤ 2 ms. `/tmp/flatten-debug.txt` = `meeting_raw={"error":"No meetings found"}`. So gmail.search returned "no meetings" (not an auth failure — Gmail token still valid). |

**Total fired: 12 distinct recipes** (across 13 runs incl. 1 sub-task + 1 replay). Skipped per task instructions: `morning-brief-slack`, `triage-brief`, `google-meet-debrief` (WRITE-EXTERNAL).

### VD-2 capture coverage (unchanged from 2026-04-29)

Of 12 fired recipes, only **1 (`branch-health`, chained-runner)** produced VD-2 fields. Confirms YAML runner **still does not** emit `resolvedParams` / `output` / `registrySnapshot` / `startedAt` per step. Documentation/scope-mismatch with what was advertised. **No improvement since prior dogfood.**

### Run-detail endpoint shape
- `GET /runs/:seq` — works, returns `{run: {…}}`. Single run detail.
- `GET /runs/:seq/plan` — works. Generates dry-run plan.
- `POST /runs/:seq/replay` — works for chained recipes (`replay 3236 → newSeq 3260, unmockedSteps: ["recent"]`); errors `replay_only_supported_for_chained_recipes` for YAML; errors `recipe_file_missing` for single-prompt JSON runs (expected).
- **`GET /recipes/:name/runs` does NOT exist.** Per-recipe filtering is via `GET /runs?recipe=:name` query param. (Worth pinning in prompts-reference.md.)

---

## Task 3 — Inbox + grounding spot-check

| File | Run | Grounded? |
|---|---|---|
| `~/.patchwork/inbox/stale-branches-2026-05-01.md` | 3233 | **Fabricated negative** — `(git branches unavailable)` is a string placeholder masquerading as data. The recipe (and its downstream readers) cannot tell whether 0 stale branches exist or the tool failed. |
| `~/.patchwork/inbox/branch-health-2026-05-01.md` | 3236 | **Mostly grounded.** All 12 cited PR numbers verified against `git log`; all 3 short-SHAs (`7056229, cfc0e70, cca29e8`) resolve to real commits with matching subjects (extension-bump, biome format, alpha.35 release). The "no stale-branch data available" line is honest about the upstream tool failure — **agent did NOT fabricate stale-branch data**, exactly as in 2026-04-29. |
| `~/.patchwork/inbox/morning-brief-2026-05-01.md` | 3240 | **Silent skip** — content is just `[agent step skipped: ANTHROPIC_API_KEY not set]`. |
| `~/.patchwork/inbox/ctx-loop-test-2026-05-01.md` | 3241 | **Honest failure** — agent correctly reports tools missing from MCP session. |
| `~/.patchwork/inbox/test-failures.md` | 3239 | **Honest failure** — agent flagged empty placeholder payload. |
| `~/.patchwork/inbox/lint.md` | 3238 | Honest-but-degenerate — `- 12:03   —  errors,  warnings` (placeholders blank). Step still `status: ok`. Silent-fail antipattern. |
| `~/.patchwork/journal/2026-05-01.md` | 3237 | Honest-but-degenerate — `- 12:03  committed  — ` (placeholders blank). Same antipattern. |
| `/tmp/debug-env-output.txt` | 3234 | Grounded (single env var). |
| `/tmp/flatten-debug.txt` | 3243 | Grounded — gmail returned `{"error":"No meetings found"}`. |

### Agent A summary file inventory (so other agents don't confuse)

```
~/.patchwork/inbox/  (mtime 2026-05-01)
  stale-branches-2026-05-01.md       12:02
  morning-brief-2026-05-01.md        12:04 (overrode the 08:00 cron output)
  branch-health-2026-05-01.md        12:04
  ctx-loop-test-2026-05-01.md        12:04
  test-failures.md                   12:03 (no date in filename — append-only)
  lint.md                            12:03 (no date in filename — append-only)

~/.patchwork/journal/2026-05-01.md   12:03
/tmp/debug-env-output.txt            12:02
/tmp/flatten-debug.txt               12:04
```

---

## Task 4 — Silent agent skip in `morning-brief`

**Reproduced.** Run seq 3240, agent step `brief` reported `status: ok, durationMs: 1`. File content = `[agent step skipped: ANTHROPIC_API_KEY not set]`. Same root cause as 2026-04-29.

**The fix exists in source and dist:**
- Detection module: `src/recipes/detectSilentFail.ts:38-42` — regex `/^\s*\[agent step (skipped|failed):/i` flags the placeholder.
- Wired into yamlRunner: `src/recipes/yamlRunner.ts:468-471, 564-571` — wraps both agent-result and tool-result paths.
- Both compiled into `dist/recipes/yamlRunner.js` (dist mtime 2026-05-01 12:01).
- Source landed 2026-04-29 12:56 in PR #72.

**Why it's still broken on this bridge:** running PID 56865 started **2026-04-29 11:17:21 +0300**, *before* PR #72's commit time (12:56 same day). The bridge has the **pre-#72** yamlRunner cached in V8's module graph. It will not pick up the fix until restarted. (Per task instructions, we did not restart.)

---

## Task 5 — `daily-status` name collision

**Still happening.** Both `daily-status.json` and `daily-status.yaml` register; `/recipes` listing returns BOTH entries (count 16 includes the duplicate); `/recipes/daily-status/run` resolves to **JSON only**. No name-uniqueness validation at recipe-load time.

**New root-cause finding:** prior dogfood believed JSON was preferred because it was alphabetically sorted first. Actual root cause is at `src/recipeOrchestration.ts:344-365`:

```ts
// Try JSON recipe first (legacy path: enqueue prompt as a task).
const loaded = loadRecipePrompt(recipesDir, name);
if (loaded) {
  // ... enqueue and return immediately ...
}
// Fall through to YAML runner for .yaml/.yml recipes.
const ymlPath = findYamlRecipePath(recipesDir, name);
```

So JSON is *intentionally checked first* in the run dispatch, with a comment marking it as the "legacy path". This means: even though `findYamlRecipePath` would prefer YAML when called alone (for delete / lint / content endpoints), the **run** endpoint always picks JSON. Two different precedence rules in the same name resolver. Recommend either (a) reject duplicate names at recipe-load time with a clear error, or (b) reverse the precedence so YAML (the actively maintained format) wins.

---

## Task 6 — Already covered in Task 3's table.

Notable cross-day check: the 2026-05-01 cron-fired `morning-brief-2026-05-01.md` (08:00 EAT) is the same 80-byte stub the manual fire produced — the cron job hits the same silent-skip path.

---

## Task 7 — Broken inputs

| Test | Result | Verdict |
|---|---|---|
| `POST /recipes/does-not-exist/run` | `400 {"ok":false,"error":"Recipe \"does-not-exist\" not found in /Users/wesh/.patchwork/recipes"}` | Good. |
| `POST /recipes/greet/run` body `{"args":"bogus"}` (unknown key) | `200 {"ok":true,"taskId":"…"}` (run started) | **LENIENT** — `args` silently dropped; only `vars` / `inputs` keys are read (`recipeRoutes.ts:130-134`). Could surface a "ignored body keys: [args]" warning. |
| body `{"vars":"string"}` (vars not object) | `200 {"ok":true,"taskId":"…"}` | Lenient — silently coerced to undefined. |
| body `[]` (array root) | `200 {"ok":true,"taskId":"…"}` | Lenient — array hits the `!Array.isArray(varsRaw)` guard, falls through to undefined vars. |
| body `{"vars":{broken` (malformed JSON) | `400 {"ok":false,"error":"Invalid JSON body"}` | Good. |
| `POST /recipes/..%2Fetc%2Fpasswd/run` | `400 {"ok":false,"error":"Recipe \"../etc/passwd\" not found in …"}` | Good — name resolver sandboxes to `recipesDir`. No path traversal. |
| `POST /recipes/%2Fetc%2Fpasswd/run` | `400 {"ok":false,"error":"Recipe \"/etc/passwd\" not found in …"}` | Good. |
| `POST /recipes/my-test-recipe/run` | `400 {"ok":false,"error":"Nested mappings are not allowed in compact mappings at line 4, column 14:\n\ndescription: Recipe: my-test-recipe\n             ^\n"}` | **No improvement** since prior dogfood. Still surfaces raw js-yaml message. Could detect "colon-in-description" and suggest quoting. |

---

## Task 8 — Lint endpoint + chained-runner template false-positive

- **`GET /recipes/:name/lint` does NOT exist** — returns `Not found`. Per-recipe lint info appears in `GET /recipes` listing (see `lint.firstError` field).
- **`POST /recipes/lint` (with `{content}` body) works** — returns `{ok, errors[], warnings[]}`.
- **Chained-runner false-positive REPRODUCED.** POSTed a minimal chained recipe with `agent.prompt: "Stale: {{steps.stale.data}}"`. Linter response:
  ```
  {"ok":false,"errors":["Step 2: Unknown template reference '{{steps.stale.data}}' in agent.prompt"]}
  ```
- Same false-positives reflected in `branch-health` (6 errors) per `/recipes` listing and `/runs/3236/plan`. Plan also lints `{{env.HOME}}`, `{{env.DATE}}`, `{{steps.summarise.data}}` as unknown — none of which are actually unknown at runtime.
- Root cause is the lint module not understanding chained-runner's `{{steps.<id>.<field>}}` and `{{env.*}}` template grammars. (Source path: `src/recipes/validation.ts` likely; not pinpointed in this session.)

---

## NEW BUG (not in 2026-04-29 dogfood)

### `hasWriteSteps: false` for chained recipes that obviously write

`/runs/3236/plan` for `branch-health` (which has a `file.write` step) returned:
```json
"connectorNamespaces":[], "hasWriteSteps":false
```

**Source root cause:** `src/recipes/chainedRunner.ts` (`generateExecutionPlan` function) — when emitting plan steps, it copies `id, type, dependencies, condition, risk, optional` but **NOT `tool`**:

```ts
return {
  steps: expandedSteps.map((s) => ({
    id: s.id ?? "",
    type: nestedRecipeRef(s) ? "recipe" : s.agent ? "agent" : "tool",
    dependencies: s.awaits ?? [],
    condition: s.when,
    risk: s.risk ?? "low",
    optional: s.optional,
    // ← tool field missing
  })),
  parallelGroups: levels,
  maxDepth: recipe.maxDepth ?? 3,
};
```

Then in `src/commands/recipe.ts:880-883`:
```ts
const raw = step as unknown as { tool?: unknown; into?: unknown };
if (typeof raw.tool === "string") base.tool = raw.tool;
```
`raw.tool` is undefined because `generateExecutionPlan` never copied it. So `enrichStepFromRegistry()` (recipe.ts:803) bails at line 806-807 (`if (step.type !== "tool" || !step.tool) return step`), never sets `isWrite`, and `summarizePlanSteps` (recipe.ts:824-836) sees no writes.

**Verified by comparison:** `/runs/3233/plan` (stale-branches, YAML/cron — uses `buildSimpleRecipeDryRunSteps` not `generateExecutionPlan`) DOES include `tool: "file.write"` and `isWrite: true` on the step, and reports `hasWriteSteps: true`.

**Severity:** MED — a chained recipe with a real `file.write` (or any write) step is reported to the dashboard / CLI dry-run as a read-only plan. Approval gating that keys on `hasWriteSteps` would silently treat chained writes as safe.

**Fix candidate:** in `chainedRunner.ts:generateExecutionPlan`, copy `s.tool` when present:
```ts
...(s.tool && typeof s.tool === "string" ? { tool: s.tool } : {}),
```

---

## TL;DR — ranked by severity

1. **HIGH (still) — Streamable-HTTP MCP transport drops ctx tools (`ctx-loop-test` Result: FAIL).** PR #71 fix is in HEAD source as of 2026-04-29 12:27 but bridge process predates the merge. **Restart bridge** to apply. After restart, retest. If still broken, the fix wasn't applied to the running code path.
2. **HIGH (still) — `git.stale_branches` returns `(git branches unavailable)`.** PR #70 fix is in HEAD source and `dist/recipes/yamlRunner.js` (mtime 2026-05-01 12:01) but bridge started 2026-04-29 11:17, before PR #70 (12:15 same day). Same fix-and-restart story as #1.
3. **MED (still) — Silent agent skip on `morning-brief` when `ANTHROPIC_API_KEY` unset.** PR #72 (silent-fail detection) is in source + dist; same bridge-staleness story (PR #72 at 12:56 vs bridge start 11:17 on 2026-04-29). Restart will activate `detectSilentFail` and the step will report `error` instead of `ok`.
4. **MED (NEW) — `hasWriteSteps: false` for chained recipes that write.** Plan-builder bug at `src/recipes/chainedRunner.ts:generateExecutionPlan` (omits `tool` field on plan steps) → downstream `enrichStepFromRegistry` sees `step.tool === undefined`, never tags writes. Approval gating that trusts `hasWriteSteps` is wrong for every chained recipe. **Not bridge-staleness — fix is required in source.**
5. **MED (still) — VD-2 captures missing from YAML runner.** Only the chained runner emits `resolvedParams`/`output`/`registrySnapshot`/`startedAt`. Same as 2026-04-29.
6. **LOW (still) — `daily-status` name collision.** New root-cause: `src/recipeOrchestration.ts:344` JSON-first dispatch, not alphabetical-first. Add load-time uniqueness check, or reverse the precedence.
7. **LOW (still) — Lint false-positives on chained-runner placeholders.** `{{steps.<id>.data}}` and `{{env.*}}` templates flagged as unknown by the linter even though the chained runner resolves them at runtime. Lives in `src/recipes/validation.ts`.
8. **LOW (still) — `my-test-recipe` YAML parse failure surfaces a generic js-yaml message.** Could detect "colon-in-description" and suggest quoting.
9. **LOW (still) — `ambient-journal`, `lint-on-save`, `watch-failing-tests` write degenerate placeholder lines on manual fire.** Same silent-fail antipattern as #3 (placeholder strings + `status: ok`). Detection regex in `detectSilentFail.ts` only catches the agent-skip and git-unavailable shapes; doesn't catch "string with `{{}}` placeholders that didn't substitute". Worth adding a `\{\{\w+\}\}` detector or making `replaceTemplate` error on unbound vars instead of substituting empty string.
10. **LOW (NEW) — `GET /recipes/:name/runs` does NOT exist.** Task wording implied it should. Either add the route (filter `runs` by `recipeName`), or update prompts/docs to say "use `/runs?recipe=<name>`". Filter via query param works.
11. **LOW (NEW) — `/recipes/:name/run` body validation is too lenient.** Unknown body keys silently dropped (`{"args":...}` accepted as `{}`). Coercion of `vars: "string"` and `vars: []` to undefined is also silent. Suggest 400 on shape mismatch + warning on unknown keys.
12. **LOW (housekeeping) — Run-detail registrySnapshot bloat.** `branch-health` 4-step run-detail JSON ~ 49 KB because the registry snapshot (full prior step output, ~14 KB) is duplicated at every step. Consider diffing snapshots or at least `before`/`after` instead of repeated snapshots. (Same observation as 2026-04-29.)

## What's improved since 2026-04-29

Nothing user-visible on this bridge process — the fixes for #1, #2, #3 are merged but not loaded. Post-restart, items 1-3 should be testable; the new bug #4 (`hasWriteSteps`) and the leniency / collision items remain.
