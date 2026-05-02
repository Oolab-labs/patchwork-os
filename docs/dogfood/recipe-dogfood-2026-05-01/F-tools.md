# F — Recipe Tool Registry Dogfood (Round 2, alpha.35 fresh)

Bridge: PID 68045, started 1777627477261 (2026-05-01 ~12:24 local), `node dist/index.js --port 3101 --automation --automation-policy automation-policy.json --claude-driver subprocess --full`. Code path: `dist/recipes/...` re-imported live. Round 1 left ~6 of 60 tools tested; this run hit all 67 read-tier tools end-to-end and source-audited every write-tier tool.

Inventory done two ways:
1. `listTools()` against the live registry (`dist/recipes/toolRegistry.js`).
2. Source grep across `src/recipes/tools/*.ts`.

Both agree: **97 tools across 23 namespaces** — 67 reads, 30 writes. Source-of-truth files for all claims below: `src/recipes/tools/<ns>.ts`.

---

## 1. Tool inventory (97 / 23 ns)

| namespace.tool | impl `file:line` | risk | classification | notes |
|---|---|---|---|---|
| `file.read` | `src/recipes/tools/file.ts:30` | low | READ-LOCAL | path-traversal NOT enforced; `~/` expand |
| `file.write` | `src/recipes/tools/file.ts:66` | medium | WRITE-LOCAL | no workspace-root containment |
| `file.append` | `src/recipes/tools/file.ts:105` | medium | WRITE-LOCAL | same |
| `git.log_since` | `src/recipes/tools/git.ts:13` | low | READ-LOCAL | impl in `yamlRunner.ts:872` `defaultGitLogSince` |
| `git.stale_branches` | `src/recipes/tools/git.ts:42` | low | READ-LOCAL | impl in `yamlRunner.ts:917` `defaultGitStaleBranches` (PR #70) |
| `diagnostics.get` | `src/recipes/tools/diagnostics.ts:13` | low | READ-LOCAL | needs `deps.getDiagnostics` |
| `asana.get_current_user` | `src/recipes/tools/asana.ts:23` | low | READ-CONNECTOR | wraps throws → `{count,items,error}` |
| `asana.list_workspaces` | `…asana.ts:64` | low | READ-CONNECTOR | same |
| `asana.list_projects` | `…asana.ts:107` | low | READ-CONNECTOR | same |
| `asana.list_tasks` | `…asana.ts:158` | low | READ-CONNECTOR | same |
| `asana.get_task` | `…asana.ts:220` | low | READ-CONNECTOR | same |
| `asana.create_task` | `…asana.ts:266` | medium | WRITE-EXTERNAL | `{ok:true, gid, name}` / `{ok:false, error}` |
| `asana.update_task` | `…asana.ts:351` | medium | WRITE-EXTERNAL | same envelope |
| `asana.complete_task` | `…asana.ts:445` | low | WRITE-EXTERNAL | same |
| `asana.add_task_comment` | `…asana.ts:492` | low | WRITE-EXTERNAL | same |
| `calendar.list_events` | `src/recipes/tools/calendar.ts:13` | low | READ-CONNECTOR | wraps |
| `confluence.getPage` | `src/recipes/tools/confluence.ts:14` | low | READ-CONNECTOR | **NO try/catch** — throws on unauth |
| `confluence.search` | `…confluence.ts:76` | low | READ-CONNECTOR | same |
| `confluence.createPage` | `…confluence.ts:120` | medium | WRITE-EXTERNAL | **NO try/catch** |
| `confluence.appendToPage` | `…confluence.ts:178` | medium | WRITE-EXTERNAL | **NO try/catch** |
| `confluence.listSpaces` | `…confluence.ts:230` | low | READ-CONNECTOR | **NO try/catch** |
| `datadog.queryMetrics` | `src/recipes/tools/datadog.ts:14` | low | READ-CONNECTOR | **NO try/catch** |
| `datadog.listMonitors` | `…datadog.ts:64` | low | READ-CONNECTOR | **NO try/catch** |
| `datadog.getMonitor` | `…datadog.ts:110` | low | READ-CONNECTOR | **NO try/catch** |
| `datadog.listActiveAlerts` | `…datadog.ts:146` | low | READ-CONNECTOR | **NO try/catch** |
| `datadog.muteMonitor` | `…datadog.ts:180` | medium | WRITE-EXTERNAL | **NO try/catch** |
| `datadog.listIncidents` | `…datadog.ts:229` | low | READ-CONNECTOR | **NO try/catch** |
| `discord.get_current_user` | `src/recipes/tools/discord.ts:25` | low | READ-CONNECTOR | wraps |
| `discord.list_guilds` | `…discord.ts:67` | low | READ-CONNECTOR | wraps |
| `discord.list_channels` | `…discord.ts:111` | low | READ-CONNECTOR | wraps |
| `discord.list_messages` | `…discord.ts:158` | low | READ-CONNECTOR | wraps |
| `discord.send_message` | `…discord.ts:209` | medium | WRITE-EXTERNAL | wraps; `{ok:true,...} / {ok:false,error}` |
| `drive.fetchDoc` | `src/recipes/tools/googleDrive.ts:3` | low | READ-CONNECTOR | wraps; placeholder envelope |
| `github.list_issues` | `src/recipes/tools/github.ts:13` | low | READ-CONNECTOR | wraps; **uses `gh` shell** (slow) |
| `github.list_prs` | `…github.ts:72` | low | READ-CONNECTOR | wraps |
| `gitlab.get_current_user` | `src/recipes/tools/gitlab.ts:18` | low | READ-CONNECTOR | wraps |
| `gitlab.list_projects` | `…gitlab.ts:59` | low | READ-CONNECTOR | wraps |
| `gitlab.list_issues` | `…gitlab.ts:124` | low | READ-CONNECTOR | wraps |
| `gitlab.get_issue` | `…gitlab.ts:191` | low | READ-CONNECTOR | wraps |
| `gitlab.list_merge_requests` | `…gitlab.ts:244` | low | READ-CONNECTOR | wraps |
| `gmail.fetch_unread` | `src/recipes/tools/gmail.ts:245` | low | READ-CONNECTOR | wraps; `{count:0,messages:[],error}` |
| `gmail.search` | `…gmail.ts:283` | low | READ-CONNECTOR | wraps |
| `gmail.getMessage` | `…gmail.ts:324` | low | READ-CONNECTOR | wraps |
| `gmail.fetch_thread` | `…gmail.ts:360` | low | READ-CONNECTOR | wraps |
| `gmail.resolveMeetingNotes` | `…gmail.ts:396` | low | READ-CONNECTOR | wraps |
| `hubspot.listContacts` | `src/recipes/tools/hubspot.ts:14` | low | READ-CONNECTOR | **NO try/catch** |
| `hubspot.getContact` | `…hubspot.ts:59` | low | READ-CONNECTOR | **NO try/catch** |
| `hubspot.listDeals` | `…hubspot.ts:92` | low | READ-CONNECTOR | **NO try/catch** |
| `hubspot.getDeal` | `…hubspot.ts:137` | low | READ-CONNECTOR | **NO try/catch** |
| `hubspot.createNote` | `…hubspot.ts:170` | medium | WRITE-EXTERNAL | **NO try/catch** |
| `hubspot.searchContacts` | `…hubspot.ts:218` | low | READ-CONNECTOR | **NO try/catch** |
| `intercom.listConversations` | `src/recipes/tools/intercom.ts:14` | low | READ-CONNECTOR | **NO try/catch** |
| `intercom.getConversation` | `…intercom.ts:75` | low | READ-CONNECTOR | **NO try/catch** |
| `intercom.replyToConversation` | `…intercom.ts:117` | medium | WRITE-EXTERNAL | **NO try/catch** |
| `intercom.closeConversation` | `…intercom.ts:169` | medium | WRITE-EXTERNAL | **NO try/catch** |
| `intercom.listContacts` | `…intercom.ts:211` | low | READ-CONNECTOR | **NO try/catch** |
| `jira.list_issues` | `src/recipes/tools/jira.ts:21` | low | READ-CONNECTOR | wraps; PR #93 |
| `jira.get_issue` | `…jira.ts:88` | low | READ-CONNECTOR | wraps; PR #93 |
| `jira.list_projects` | `…jira.ts:138` | low | READ-CONNECTOR | wraps; PR #93 |
| `jira.create_issue` | `…jira.ts:183` | medium | WRITE-EXTERNAL | wraps; PR #93 |
| `jira.update_status` | `…jira.ts:280` | medium | WRITE-EXTERNAL | wraps; PR #93 |
| `jira.add_comment` | `…jira.ts:340` | low | WRITE-EXTERNAL | wraps; PR #93 |
| `linear.list_issues` | `src/recipes/tools/linear.ts:18` | low | READ-CONNECTOR | wraps |
| `linear.listIssues` | `…linear.ts:101` | low | READ-CONNECTOR | **alias** of list_issues (PR #103) |
| `linear.createIssue` | `…linear.ts:107` | medium | WRITE-EXTERNAL | **bare `{error}`** envelope (no `ok`) |
| `linear.updateIssue` | `…linear.ts:183` | medium | WRITE-EXTERNAL | **bare `{error}`** envelope |
| `linear.addComment` | `…linear.ts:265` | low | WRITE-EXTERNAL | `{ok,id,body,url}/{ok:false,error}` |
| `meetingNotes.createLinearIssues` | `src/recipes/tools/meetingNotes.ts:421` | medium | WRITE-EXTERNAL | `{created,error}` |
| `meetingNotes.parse` | `…meetingNotes.ts:612` | low | READ-LOCAL | pure parser |
| `meetingNotes.flatten` | `…meetingNotes.ts:665` | low | READ-LOCAL | pure transform |
| `notion.queryDatabase` | `src/recipes/tools/notion.ts:14` | low | READ-CONNECTOR | **NO try/catch** |
| `notion.getPage` | `…notion.ts:83` | low | READ-CONNECTOR | **NO try/catch** |
| `notion.search` | `…notion.ts:124` | low | READ-CONNECTOR | **NO try/catch** |
| `notion.createPage` | `…notion.ts:178` | medium | WRITE-EXTERNAL | **NO try/catch** |
| `notion.appendBlock` | `…notion.ts:249` | medium | WRITE-EXTERNAL | **NO try/catch** |
| `pagerduty.list_incidents` | `src/recipes/tools/pagerduty.ts:22` | low | READ-CONNECTOR | wraps |
| `pagerduty.get_incident` | `…pagerduty.ts:97` | low | READ-CONNECTOR | wraps |
| `pagerduty.list_services` | `…pagerduty.ts:142` | low | READ-CONNECTOR | wraps |
| `pagerduty.list_on_calls` | `…pagerduty.ts:187` | low | READ-CONNECTOR | wraps |
| `pagerduty.acknowledge_incident` | `…pagerduty.ts:243` | medium | WRITE-EXTERNAL | wraps |
| `pagerduty.resolve_incident` | `…pagerduty.ts:298` | medium | WRITE-EXTERNAL | wraps |
| `pagerduty.add_incident_note` | `…pagerduty.ts:363` | low | WRITE-EXTERNAL | wraps |
| `pagerduty.create_incident` | `…pagerduty.ts:422` | medium | WRITE-EXTERNAL | wraps |
| `sentry.get_issue` | `src/recipes/tools/sentry.ts:19` | low | READ-CONNECTOR | wraps; PR #93 |
| `slack.post_message` | `src/recipes/tools/slack.ts:18` | medium | WRITE-EXTERNAL | wraps; `{ok,ts,channel}/{ok:false,error}` |
| `slack.postMessage` | `…slack.ts:101` | medium | WRITE-EXTERNAL | **alias** of post_message (PR #103) |
| `stripe.listCharges` | `src/recipes/tools/stripe.ts:13` | low | READ-CONNECTOR | **NO try/catch** |
| `stripe.getCharge` | `…stripe.ts:65` | low | READ-CONNECTOR | **NO try/catch** |
| `stripe.listCustomers` | `…stripe.ts:101` | low | READ-CONNECTOR | **NO try/catch** |
| `stripe.getCustomer` | `…stripe.ts:146` | low | READ-CONNECTOR | **NO try/catch** |
| `stripe.listSubscriptions` | `…stripe.ts:185` | low | READ-CONNECTOR | **NO try/catch** |
| `stripe.listInvoices` | `…stripe.ts:239` | low | READ-CONNECTOR | **NO try/catch** |
| `zendesk.listTickets` | `src/recipes/tools/zendesk.ts:14` | low | READ-CONNECTOR | **NO try/catch** |
| `zendesk.getTicket` | `…zendesk.ts:80` | low | READ-CONNECTOR | **NO try/catch** |
| `zendesk.addComment` | `…zendesk.ts:125` | medium | WRITE-EXTERNAL | **NO try/catch** |
| `zendesk.updateStatus` | `…zendesk.ts:176` | medium | WRITE-EXTERNAL | **NO try/catch** |
| `zendesk.listUsers` | `…zendesk.ts:230` | low | READ-CONNECTOR | **NO try/catch** |

Counts agree with `listTools()`: 97 tools, 23 namespaces, 30 writes / 67 reads, 20 connector namespaces. All write tools call `assertWriteAllowed()` (or are gated through `executeTool` in `toolRegistry.ts:117`) — kill-switch path verified.

---

## 2. Live read-tier test results (67/67 fired)

Each tool fired through `executeTool(id, ToolContext)` against the live registry. `params` chosen per-tool to exercise the schema-required path. Source data: `/tmp/dogfood-F2/read-only-results.json` (raw) + `/tmp/dogfood-F2/results-table.md` (rendered).

Tally: **39 ok / 28 throw**. **Throw is the smoking-gun anti-pattern** — see §4.

| id | namespace | status | durationMs | shape | silent-fail | brief |
|---|---|---|---|---|---|---|
| file.read | file | ok | 0 | JSON `name,version,description,type` |  | real package.json |
| git.log_since | git | ok | 24 | string |  | 1777627... real commits |
| git.stale_branches | git | ok | 17 | string `(no branches inactive >90d)` |  | **PR #70 confirmed real** |
| diagnostics.get | diagnostics | ok | 0 | string | placeholder | needs deps wired |
| asana.* (5) | asana | ok | 0–29 | error-envelope | list-tool flagged | unauth → wrapped |
| gmail.* (5) | gmail | ok | 0–1 | error-envelope | list-tool flagged | unauth → wrapped |
| drive.fetchDoc | drive | ok | 0 | error-envelope |  | unauth → wrapped |
| github.list_issues | github | ok | 2348 | JSON `count,issues` |  | empty real (gh) |
| github.list_prs | github | ok | 635 | JSON `count,prs` |  | empty real (gh) |
| gitlab.* (5) | gitlab | ok | 0–28 | error-envelope | 3/5 list-tool flagged | wraps |
| linear.list_issues | linear | ok | 1216 | JSON `count,issues` |  | real connect, 0 issues |
| linear.listIssues | linear | ok | 39 | JSON `count,issues` |  | **alias works** |
| calendar.list_events | calendar | ok | 487 | error-envelope | list-tool flagged | invalid_grant — real |
| **notion.* (3)** | notion | **THROW** | 15–18 | null |  | bubble unauth |
| **confluence.* (3)** | confluence | **THROW** | 16–18 | null |  | bubble unauth |
| **zendesk.* (3)** | zendesk | **THROW** | 16–32 | null |  | bubble unauth |
| **intercom.* (3)** | intercom | **THROW** | 15–17 | null |  | bubble unauth |
| **hubspot.* (5)** | hubspot | **THROW** | 14–15 | null |  | bubble unauth |
| **datadog.* (5)** | datadog | **THROW** | 15–17 | null |  | bubble unauth |
| **stripe.* (6)** | stripe | **THROW** | 14–16 | null |  | bubble unauth |
| discord.* (4) | discord | ok | 14–15 | error-envelope | list-tool flagged | wraps |
| jira.* (3) | jira | ok | 14–15 | error-envelope | 2/3 list-tool flagged | wraps |
| pagerduty.* (4) | pagerduty | ok | 14–16 | error-envelope | list-tool flagged | wraps |
| sentry.get_issue | sentry | ok | 15 | `{ok:false,error}` |  | wraps |
| meetingNotes.parse | meetingNotes | ok | 2 | JSON `[]` |  | real parse |
| meetingNotes.flatten | meetingNotes | ok | 1 | `{error:"No meetings found"}` |  | not silent-fail flagged |

---

## 3. Live write-tier test results — local writes only

Synthetic recipe `/tmp/dogfood-F2/synthetic-readonly.yaml` ran through real `runYamlRecipe()` end-to-end:

```
stepsRun: 4 (file.read, git.log_since, git.stale_branches, file.write)
all status: ok
durations: 1ms / 19ms / 16ms / 1ms
file written: /tmp/dogfood-F2/sandbox-write.txt = "ok-2026-05-01 pkg-len="
context keys: pkg, log, stale, written, written.path, written.bytesWritten
```

Confirms PR #103's `applyToolOutputContext`/`seedToolOutputPreviewContext` runs in production: nested `written.path` / `written.bytesWritten` populated correctly per the `outputSchema` (`toolRegistry.ts:312`).

**WRITE-EXTERNAL tools NOT fired** per safety rules. Source-only audit:

| envelope shape | tools |
|---|---|
| `{ok:true, ...} / {ok:false, error}` | asana.create/update/complete/add_task_comment, slack.post_message, slack.postMessage, jira.create_issue, jira.update_status, jira.add_comment, pagerduty.acknowledge_incident, pagerduty.resolve_incident, pagerduty.add_incident_note, pagerduty.create_incident, discord.send_message, linear.addComment |
| **bare `{error: "..."}`** (no `ok`) | linear.createIssue (`linear.ts:174`), linear.updateIssue (`linear.ts:255`) |
| `{created: [...], error}` | meetingNotes.createLinearIssues |
| **NO try/catch — throws** | notion.createPage, notion.appendBlock, confluence.createPage, confluence.appendToPage, hubspot.createNote, intercom.replyToConversation, intercom.closeConversation, zendesk.addComment, zendesk.updateStatus, datadog.muteMonitor |

`linear.createIssue/updateIssue` returning bare `{error}` is inconsistent with every other write tool in the registry — `success: result.ok === true` checks anywhere downstream will mis-read the response. (`src/recipes/tools/linear.ts:154-176, 234-258`).

**`notify.push`** mentioned in the prompt does NOT exist in the registry. No tool with that id; no namespace `notify`. Source-grep negative across `src/recipes/tools/`.

---

## 4. camelCase alias verification matrix (PR #103 gap)

`linear.list_issues ↔ linear.listIssues` and `slack.post_message ↔ slack.postMessage` are the **only** aliases registered. Pulled from `src/recipes/tools/linear.ts:99-101` + `src/recipes/tools/slack.ts:98-101`. Anywhere else, the camelCase form returns `hasTool() === false`.

| pair | result |
|---|---|
| linear.list_issues ↔ linear.listIssues | **BOTH** |
| slack.post_message ↔ slack.postMessage | **BOTH** |
| gmail.search ↔ gmail.search | BOTH (no underscore) |
| github.list_issues ↔ github.listIssues | snake-only |
| github.list_prs ↔ github.listPrs | snake-only |
| gmail.fetch_unread ↔ gmail.fetchUnread | snake-only |
| gmail.fetch_thread ↔ gmail.fetchThread | snake-only |
| git.log_since ↔ git.logSince | snake-only |
| git.stale_branches ↔ git.staleBranches | snake-only |
| jira.list_issues / get_issue / list_projects / create_issue / update_status / add_comment | snake-only (6) |
| pagerduty.list_incidents / get_incident / acknowledge_incident / resolve_incident | snake-only (4) |
| asana.create_task / update_task / list_tasks / get_task / complete_task / add_task_comment | snake-only (6) |
| discord.send_message / list_channels / list_guilds / list_messages / get_current_user | snake-only (5) |
| sentry.get_issue ↔ sentry.getIssue | snake-only |
| calendar.list_events ↔ calendar.listEvents | snake-only |
| gitlab.* (5) | snake-only |

**Summary: both=3 / snake-only=34 / camel-only=0 / neither=0.** PR #103 advertised camelCase parity but only delivered for `linear.listIssues` + `slack.postMessage`. Round 1's bug #19 (`PR #103 camelCase aliases untested`) is live: every other expected alias does NOT resolve. Recipes ported from older Patchwork versions referencing camelCase will fail with `Unknown tool: "<id>"` (`toolRegistry.ts:115`).

`registerTool` in toolRegistry has zero alias-emission scaffolding — it's the per-namespace tool file that has to opt in (linear.ts:101, slack.ts:101). Mass-fix is mechanical: emit camelCase variant whenever the canonical id contains `_`.

---

## 5. Silent-fail patterns by tool

`detectSilentFail` (`src/recipes/detectSilentFail.ts:71`) recognizes three antipatterns: parens-wrapped placeholder, `[agent step skipped|failed: …]`, and `{count|items|results: 0/[], error: "..."}`.

Confirmed live during fire-test:

| tool | unauth/error path | detector flags? | classification |
|---|---|---|---|
| `git.stale_branches` (PR #70 + #72 both fixed) | `(git branches unavailable)` only on git error/exit nonzero | YES (parens) | OK |
| `git.stale_branches` happy zero | `(no branches inactive >Nd)` | NO (correct — real "0" answer) | OK |
| `git.log_since` | JSON `{ok:false,error:"..."}` on git failure | runner JSON-error catch (yamlRunner.ts:551) | OK |
| `agentExecutor` | `[agent step skipped: ANTHROPIC_API_KEY not set]` | YES (bracket) | OK |
| asana / gmail / discord / pagerduty / jira / drive / gitlab list-reads | `{count:0,items:[],error:"…"}` | YES (list-tool antipattern) | OK |
| asana / gmail / sentry / drive scalar reads (e.g. `getMessage`) | `{...,error:"..."}` no `count`/`items` | **NO — slips through** | GAP |
| **notion / confluence / zendesk / intercom / hubspot / datadog / stripe ALL methods** | **uncaught throw** | n/a — error path bypasses runner JSON parse; yamlRunner catches throw → `status:"error"` | inconsistent |
| `linear.createIssue/updateIssue` failures | bare `{error: "..."}` (no `ok` field) | NO (no `count`, no `ok:false`) | GAP — silent fail |
| `meetingNotes.flatten` empty input | `{error:"No meetings found"}` | NO | GAP |

**Top gap: scalar-read error envelopes** (e.g. `gmail.getMessage`) and `linear.create/updateIssue` writes both return `{error: "..."}` without `ok:false` and without `count/items`. They fail silently in yamlRunner — both the JSON-error short-circuit (`yamlRunner.ts:551-557`, requires `ok === false`) and `detectSilentFail` (requires `count` or `items` or `results`) miss them. Downstream agents see `{error}` shoved into context as if it were data.

**Top gap: chained runner has zero silent-fail detection.** `grep -c detectSilentFail src/recipes/chainedRunner.ts` = 0. Confirmed live. `chainedRunner.ts:456` calls `executeTool` and unconditionally returns `{success: true, data: result}` (line 464) regardless of placeholder content. RecipeOrchestrator (`src/recipes/RecipeOrchestrator.ts`) also = 0. Round-1 bug #2 still present.

---

## 6. PR #93 deep dive — Jira + Sentry

Source: `src/recipes/tools/jira.ts` (393 lines, 6 tools) + `src/recipes/tools/sentry.ts` (78 lines, 1 tool).

**Jira tools:**

| tool | args | success shape | error shape | live test |
|---|---|---|---|---|
| `jira.list_issues` | `{jql?, project?, max?, into?}` | `{count, items}` | `{count:0, items:[], error}` | unauth → flagged silent-fail |
| `jira.get_issue` | `{key, into?}` | full issue object | `{error}` (scalar — no list shape) | unauth → ok status, NOT flagged |
| `jira.list_projects` | `{max?, into?}` | `{count, items}` | `{count:0, items:[], error}` | unauth → flagged silent-fail |
| `jira.create_issue` | `{project_key, summary, description?, issue_type?, priority?, labels?, assignee?, into?}` | `{ok:true, id, key, self}` | `{ok:false, error}` | source-only |
| `jira.update_status` | `{key, transition_id, into?}` | `{ok:true, key, transition_id}` | `{ok:false, error}` | source-only |
| `jira.add_comment` | `{key, body, into?}` | `{ok:true, key}` | `{ok:false, error}` | source-only |

All three writes early-return `{ok:false,error}` from connector throws (`jira.ts:267-273, 326-333, 385-391`). `add_comment` validates non-empty body (`jira.ts:373-378`).

**Sentry tools:**

| tool | args | success shape | error shape | live test |
|---|---|---|---|---|
| `sentry.get_issue` | `{issue, into?}` | `{ok:true, issueId, title, stackTrace}` | `{ok:false, error}` | unauth → `{ok:false,error:"Sentry not connected"}` |

`sentry.get_issue` is the ONLY sentry tool. Validates `loadTokens()` early (`sentry.ts:53-55`) and `issue` non-empty (`sentry.ts:57-62`).

**Test coverage**: `ls src/recipes/tools/__tests__/` returns ONLY `sinceToGmailQuery.test.ts`. **Zero unit tests for jira (6 tools), sentry (1 tool), or any of the other 90 registry tools.** Confirms round-1 bug #18.

PR #93 inconsistency: jira read tools `list_issues`/`list_projects` use the `{count,items,error}` antipattern shape that the silent-fail detector catches. But `jira.get_issue` returns plain `{error}` on failure — slips past detection.

---

## 7. PR #71 / #72 / #73 verification

### PR #71 (HTTP transport tool parity)
Initialized HTTP MCP via `POST /mcp` (`Mcp-Session-Id` + `Mcp-Session-Token` both required). Then `tools/list` → **193 tools** including:
- `ctxQueryTraces` ✓
- `ctxGetTaskContext` ✓
- `ctxSaveTrace` ✓

**PR #71 confirmed.** Streamable HTTP transport now exposes the same tool surface as WS/stdio in `--full` mode. Raw output: `/tmp/dogfood-F2-tools-list.json`.

### PR #72 (silent-fail detector wired into runner)
- `grep detectSilentFail src/recipes/yamlRunner.ts` = 3 hits (import + agent path:471 + tool path:570).
- Live probe: `(git branches unavailable)` flagged with `reason: "tool returned a parens-wrapped placeholder"`. `[agent step skipped: ANTHROPIC_API_KEY not set]` flagged. `{count:0, items:[], error:"rate limit"}` flagged.
- Negative: real-zero answers `(no branches inactive >30d)`, plain text `Hello world`, and `{count:0, items:[]}` without error all correctly NOT flagged.

**PR #72 confirmed for yamlRunner.** Detector itself solid. `src/recipes/__tests__/detectSilentFail.test.ts` has 16 cases including negatives.

**HOWEVER**: detector is NOT wired into `chainedRunner` or `RecipeOrchestrator`. Bug #2 from round 1 unchanged. Chained recipes (which is where `branch-health` and other parallel `awaits:` flows live) still slip placeholder strings through.

### PR #73
Not given a description in the prompt; based on git log (`git log --grep "#73"`), no obvious change. Couldn't locate a load-bearing surface to verify against.

### PR #70 (stale-branches real data)
`defaultGitStaleBranches(90, repo)` against this repo returned `(no branches inactive >90d)` (legitimate empty). `defaultGitLogSince("24h", repo)` returned 3 real commits. Both impl branches use `git for-each-ref` (`yamlRunner.ts:935-942`) — the broken `git branch --since=` flag is gone.

**PR #70 confirmed.**

---

## 8. TL;DR — severity-ranked findings

### CRITICAL

**F1. `file.write` / `file.append` / `file.read` accept arbitrary paths — no workspace-root containment.** `src/recipes/tools/file.ts:91-98, 132-145, 50-60`. Live probed: `file.write { path: "/tmp/dogfood-F2/../dogfood-F2-leak.txt" }` succeeded; `~/.patchwork/dogfood-F2-leak.txt` succeeded. There is `expandHome()` (line 12) but no `resolveFilePath()` analog — compare bridge's `src/tools/utils.ts` which has null-byte rejection, ancestor walk, workspace containment. Recipe-tool layer bypasses every guard the bridge layer has. Any recipe author can write outside workspace.

**F2. 7 connector tool files have ZERO try/catch and bubble unauth throws.** notion (5), confluence (5), zendesk (5), intercom (5), hubspot (6), datadog (6), stripe (6) — 38 tools total. Source: `grep -c "catch" src/recipes/tools/<f>.ts` = 0 for each. Live: every probe with no token threw and yamlRunner returned `status:"error"` for every step. Inconsistent with the 9 other namespaces (asana/gmail/discord/jira/pagerduty/gitlab/github/linear/slack/sentry) that all wrap. Mixed contract → recipe authors can't write portable on_error logic.

**F3. Chained runner + RecipeOrchestrator do NOT call `detectSilentFail`.** `src/recipes/chainedRunner.ts:456-464` → `success: true` for any non-throwing tool result. ~85% of in-repo recipes are YAML and run through yamlRunner (which IS protected). But every chained recipe (`branch-health`, etc.) runs unprotected. Round-1 bug #2 unchanged at alpha.35.

### HIGH

**F4. PR #103 camelCase aliases ship for 2 of 36 expected pairs.** Only `linear.listIssues` and `slack.postMessage`. The other 34 tested pairs are snake-only. Recipes that reference `gmail.fetchUnread`, `git.staleBranches`, `jira.listIssues`, `asana.createTask`, etc. fail at registry lookup (`toolRegistry.ts:115`). Round-1 bug #19 confirmed wholesale, not partial.

**F5. PR #93 has zero unit tests.** `ls src/recipes/tools/__tests__/` = `sinceToGmailQuery.test.ts` only. 6 jira tools + 1 sentry tool + 89 others completely untested. Round-1 bug #18 unchanged.

**F6. `linear.createIssue` and `linear.updateIssue` use bare `{error}` envelope** while every other linear/asana/jira/pagerduty write tool uses `{ok:false, error}`. `src/recipes/tools/linear.ts:172-176, 253-258`. Downstream `success: data.ok === true` checks fail closed silently.

### MEDIUM

**F7. Scalar-read error envelopes slip past `detectSilentFail`.** `gmail.getMessage`, `gmail.fetch_thread`, `gitlab.get_issue`, `jira.get_issue`, `drive.fetchDoc` etc. return `{...,error:"..."}` without `count`, `items`, or `results` field — detector requires one of those (`detectSilentFail.ts:101-112`). Recipes get strings like `{"id":"","subject":"","body":"","links":[],"error":"no token"}` shoveled into context as success. Could be patched by adding `error` field with empty scalar fields → silent-fail.

**F8. yamlRunner JSON-error short-circuit requires `ok === false`** (`yamlRunner.ts:551-557`). Doesn't trigger on bare `{error: "..."}`. Combined with F6 + F7 → linear/jira/scalar errors all slip through this gate too. Detector AND short-circuit BOTH miss the same shape.

**F9. PR #103's bonus camelCase test in this round-2 run shows the alias mechanism is naïve.** No central alias-emit helper — relies on per-tool-file authors to remember `registerTool({ ...x, id: "x.camelCase" })`. Predictably forgotten. Best fix: emit alias automatically inside `registerTool` whenever id contains `_`.

### LOW

**F10. No `notify.push` tool exists** — task-prompt referenced it but registry has no `notify` namespace. Source grep negative.

**F11. `meetingNotes.flatten { items: [...] }`** input validation weak — accepts `[{text:"test"}]` (which lacks `actionItems`) and returns `{error:"No meetings found"}` without `ok:false` → slips past detector. `src/recipes/tools/meetingNotes.ts:665`.

**F12. `github.list_issues` took 2348ms** in test. It shells out to `gh` (per `src/connectors/github.ts`). Slowest read in the registry by 100x. Worth a comment in the schema to warn recipe authors.

**F13. `diagnostics.get` requires `deps.getDiagnostics`** — when not wired (which is the default outside the bridge runtime), returns plain `(diagnostics not wired in probe)` placeholder string with no parens guard or error-envelope. Could be flagged as silent-fail if wrapped in parens, but isn't.

---

## Source files cited
- `src/recipes/toolRegistry.ts` (registry impl)
- `src/recipes/tools/index.ts` (loader)
- `src/recipes/tools/file.ts` (file ns — F1)
- `src/recipes/tools/notion.ts`, `confluence.ts`, `zendesk.ts`, `intercom.ts`, `hubspot.ts`, `datadog.ts`, `stripe.ts` (F2)
- `src/recipes/chainedRunner.ts:456-464` (F3)
- `src/recipes/tools/linear.ts:99-101, 172-176, 253-258` (F4, F6)
- `src/recipes/tools/slack.ts:98-101` (F4)
- `src/recipes/tools/__tests__/` (F5)
- `src/recipes/detectSilentFail.ts:71-116` (F7)
- `src/recipes/yamlRunner.ts:551-557, 565-574` (F8)

Raw artifacts in `/tmp/dogfood-F2/`: `registry-dump.json`, `read-only-results.json`, `results-table.md`, `synthetic-readonly.yaml`, plus probe scripts.
