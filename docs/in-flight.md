# In-flight work ledger

Lightweight coordination doc for when more than one Claude Code session is
working in this repo at the same time (parallel chats, Cowork worktrees,
scheduled routines). Not enforced by tooling — a convention, not a gate.

## Why this exists

On 2026-06-30/07-01, two sessions independently built the exact same fix
(`github.search_issues` registration + `state`/`stateReason` plumbing for
the outcome-ingester) without knowing about each other. One session's
commit landed on the *other* session's active branch
(`fix/shim-workspace-aware-lock-discovery`), which had to be rescued by
branching the commit off and leaving that branch untouched rather than
force-moving it back — avoidable with five minutes of a shared ledger.

## Convention

Before starting non-trivial work (a new branch, a fix touching shared
subsystems like the worker-trust gate, the recipe runner, or the bridge
init/shim path), add a line here. Remove the line once the PR merges (or
mark it merged and delete on the next sweep).

Format: `- <date> <branch-or-PR> — <one-line scope> — <session/chat identity if known>`

## Active

## Recently closed (informal log, prune periodically)

- 2026-07-03 `feat/dashboard-inbox-mailclient` (#1083) — dashboard redesign page 3/7 (Inbox → "Mail client", mockup I-B): investigated `app/inbox/page.tsx` — the two-pane mail-client layout was already built in an earlier session (`.inbox-twopane`/list/reader panes, folder chips, provenance strip, 65ch markdown, Replay/Trace/Archive/Delete toolbar, mobile back app-bar). Only change: removed a dead unused `RecipeIcon` component. Spec: docs/plans/dashboard-redesign-2026-07-03.md item 3. — merged
- 2026-07-03 `feat/dashboard-recipe-dossier` (#1081) — dashboard redesign page 2/7 (Recipe detail → "Dossier", mockup D-A): `app/recipes/[...name]/` — sticky 280px identity rail (name/status/desc, Run now/Enable/Edit YAML, facts list, relation links, quiet danger zone at bottom) + content stack (doctor-first card, YAML "what it does", run history) via new `RailContext`. Killed the Overview/Edit/Plan tab bar in `layout.tsx`. Spec: docs/plans/dashboard-redesign-2026-07-03.md item 2. — merged

- 2026-07-03 `feat/dashboard-humane-w2-roster` (#1079) — humane-redesign W2: workers roster rows + per-worker drawer (compact row: avatar, status chip, 5-stop `RosterBar` + 🔒 limit; JourneyStepper/timeline/per-task/ramp-vs-gate relocated into the drawer) — merged
- 2026-07-03 `feat/dashboard-humane-w1-workers` (#1078) — dashboard humane-redesign slice W1 (workers Bands 1+2) + a small bridge change. BRIDGE: thread the filing `title` (already echoed by `github.create_issue`) through `PendingConfirmation` in `computePendingConfirmations` + `formatPendingConfirmations` (`src/workers/runWorkerShadow.ts`) so the review queue can show "Login test failing on main" not a bare URL — must be snapshotted into `../patchwork-multitenant/src/`. DASHBOARD (`app/workers/page.tsx`): Band 1 team header ("Your AI team — N workers" + a one-sentence triage "N need your review · M ready for a promotion" / "All good", plus the rubber-stamp check collapsed to a single amber sentence only-when-triggered, telemetry → details); Band 2 review queue humanized (title + worker + relative time, lifted `/outcomes/pending` fetch shared with the triage count); verdict history collapsed to a "Past verdicts (N · X real, Y not)" disclosure; replaced the local `expert` useState with the shared `useExpertMode`/`ExpertToggle`. WorkerCard roster + per-worker drawer is W2. Spec §4, §7. — build session

- 2026-07-03 `feat/dashboard-humane-r1-recipe-header` (#1077) — humane-redesign R1 recipe detail Bands 1+2: `StatusMedallion` status header (pure `lib/recipeStatus.ts` deriver) + plain schedule (`humanizeSchedule`) + Run now/**Pause**/`ExpertToggle`; conditional **Needs you** band (`haltPhrasing` + one grouped fix button); **Danger zone** fold ("Delete this recipe"); folded Doctor + What-If under details ("Check for problems" / "Preview what it would do"). Review-polish included. — merged
- 2026-07-02 `feat/dashboard-humane-s1-primitives` (#1076) — humane-redesign S1 shared primitives: `StatusMedallion`, `DotStrip`+`workedSentence`, `DetailsFold`/`ExpertToggle`/`useExpertMode` (localStorage-persisted, same-tab-synced), `lib/humanSchedule.ts`, `lib/haltPhrasing.ts`; 33 unit tests — merged
- 2026-07-02 `feat/workers-page-confirm-ux` (#1075) — dashboard `/workers` "speak-human" pass + trust-journey (stepper + "How it got here" history timeline + attention-first fleet sort); plain per-task record replacing the L0–L4 dial; page-level "Show details" toggle; confirm-loop polish — merged

- 2026-07-02 `feat/pending-outcomes-visibility` (#1074) — roadmap plan slice #4 (make the confirm queue visible): `computePendingConfirmations` join (runs × dispositions) in runWorkerShadow → `patchwork outcomes pending [--json]` + `GET /outcomes/pending` (new `pendingConfirmationsFn` dep) + an "Awaiting confirmation" one-click confirm/reject panel on dashboard `/workers` — merged

- 2026-07-02 `feat/outcomes-http-confirm-panel` (#1073) — roadmap plan slice #3 (outcomes over HTTP + confirm panel): bridge `GET/POST /outcomes` (Bearer-gated, `outcomeStoreFn` dep) + a one-click Confirm/Reject "Filed outcomes" card on dashboard `/workers`. NEVER a recipe step / MCP tool (self-confirm prohibition). Load-bearing fix: a single shared `resolveOutcomeLogDir()` so the outcome-log WRITE (CLI/ingester/POST) and the trust-replay READ (runWorkerShadow) agree on one file even under PATCHWORK_HOME — merged

- 2026-07-02 `fix/foldoutcome-junk-reorder` (#1072) — roadmap plan slice #2 (evidence-integrity bug, test-first): reorder `foldOutcome` (src/workers/shadowObserver.ts) so a human-REJECTED (junk) filing demotes the worker IMMEDIATELY (`good:false`) instead of being withheld until its 24h durability window elapses; junk-only short-circuit, confirmed/unknown still wait out the window (never widens); backtest inherits via the shared foldOutcome — merged
- 2026-07-02 `fix/runlog-vitest-testmode-guard` (#1071) — roadmap plan slice #1 (run-log hygiene): VITEST-aware `testMode` default in `runYamlRecipe` so a bare test run never appends synthetic rows to the operator's live `~/.patchwork/runs.jsonl` (also the de-facto trust store, rotates at 1MB). Guard test `runLogIsolation.test.ts` (temp HOME+USERPROFILE) + explicit `testMode:false` on the 4 persistence-asserting test files. Flat runner only. — merged
- 2026-07-02 `fix/dogfood-filing-var-defaults-and-decision-gate` (#1070) — unblock worker filing: (1) RecipeOrchestrator.fire merges trigger.vars/inputs defaults on every fire path (on_test_run runs no longer drop `repo`); (2) `when` guard evaluates the last token so an agent decision's prose ending in true/false gates correctly (yamlRunner + chainedRunner parity); extracts applyTriggerInputDefaults → src/recipes/triggerVars.ts — merged
- 2026-07-02 `feat/backtest-outcome-parity` (#1068) — thread OutcomeStore into backtestWorker via a shared foldOutcome helper so `patchwork workers backtest` labels outcomes exactly like `workers shadow` (junk→bad, unknown→withheld); refactors ingestRun onto the same helper — merged
- 2026-07-02 `fix/dependency-upkeep-ceiling-cap` (#1067) — cap dependency-upkeep-worker's autonomyCeiling 3→1 (neutralise the PR-path trust-by-neglect leak: vcs-remote had no outcome grader) pending a PR-outcome grader — merged
- 2026-07-02 `feat/outcomes-confirm-cli` (#1066) — `patchwork outcomes confirm|reject|list` verb (operator confirm-label loop) + outcome-ingester label-comment fix — merged
- 2026-07-02 `fix/test-guardian-ceiling-cap` (#1065) — cap test-guardian-worker's autonomyCeiling below the compensable auto-allow threshold pending real-world trust-signal validation — merged
- 2026-07-02 `fix/shadow-observer-unknown-not-durable` (#1064) — trust-by-neglect fix: unknown disposition withheld (not good:true) in WorkerShadowObserver.ingestRun — merged

- 2026-07-01 `feat/gate-decision-diff` (#1062) — Tier 2 legibility layer: `patchwork gate explain --diff` — merged
- 2026-07-01 `feat/gate-explain-cli` (#1061) — `patchwork gate explain <workerId> <classKey>` — read-only formatter over WorkerGateDecisionLog + `GET /gate/decisions` — merged
- 2026-07-01 `fix/outcome-ingester-search-issues` (#1053) — github.search_issues + state plumbing — merged
- 2026-07-01 `fix/bridge-mcp-init-stray-shim` (#1054) — pin --workspace on global MCP shim init — merged
- 2026-07-01 `fix/outcome-ingester-deterministic-classify` (#1055) — remove LLM judge from outcome classification — merged
- 2026-07-01 `fix/status-cli-workspace-aware-lock` (#1056) — patchwork status workspace-aware lock discovery — merged
- 2026-07-01 `fix/gmail-hard-halt-and-lock-discovery-tier1` (#1058) — gmail fetch/parse soft-fail + 4th tokenEfficiency lock-discovery instance — merged
- 2026-07-01 `fix/dashboard-trust-dial-not-owned` (#1059) — surface not-owned action classes in the dashboard trust dial — merged
- 2026-06-30/07-01 `dogfood/outcome-ingester-search-issues` — duplicate of #1053, discovered and deleted after confirming byte-identical content — the incident that prompted this doc
