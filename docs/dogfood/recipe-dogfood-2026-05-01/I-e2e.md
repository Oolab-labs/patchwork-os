# Recipe E2E Dogfood — 2026-05-01 (Round 2)

Bridge: alpha.35, PID 68045, port 3101 (fresh restart).
Workspace: `/Users/wesh/Documents/Anthropic Workspace/Patchwork OS`.
Baseline `/recipes` count: 16. Final after cleanup: 16. Tmp dir `/tmp/dogfood-I` removed.

## TL;DR — severity-ranked seams found

| # | Severity | Seam | Pin |
|---|---|---|---|
| 1 | **CRITICAL** | Chained recipe with `file.write` step still reports `hasWriteSteps: false`. Safety gate bypassed. README #1 reconfirmed on alpha.35 fresh build. | `src/recipes/chainedRunner.ts:991` `generateExecutionPlan`; preflight JSON for P2 returns `plan.hasWriteSteps: False` |
| 2 | **CRITICAL** | Nested-recipe depth limit off-by-one: `maxDepth: 1` permits 2 layers (parent→child→grandchild). README #13 reconfirmed. | `src/recipes/nestedRecipeStep.ts:70` `if (currentDepth > recipeMaxDepth)` should be `>=`; live: `seq=3280` parent maxDepth=1, grandchild was entered |
| 3 | **CRITICAL** | No cycle detection for nested-recipe calls. parent→A and child→A loop runs until `maxDepth` hits, only saved by depth limit. | live: `seq=3281`, child invocations recurse parent↔child until depth 5 |
| 4 | **HIGH** | Cron-triggered recipe installed post-startup never auto-fires. Scheduler initialized once at bridge boot; new install does not trigger re-scan. P3 enabled at unix 1777627928, 0 runs in 240s. Bridge restart required to schedule. | `src/bridge.ts:1462` scheduler.start() called once on boot; `src/recipes/scheduler.ts` has no reload-on-install hook |
| 5 | **HIGH** | Two recipes with the same `name:` field both install successfully and both appear in HTTP `/recipes` list. `POST /recipes/<name>/run` then fails with **"not found"** — both are unreachable. Worse than ambiguous. | live: `p1-pkg/p1-hello.yaml` + `conflict-pkg/p1-hello.yaml` both `name: p1-hello`, HTTP shows 2 entries, run dispatch returns `{"ok":false,"error":"Recipe \"p1-hello\" not found ..."}` |
| 6 | **HIGH** | Multi-YAML package: only one of N recipes from a single install dir is discoverable at runtime. `p4-pkg/` containing both `p4-parent.yaml` + `p4-child.yaml` → `/recipes` shows only `p4-child`; `POST /recipes/p4-parent/run` → "not found". | `src/commands/recipeInstall.ts` `listInstalledRecipes` walks dir but registry only registers one entry per dir |
| 7 | **HIGH** | VD-2 capture (`resolvedParams`/`output`/`registrySnapshot`/`startedAt`) **still missing from YAML runner**. P1 + P3 (yamlRunner) returned bare 4-field stepResults; P2/P4 (chainedRunner) had full VD-2. README #9 reconfirmed unchanged on alpha.35. | yamlRunner does not import `captureForRunlog`; live `seq=3264` (P1 yaml) vs `seq=3271` (P2 chained) — same fixture-style 4 fields vs full capture |
| 8 | **HIGH** | `recipe install` accepts malformed YAML (no preflight pre-write). Bad recipe lands on disk with exit 0; HTTP enumeration silently drops it; `recipe test` exits 0 with parse error. README #5 reconfirmed. | `src/commands/recipeInstall.ts` install path; `claude-ide-bridge recipe test bad.yaml` → "1 error(s)" + EXIT 0 |
| 9 | **HIGH** | Nested child recipe runs are **not visible in `/runs`** — no separate runlog entry for child invocations. Only parent run has them inlined as `output.childOutputs`. Lost observability for nested executions. | live: `GET /runs?recipe=p4-child` returns empty; child only appears nested in `p4-parent`'s row |
| 10 | **MEDIUM** | `--allow-write` flag is **singular** (`--allow-write file`) but README and intuition spell `--allow-writes`. Using plural causes positional-arg drift: `recipe preflight foo.yaml --allow-writes file` swallows `file` as a recipe name → "recipe \"file\" not found". | `src/index.ts:1321` (preflight); silent flag drop. README/CLAUDE.md should document |
| 11 | **MEDIUM** | Nested-step `vars` template scoping: when child recipe is invoked, parent registry refs require **`{{steps.X.data}}`** form, not bare `{{X}}`. But every example recipe in `examples/recipes/` uses bare references (`{{threads}}` etc). Examples are dead. README #8 reframed: bare refs aren't false positives — they're invalid per current `templateEngine.parseExpression`. | `src/recipes/templateEngine.ts:114-134` requires `steps.X.data` or `env.Y`; e.g. `examples/recipes/morning-inbox-triage.yaml:33` `{{threads}}` would fail at runtime |
| 12 | **MEDIUM** | When nested child fails, `output.childOutputs` returns `{}` empty — failure step details lost. Only `childSummary: {failed: 1}` count visible. | live: `seq=3279` `call_child` output shows `childSummary` but `childOutputs: {}` |
| 13 | **MEDIUM** | CLI `recipe enable <recipe-name>` cannot find recipes by their YAML `name:` — only by directory name. HTTP shows recipe as `p1-hello`; CLI requires `p1-pkg`. Identity model inconsistent. | live: `recipe enable p1-hello` → "No installed recipe named", `recipe enable p1-pkg` → ✓ enabled |
| 14 | **MEDIUM** | `registrySnapshot` duplicated full at every chained step (README #25 reconfirmed). P2 4-step run → 31KB JSON because each parallel-read step re-emits the full git log in registrySnapshot. | live: `seq=3271` 31.3KB run JSON for 4 simple steps |
| 15 | **LOW** | Manually-fired YAML recipe (via `POST /recipes/<name>/run`) is logged with `trigger: "cron"` if recipe declares `trigger.type: cron`. Misleading — should report actual trigger source. | live: P3 fired manually via HTTP, `seq=3277` shows `"trigger": "cron"` |
| 16 | **LOW** | Replay correctly rejects YAML runs (`replay_only_supported_for_chained_recipes`) and accepts chained runs (`newSeq` returned, mocked re-execution). README A-live-runs confirmed working — repro on fresh bridge. No change. | live: `POST /runs/3264/replay` → 400 error msg; `POST /runs/3271/replay` → `{ok:false,newSeq:3273,unmockedSteps:[...]}` (newSeq created cleanly) |

---

## Pipeline 1 — simple manual recipe

### Recipe (`/tmp/dogfood-I/p1-hello.yaml`)

```yaml
apiVersion: patchwork.sh/v1
version: 1.0.0
name: p1-hello
description: Pipeline 1 dogfood — single file.write step
trigger:
  type: manual
steps:
  - id: write_hello
    tool: file.write
    path: "~/.patchwork/inbox/p1-hello-{{date}}.md"
    content: |
      # p1-hello
      hello from dogfood pipeline 1
    risk: low
```

### Lifecycle results

| Stage | Cmd / HTTP | Result | Exit / status | Note |
|---|---|---|---|---|
| Author | YAML drafted | OK | – | – |
| **Preflight #1** | `recipe preflight p1-hello.yaml` | **FAIL** "unacknowledged-write" | EXIT 1 | Need `--allow-write file` |
| Preflight #2 | tried inline `allowWrites: true` field | FAIL same error | EXIT 1 | **Seam** — `allowWrites` is a CLI flag, not a recipe field. No way to declare write acknowledgement in the recipe itself |
| Preflight #3 | `--allow-writes file` (plural) | "recipe \"file\" not found" | EXIT 1 | **Seam #10** — wrong flag; arg consumed as positional |
| Preflight #4 | `--allow-write file` (singular) | "✓ Preflight passed for p1-hello (1 steps)" | EXIT 0 | OK |
| Install #1 | `recipe install /tmp/dogfood-I/p1-hello.yaml` | "Local path is not a directory" | EXIT 1 | Confirms B-cli #9 (YAML/JSON asymmetry) |
| Install #2 | `recipe install /tmp/dogfood-I/p1-pkg` (dir) | "✓ Installed p1-pkg, Status: disabled" | EXIT 0 | Lands at `~/.patchwork/recipes/p1-pkg/` |
| HTTP `GET /recipes` | – | recipe `p1-hello` listed (NOT `p1-pkg`), `enabled: false` | – | name vs dir-name divergence (Seam #13) |
| Enable #1 | `recipe enable p1-hello` | "No installed recipe named" | EXIT 1 | **Seam #13** — CLI needs dir name |
| Enable #2 | `recipe enable p1-pkg` | "✓ enabled" | EXIT 0 | – |
| Enable idempotent | `recipe enable p1-pkg` | "ℹ already enabled" | EXIT 0 | – |
| Disable | `recipe disable p1-pkg` | "✓ disabled" | EXIT 0 | – |
| Re-enable | `recipe enable p1-pkg` | "✓ enabled" | EXIT 0 | Round-trip OK |
| **Fire** | `POST /recipes/p1-hello/run` | `{"ok":true,"taskId":"p1-hello-1777627780016","name":"p1-hello"}` | – | – |
| Get run | `GET /runs?recipe=p1-hello&limit=1` | `seq=3264 status=done durationMs=0` | – | **Seam #7** — VD-2 absent. Only `id, tool, status, durationMs` in stepResults. No `resolvedParams`, `output`, `registrySnapshot`, `startedAt`. `outputTail: "[ok] file.write"`. README #9 reconfirmed |
| File written | `~/.patchwork/inbox/p1-hello-2026-05-01.md` | OK content present | – | – |
| **Replay** | `POST /runs/3264/replay` | `{"ok":false,"error":"replay_only_supported_for_chained_recipes"}` | – | Expected per E-tests-dashboard. Round 1 confirmed |
| Re-install (idempotent) | `recipe install p1-pkg` ×2 | both EXIT 0, **silent overwrite** (no "(overwriting)" notice) | – | B-cli #6 reconfirmed |
| Uninstall | `recipe uninstall p1-pkg` | "✓ Uninstalled" | EXIT 0 | – |
| HTTP confirms gone | `GET /recipes` | p1-hello absent, count back to 16 | – | Clean |

### VD-2 capture observations
**MISSING** for yamlRunner. `seq=3264` shows only the bare 4-field stepResult shape from the legacy capture path. The `outputTail` string is the only visible output trace.

### Replay
Correctly rejected (chained-only).

---

## Pipeline 2 — chained DAG (parallel reads + agent + write)

### Recipe (`/tmp/dogfood-I/p2-chain.yaml`)

```yaml
apiVersion: patchwork.sh/v1
version: 1.0.0
name: p2-chain
trigger:
  type: chained
steps:
  - id: parallel_reads
    parallel:
      - tool: git.log_since
        since: 3 days ago
        into: log
      - tool: git.stale_branches
        days: 30
        into: stale
    risk: low
  - id: summarise
    agent:
      prompt: |
        Summarise these git observations:
        Recent commits: {{log}}
        Stale branches: {{stale}}
        ...
      into: summary
    awaits: [parallel_reads]
    risk: low
  - id: write_report
    tool: file.write
    path: "~/.patchwork/inbox/p2-chain-{{date}}.md"
    content: "{{summary}}"
    awaits: [summarise]
    risk: low
maxConcurrency: 2
maxDepth: 1
```

### Lifecycle

| Stage | Cmd | Result | Exit |
|---|---|---|---|
| Preflight | `recipe preflight ... --allow-write file` | "✓ Preflight passed for p2-chain (4 steps)" | 0 |
| `--json` plan | `recipe preflight ... --allow-write file --json` | `plan.hasWriteSteps: false` | 0 |
| Install | `recipe install p2-pkg` | OK, disabled | 0 |
| Enable | `recipe enable p2-pkg` | OK | 0 |
| Fire | `POST /recipes/p2-chain/run` | `taskId="p2-chain-1777627862191"` | – |
| Get run | `GET /runs?recipe=p2-chain&limit=1` | **seq=3271 status=error** | – |

### Critical seams from P2

1. **`hasWriteSteps: false`** despite `write_report` step being `tool: file.write` — README #1 / **CRITICAL Seam #1**. Pinned at `src/recipes/chainedRunner.ts:991`.

2. **Template engine rejects `{{log}}` / `{{stale}}`** as "Invalid expression: log". The agent step `summarise` errored at template resolution. Per `src/recipes/templateEngine.ts:114-134`, valid syntax is **only** `{{steps.X.data}}` or `{{env.Y}}` — bare aliases from `into:` are invalid. **Seam #11**.
   - This means agent prompts in `examples/recipes/morning-inbox-triage.yaml`, `meeting-prep.yaml` (using `{{threads}}`) would fail at runtime. Examples are misleading.
   - Cascading: `write_report` skipped because upstream `summarise` failed.

3. **VD-2 capture present** for chained — `resolvedParams`, `output`, `registrySnapshot`, `startedAt` all populated.

4. **`registrySnapshot` duplicated at every step** — full git log re-emitted at each step's snapshot. 31KB run JSON. README #25.

### Replay
`POST /runs/3271/replay` → `{ok:false, newSeq:3273, unmockedSteps:["summarise","write_report"], error:"2 step(s) failed"}` — replay path works for chained. Mocked re-execution still exposed the template error (recurring deterministically).

### Agent grounding
Did not exercise — agent step never ran (template error blocked it).

### Cleanup: `recipe disable p2-pkg` + `recipe uninstall p2-pkg` → both EXIT 0.

---

## Pipeline 3 — cron recipe

### Recipe

```yaml
apiVersion: patchwork.sh/v1
version: 1.0.0
name: p3-cron
trigger:
  type: cron
  at: "*/2 * * * *"
steps:
  - id: write_tick
    tool: file.write
    path: "~/.patchwork/inbox/p3-cron-{{date}}.md"
    content: |
      tick at run
    risk: low
```

### Lifecycle

| Stage | Cmd | Result | Exit |
|---|---|---|---|
| Preflight | `--allow-write file` | "✓ (1 steps)" | 0 |
| Install + enable | – | OK at unix 1777627928 | 0 |
| **Wait 240s** | – | – | – |
| `GET /runs?recipe=p3-cron` | – | **0 runs** — cron never fired in 4 min window | – |
| Force-fire via HTTP | `POST /recipes/p3-cron/run` | `taskId="p3-cron-1777628223215"` → seq=3277 status=done | – |

### Seam — cron not auto-firing

**Seam #4 (HIGH).** `*/2 * * * *` cron should have fired at least once at minute boundaries inside 240s. It did not.

Root cause: scheduler is initialized once at bridge boot in `src/bridge.ts:1462`. `recipeScheduler.start()` is called at startup; it scans `~/.patchwork/recipes/` once and registers cron jobs via `node-cron`. There's no hook (file-watcher, install callback) that calls `scheduler.restart()` after `recipe install`/`enable`. New cron-triggered recipes are dormant until the bridge is restarted.

Note: `seq=3277` for the manual fire reports `"trigger": "cron"` because dispatch reads recipe.trigger.type (Seam #15) — manual fires misattributed.

### VD-2: yamlRunner shape (4 fields only). Same as P1.

### Replay: not exercised — only one run, expected to be rejected per yamlRunner gate.

### Cleanup: disable + uninstall, both EXIT 0.

---

## Pipeline 4 — nested-recipe step

### Recipes

`p4-parent.yaml` (after fix):
```yaml
trigger:
  type: chained
steps:
  - id: setup
    tool: git.log_since
    since: 1 day ago
    risk: low
  - id: call_child
    recipe: p4-child
    vars:
      log_summary: "{{steps.setup.data}}"
    awaits: [setup]
    risk: low
    into: child_result
maxConcurrency: 1
maxDepth: 2
```

`p4-child.yaml`:
```yaml
trigger:
  type: chained
context:
  - type: env
    keys: [log_summary]
steps:
  - id: write_child_output
    tool: file.write
    path: "~/.patchwork/inbox/p4-child-{{date}}.md"
    content: |
      ## P4 child fired
      log_summary received: {{log_summary}}
    risk: low
maxConcurrency: 1
maxDepth: 1
```

### Lifecycle

| Stage | Cmd | Result | Exit |
|---|---|---|---|
| Preflight parent | – | "⚠ lint-warning: Step 2: 'recipe: p4-child' — recipe not found" + "✓ passed (2 steps)" | 0 |
| Preflight child | – | "✓ passed (1 steps)" | 0 |
| Install BOTH in `p4-pkg/` | – | OK | 0 |
| List `/recipes` | – | only `p4-child` shown, NO `p4-parent` | – |
| Fire parent | `POST /recipes/p4-parent/run` | `{"ok":false,"error":"Recipe \"p4-parent\" not found"}` | – |

**Seam #6 (HIGH)** — multi-YAML package only registers one recipe at runtime.

Switched to **separate packages** (`p4-parent-pkg/`, `p4-child-pkg/`):

| Stage | Cmd | Result |
|---|---|---|
| First fire (with `{{log}}`) | `POST .../p4-parent/run` | seq=3278: setup OK, call_child errored — "Variable template errors: Invalid expression: log" |
| Second fire (with `{{steps.setup.data}}`) | – | seq=3279: setup OK, call_child errored — "Step call_child failed". `output.recipe="p4-child"`, `childSummary.failed=1`, **`childOutputs: {}` empty** |

Despite call_child appearing to invoke the child, **no `~/.patchwork/inbox/p4-child-*.md` file was written**. Child-step error opaque (Seam #12). Also: `GET /runs?recipe=p4-child` returns empty — child runs not separately logged (Seam #9).

### Depth limit test (off-by-one verification)

Setup: `parent (maxDepth: 1) → child → grandchild`. Expected: grandchild blocked at depth=1 boundary.

Result `seq=3280` `output`:
```json
{
  "recipe": "p4-depth-child",
  "childSummary": { "total": 1, "succeeded": 0, "failed": 1 },
  "childOutputs": {
    "call_grandchild": {
      "recipe": "p4-depth-grandchild",
      "childSummary": { "total": 1, "succeeded": 0, "failed": 1 },
      "childOutputs": {}
    }
  }
}
```

**Grandchild was entered.** Parent declared `maxDepth: 1` but recursion reached the grandchild's `noop` step (which then failed for unrelated reasons — likely write-ack). **CRITICAL Seam #2 confirms README #13** — `nestedRecipeStep.ts:70` `if (currentDepth > recipeMaxDepth)` permits one extra layer.

### Cycle detection

Setup: `p4-cycle-a → p4-cycle-b → p4-cycle-a → ...` with `maxDepth: 5`.

Result `seq=3281`: cycle expanded all 5 layers (a→b→a→b→a→...) until depth limit kicked in. **No name-based cycle detection** — only saved by `maxDepth`. A recipe with `maxDepth: 100` would generate a 100-deep nested execution tree before halting. **CRITICAL Seam #3**.

The PR #103 cycle detector handles **intra-recipe step DAG cycles** (verified working in round 1 README); it does NOT handle **inter-recipe call cycles**.

### VD-2 at parent

VD-2 captured at parent (chainedRunner). For nested invocations, only summary is exposed; full child step traces unavailable from parent runlog.

### Cleanup
All 7 packages uninstalled cleanly.

---

## Special-case probes

### Re-install with same recipe name, different content

Both `p1-pkg/p1-hello.yaml` and `conflict-pkg/p1-hello.yaml` contained `name: p1-hello`. Installed both → `/recipes` showed **two `p1-hello` entries**. `POST /recipes/p1-hello/run` → "Recipe \"p1-hello\" not found" (Seam #5 above). No conflict guard at install or dispatch.

### Install `lint.ok: false` recipe

`bad-pkg/bad.yaml` — malformed YAML (`steps: notalist`, bad version, missing trigger).
- `recipe install bad-pkg` → **EXIT 0** (✓ Installed).
- `/recipes` enumeration: bad-recipe absent (silently dropped, total stayed at 17 = baseline 16 + visible recipes from other tests).
- Disk has the file in `~/.patchwork/recipes/bad-pkg/bad.yaml`.

Confirms README #5 / B-cli #7: install plants malformed YAML on disk; no preflight pre-write.

### `recipe test` exit code

`recipe test bad.yaml` → "✗ YAML parse error..." + "1 error(s), 0 warning(s)" + **EXIT 0**.

Confirms B-cli #36: CI invocations of `recipe test` will silently pass when they should fail. Inconsistent with `recipe lint` / `recipe preflight` (both exit 1 on errors).

### `~/.patchwork/runs/` directory

Doesn't exist. Persistence is single jsonl file `~/.patchwork/runs.jsonl` (946 KB, append-only, with `.bak` rotation). Each line is one run record. Live `/runs` HTTP endpoint reads the same file (verified by tail matching seq=3279/3280/3281). **No per-run JSON files on disk.**

---

## Cleanup verification

```
$ curl ... /recipes | count
16     # = baseline
$ ls /tmp/dogfood-I 2>&1
ls: /tmp/dogfood-I: No such file or directory
```

All synthetic recipes uninstalled. Tmp dir removed. No mutation to existing 16 user recipes confirmed.

---

## Summary of new seams (not previously catalogued in README)

| New seam | Severity |
|---|---|
| Multi-YAML package registers only one recipe at runtime (Seam #6) | HIGH |
| Same-name conflict → both unreachable via `/recipes/<name>/run` (Seams #5, #14) | HIGH |
| Cron-recipes installed post-startup never fire (no scheduler reload hook) (Seam #4) | HIGH |
| Nested child runs absent from `/runs` (Seam #9) | HIGH |
| Nested-recipe call cycle detection missing — only depth-limited (Seam #3) | CRITICAL |
| Nested child failure surfaces zero step-level error info to parent (Seam #12) | MEDIUM |
| `--allow-writes` (plural) silently swallows positional args (Seam #10) | MEDIUM |
| CLI `recipe enable <yaml-name>` rejects despite HTTP showing the name (Seam #13) | MEDIUM |
| Manual HTTP fire of cron recipe logs `trigger: "cron"` (Seam #15) | LOW |

## Reconfirmations (round 1 bugs unchanged on alpha.35 fresh)

| README ref | Status |
|---|---|
| #1 chained `hasWriteSteps: false` | RECONFIRMED |
| #5 install accepts malformed YAML | RECONFIRMED |
| #5 `recipe test` exit 0 on errors | RECONFIRMED |
| #9 yamlRunner missing VD-2 | RECONFIRMED |
| #13 nestedRecipeStep depth off-by-one | RECONFIRMED |
| #25 registrySnapshot duplicated per step | RECONFIRMED |
| B-cli #6 silent overwrite on re-install | RECONFIRMED |
| B-cli #9 YAML/JSON install asymmetry | RECONFIRMED |
| B-cli #36 `recipe test` exit 0 on errors | RECONFIRMED |
| Replay chained-only gate | WORKING (no regression) |
