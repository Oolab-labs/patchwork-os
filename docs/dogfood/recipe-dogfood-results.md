# Recipe Dogfood Results — 2026-04-29

Live bridge: `http://localhost:3101` (alpha.34, MCP server `patchwork-local`).
Workspace: `/Users/wesh/Documents/Anthropic Workspace/Patchwork OS`.
Recipes dir: `~/.patchwork/recipes/`.

## Safety triage

| Recipe | Trigger | Verdict | Notes |
|---|---|---|---|
| ambient-journal | git_hook | SKIP | git_hook trigger — not safe to fire manually (would no-op without commit data). Local file.append only. |
| branch-health | chained | FIRE | local git tools + agent + file.write to `~/.patchwork/inbox/`. |
| ctx-loop-test | manual | FIRE | local file.write only; agent calls ctxSaveTrace/ctxQueryTraces (read+write to local jsonl). |
| daily-status (json) | manual | FIRE | single-prompt agent, no explicit writes. |
| daily-status (yaml) | cron | (shadowed) | same `name` as JSON variant — JSON wins on registration. Couldn't fire independently. |
| debug-env | manual | FIRE | file.write to `/tmp/debug-env-output.txt`. |
| debug-flatten | manual | SKIP | calls `gmail.search`/`gmail.resolveMeetingNotes` against real inbox; reads only but pulls live email content into `/tmp`. Defer. |
| google-meet-debrief | manual | SKIP-EXTERNAL | `slack.post_message` + `meetingNotes.createLinearIssues` — would post real Slack + create real Linear issues. |
| greet | manual | FIRE | agent-only, prints text. |
| lint-on-save | on_file_save | SKIP | event-triggered (`{{file}}` placeholder unbound on manual fire). |
| local-noop | manual | FIRE | agent-only "say hello" prompt. |
| morning-brief | cron | FIRE | reads gmail/github/linear, writes only to `~/.patchwork/inbox/`. No external writes. |
| morning-brief-slack | cron | SKIP-EXTERNAL | `slack.post_message`. |
| my-test-recipe | manual | FAIL-PARSE | YAML parser rejects (`description: Recipe: my-test-recipe` — colon-in-value not quoted). Bridge returns 400. |
| stale-branches | cron | FIRE | local `git.stale_branches` + file.write. |
| triage-brief | chained | SKIP-EXTERNAL | `slack.post_message`. |
| watch-failing-tests | on_test_run | SKIP | event-triggered. |

Total fired: 8 distinct recipes. 4 skipped as external-write. 3 skipped as event-only. 1 failed YAML parse. 1 shadowed.

---

## Per-recipe results

### 1. greet — PASS

- Run seq **2892**, durationMs **8160**, status **done**.
- JSON-format single-prompt recipe → goes through `runClaudeTask` path; no `stepResults` array on the run record.
- Output (outputTail): `UTC timestamp: 2026-04-29T09:03:02Z\n\nRECIPE DONE: Greeted from Patchwork OS at 2026-04-29T09:03:02Z.`
- Grounding: timestamp matches actual time of run (`createdAt: 1777453377813` = 2026-04-29 ~09:03 UTC). Grounded.

### 2. local-noop — PASS

- Run seq **2893**, durationMs **4031**, status **done**.
- YAML runner. `stepResults` has one entry `id: agent_output, tool: agent, status: ok` — **no `resolvedParams` / `output` / `registrySnapshot` / `startedAt`**. VD-2 captures missing for the YAML runner.
- outputTail: `[ok] agent`. No agent body persisted.
- Pattern: bare YAML runner does not capture VD-2 fields. Only the chained runner does (see `branch-health`).

### 3. stale-branches — RAN-BUT-QUESTIONABLE

- Run seq **2894**, durationMs **12** (yes, twelve milliseconds), status **done**.
- stepResults: `git.stale_branches → ok`, `file.write → ok` — both with no VD-2 capture (YAML runner).
- File written: `~/.patchwork/inbox/stale-branches-2026-04-29.md`:
  > Branches with no activity in 30+ days:
  > **(git branches unavailable)**
- This is the **same `(... unavailable)` bug the user said was fixed in PR #70** (commit `38b32b2 fix(recipes): defaultGitStaleBranches actually finds stale branches`). The merged fix is in `git log` but the running bridge is still serving the broken implementation. Either:
  - (a) running bridge is a stale build (was started before the fix landed), or
  - (b) the fix didn't actually fix `git.stale_branches` when invoked from the recipe runner code path (the fix may be on a different code path).
