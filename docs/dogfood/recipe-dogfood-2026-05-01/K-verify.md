# K — Round-2 Re-verification on alpha.35 fresh bridge

Bridge: PID 68045, port 3101, alpha.35, started 2026-05-01 12:24.
Workspace: `/Users/wesh/Documents/Anthropic Workspace/Patchwork OS`.
Method: source reads on alpha.35 + live HTTP fires + CLI fires. No bridge restart, no `~/.patchwork/recipes/` mutation (synthetic in `/tmp/dogfood-K/`, install/uninstall round-trip used once).

Already confirmed by user (skipped): PR #70 `git.stale_branches` LIVE. Re-confirmed below — `branch-health.stale` returned `(no branches inactive >14d)` on `seq=3274`.

---

## CRITICAL

### Bug #1 — Chained `hasWriteSteps: false` despite write steps
**Status: STILL-BROKEN**

Repro: `node dist/index.js recipe run branch-health --dry-run`. Plan output:
```
"steps":[
  {"id":"stale","type":"tool","dependencies":[],"risk":"low"},
  {"id":"recent","type":"tool","dependencies":[],"risk":"low"},
  {"id":"summarise","type":"agent","dependencies":["stale","recent"],"risk":"low"},
  {"id":"write","type":"tool","dependencies":["summarise"],"risk":"low"}
],
"hasWriteSteps": false
```
`branch-health` has a `file.write` step (`write`) that writes to `~/.patchwork/inbox/`. Plan still says `hasWriteSteps: false`.

Source pin:
- `src/recipes/chainedRunner.ts:1028-1040` — `generateExecutionPlan` step output never includes `tool` field (only `id`, `type`, `dependencies`, `risk`, `optional`).
- `src/commands/recipe.ts:806` — `enrichStepFromRegistry` first line: `if (step.type !== "tool" || !step.tool) return step;`. With `tool` undefined the step is returned untouched, no `isWrite` tag.
- `src/commands/recipe.ts:824-837` — `summarizePlanSteps` then iterates and sets `hasWriteSteps` only if any `step.isWrite` is truthy. Always false for chained.

Safety-gate bypass — every chained recipe with a write step misreports.

---

### Bug #2 — `detectSilentFail` not wired into chained runner
**Status: STILL-BROKEN**

Source read: `grep -rn detectSilentFail src/`:
```
src/recipes/yamlRunner.ts:43:import { detectSilentFail } from "./detectSilentFail.js";
src/recipes/yamlRunner.ts:471: ? detectSilentFail(agentResult)
src/recipes/yamlRunner.ts:570: const detected = detectSilentFail(result);
```
No hits in `src/recipes/chainedRunner.ts`. PR #72 (`5ee0f87 feat(recipes): silent-fail pattern detection in step runner (P1)`) only touched `yamlRunner.ts` + `detectSilentFail.ts` + tests (4 files). Chained runner was not extended.

Source pin: `src/recipes/chainedRunner.ts:10` — only imports `captureForRunlog`, missing `detectSilentFail`.

Live evidence on `seq=3274` (chained branch-health, fresh bridge): all four steps `status: "ok"` even though `summarise` step output for the agent has no silent-fail check applied. yamlRunner-level branch-health-stale silent-fail (string placeholder) cannot be tested here because PR #70 fixed the underlying bug — but the missing import is dispositive.

---

### Bug #3 — Schema/parser/validator disagree on legal trigger types
**Status: STILL-BROKEN**

Source reads:
- `src/recipes/parser.ts:72-115` accepts `{webhook, cron, file_watch, git_hook, manual}` — throws on anything else.
- `src/recipes/validation.ts:57-66` accepts `{manual, cron, webhook, file_watch, git_hook, on_file_save, on_test_run, chained}` — wider set.

The parser is dead code per Round-1 #23 — neither runner calls `parseRecipe`. But the divergence remains: lint says one thing, parse says another, runtime ignores both. No PR has reconciled them.

---

## HIGH

### Bug #4 — `recipe list` shows 1-of-N recipes
**Status: STILL-BROKEN**

Repro: `node dist/index.js recipe list`:
```
Name               Version  Status    Description / Files
---------------------------------------------------------
p1-pkg             —        enabled   [p1-hello.yaml]
test-recipe-local  —        enabled   [local-noop.yaml]
```
2 recipes shown. `GET /recipes` returns 17. The 15 top-level YAML/JSON files are invisible to the CLI.

