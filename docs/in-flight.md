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

*(empty — add entries here as work starts)*

## Recently closed (informal log, prune periodically)

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