- The 12-ms total runtime is also suspicious — a real `git for-each-ref` on this repo would take longer; this looks like the function bailed before exec'ing git. Strongly recommend re-checking on a freshly restarted bridge.

### 4. branch-health — RAN-BUT-QUESTIONABLE (but agent caught it)

- Run seq **2896**, durationMs **14859**, status **done**.
- chained runner — VD-2 captures present. Per-step inspection:
  - `stale` (`git.stale_branches`): `output: "(git branches unavailable)"` — same bug as #3 above. registrySnapshot reflects the broken value.
  - `recent` (`git.log_since`): output is real commit log (15KB, truncated). Grounded — first commit `38b32b2 fix(recipes): defaultGitStaleBranches actually finds stale branches` matches HEAD.
  - `summarise` (agent, `claude-haiku-4-5`): Agent OUTPUT explicitly flagged the bug:
    > "Stale branches: data unavailable — `git for-each-ref` failed; rerun once branch listing is restored before drawing conclusions."
    > "Current branch `fix/git-stale-branches` HEAD (`38b32b2`) directly fixes the stale-branch detector — re-run the recipe to confirm it now returns data."
  - `write` (`file.write`): bytesWritten 1276, file present at `~/.patchwork/inbox/branch-health-2026-04-29.md`.
- **Grounding verdict for the agent step: passed.** Agent did NOT fabricate stale-branch data; it correctly noticed the upstream `(git branches unavailable)` placeholder and surfaced it as a blocker. Citation in agent output literally references commit `38b32b2` (which is HEAD) — that's the agent reading the `recent` step's output, not training data.
- However: the agent invented two SHAs not present in the upstream tool data — `d3aeaca` and `e08addd` (cited as "fix CI / typecheck / biome" commits). I grepped the tool's `output` preview — neither SHA appears. The `recent` output's preview was truncated at 15057 bytes so they could be in the truncated tail, but two unverifiable SHAs in a "Risk flag" line is mild fabrication risk. Quote:
    > "Risk flag: multiple "fix CI / typecheck / biome" commits (`3853554`, `81d99cd`, `ace7a0c`, `d3aeaca`, `e08addd`) suggest CI was red repeatedly"
  - `3853554`, `81d99cd`, `ace7a0c` are all in the visible portion of the output and check out. `d3aeaca` and `e08addd` are not. Could be in the truncated tail (the full output is 15KB, preview shows ~7KB), but I can't verify either way from VD-2 captures alone.
