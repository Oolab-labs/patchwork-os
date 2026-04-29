# Patchwork Recipe Inventory — Dogfood Audit

Survey of every recipe in `~/.patchwork/recipes/` (user installs) and `examples/recipes/` (bundled). Inspection only — nothing executed.

Tool registry source-of-truth: [src/recipes/tools/](../../src/recipes/tools/) (60 registered ids across 16 namespaces).

## 1. Recipe roster

### `~/.patchwork/recipes/` (user-installed)

| Name | Trigger | Steps | Tools | Agent | Safety |
|---|---|---|---|---|---|
| [ambient-journal](../../../../.patchwork/recipes/ambient-journal.yaml) | git_hook (post-commit) | 1 | `file.append` | no | WRITE-LOCAL |
| [branch-health](../../../../.patchwork/recipes/branch-health.yaml) | chained | 4 | `git.stale_branches`, `git.log_since`, `file.write` | yes | WRITE-LOCAL |
| [ctx-loop-test](../../../../.patchwork/recipes/ctx-loop-test.yaml) | manual | 3 | `git.log_since`, `file.write` (+ agent calls `ctxSaveTrace`/`ctxQueryTraces` via MCP) | yes | WRITE-LOCAL |
| [daily-status.json](../../../../.patchwork/recipes/daily-status.json) | manual | 1 (prompt) | none (raw shell via prompt) | yes | SAFE-READ |
| [daily-status.yaml](../../../../.patchwork/recipes/daily-status.yaml) | cron `0 8 * * *` | 4 | `git.log_since`, `file.read`, `file.write` | yes | WRITE-LOCAL |
| [debug-env](../../../../.patchwork/recipes/debug-env.yaml) | manual | 1 | `file.write` (to `/tmp`) | no | WRITE-LOCAL |
| [debug-flatten](../../../../.patchwork/recipes/debug-flatten.yaml) | manual | 5 | `gmail.search`, `gmail.resolveMeetingNotes`, `meetingNotes.parse`, `meetingNotes.flatten`, `file.write` | no | WRITE-LOCAL |
| [google-meet-debrief](../../../../.patchwork/recipes/google-meet-debrief.yaml) | manual | 7 | `gmail.search`, `gmail.resolveMeetingNotes`, `meetingNotes.parse`, `meetingNotes.createLinearIssues`, `meetingNotes.flatten`, `slack.post_message`, `notify.push` | no | WRITE-EXTERNAL |
| [greet.json](../../../../.patchwork/recipes/greet.json) | manual | 1 | none | yes | SAFE-READ |
| [lint-on-save](../../../../.patchwork/recipes/lint-on-save.yaml) | on_file_save | 2 | `diagnostics.get`, `file.append` | no | WRITE-LOCAL |
| [morning-brief-slack](../../../../.patchwork/recipes/morning-brief-slack.yaml) | cron `0 8 * * 1-5` | 5 | `github.list_prs`, `linear.list_issues`, `calendar.list_events`, `file.write`, `slack.post_message` | yes | WRITE-EXTERNAL |
| [morning-brief](../../../../.patchwork/recipes/morning-brief.yaml) | cron `0 8 * * 1-5` | 6 | `gmail.fetch_unread`, `git.log_since`, `github.list_issues`, `github.list_prs`, `linear.list_issues`, `file.write` | yes | WRITE-LOCAL |
| [my-test-recipe](../../../../.patchwork/recipes/my-test-recipe.yaml) | manual | 1 | `file.write` | no | WRITE-LOCAL |
| [stale-branches](../../../../.patchwork/recipes/stale-branches.yaml) | cron `0 9 * * MON` | 2 | `git.stale_branches`, `file.write` | no | WRITE-LOCAL |
| [test-recipe-local/local-noop](../../../../.patchwork/recipes/test-recipe-local/local-noop.yaml) | manual | 1 | none | yes | SAFE-READ |
| [triage-brief](../../../../.patchwork/recipes/triage-brief.yaml) | chained | 4 | `linear.list_issues`, `git.log_since`, `slack.post_message` | yes | WRITE-EXTERNAL |
| [watch-failing-tests](../../../../.patchwork/recipes/watch-failing-tests.yaml) | on_test_run (filter:failure) | 2 | `file.append` | yes | WRITE-LOCAL |

### `examples/recipes/` (bundled)