Source pin: `src/commands/recipeInstall.ts:678-718` — `scanDir`'s third line is `if (!statSync(itemPath).isDirectory()) continue;`. Top-level YAML/JSON files filtered before any inspection.

---

### Bug #5 — `recipe install` accepts dir with malformed YAML; `recipe test`/`recipe lint` exit ≠ 0 (PARTIALLY FIXED)
**Status: PARTIALLY-FIXED**

Repro 1 (lint of broken YAML — fixed-by-source):
```
$ node dist/index.js recipe lint /tmp/dogfood-K/broken-yaml.yaml; echo "exit=$?"
✗ YAML parse error: Nested mappings are not allowed in compact mappings at line 3, column 14
1 error(s), 0 warning(s)
exit=1
```

Repro 2 (test of broken YAML — fixed-by-source):
```
$ node dist/index.js recipe test /tmp/dogfood-K/broken-yaml.yaml; echo "exit=$?"
✗ YAML parse error: …
1 error(s), 0 warning(s)
exit=1
```

Repro 3 (install of dir containing broken YAML — STILL-BROKEN):
```
$ node dist/index.js recipe install /tmp/dogfood-K/; echo "exit=$?"
✓ Installed dogfood-K to /Users/wesh/.patchwork/recipes/dogfood-K
exit=0
```
A dir containing only a broken-YAML file installs cleanly. (Cleaned up via `recipe uninstall dogfood-K` after capture.)

`recipe lint` and `recipe test` now exit 1 on parse errors — those two paths fixed. `recipe install` still installs without parse-validating the YAML inside the dir.

---

### Bug #6 — YAML-trigger recipes never auto-fire (`on_file_save`/`on_test_run`/`on_recipe_save`/`file_watch`/`git_hook`)
**Status: STILL-BROKEN**

Source reads:
- `src/recipes/scheduler.ts:178` and `:193` — both branches `if (parsed.trigger?.type !== "cron") continue;`. Scheduler only dispatches cron.
- `src/recipes/compiler.ts:154-180` — `mapTrigger` handles `file_watch`, `git_hook` (compiles to AutomationProgram); throws on `cron`, `webhook`, `manual`; **does not handle** `on_file_save`, `on_test_run`, `on_recipe_save`, `chained`.
- `automation-policy.json` — no recipe-trigger-type wiring; only generic hook handlers.

`lint-on-save`, `watch-failing-tests`, `ambient-journal` (git_hook) etc. never auto-fire. `git_hook` recipes do compile via `compiler.ts:157` but nothing in the alpha.35 server wires that compilation to the running automation interpreter for installed recipes — confirmed by no recipes showing up via `automation-policy.json` and scheduler ignoring everything but `cron`.

---

### Bug #7 — `recipe new` template fails its own `recipe lint`
**Status: STILL-BROKEN**

Repro:
```
$ node dist/index.js recipe new dogfood-K-tmp
  ✓ Created /Users/wesh/.patchwork/recipes/dogfood-K-tmp.yaml
$ cat <generated file>
description: Recipe: dogfood-K-tmp        ← colon-in-compact-value
$ node dist/index.js recipe lint <generated file>
✗ YAML parse error: Nested mappings are not allowed in compact mappings at line 4, column 14
1 error(s), 0 warning(s)
```
Cleaned up immediately (moved out of `~/.patchwork/recipes/`, removed from there).

Source pin: `src/index.ts:~1228` (the `recipe new` template) writes `description: Recipe: ${name}` — the second colon plus a space starts a YAML compact-mapping that parses as nested map.

---

### Bug #8 — 100% lint false-positive rate on live recipes (`{{steps.X.data}}`, `{{env.X}}`)
**Status: STILL-BROKEN**

Repro: `GET /recipes`:
```
branch-health   6 errors  firstErr=Step 3: Unknown template reference '{{steps.stale.data}}' in agent.prompt
triage-brief    5 errors  firstErr=Step 3: Unknown template reference '{{steps.linear_issues.data}}' in agent.prompt
daily-status    1 errors  (JSON variant, separate issue, kept for completeness)
```
Same 11 spurious errors across `branch-health` + `triage-brief` (the `daily-status.json` error is structural, not template).