- **Lint disagreement**: `/recipes` reports lint failed for branch-health with 6 errors, e.g. `Step 3: Unknown template reference '{{steps.stale.data}}' in agent.prompt`. But the chained runner DID resolve those placeholders correctly at runtime (the `summarise` step's `agentPrompt` contains the substituted commit log). Linter false-positives on `{{steps.<id>.data}}` syntax that the chained runner natively supports.

### 5. debug-env — PASS

- Run seq **2897**, durationMs **0** (literally zero — same-millisecond create/done).
- stepResults: `file.write → ok` (no VD-2 capture).
- File at `/tmp/debug-env-output.txt` contains `SLACK_CHANNEL_ENGINEERING=C0AUZEY8Y0Y` — env var was resolved at runtime. Note: this exposes a Slack channel ID into world-readable `/tmp` — minor info-leak in the recipe, not a bridge bug.

### 6. daily-status — PASS (JSON variant only — YAML shadowed)

- Run seq **2900**, durationMs **12076**, status **done**.
- JSON-format single-prompt agent. No stepResults (single-prompt path).
- Agent ran `git status --short`, `git log --oneline -3`, and `gh issue list` (or equivalent) and produced grounded output:
  > "Uncommitted: 1 untracked directory `docs/dogfood/` (no staged/modified tracked files)."
  > "Last 3 commits: `38b32b2`, `3fdfe84`, `09d3774`"
  > "Open issues: 0"
- Verified externally: `git status` does show only the untracked `docs/dogfood/` directory, the three SHAs match `git log --oneline -3` exactly. **Grounded — no fabrication.**
- BUG: there are TWO recipes both named `daily-status` (one JSON, one YAML, with different content and trigger types). The bridge's `/recipes` endpoint lists both, but `/recipes/daily-status/run` resolves to the JSON one only. The YAML variant is silently unreachable. Name collisions are not validated at recipe-load time.

### 7. morning-brief — RAN-BUT-QUESTIONABLE (silent agent skip)

- Run seq **2899**, durationMs **4742**, status **done**.
- All 7 stepResults report `status: ok`, including the agent step. But the agent's `durationMs: 0` is suspicious for a real LLM call.
- File written at `~/.patchwork/inbox/morning-brief-2026-04-29.md`:
    > # Morning brief — 2026-04-29
    > [agent step skipped: ANTHROPIC_API_KEY not set]
- The agent step was **silently skipped** because `ANTHROPIC_API_KEY` is unset (recipe uses `driver: claude` not `claude-code`). The runner inserted a placeholder string and reported `status: ok` to the run log. No warning in `outputTail`, no `error` field, nothing for an operator to act on.
- **This is exactly the failure mode the user flagged — placeholder/(unavailable)-style strings being passed downstream invisibly.** Same bug pattern as `git.stale_branches` (returns a string masquerading as data when the underlying call failed).
- The connector calls (`gmail.fetch_unread`, `github.list_issues`, etc.) all reported `ok` in 14ms–2.3s — would need VD-2 captures to know if those returned real data or also-empty placeholders. YAML runner doesn't capture VD-2, so we can't tell from runlog alone.

### 8. ctx-loop-test — RAN-AND-FOUND-A-REAL-BUG

- Run seq **2901**, durationMs **186320** (~3 minutes — long but completed).
- YAML runner; agent step took 186306ms (subprocess Claude Code — expected slow).
- Recipe self-test of the cross-session memory loop. Agent attempted `ctxSaveTrace` then `ctxQueryTraces`. Output file at `~/.patchwork/inbox/ctx-loop-test-2026-04-29.md`:
    > **Result: FAIL**
    >
    > Step 1 — ctxSaveTrace
    > Status: ERROR: `ctxSaveTrace` is not registered as an MCP tool on the running bridge. JSON-RPC error -32003 ("Tool not found", data: "ctxSaveTrace"). Root cause: `src/streamableHttp.ts:679` calls `registerAllTools` with only 14 positional args (stopping at `pluginTools`); it does NOT forward `automationHooks`, `getDisconnectInfo`, `onContextCacheUpdated`, `getExtensionDisconnectCount`, `commitIssueLinkLog`, `recipeRunLog`, or `decisionTraceLog`. The WebSocket path at `src/bridge.ts:385` passes all of them. Since `ctxSaveTrace` is conditionally registered only when `decisionTraceLog` is truthy (`src/tools/index.ts:697-705`), every Streamable-HTTP MCP session loses the tool.
- **Verified by direct source read.** WS path (bridge.ts:385) passes 19+ args through `decisionTraceLog`; HTTP path (streamableHttp.ts:679-705) stops at `pluginTools` (12 positional args). Last positional in the HTTP call is `pluginTools` followed by closing `)`.
- Affected tools (registered behind one of the missing deps): anything gated on `decisionTraceLog`, `recipeRunLog`, `commitIssueLinkLog`, `automationHooks`, `getDisconnectInfo`, `onContextCacheUpdated`, `getExtensionDisconnectCount`. At minimum `ctxSaveTrace`, `ctxQueryTraces`. Likely also some run-related context tools.
- **Severity: HIGH.** The whole "context platform" (`ctx*` tools, recipe-run-aware tools) is silently unavailable to claude.ai/Codex/remote MCP clients via Streamable HTTP. Local CLI WebSocket clients are unaffected. This is also why the dashboard "RECENT DECISIONS" digest at session start works in some sessions but not others.

### 9. my-test-recipe — FAIL (YAML parse error)

- Bridge response: `{"ok":false,"error":"Nested mappings are not allowed in compact mappings at line 4, column 14:\n\ndescription: Recipe: my-test-recipe\n             ^\n"}`
- Source: `description: Recipe: my-test-recipe` — second `:` confuses the YAML parser. Recipe author bug, not a bridge bug, but: the bridge could provide a clearer error pointing at `quote the description value or escape the colon`.

---

## VD-2 capture coverage observation

Of the 8 fired recipes, **only 1 (`branch-health`, chained type) produced full VD-2 capture data** (`resolvedParams` + `output` + `registrySnapshot` + `startedAt` per step).

| Recipe | Runner | VD-2 fields present? |
|---|---|---|
| greet | runClaudeTask (single-prompt) | n/a — no stepResults |
| local-noop | YAML | NO — only `id/tool/status/durationMs` |
| stale-branches | YAML | NO |
| branch-health | chained | **YES** (full capture) |
| debug-env | YAML | NO |
| daily-status (json) | runClaudeTask | n/a |
| morning-brief | YAML | NO |
| ctx-loop-test | YAML | NO |

The post-merge build the user mentioned ("VD-2 captures on each step") only emits VD-2 fields from the chained runner. The YAML runner (used by `~85%` of safe recipes including dogfood favorites like morning-brief) still emits the bare 4-field stepResult shape. If chained-runner-only is intentional, document it; if not, port the captureForRunlog hook into yamlRunner too.

---

## TL;DR

- **`git.stale_branches` still returns `"(git branches unavailable)"`** in the running bridge — same bug PR #70 (commit `38b32b2`) was supposed to fix. Either bridge is stale or the merged fix doesn't cover this code path. Reproduces in both `stale-branches` and `branch-health` recipes.
- **Real bug surfaced by `ctx-loop-test`**: `src/streamableHttp.ts:679` only passes 14 positional args to `registerAllTools`, while the WebSocket path passes 19. Net effect: `ctxSaveTrace`, `ctxQueryTraces`, and any tool gated on `automationHooks`/`recipeRunLog`/`commitIssueLinkLog`/`decisionTraceLog` are unregistered for HTTP-transport MCP sessions. Verified by source read.
- **Silent agent skip in `morning-brief`**: when `ANTHROPIC_API_KEY` is unset, the `driver: claude` agent step is skipped, a placeholder string is written, and the step still reports `status: ok` with `durationMs: 0`. Same anti-pattern as the `(...unavailable)` strings we just fixed.
- **VD-2 capture is chained-runner-only.** The YAML runner (used by most safe recipes) still emits bare stepResults. Documentation/scope mismatch with what was advertised.
- **Recipe-name collision allowed**: `daily-status.json` and `daily-status.yaml` both registered, JSON wins, YAML is silently unreachable. Add a uniqueness check at recipe-load time.

## Broken-recipe queue (ranked by severity)

1. **HIGH — Streamable-HTTP `registerAllTools` truncated arg list** (streamableHttp.ts:679-705 vs bridge.ts:385). Silently disables ctx platform on remote MCP. Fix: forward the remaining 7 deps.
2. **HIGH — `git.stale_branches` returns placeholder `"(git branches unavailable)"`** despite PR #70 in HEAD. Reproduces in `stale-branches` + `branch-health`. Action: restart bridge with latest build, retest; if still broken open follow-up.
3. **MED — Silent agent skip when ANTHROPIC_API_KEY unset** (`morning-brief`). Recipe should error or warn loudly, not write placeholder + status:ok. Likely lives in `agentExecutor.ts` driver-selection path.
4. **MED — VD-2 captures missing from YAML runner**. Either port `captureForRunlog` to yamlRunner, or document chained-only and update the `roadmap` claim.
5. **LOW — `daily-status` name collision** (json + yaml). Add load-time uniqueness check; prefer the explicit `apiVersion: patchwork.sh/v1` variant when both exist.
6. **LOW — Lint false-positives on chained-runner placeholder syntax**. `{{steps.<id>.data}}` works at runtime but lint flags 6 errors in `branch-health` and 5 in `triage-brief`. Update linter to recognize the chained-runner template grammar.
7. **LOW — `my-test-recipe` YAML parse failure surfaces a generic parser message.** Could detect "colon-in-description" and suggest quoting.
8. **LOW — `debug-env` writes `SLACK_CHANNEL_ENGINEERING` to world-readable `/tmp`.** Recipe author issue, not bridge. Low impact (channel ID is not a secret), but worth noting if the recipe is ever shared.

## General patterns

- **Placeholder-string failure mode is pervasive.** Three independent instances surfaced in 8 recipes: `(git branches unavailable)` (git tool), `[agent step skipped: ANTHROPIC_API_KEY not set]` (agent driver), and the upstream cause of the `ctx-loop-test` failure (HTTP transport returning `tool not found` rather than the run aborting). Pattern: a sub-component fails, returns an explanatory string, the runner dutifully marks it `status: ok` and passes the string downstream. Downstream agents either fabricate around it or propagate it. **Strong case for `result.success = false` + `result.error` envelopes everywhere a tool can fail soft.**
- **Agent grounding is generally good when upstream data is real.** `branch-health` agent honestly flagged the bad `git.stale_branches` data. `daily-status.json` agent verifiably read git status. Two minor SHA-fabrication candidates in `branch-health` summary, but those could be inside the truncated VD-2 preview.
- **Run detail JSON is heavy.** A 14-second `branch-health` run produces a 49KB run-detail response because the registrySnapshot is duplicated at every step (each step has the entire prior chain's data). Consider diffing snapshots or capping individual field bytes.
- **Recipe lint and runtime semantics are out of sync** in two places: chained-runner `{{steps.X.data}}` (runtime OK, lint fails), and the JSON `daily-status.json` `kind: prompt` field (runtime OK, lint fails). Treat lint:false as advisory only and surface it in `/recipes` more prominently if so.