| Name | Trigger | Steps | Tools | Agent | Safety |
|---|---|---|---|---|---|
| [chained-followup-child](../../examples/recipes/chained-followup-child.yaml) | chained | 1 | none | yes | SAFE-READ |
| [chained-followup-demo](../../examples/recipes/chained-followup-demo.yaml) | chained | 4 | `inbox.fetch_threads`*, `notes.lookup_recent_context`*, sub-recipe call | yes | BROKEN-LIKELY |
| [google-meet-debrief-single](../../examples/recipes/google-meet-debrief-single.yaml) | manual | 3 | `gmail.getMessage`, `drive.fetchDoc`, `meetingNotes.parse` | yes | SAFE-READ |
| [google-meet-debrief](../../examples/recipes/google-meet-debrief.yaml) | manual | 7 | `gmail.search`, `gmail.resolveMeetingNotes`, `meetingNotes.parse`, `meetingNotes.createLinearIssues`, `meetingNotes.flatten`, `slack.post_message`, `notify.push`* | no | WRITE-EXTERNAL |
| [morning-inbox-triage](../../examples/recipes/morning-inbox-triage.yaml) | cron `30 4 * * *` | 7 | `inbox.fetch`*, `inbox.getThread`*, `inbox.draftReply`*, `inbox.archive`*, `dashboard.render`*, `notify.push`* | yes | BROKEN-LIKELY |

### `examples/recipes/starter-pack/` (bundled — vision/draft tier)

| Name | Trigger | Steps | Tools | Agent | Safety |
|---|---|---|---|---|---|
| [apology-drafter](../../examples/recipes/starter-pack/apology-drafter.yaml) | manual | 3 | `dashboard.render`* | yes | BROKEN-LIKELY |
| [awkward-message-rewriter](../../examples/recipes/starter-pack/awkward-message-rewriter.yaml) | manual | 3 | `dashboard.render`* | yes | BROKEN-LIKELY |
| [birthday-watcher](../../examples/recipes/starter-pack/birthday-watcher.yaml) | cron `0 8 * * *` | 4 | `contacts.upcomingDates`*, `inbox.search`*, `notes.search`*, `dashboard.render`* | yes | BROKEN-LIKELY |
| [calendar-defense](../../examples/recipes/starter-pack/calendar-defense.yaml) | cron `0 7 * * 1-5` | 4 | `calendar.list`*, `dashboard.render`* | yes | BROKEN-LIKELY |
| [compliment-archive](../../examples/recipes/starter-pack/compliment-archive.yaml) | event `inbox.new_message` | 3 | `file.append`, `log.info`* | yes | BROKEN-LIKELY |
| [decision-journal](../../examples/recipes/starter-pack/decision-journal.yaml) | manual | 3 | `file.write`, `scheduler.enqueue`* | yes | BROKEN-LIKELY |
| [disagreement-cooldown](../../examples/recipes/starter-pack/disagreement-cooldown.yaml) | event `inbox.draft_saved` | 5 | `queue.delay`*, `dashboard.render`* | yes | BROKEN-LIKELY |
| [errand-batcher](../../examples/recipes/starter-pack/errand-batcher.yaml) | cron `0 9 * * 6` | 3 | `notes.search`*, `inbox.search`*, `dashboard.render`* | yes | BROKEN-LIKELY |
| [evening-shutdown](../../examples/recipes/starter-pack/evening-shutdown.yaml) | cron `0 18 * * 1-5` | 5 | `calendar.list`*, `inbox.search`*, `file.append`, `system.setDND`* | yes | BROKEN-LIKELY |
| [gift-brain](../../examples/recipes/starter-pack/gift-brain.yaml) | cron `0 9 * * *` | 5 | `notes.search`*, `contacts.list`*, `file.merge_yaml`*, `contacts.upcomingDates`*, `notify.push`* | yes | BROKEN-LIKELY |
| [lost-thread-finder](../../examples/recipes/starter-pack/lost-thread-finder.yaml) | cron `0 17 * * 5` | 4 | `inbox.search`*, `inbox.getThread`*, `dashboard.render`* | yes | BROKEN-LIKELY |
| [meeting-prep](../../examples/recipes/starter-pack/meeting-prep.yaml) | event `calendar.upcoming` | 4 | `calendar.get`*, `inbox.search`*, `fetch.url`*, `notify.push`* | yes | BROKEN-LIKELY |
| [mood-tagger](../../examples/recipes/starter-pack/mood-tagger.yaml) | cron `0 10,14,20 * * *` | 2 | `notify.ask`*, `file.append` | no | BROKEN-LIKELY |
| [morning-brief (starter)](../../examples/recipes/starter-pack/morning-brief.yaml) | cron `0 6 * * 1-5` | 2 | `weather.today`*, `calendar.list`*, `inbox.search`*, `notes.last`*, `notify.push`* | yes | BROKEN-LIKELY |
| [quiet-hours-enforcer](../../examples/recipes/starter-pack/quiet-hours-enforcer.yaml) | event `notification.incoming` | 2 | `notify.push`*, `queue.append`* | yes | BROKEN-LIKELY |
| [reading-capture](../../examples/recipes/starter-pack/reading-capture.yaml) | event `inbox.new_message` | 3 | `file.append` | yes | BROKEN-LIKELY (trigger filter unsupported) |
| [receipt-logger](../../examples/recipes/starter-pack/receipt-logger.yaml) | event `inbox.new_message` | 4 | `file.append`, `notify.push`* | yes | BROKEN-LIKELY |
| [social-battery-planner](../../examples/recipes/starter-pack/social-battery-planner.yaml) | cron `0 19 * * 0` | 3 | `calendar.list`*, `dashboard.render`* | yes | BROKEN-LIKELY |
| [subscription-watchdog](../../examples/recipes/starter-pack/subscription-watchdog.yaml) | cron `0 10 1 * *` | 4 | `notes.search`*, `inbox.search`*, `dashboard.render`* | yes | BROKEN-LIKELY |
| [sunday-reset](../../examples/recipes/starter-pack/sunday-reset.yaml) | cron `0 18 * * 0` | 5 | `calendar.list`*, `inbox.search`*, `notes.list`*, `dashboard.render`* | yes | BROKEN-LIKELY |
| [travel-prep](../../examples/recipes/starter-pack/travel-prep.yaml) | event `calendar.upcoming` | 4 | `inbox.search`*, `calendar.get`*, `weather.forecast`*, `dashboard.render`* | yes | BROKEN-LIKELY |