Source pin:
- `src/recipes/validation.ts:356-364` — `builtinKeys = {date, time, YYYY-MM, YYYY-MM-DD, ISO_NOW}`. **`steps` and `env` are NOT in the set.**
- `src/recipes/validation.ts:393-401` — for each dotted-path ref, splits to root, looks up only the root in `availableKeys`. `{{steps.stale.data}}` → root=`steps` → not present → error.
- Chained runner resolves `{{steps.<id>.data}}` at runtime via the output registry; lint never sees it.

---

### Bug #9 — VD-2 capture (`resolvedParams`/`output`/`registrySnapshot`/`startedAt`) chained-only
**Status: STILL-BROKEN**

Repro: fired both runners on fresh bridge, compared `stepResults` shapes.

Chained `branch-health` (`seq=3274`):
```
stale       keys=[durationMs, id, output, registrySnapshot, resolvedParams, startedAt, status, tool]
recent      keys=[durationMs, id, output, registrySnapshot, resolvedParams, startedAt, status, tool]
summarise   keys=[durationMs, id, output, registrySnapshot, resolvedParams, startedAt, status]
write       keys=[durationMs, id, output, registrySnapshot, resolvedParams, startedAt, status, tool]
```

YAML `morning-brief` (`seq=3272`, after fresh bridge fire):
```
messages       keys=[durationMs, error, id, status, tool]
commits        keys=[durationMs, id, status, tool]
issues         keys=[durationMs, error, id, status, tool]
…
```

Same divergence as Round-1 #9. `captureForRunlog` only imported by `chainedRunner.ts:10`. yamlRunner stepResults are still bare 5 fields.

---

### Bug #10 — Cron uses local TZ
**Status: STILL-BROKEN**

Source pin: `src/recipes/scheduler.ts:232`:
```
const cronJob = cron.schedule(parsed2.expression, () => {
  this.fire(name);
});
```
No `{ timezone: ... }` second argument. No per-recipe override read elsewhere. `node-cron` defaults to system local TZ. `morning-brief @ "0 8 * * 1-5"` fires at 08:00 EAT here (UTC+3), not UTC. No PR has added a timezone option.

---