`*` = tool not in `src/recipes/tools/` registry (see [§4](#4-anything-weird)).

## 2. Safety classification

### SAFE-READ (4)
Only read-only registered tools or pure-agent steps. No writes anywhere.
- `daily-status.json`, `greet.json`, `test-recipe-local/local-noop`, `chained-followup-child`
- `google-meet-debrief-single` (chain ends at `meetingNotes.parse` — no write/post step)

### WRITE-LOCAL (10)
Read tools + writes confined to `~/.patchwork/`, workspace, or `/tmp`.
- `ambient-journal`, `branch-health`, `ctx-loop-test`, `daily-status.yaml`, `debug-env`, `debug-flatten`, `lint-on-save`, `morning-brief`, `my-test-recipe`, `stale-branches`, `watch-failing-tests`

### WRITE-EXTERNAL (3) — DO NOT DOGFOOD WITHOUT APPROVAL
- `~/.patchwork/recipes/google-meet-debrief.yaml` — posts to Slack + creates Linear issues
- `~/.patchwork/recipes/morning-brief-slack.yaml` — posts to `all-massappealdesigns` daily 08:00
- `~/.patchwork/recipes/triage-brief.yaml` — posts to `all-massappealdesigns`
- `examples/recipes/google-meet-debrief.yaml` — same external footprint as the user copy

### BROKEN-LIKELY (21)
All starter-pack recipes plus `chained-followup-demo` and `morning-inbox-triage`. They reference unregistered tool namespaces that have no implementation under [src/recipes/tools/](../../src/recipes/tools/):

| Missing tool | Recipes |
|---|---|
| `inbox.*` (`fetch`, `fetch_threads`, `getThread`, `search`, `draftReply`, `archive`) | morning-inbox-triage, chained-followup-demo, birthday-watcher, errand-batcher, evening-shutdown, lost-thread-finder, meeting-prep, morning-brief (starter), receipt-logger, sunday-reset, subscription-watchdog, travel-prep |
| `notes.*` (`search`, `list`, `last`, `lookup_recent_context`) | gift-brain, errand-batcher, sunday-reset, subscription-watchdog, chained-followup-demo, morning-brief (starter) |
| `dashboard.render` | apology-drafter, awkward-message-rewriter, birthday-watcher, calendar-defense, disagreement-cooldown, errand-batcher, lost-thread-finder, social-battery-planner, subscription-watchdog, sunday-reset, travel-prep, morning-inbox-triage |
| `notify.push` / `notify.ask` | gift-brain, meeting-prep, mood-tagger, morning-brief (starter), quiet-hours-enforcer, receipt-logger, travel-prep, morning-inbox-triage, both google-meet-debrief copies |
| `contacts.*` (`upcomingDates`, `list`) | birthday-watcher, gift-brain |
| `calendar.list`, `calendar.get` | calendar-defense, evening-shutdown, social-battery-planner, sunday-reset, meeting-prep, travel-prep, morning-brief (starter). Registry has `calendar.list_events`, not `calendar.list`. |
| `weather.today`, `weather.forecast` | morning-brief (starter), travel-prep |
| `queue.delay`, `queue.append` | disagreement-cooldown, quiet-hours-enforcer |
| `scheduler.enqueue`, `system.setDND`, `log.info`, `file.merge_yaml`, `fetch.url` | decision-journal, evening-shutdown, compliment-archive, gift-brain, meeting-prep |

The starter-pack recipes are vision-tier sketches — they describe a future surface area, not a runnable surface. They should likely be moved to `examples/recipes/vision/` or annotated with a `# vision-only` banner so users don't try to install them.

Note: `git.stale_branches` was returning `(git branches unavailable)` per CLAUDE.md PR #70 context, but the registry entry is present and the implementation is delegated through `deps.gitStaleBranches`. Recipes using it (`branch-health`, `stale-branches`) classify as WRITE-LOCAL rather than BROKEN-LIKELY pending PR #70 landing.

## 3. Dogfood recommendations

Recipes I'd actually fire (SAFE-READ + WRITE-LOCAL only):

| Recipe | Rationale |
|---|---|
| `greet.json` | Sanity-check single-step agent recipe; zero side effects. |
| `test-recipe-local/local-noop` | Pure agent hello-world — confirms recipe loader + agent driver wiring. |
| `daily-status.json` | Plain prompt, no tools — validates agent-only recipe path. |
| `my-test-recipe` | Single `file.write` to inbox — confirms templating (`{{date}}` is intentionally absent here). |
| `ambient-journal` | post-commit hook → file.append to `~/.patchwork/journal/`. Good chained-trigger smoke test. |
| `lint-on-save` | on_file_save trigger → diagnostics + inbox append. Tests on-save hook glob filtering. |
| `stale-branches` | Cron → git.stale_branches → inbox file. Will dogfood the PR #70 fix. |
| `daily-status.yaml` | Cron + git.log_since + file.read (optional) + agent + file.write. Multi-step parity test. |
| `branch-health` | Chained trigger w/ 4 steps incl. parallel `awaits` — exercises chained DAG. |
| `morning-brief` | Heaviest read-only fan-out: gmail + git + github + linear + agent + local file. Best end-to-end SAFE-READ workhorse if connectors authed. |
| `watch-failing-tests` | on_test_run trigger → agent + file.append. Validates failure-filter automation hook. |
| `google-meet-debrief-single` (examples) | Manual, parses one Gmail message ID, no posting/issue creation. Safe meeting-notes pipeline test. |
| `ctx-loop-test` | Validates ctxSaveTrace/ctxQueryTraces round-trip — only run via Dashboard, NOT `patchwork recipe run` (per its own NOTE block). |
| `debug-env`, `debug-flatten` | Diagnostics only; both write to `/tmp`. Useful when triaging env-var or meeting-flatten regressions. |

Skip these without explicit user approval (WRITE-EXTERNAL):
- `morning-brief-slack` — posts to `all-massappealdesigns` (real channel).
- `triage-brief` — same channel.
- both `google-meet-debrief` recipes — create Linear issues + Slack post.

## 4. Anything weird

- **Hardcoded Slack channel ID in bundled example**: [examples/recipes/google-meet-debrief.yaml](../../examples/recipes/google-meet-debrief.yaml) lines 60-62 use literal `C0AUZEY8Y0Y` for all three team channels (Sales/Marketing/Engineering all routed to the same id). The user copy at `~/.patchwork/recipes/google-meet-debrief.yaml` correctly reads from env vars. Bundled example should be templated.
- **Bare channel name in user recipes**: `morning-brief-slack` and `triage-brief` post to `channel: all-massappealdesigns` literal. Hardcoded org/channel in user-owned files is fine, but if either is the canonical example, scrub before publishing.
- **`notify.push` used by user-installed recipe but not registered**: `~/.patchwork/recipes/google-meet-debrief.yaml` step `notify` calls `notify.push` — same gap as the bundled examples. Step will likely no-op or error. Consider stripping or replacing with a `file.append` to inbox.
- **`drive.fetchDoc` referenced but not declared as a step tool**: [google-meet-debrief-single.yaml](../../examples/recipes/google-meet-debrief-single.yaml) declares `tools: [drive.fetchDoc]` *under an agent step* — the agent is expected to call it. `drive.fetchDoc` IS in the registry, so this works only if the agent driver supports per-step tool grants. Worth confirming this code path is wired.
- **Cron at 04:30 UTC**: `morning-inbox-triage` at `30 4 * * *` is fine if user is in a -5 to -8 timezone, but on a UTC server it fires at 4:30am UTC. Sanity-check before scheduling.
- **`reading-capture` event filter syntax**: uses `from:` array of literal addresses on `inbox.new_message`. Even if `inbox.new_message` existed, the filter shape is undocumented in [src/recipes/tools/](../../src/recipes/tools/).
- **`{{YYYY-MM-DD}}` placeholder convention**: starter-pack uses `{{YYYY-MM-DD}}`, `{{ISO_NOW}}`, `{{YYYY-MM}}` — the runtime supports `{{date}}` and `{{time}}` (per `ambient-journal` and others). These won't substitute.
- **Mixed `output:` vs `into:`**: `branch-health` and `triage-brief` use `output: <name>` for step result naming; every other recipe uses `into:`. Both syntaxes appear to work but the inconsistency is confusing. Worth normalizing in a follow-up cleanup.
- **`risk` field used inconsistently**: bundled examples and starter-pack tag every step with `risk: low|medium|high`; user recipes mostly omit it. Either it's load-bearing for approvals (in which case the user recipes are unsafe by default) or it's documentation-only (in which case the bundled examples are noisy). Spec gap.
- **`maxConcurrency` / `maxDepth` only on chained recipes**: `branch-health`, `triage-brief`, `chained-followup-demo`, `chained-followup-child` set them; nothing else. Confirm defaults exist for the other trigger types.
- **`parallel:` block in starter-pack `morning-brief.yaml` and `travel-prep.yaml`**: this isn't the `awaits:`-based DAG used by `branch-health`/`triage-brief`. Two different parallelism dialects in one repo.
- **`apiVersion: patchwork.sh/v1` only on `my-test-recipe`**: every other recipe uses `version: 1.0.0` or no version field. Schema-version drift.
- **`branch:` step in `quiet-hours-enforcer`**: conditional branching syntax (`when:` / `otherwise:`) appears nowhere else in the corpus and isn't reflected in [src/recipes/tools/](../../src/recipes/tools/). Likely vision-only.
- **No `playwright/` recipes despite directory existing**: `examples/recipes/playwright/` is empty. Either drop the dir or land the recipes that explain why it's there.

## TL;DR

- 27 recipes total: **17 user-installed** (4 SAFE-READ, 10 WRITE-LOCAL, 3 WRITE-EXTERNAL), **5 examples**, **21 starter-pack** — most starter-pack recipes are BROKEN-LIKELY because they reference unregistered tool namespaces (`inbox.*`, `notes.*`, `dashboard.render`, `notify.*`, `weather.*`, `contacts.*`, etc.).
- Safe dogfood targets: `greet`, `local-noop`, `daily-status.*`, `ambient-journal`, `lint-on-save`, `stale-branches`, `branch-health`, `morning-brief`, `watch-failing-tests`, `google-meet-debrief-single`. Skip `morning-brief-slack`, `triage-brief`, and both `google-meet-debrief` recipes — they post to a real Slack channel.
- Highest-leverage cleanups: (a) move starter-pack to `examples/recipes/vision/` until tools land, (b) fix hardcoded channel id in bundled `google-meet-debrief.yaml`, (c) normalize `output:`/`into:` and `version`/`apiVersion` schema drift, (d) confirm `git.stale_branches` PR #70 is merged before relying on `branch-health`/`stale-branches` output.