### Bug #11 — `morning-brief` silently skips agent step on missing `ANTHROPIC_API_KEY`
**Status: FIXED-IN-SOURCE (PR #72 silent-fail detector)**

Repro: bridge has no `ANTHROPIC_API_KEY` (env grep on PID 68045 returned nothing). Fired:
```
$ curl -X POST .../recipes/morning-brief/run
{"ok":true,"taskId":"morning-brief-1777627887298"}
```
Run record (`seq=3272`):
```
status: "error"
brief step: status:"error", error:"silent-fail detected (agent step skipped or failed (string placeholder)): [agent step skipped:"
errorMessage: "gmail.fetch_unread failed: silent-fail detected (list-tool returned empty with error field): Token refresh failed: 400 (invalid_grant)"
```
Inbox file `~/.patchwork/inbox/morning-brief-2026-05-01.md` is now near-empty (33 bytes — header only) instead of containing a placeholder masquerading as content.

PR #72 (`5ee0f87`) — `feat(recipes): silent-fail pattern detection in step runner (P1)` — wires `detectSilentFail` into yamlRunner. Catches three patterns including the `[agent step skipped: …]` placeholder. Run now correctly reports `status: error`. Same PR also catches `silent-fail detected (list-tool returned empty with error field)` for `gmail.fetch_unread`, `github.list_issues`, `github.list_prs`. Three silent-fail antipatterns from this audit caught by single PR.

Note: Bug #2 explicitly remains because PR #72 only patched yamlRunner. Chained agent steps are still unprotected.

---

## Status table — all 28 round-1 bugs

| # | Severity | Bug | Status |
|---|---|---|---|
| 1 | CRITICAL | Chained `hasWriteSteps: false` despite writes | **STILL-BROKEN** |
| 2 | CRITICAL | `detectSilentFail` not wired into chainedRunner | **STILL-BROKEN** |
| 3 | CRITICAL | Schema/parser/validator disagree on trigger types | **STILL-BROKEN** |
| 4 | HIGH | `recipe list` shows 1-of-N | **STILL-BROKEN** |
| 5 | HIGH | install/test exit-codes accept malformed YAML | **PARTIALLY-FIXED** (lint+test fixed; install still accepts) |
| 6 | HIGH | YAML-trigger recipes never auto-fire | **STILL-BROKEN** |
| 7 | HIGH | `recipe new` template fails own lint | **STILL-BROKEN** |
| 8 | HIGH | 100% lint false-positive on `{{steps.X}}` / `{{env.X}}` | **STILL-BROKEN** |
| 9 | HIGH | VD-2 capture chained-only | **STILL-BROKEN** |
| 10 | HIGH | Cron uses local TZ | **STILL-BROKEN** |
| 11 | HIGH | `morning-brief` silent agent skip | **FIXED-IN-SOURCE** (#72) |
| 12 | MEDIUM | Bridge staleness masking #70/#71/#72 | **FIXED-BY-RESTART** (alpha.35 fresh bridge running) |
| 13 | MEDIUM | `nestedRecipeStep.validateNestedRecipe` off-by-one | **NOT-RE-VERIFIED** (out of scope; source unchanged per Round-1 pin) |
| 14 | MEDIUM | `daily-status` JSON-first dispatch ordering | **NOT-RE-VERIFIED** (out of scope) |
| 15 | MEDIUM | `/recipes/:name/runs` route absent | **NOT-RE-VERIFIED** (out of scope) |
| 16 | MEDIUM | `kind: prompt` JSON recipes lint-fail/schema-fail/execute-OK | **NOT-RE-VERIFIED** (live `daily-status.json` still shows `1 errors` in `/recipes`; matches Round-1) |
| 17 | MEDIUM | `recipe run <name>` cannot resolve subdir recipes | **NOT-RE-VERIFIED** (out of scope) |
| 18 | LOW | PR #93 Jira+Sentry recipe-tool wrappers untested | **NOT-RE-VERIFIED** (out of scope) |
| 19 | LOW | PR #103 camelCase aliases untested | **NOT-RE-VERIFIED** (out of scope) |
| 20 | LOW | `recipe new --help` creates `--help.yaml` | **NOT-RE-VERIFIED** (out of scope) |
| 21 | LOW | `quick-task` raw `DOMException` | **NOT-RE-VERIFIED** (out of scope) |
| 22 | LOW | `replayRun` no CLI subcommand | **NOT-RE-VERIFIED** (out of scope) |
| 23 | LOW | `parser.ts:parseRecipe` dead/divergent | **STILL-BROKEN** (Bug #3 source-confirms divergence) |
| 24 | LOW | `output:` keyword deprecation warning per load | **STILL-BROKEN** (observed in branch-health dry-run output: 6 deprecation lines emitted) |
| 25 | LOW | `registrySnapshot` duplicated per chained step | **STILL-BROKEN** (visible in `seq=3274` — each step has full snapshot) |
| 26 | LOW | `recipe`/`recipe --help`/`recipe new --help` print nothing | **NOT-RE-VERIFIED** (out of scope) |
| 27 | LOW | apiVersion warning 3× / param warnings 2× per preflight | **STILL-BROKEN** (observed: `recipe run branch-health --dry-run` prints 2× apiVersion + 6× output-deprecation) |
| 28 | LOW | Starter-pack `event:` triggers BROKEN-LIKELY | **STILL-BROKEN** (source: parser/scheduler/compiler don't handle `event` legacyType in dispatch) |

### Summary counts
- **STILL-BROKEN:** 13 (#1, #2, #3, #4, #6, #7, #8, #9, #10, #23, #24, #25, #27, #28)
- **PARTIALLY-FIXED:** 1 (#5 — lint+test paths fixed, install path still broken)
- **FIXED-IN-SOURCE:** 1 (#11 — PR #72)
- **FIXED-BY-RESTART:** 1 (#12 — alpha.35 bridge live)
- **NOT-RE-VERIFIED:** 12 (out-of-scope per task)

### Cross-runner pattern
The chained vs YAML runner divergence is the structural source of #1, #2, #9. Chained runner has VD-2 capture but no silent-fail and no `tool`-field-aware plan generator; YAML runner has silent-fail but no VD-2. A single sweep that aligns both runners' stepResult contract + safety-detect path would close 3 critical/high bugs at once.

### Caveat on #11
Bug #11 is FIXED-IN-SOURCE for the YAML runner. The same agent-step skip pattern in a **chained** recipe would still slip through (Bug #2). `morning-brief` happens to be YAML-driven so it's caught.
