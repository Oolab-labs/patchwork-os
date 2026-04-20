# Changelog

All notable changes to claude-ide-bridge are documented here.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

---

## [Unreleased]

---

## [0.2.0-alpha.4] — 2026-04-20

### Added
- **`createLinearIssue` MCP tool** — write path for the Linear connector. Accepts `title`, `description`, `teamKey` (case-insensitive, defaults to first team), `priority` (0–4), and `labelNames` (resolved to Linear label IDs). Returns `identifier` + `url`. Linear connector now supports full read + write. 8 tests.
- **`sentry-to-linear` starter recipe** (`templates/recipes/sentry-to-linear.yaml`) — fetches a Sentry issue with git blame enrichment and creates a triage-ready Linear ticket in one agent step. Demonstrates the Sentry + Linear connector pair. Supports `SENTRY_ISSUE_ID`, `LINEAR_TEAM_KEY`, and `LINEAR_PRIORITY` vars.

### Fixed
- **Dashboard activity page**: when the noise filter (connection/grace events) hides all loaded events, now shows "N connection events hidden — click Show connection events to see them" instead of an empty table with no explanation.
- **Dashboard overview**: Extension "Disconnected" badge now shows a hover tooltip and "Not connected — see Settings" foot text instead of a bare red pill.

---

## [0.2.0-alpha.3] — 2026-04-20

### Added
- **Linear connector** — personal API key auth (no OAuth app required). Token stored at `~/.patchwork/tokens/linear.json`. HTTP routes: `POST /connections/linear/connect`, `POST /connections/linear/test`, `DELETE /connections/linear`. Dashboard connections page wired.
- **`fetchLinearIssue` MCP tool** — fetch a Linear issue by identifier (`LIN-42`), team-prefixed ID (`TEAM-123`), or full URL. Returns title, description, state, assignee, labels, priority, and team. 7 tests.
- **`ctxGetTaskContext` Linear integration** — `detectRefType` now recognises `LIN-42` / `TEAM-123` patterns and Linear URLs as `linear_issue` refs. Fetches and merges issue data into unified task context alongside GitHub + commit data. 5 new tests.
- **`linear.list_issues` recipe step** — `yamlRunner` supports `assignee`, `state`, `team`, `max` params. Morning-brief template updated with a Linear section.
- **Sentry connector** (`src/connectors/sentry.ts`) + **`fetchSentryIssue` MCP tool** — fetch a Sentry issue and enrich its stack trace with `git blame` to identify the suspect commit. `confidence` field: `high / medium / low`. 45s timeout.

### Fixed
- **Dashboard per-route page titles** — 14 Next.js route segment `layout.tsx` files added; each page now shows a specific title in the browser tab and PWA (e.g. "Activity — Patchwork OS"). `favicon.ico` added.
- **Dashboard `runs` page** — missing `key` props, task IDs now link to `/tasks`, dates replaced with relative timestamps.
- **Dashboard `recipes` page** — missing `key` prop on fragment list.
- **Automation policy deprecations** — `~/.claude/automation-policy.json` updated: `onPostCompact` → `onCompaction { phase: "post" }`, `onDiagnosticsError` → `onDiagnosticsStateChange { state: "error" }`, `onTestRun.onFailureOnly` → `filter: "failure"`.
- **`claudeDriver.ts`** — non-null assertion on `newFactory()` result replaced with explicit null check + throw.

### Changed
- `platform-docs.md` version header → `0.2.0-alpha.3 · 170+ tools · 4 connectors`. New Connectors reference section covering Gmail, GitHub, Sentry, and Linear.

---

## [2.43.0] — 2026-04-16

### Changed
- **Default tool mode flipped from slim → full.** `claude-ide-bridge` now starts with the full ~140-tool set by default (IDE + git + terminal + file ops + HTTP + GitHub). Prior default was slim (~60 IDE-exclusive tools), which required users to pass `--full` to access git/terminal/GitHub — friction reported by ~85% of users in the DX assessment.
- **`--slim` CLI flag added** (opt-out). Users who want the narrower IDE-only surface (LSP, debugger, editor state) pass `--slim` explicitly, or set `"fullMode": false` in `claude-ide-bridge.config.json`.
- **`--full` is now a no-op** retained for backward compatibility — any existing scripts passing `--full` continue to work unchanged.
- **Startup banner updated** (`src/bridge.ts:1322-1326`) to reflect the new default and show `--slim` opt-out hint when running slim.
- **README quickstart, slim/full section, key-flags table** updated. `documents/platform-docs.md` + `docs/*.md` references to "slim mode is default" remain stale — follow-up doc pass queued.

### Tests
- `slimMode.test.ts`: flipped default assertion; added `--slim` opt-out test; added `--full` no-op backward-compat test. Full suite 2852 green.

### Verification
- Roadmap assessment (`/Users/wesh/.claude/plans/make-a-plan-on-majestic-seal.md`) Phase A verified the shape-safety gate (`scripts/audit-shape-safety.mjs`) is active in CI and startup banner prints the lock file path clearly. Phase A's proposed tool removals (`getHoverAtCursor`, `getTypeSignature`, `navigateToSymbolByName`) aborted after full-repo grep revealed they have real callers in MCP prompts (`src/prompts.ts` `type-of`), headless LSP fallback (`src/tools/headless/lspFallback.ts`), documented capabilities (`documents/platform-docs.md`, `ARCHITECTURE.md`), and plugin examples. All three tools retained.

---

## [2.42.2] — 2026-04-16

### Fixed
- **`listClaudeTasks` / `getClaudeTaskStatus`**: automation-spawned tasks (sessionId `""`) were invisible to all Claude Code sessions. Both tools filtered strictly by caller session ID, so any session connecting after an automation hook fired returned "not found" even though the task was in memory and persisted to disk. Fix: include tasks with `sessionId === ""` in both tools' filter — session isolation for user-enqueued tasks is preserved. Root cause surfaced during self-healing demo testing.

### Added
- **`spawnWorkspace.waitForExtension`** — boolean flag; polls `/health` on the spawned bridge until `extensionConnected: true` before returning. Shares the existing `timeoutMs` budget; on handshake timeout the bridge is SIGTERM'd and the caller gets a specific timeout error distinguishing "no lock" from "extension never connected". Closes the "how do I know LSP is ready?" gap. (gap #2 of Spawn-a-Bridge roadmap)
- **`spawnWorkspace.codeServer`** — boolean flag; also spawns `code-server` against the workspace so the bundled VS Code extension can complete the handshake and make LSP available on the spawned bridge. Related flags: `codeServerPort` (default 8080), `codeServerBin` (default `code-server` on PATH). Implicitly enables `waitForExtension`. Missing binary → `code=code_server_missing` and the bridge we just spawned is cleaned up. (gap #1 of Spawn-a-Bridge roadmap)
- **`docs/spawn-a-bridge.md`** — usage guide for the new flags, prerequisites, and the remaining roadmap gaps.

### Tests
- **Stabilize sprint**: 33 new regression tests across four high-blast-radius surfaces from the v2.11→v2.42 week — shape-safety regressions for the v2.25.18–24 `proxy<T>` bugs (12), `mergeAutomationStates` parallel-merge edges (5), the `/launch-quick-task` HTTP boundary (10), and the `spawnWorkspace` flag additions (6). Net 2802 → 2835 tests, all green.

---

## [2.42.1] — 2026-04-16

### Fixed
- **CI gate**: `launchQuickTask` description shortened 319 → 99 chars to pass the 200-char `audit-lsp-tools` gate. Full behaviour documented in `documents/platform-docs.md` + `documents/headless-quickstart.md`.

---

## [2.42.0] — 2026-04-16

### Added
- **Headless parity CLI** — `start-task "<description>"`, `quick-task <preset>`, `continue-handoff`. Sidebar, CLI, and MCP clients now share one dispatch path. All subcommands support `--json`, `--port`, `--source`. Auth via bridge lock file token (same pattern as `notify`).
- **`launchQuickTask` MCP tool** — context-aware preset launcher. Composes `runClaudeTask` via in-process deps, enforces 5s bridge-global cooldown with source-tagged diagnostics, appends handoff context unless auto-snapshot. Presets: `fixErrors`, `refactorFile`, `addTests`, `explainCode`, `optimizePerf`, `runTests`, `resumeLastCancelled`.
- **`src/quickTaskPresets.ts`** — shared preset module; extension's `_buildPresets` now delegates. Copied into extension tree at esbuild time.
- **POST `/launch-quick-task`** HTTP endpoint — bearer auth, 200 ok / 429 cooldown / 503 when no session connected.
- **`McpTransport.invokeToolDirect()`** — public method for HTTP endpoints to dispatch tools without a full JSON-RPC session.
- **`ToolErrorCodes.COOLDOWN_ACTIVE`** — new tool-level error code.
- **`docs/perf-baseline.md`** — loopback p50/p95/p99 for 8 representative tool calls. All ≤ 1ms on M4 Max / 500 iterations. Anchor for future regression detection.

### Changed
- Extension bumped to v1.4.7 (Windsurf cache invalidation).

### Stats
- 141 tools; 2802 bridge tests / 191 files.

---

## [2.41.0] — 2026-04-16

### Added
- **4-track follow-up**: PBT expansion, `spawnWorkspace` tool, managed-agents docs, visual skills.

---

## [2.40.1] — 2026-04-16

### Fixed
- **FP interpreter**: parallel state merge correctness, retry re-execution semantics; interpreter doc cleanup.

---

## [2.40.0] — 2026-04-16

### Added
- **Functional Interpreter / Algebraic DSL (phases 1–4 complete)** — `src/fp/`: `AutomationProgram` ADT, `policyParser`, `executeAutomationPolicy`, `VsCodeBackend` / `TestBackend`. Extended `AutomationState` with 4 new fields + 6 new pure transition functions. All 20 automation hooks wired through the interpreter.

### Changed
- **`automation.ts`**: removed 2879 lines of imperative handler bodies — behaviour migrated wholesale into the interpreter.

### Stats
- 2761 bridge tests / 188 files.

---

## [2.39.0] — 2026-04-16

### Added
- **FP layer (Red Book) complete + audited** — `src/fp/` module with `ToolResult<T>`, `BridgeErrorCode`, `traverse`, `longPoll`, `ExtensionSnapshot`, `activityAnalytics`, `tokenBucket`, `automationUtils`, `automationState`, `commandDescription`, `brandedTypes`. 29 property-based tests (fast-check seed:42).

### Fixed
- `untrustedBlock` DoS (regex metachar → `split/join`).
- `HOOK_SUBJECT_KEY` typo (`onTaskRun` → `onTestRun`).
- `toClaudeTaskOutcome` missing `cancelReason` param.
- `batchLsp` outputSchema missing `required[]`.
- `traverse` dedup moved out of `result.ts` into `async.test.ts`.

---

## [2.38.0] — 2026-04-16

### Fixed (security + stability)
- **`sendPush`** uses `safeSend()` — backpressure-aware WS send.
- **Automation retry**: `setTimeout` tracked in `_retryTimeouts` Set; `destroy()` cancels.
- **`_drain`** infinite loop guard — skipped counter breaks oversized-task cycle.
- **`testTraceToSource`**: `coverageDir` now workspace-jailed.
- **`handoffNote`**: `CLAUDE_CONFIG_DIR` `path.resolve()` closes traversal window.
- **OAuth CIMD fetch**: disables redirects (`redirect:"error"`).

### Changed
- **`proxy<T>` fully eliminated** — all 7 call-sites migrated to `tryRequest` / `validatedRequest`; `proxy` method removed.
- **`listVSCodeCommands`** return type corrected (`{commands, total, capped}`).
- **Shape-safety allowlist** cleared — all migrations done; CI gate now enforces zero new `proxy` calls.

---

## [2.37.0] — 2026-04-15

### Added
- **Edit transactions** — `beginTransaction`, `stageEdit`, `commitTransaction`, `rollbackTransaction`.
- **Diagnostic workflows** — `testTraceToSource`, `explainDiagnostic`, `previewEdit`, `replaceBlock`, `refactorPreview`.
- **Coverage tracing** — `getCodeCoverage` + lcov/json-summary parsing.

### Performance
- **Token efficiency**: `outputSchema` stripped from wire schema in `tools/list`; parameter descriptions compressed ~50%.

### Fixed
- **`token-efficiency status`** subcommand: replaces session-scoped stats with `/health` + `tools/list` counts.

---

## [2.36.1] — 2026-04-15

### Fixed (post-release audit — 9 bugs)
- **H1**: `writePatchedClaudeMd` restores `.bak` on rename failure (previously lost data).
- **H2**: `patchClaudeMdImport` replaces **all** duplicate sentinels, not just the first.
- **H3**: marker-present case wraps marker inside sentinels so future updates work.
- **H4**: `handoffNote` parse errors no longer cached — retries from disk, logs the error.
- **H5**: tool bucket rate limit uses `-32004` (was `-32029`, inconsistent with global limiter).
- **M1**: `handleDelete` returns 409 when `tools/call` in-flight (was destroying live session).
- **M2**: `tools` with no subcommand exits `1`, not `0` (CI false-success fix).
- **L1**: `toolsSearch` tests restore stdout spy in `finally` (leak on throw).
- **L2**: `init-idempotency` test 8 asserts correct return value `"updated"`.

---

## [2.36.0] — 2026-04-15

### Added
- **`claude-ide-bridge tools search <query>` / `tools list`** — offline CLI, no bridge required. `--json` flag, 11 categories, 160 tools indexed.
- **`docs/protocol-spec.md`** — 575-line developer reference: 3 transports, MCP handshake, extension handshake, error codes, rate limiting, slim/full modes, OAuth, curl quick-start.
- **`init` idempotency** — version-stamped CLAUDE.md blocks with 5 state transitions (`already-current` / `updated` / `patched` / `already-present` / `no-section`). Re-running `init` after upgrade now updates stale content cleanly.

### Fixed
- **`writePatchedClaudeMd`** race window — removed `unlinkSync` before `wx` write.
- **`patchClaudeMdImport`** no longer drops user content under the bridge marker.
- **`tools --json list`** flag-before-subcommand now parses correctly.
- **CLAUDE.md idle TTL** corrected `10min → 2hr`; protocol spec `-32029` named.

### Stats
- 15 new tests; 2462 bridge tests total.

---

## [2.35.1] — 2026-04-15

### Changed
- **`handoffNote`** — 30s in-memory read cache (pre-computed paths at factory time; cache hits avoid repeated sha256/disk reads for automation hooks).
- **`AnalyticsViewProvider`** — takes `ExtensionContext` as 5th arg (needed for `workspaceState` pin persistence).
- **Extension** bumped to v1.4.5.

### Added
- `.gitignore` ignores `session-*.md` export files.

---

## [2.35.0] — 2026-04-15

### Added
- **`getPerformanceReport`** tool (slim mode) — health score 0–100, p50/p95/p99 per-tool latency, windowed throughput, connectionQuality rating.
- **`ActivityLog`**: `windowedStats(windowMs)`, `recordRateLimitRejection()`, extended `toPrometheus()` with percentile metrics.
- **Transport**: `recordRateLimitRejection()` on `-32004` rejections.
- **Dashboard**: Health Score card + Top Tool p95 latency card.
- **Analytics sidebar**: MCP session `DELETE` cleanup, SSE last-data-line fix, auto-snapshot detection, Output button for all tasks, `taskOutput` overlay, health badge + latency table, blue active / grey cancelled badges.

### Fixed
- **`claudeOrchestrator`**: pending-cancel output, unconditional abort output.
- **`getAnalyticsReport`**: include `output` / `errorMessage` in task mapping (2000-char cap).

### Changed
- Extension bumped to v1.4.4. CLAUDE.md: always bump version before packaging `.vsix`.

---

## [2.34.0] — 2026-04-14

### Added
- **Live analytics endpoint** — authenticated `GET /analytics`. `analyticsFn` wired from `activityLog.stats()` + orchestrator task list.
- **Periodic snapshot** — `_buildSnapshotSummary()` captures real extension state, diagnostics, top tools; 5-min timer with `unref()`.

### Changed
- **Extension analytics panel**: replaced hardcoded stub with real HTTP fetch to `/analytics`. 512 KB body cap + in-flight guard. Full UX rewrite: active tasks section, handoff preview (2-line), 5 real quick-task presets in 2-col grid, collapsible recent tasks + stats, live "updated Xs ago" counter (15s refresh).

### Fixed
- **`hooksLast24h`** counts `isAutomationTask` tasks, not lifecycle events.
- **`memoryGraphQueries`**: `description` → `hint` (CI audit gate fix).

---

## [2.33.0] — 2026-04-14

### Added (polish features F1–F11)
- **F1**: live status bar — context age, debug flash, pre-compact armed state.
- **F2**: `init` success message + auto-open docs.
- **F3**: automation `when.testRunnerLastStatus` `"any"` branch.
- **F4**: marketplace stars column.
- **F5**: update-check on bridge start.
- **F6**: Levenshtein "did you mean?" for unknown CLI flags.
- **F7**: `expectType()` helper replaces 19 inline throws in `automation.ts`.
- **F8**: `getBridgeStatus` exposes `automationPolicyPath` + `lastHookFiredAt`.
- **F9**: `getProjectContext` tracks `topModulesSource` / `ctagsStatus` + `onCacheUpdated` callback.
- **F10**: `auditDependencies` progress start/end messages.
- **F11**: VS Code walkthrough onboarding contribution.

### Fixed (workspace-escape hardening)
- 8 tool descriptions now scope to workspace; `resolveFilePath` error hints native Read tool.
- Automation-policy prompts tightened.

---

## [2.32.0] — 2026-04-13

### Added (token efficiency)
- **Phase 1+4+5+6a**: `cache_control`, summarize, `getSessionUsage`, lower default limits.
- **Phase 2+6b**: `searchTools` + LSP verbosity controls.

### Fixed
- Extension tests: added `registerWebviewViewProvider` to vscode mock.

---

## [2.31.0] — 2026-04-13

### Added
- **Analytics sidebar**: Start Task button (context-injected Claude task), recent tasks + Resume buttons, quick-task presets, Continue from handoff.
- **`getAnalyticsReport`** tool.
- **Ant CLI support** — `useAnt: true` on `runClaudeTask`.
- **Automation**: `onDebugSessionStart`, `onPreCompact` hooks; `getProjectContext` tool.

### Changed
- Documentation rewrite (removed ICPs.md + cowork-workflow.md; fixed broken refs).
- Extension bumped to v1.4.0.

### Fixed
- Shim passive-mode `waitFor` timeout 10s → 20s (flaky on slow CI).
- CI: build before test in `publish-npm` workflow (init.test.ts needs `dist/`).

---

## [2.30.0] — 2026-04-14

### Added
- **`getSymbolHistory`** — composite tool: LSP `goToDefinition` → `git blame --porcelain` on definition site → `git log --follow` on definition file. Answers "who last touched this?" and "why does it exist?" Decodes `file://` URIs; falls back to query-site blame when LSP unavailable. 9 tests.
- **`findRelatedTests`** — composite tool: finds test files covering a source file via name-pattern search (`*.test.*`, `*.spec.*`) and ripgrep import-reference scan. Optionally cross-references `coverage-summary.json` for per-file coverage %. Returns `memoryGraphHint` for codebase-memory graph traversal. 9 tests.
- **`screenshotAndAnnotate`** — composite tool: derives dev-server URL from `package.json` scripts (vite→5173, next/react-scripts→3000, or explicit `--port`), fans out diagnostics + `git diff` in parallel, returns `playwrightSteps[]` action plan + `ideState`. Follows query-plan pattern — guides Playwright MCP, doesn't call it directly. 14 tests.
- **`getArchitectureContext`** — composite tool: structured codebase-memory query plan for architecture aspects (modules, dependencies, ADRs, hotspots, god-objects). Accepts `aspects[]` filter and `maxNodes`.
- **`review-changes` MCP prompt** — composes `getGitDiff` + `getDiagnostics` + `getGitHotspots` into a one-line review workflow with commit message suggestion.
- **`explainSymbol` `useMemoryGraph` param** — opt-in flag; adds `memoryGraph` guidance to response for codebase-memory `search_graph` traversal.
- **4 additional companions** in `install` command: `@modelcontextprotocol/server-postgres`, `@modelcontextprotocol/server-slack`, `@playwright/mcp`, `codebase-memory-mcp`. `--env` flag for env var injection.

### Fixed
- **Dashboard `extensionConnected` bug** — `GET /dashboard/data` returned `health.extension` (`undefined`); corrected to `health.extensionConnected`.
- **`runCommand` outputSchema** — added optional truncation fields (`truncated`, `stdoutTruncated`, `stderrTruncated`, `maxBytes`, `note`); previously caused validation failures on truncated output.
- **`handoffNote` outputSchema** — added optional `message` field; validation failed when `setHandoffNote` returned a message.
- **`jumpToFirstError` error suppression** — empty catch replaced with `console.warn` so decoration failures are visible in logs.
- **`openFile` spawn error logging** — `child.on("error")` now logs spawn errors; removed misleading `CLAUDE_IDE_BRIDGE_EDITOR` env hint.

### Stats
- 137 tools (↑ from 133); ~2282 bridge tests

---

## [2.12.0] — 2026-04-09

### Added
- **12 new LSP-composition MCP slash commands** — all compose existing LSP primitives (zero new bridge tools):
  - `/mcp__bridge__find-callers` — list all callers of a symbol via call hierarchy + references
  - `/mcp__bridge__blast-radius` — compute change impact at a position (risk badge + reference counts)
  - `/mcp__bridge__why-error` — explain a diagnostic in plain English with type context
  - `/mcp__bridge__unused-in` — find dead exports and unused code in a file
  - `/mcp__bridge__trace-to` — trace outgoing call chain from a symbol with type signatures
  - `/mcp__bridge__imports-of` — list every file that imports a symbol with reference counts
  - `/mcp__bridge__circular-deps` — detect circular import cycles workspace-wide
  - `/mcp__bridge__refactor-preview` — preview rename edits + blast-radius risk before committing
  - `/mcp__bridge__module-exports` — list a file's exported symbols with type signatures
  - `/mcp__bridge__type-of` — get the type signature at a cursor position
  - `/mcp__bridge__deprecations` — find `@deprecated` APIs workspace-wide and count callers
  - `/mcp__bridge__coverage-gap` — list untested functions by correlating coverage with document symbols
- **3 new plugin skills** (in `claude-ide-bridge-plugin`):
  - `ide-dead-code-hunter` — unused exports + dead functions with LSP cross-verification
  - `ide-type-mismatch-fix` — diagnose and optionally fix type errors using diagnostics + code actions
  - `ide-api-deprecation-tracker` — audit `@deprecated` APIs ranked by caller count with migration paths
- **`ide-architect` subagent** — architectural health audit: God objects, circular deps, coupling analysis, modularization opportunities
- **`templates/automation-policy.example.json`** — LSP-aware default automation hook prompts for `onFileChanged`, `onBranchCheckout`, `onGitCommit`, `onGitPush`, `onPullRequest`, `onTestRun`, `onPostCompact`, `onDiagnosticsError`
- Prompt count: 15 → **27** total MCP slash commands

---

## [2.11.23] — 2026-04-09

### Added
- **`onGitCommit` automation hook** — fires after every successful `gitCommit` tool call. Placeholders: `{{hash}}`, `{{branch}}`, `{{message}}`, `{{count}}`, `{{files}}`. Loop guard prevents re-triggering from tasks spawned by the hook itself. Cooldown min 5s.
- **`onGitPush` automation hook** — fires after every successful `gitPush` tool call. Placeholders: `{{remote}}`, `{{branch}}`, `{{hash}}`. Cooldown min 5s.
- **`onBranchCheckout` automation hook** — fires after every successful `gitCheckout` tool call. Placeholders: `{{branch}}`, `{{previousBranch}}`, `{{created}}`. Cooldown min 5s.
- **`onPullRequest` automation hook** — fires after every successful `githubCreatePR` tool call. Placeholders: `{{url}}`, `{{number}}`, `{{title}}`, `{{branch}}`. `{{title}}` is nonce-wrapped (prompt injection defense). Cooldown min 5s.
- **`previewCodeAction` LSP tool** — shows exact text edits a code action would make without applying them. Safe to call before `applyCodeAction`. Included in slim mode (50 slim tools total).
- **`bridgeDoctor` tool** — comprehensive environment health check: extension connection, git, TypeScript, linter, test runner, lock file, node_modules, GitHub CLI. Returns per-check status and actionable suggestions.
- **outputSchema + structuredContent** on all 29 LSP tools — structured output now enforced by CI audit script (`audit-lsp-tools.mjs`, 5 checks).
- **SSE event IDs** on Streamable HTTP — monotonic event IDs + replay buffer (cap 100, TTL 30s) for `Last-Event-ID` reconnect resumability.
- **Windowed circuit breaker** — opens only after ≥3 extension timeouts in 30s window (previously tripped on any single failure).
- **RTT tracking** — `getBridgeStatus` now includes `latencyMs` and `connectionQuality` (`healthy`/`degraded`/`poor`).

### Fixed
- **`bridge.ts` shutdown exit code** — force-terminate timer now uses `exitCode` from signal handler instead of hardcoded `1`. Correct exit code propagated on SIGTERM/SIGINT.
- **`connection.ts` 401 auto-recovery** — on auth token mismatch, the extension now clears the stale cached token and resets reconnect delay/attempts rather than showing a "Reload Window" modal. Recovery is automatic on the next reconnect cycle.

### Changed
- Slim mode tool count: 49 → **50** (`previewCodeAction` promoted to slim, `bridgeDoctor` added).
- All automation hook prompt injection: untrusted placeholders (`{{title}}`, `{{files}}`, `{{message}}`, `{{branch}}`, `{{previousBranch}}`, `{{remote}}`) are nonce-wrapped with per-trigger delimiters.
- Documentation overhaul: phantom snapshot tools removed from `platform-docs.md` and `use-cases.md`; all tool counts updated to 136+/50 slim; `troubleshooting.md` expanded with Issues 8–10; `vscode-extension/README.md` version corrected to 1.0.20.

---

## [2.11.2] — 2026-04-04

### Added
- **`src/instructionsUtils.ts`** — new shared module exporting `buildEnforcementBlock()`. Both `bridge.ts` and `orchestratorBridge.ts` now call it instead of maintaining separate copies of the enforcement text, eliminating silent drift between the two.
- **`@import` auto-patch on existing installs** — `gen-claude-md --write` and `init` now detect when a CLAUDE.md already contains the `## Claude IDE Bridge` section but is missing the `@import .claude/rules/bridge-tools.md` line (users who installed before v2.11.0). The line is inserted automatically; the original file is backed up with a timestamp suffix.
- **Corrupted `bridge-tools.md` repair** — both write paths now validate file content via `isBridgeToolsFileValid()` (checks for `runTests` and `getDiagnostics`) rather than checking existence only. Zero-byte, truncated, or corrupted files are replaced and logged as `[repair]`.
- **EACCES warning on rules file write** — if `.claude/rules/bridge-tools.md` cannot be written due to a permissions error, a `[warn]` message is emitted with remediation instructions instead of crashing. All other write errors are similarly caught and logged.
- **Scheduled-tasks nudge in `init` output** — the "Next steps" block now includes an optional step with the `cp` command for activating scheduled-task templates, gated on the templates directory being present.
- **10 new tests** — `src/__tests__/instructionsUtils.test.ts` (4 unit tests for `buildEnforcementBlock`); expanded `src/__tests__/init.test.ts` covers `@import` patch, idempotency with `@import` present, corrupted/zero-byte repair, and valid-file preservation.

---

## [2.11.1] — 2026-04-04

### Added
- **Session-start tool enforcement via MCP instructions** — `buildInstructions()` in both `bridge.ts` and `orchestratorBridge.ts` now appends a `BRIDGE TOOL ENFORCEMENT` block to the MCP initialize response. Every Claude session receives an active reminder to use bridge MCP tools instead of shell commands — zero configuration required.
- **Plugin hook reminders** — `session-info.sh` (SessionStart) and `instructions-loaded.sh` (InstructionsLoaded) append a tool enforcement reminder to their status messages for users with the Claude Code plugin loaded.
- **`orient` prompt reads template at runtime** — the `orient-project` Phase 3c bridge-tools content is now loaded from `templates/bridge-tools.md` at module initialization, eliminating a static inline copy that would drift from the template on future edits.
- **Integration tests for `init` and `gen-claude-md`** — 6 new tests covering file placement, idempotency, ENOENT fix, and dry-run output.

### Changed
- **`gen-claude-md` dry-run note** — running without `--write` now prints a stderr notice explaining that `--write` will also create `.claude/rules/bridge-tools.md`.

---

## [2.11.0] — 2026-04-04

### Added
- **Mandatory bridge tool rules** — `claude-ide-bridge init` and `gen-claude-md --write` now write `.claude/rules/bridge-tools.md` to the workspace. This scoped rules file contains a mandatory substitution table directing Claude to call MCP tools (`runTests`, `getDiagnostics`, `gitCommit`, `searchWorkspace`, etc.) instead of shell equivalents (`npm test`, `tsc`, `git commit`, `grep`) whenever the bridge is connected.
- **`@import` in CLAUDE.bridge.md template** — the bridge section of CLAUDE.md now auto-loads the rules file via `@import .claude/rules/bridge-tools.md`, ensuring the substitution table applies in every session without manual setup.
- **`orient` prompt includes bridge-tools.md** — the `orient-project` MCP prompt's Phase 3c scaffolding now creates `.claude/rules/bridge-tools.md` (skipping if already present from `init`), closing the gap for users who onboard via the prompt rather than the CLI.

### Fixed
- **`init` workspace creation ordering** — `mkdirSync` is now called before `writeFileSync` for the CLAUDE.md temp file, preventing an `ENOENT` crash when `init --workspace` points to a directory that does not yet exist.

---

## [2.10.0] — 2026-04-04

### Added
- **LSP readiness signal** — The VS Code extension now notifies the bridge when a language server finishes indexing via a new `extension/lspReady { languageId, timestamp }` notification. The bridge tracks ready language IDs per session (`ExtensionClient.lspReadyLanguages`) and `lspWithRetry` skips the 4s + 8s cold-start retry delays for known-ready languages, returning `"timeout"` immediately instead. Detection uses `onDidChangeDiagnostics` — first diagnostic per language ID signals readiness. A 30s fallback timer fires for error-free workspaces. Fully backwards-compatible: old extensions keep the existing 3-attempt retry behavior unchanged.

### Changed
- **Extension v1.0.19** — ships `lspReadiness.ts` tracker; `extension/lspReady` added to `BUFFERABLE_METHODS` so it survives transient disconnects; re-sends all ready states on reconnect.

---

## [2.9.0] — 2026-04-03

### Added
- **`_meta["anthropic/maxResultSizeChars"]` on large-result tools** — 14 tools that return potentially large outputs (file contents, git diffs, search results, dependency trees, diagnostics, security advisories, etc.) now annotate their content blocks with `_meta["anthropic/maxResultSizeChars"]: 500000`. This tells Claude Code (v2.1.91+) to persist up to 500K chars instead of silently truncating large results. New helpers `successLarge()` and `successStructuredLarge()` in `src/tools/utils.ts`.
- **CIMD support in OAuth authorize endpoint (SEP-991 / Claude Code v2.1.81+)** — When `client_id` is an HTTPS URL, the `/oauth/authorize` endpoint now fetches the Client ID Metadata Document at that URL to obtain `redirect_uris` dynamically, without requiring pre-registration via `/oauth/register`. Results are cached for 5 minutes. SSRF protection: private/loopback addresses blocked, response capped at 8KB, 5s timeout.
- **6 tools promoted to slim mode** — `selectionRanges`, `foldingRanges`, `refactorExtractFunction`, `getImportTree`, `setEditorDecorations`, `clearEditorDecorations` added to `SLIM_TOOL_NAMES`. Previously only available in `--full` mode, making LSP refactor, onboarding, and code-review workflows non-functional in default deployments.
- **LSP workflow guide in CLAUDE.md** — Five concrete tool sequences (add tool, code review, refactor, debug, onboard) with correct parameter names and quick-reference table. Replaces the single "Code Review with Decorations" section.

---

## [2.6.3] — 2026-03-28

### Added
- **Jujutsu (`.jj`) and Sapling (`.sl`) VCS exclusions** — `getFileTree` and `findFiles` now skip `.jj` and `.sl` directories alongside `.git`, preventing descent into VCS internals for repos using these newer version control systems.
- **`X-Claude-Code-Session-Id` header correlation** — HTTP sessions (Streamable HTTP transport) now read the `X-Claude-Code-Session-Id` header sent by Claude Code 2.1.86+. The value is stored on the session and propagated to the transport's tool-call spans as `claude.session.id`, so proxy logs and bridge logs can be correlated by session without parsing request bodies.
- **Automation policy summary in `getBridgeStatus`** — When automation is enabled, `getBridgeStatus` now includes an `automation` field reporting the enabled/disabled state of `onPostCompact`, `onDiagnosticsError`, and `onFileSave` hooks. For `onPostCompact` the configured `cooldownMs` is also surfaced, useful for diagnosing unexpected compaction behavior given Claude Code's new configurable `autoCompactThreshold`.

---

## [2.6.1] — 2026-03-26

### Added
- **`shim` subcommand** — `claude-ide-bridge shim` is an stdio relay that auto-discovers the running bridge or orchestrator via lock file and connects Claude Code to it. Replaces the hardcoded path to `scripts/mcp-stdio-shim.cjs`. Add once to `~/.claude.json` and bridge tools are available in every `claude` session regardless of working directory:
  ```json
  { "mcpServers": { "claude-ide-bridge": { "command": "claude-ide-bridge", "args": ["shim"] } } }
  ```

### Changed
- **`init` subcommand** — Now automatically registers the `claude-ide-bridge shim` MCP server in `~/.claude.json` as step 3. After running `init`, bridge tools are available in all `claude` sessions without any manual config.

### Fixed
- **Orchestrator 0-tools bug** — When a child bridge responded to `/ping` but `listTools()` returned empty (HTTP session init failed silently), the bridge was incorrectly marked healthy with 0 tools, causing the orchestrator to expose no proxied tools to Claude. The bridge now stays in the warming state and retries on the next health cycle.

---

## [2.6.0] — 2026-03-25

### Breaking Change
- **Slim mode is now the default** — The bridge registers 27 IDE-exclusive tools by default instead of all ~95. Pass `--full` to restore git, terminal, file ops, HTTP, and GitHub tools. Plugin tools always bypass the slim filter. Existing users who rely on git/terminal/file tools via the bridge must add `--full` to their startup command (or in `start-all.sh`).

### Added
- **`init` subcommand** — One-command setup: auto-detects editor, installs the VS Code extension, writes/appends to `CLAUDE.md`, and prints numbered next steps. Replaces the 4-step manual Quick Start.
- **`SLIM_TOOL_NAMES` export** — `Set<string>` of the 27 slim tools exported from `src/tools/index.ts` for introspection and testing.
- **`--full` flag** — Opt-in to register all ~95 tools (git, terminal, file ops, HTTP, GitHub).
- **`start-all.sh --full`** — Passthrough flag; also prints a prominent slim mode warning in pane 0 when running without `--full`.
- **Startup banner** — Now prints tool mode (slim/full) with `--full` hint when in slim mode.
- **9 new tests** in `src/tools/__tests__/slimMode.test.ts` covering `SLIM_TOOL_NAMES` invariants, `parseConfig --full`, registration filtering, and plugin bypass.

### Changed
- **README Quick Start** — Reduced from 4 manual steps to 3 lines using `init`.
- **README MCP Tools section** — Replaced 70-line wall-of-text with two-table slim/full layout.
- **Multi-IDE Orchestrator section** — Added "when to use" gate (50k+ lines) and "where not worth it" guidance.
- **ICPs.md** — Added Persona 6: Multi-IDE Orchestrator User.
- **`package.json` repository URL** — Normalized to `git+https://...git` form.

---

## [2.5.17] — 2026-03-25

### Changed
- **`switchWorkspace` response** — Now reports the `wsN` alias (`Active workspace: ws1 — /path (IDE)`) so Claude knows which alias prefix corresponds to the active bridge. Disambiguation message condensed; error messages use tighter phrasing.
- **`getOrchestratorStatus` output** — Replaced pretty-printed JSON blob with a compact line-oriented format (`sessions=N`, `[healthy]`/`[warming]`/`[unhealthy]` per bridge). Saves ~500–800 bytes per call.

---

## [2.5.16] — 2026-03-25

### Changed
- **Lazy tool exposure in multi-bridge mode** — When two or more IDE bridges are healthy, the orchestrator now exposes only the active bridge's tools at session connect time (instead of all bridges' tools combined). The active bridge is pre-selected via `pickBest()` and stored as the session's sticky bridge. Calling `switchWorkspace` swaps the exposed tools to the new bridge and sends `notifications/tools/list_changed`. This reduces tool count from `N × 136` to `136` in all cases.
- **`McpTransport.deregisterTool(name)`** added — removes a single tool by name (used by the lazy swap path to drop tools exclusive to the previous bridge).

---

## [2.5.15] — 2026-03-25

### Changed
- **Description prefix compression** — In single-bridge mode, proxied tool descriptions no longer include the `[IdeName: workspace]` prefix (saves ~15 KB per `tools/list` response). In multi-bridge mode, the full path prefix is replaced with a compact alias (`[ws1]`, `[ws2]`) matching the workspace index in the session instructions.
- **Compact session-start instructions** — `buildInstructions()` now emits a structured format (`WORKSPACES:`, `MULTI-IDE:`, `CAUTION:`, `RULE:`) instead of prose. Adds `RULE: do NOT call getOrchestratorStatus/listWorkspaces/listBridges at session start` to prevent redundant status calls on every new session.

---

## [2.5.14] — 2026-03-25

### Fixed
- **Proxied tool refresh crash** — `registerProxiedTools()` used `registerTool` (throws on duplicate names). When `probeAll()` called it on an existing session after a child bridge plugin hot-reload, it threw for every already-registered tool, silently breaking the session. Switched to `replaceTool` (upsert).

---

## [2.5.13] — 2026-03-25

### Fixed
- **SSE parser** — `ChildBridgeClient.post()` now returns the last `data:` frame that contains a `result` or `error` field. Previously the first `data:` line was used, so progress notifications emitted before the final result were silently returned as the tool output for long-running tools.
- **404 session-expiry recovery** — When a child bridge's HTTP session expires (2-hour idle TTL), `callTool()` now nulls the session ID, re-initialises, and retries once instead of counting the 404 toward the circuit breaker. Avoids false "bridge unavailable" errors on healthy bridges.
- **`pickBest()` tie-break** — Now sorts by `consecutiveFailures` ascending before `startedAt` descending, matching `pickForWorkspace()` behaviour.
- **`__toolName` argument injection removed** — Proxied tools in the orchestrator now dispatch via named closures only. The previous dynamic dispatch path injected `__toolName` into tool arguments, which would silently drop any child bridge tool argument with that name.
- **Proxied tools refresh on health probe** — `probeAll()` now always re-fetches the tool list from each child bridge. When the list changes (e.g. after a plugin hot-reload), existing sessions receive updated tool registrations and a `notifications/tools/list_changed` notification.
- **Orchestrator reconnect** — `transport.markInitialized()` is called after `transport.attach()` so Claude Code sessions that reconnect without re-sending the MCP `initialize` handshake can call tools immediately.

---

## [2.5.8] — 2026-03-23

### Added
- **`source: 'settings'` plugin support documented** — `claude-ide-bridge-plugin/README.md` now includes Option 3 (project-level team sharing via `enabledPlugins` in `.claude/settings.json`). No CLI flags needed; Claude Code loads the plugin automatically from the project root.

### Security
- **WebSocket Host header allowlist extended** — `ALLOWED_HOSTS` was hardcoded to loopback addresses. Remote deployments using `--cors-origin` (e.g. `https://bridge.example.com`) now have their hostname added to the WS upgrade allowlist, fixing a correctness issue where reverse-proxy deployments rejected legitimate WebSocket connections. (MEDIUM, finding #5)

### Fixed
- **Onboarding docs overhaul** — plugin README Quick Start added (env var, extension install, `--watch`, verify step); SETUP.md Remote Control sections removed (stale); `install-extension` positional arg syntax corrected; CHANGELOG gaps for v2.5.3/2.5.5/2.5.6/2.5.7 filled.
- **`session-info.sh`** — "no bridge detected" message now correctly says `claude-ide-bridge --watch` instead of `npm start`.
- **`templates/CLAUDE.bridge.md`** — replaced `getToolCapabilities` at session start with `getBridgeStatus`; fixed scheduled-task copy path for npm global installs.
- **Plugin examples** — `02-review-pull-request.md`: fixed `githubCreateReview` → `githubPostPRReview`; `03-refactor-with-lsp.md`: use `renameSymbol` instead of `searchAndReplace` for LSP-aware renames.
- **`deploy/README.md`** — clarified that `install-vps-service.sh` handles service restart automatically.

---

## [2.5.7] — 2026-03-23

### Changed
- **Agent frontmatter tightened** — all 3 built-in subagents (`ide-code-reviewer`, `ide-debugger`, `ide-test-runner`) now declare explicit `maxTurns` limits (30/20/15 respectively) and `disallowedTools` lists. `ide-code-reviewer` also blocks `Edit` and `Write` to enforce read-only review behaviour. `deleteFile` is blocked across all three.

---

## [2.5.6] — 2026-03-23

### Added
- **Regression test suite expanded**: bridge now has 1349 tests (+8 covering `runCommand` `-f`/`-r` per-command blocking and curl output flags); extension has 406 tests (+12: new `httpProbe.test.ts` file, 4 multi-bridge lockfile tests).

### Changed
- **Docs updated** — `platform-docs.md` and `styleguide.md` refreshed to reflect `runInTerminal` timeout behaviour, `runCommand` dangerous-flag table, OAuth register endpoint, and security patterns introduced in v2.5.x.

---

## [2.5.5] — 2026-03-23

_Internal npm slot. No additional changes beyond v2.5.4 — published to resolve a registry slot conflict with v2.5.3._

---

## [2.5.4] — 2026-03-23

### Added
- **ElicitationResult hook** (`claude-ide-bridge-plugin`) — fires when a user cancels or times out an MCP elicitation dialog; silent on submit (expected normal flow).
- **`effort` frontmatter** on all built-in skills: `low` for data-gathering/rendering skills (ide-coverage, ide-diagnostics-board, ide-deps), `high` for deep analysis/action skills (ide-review, ide-explore, ide-refactor, ide-debug, ide-quality).
- **Rate limit awareness** in `session-info.sh` — surfaces 5-hour and 7-day quota percentages at session start when above 50%/80% respectively (uses `rate_limits` field added in Claude Code 2.1.80).

### Changed
- **`SubprocessDriver` now passes `--bare`** when spawning Claude Code subprocesses via `runClaudeTask`. Prevents hook loops when the subprocess shares `~/.claude/` with the parent session.
- **`-f` and `-r` flags unblocked globally** from `DANGEROUS_PATH_FLAGS`. These common short flags (`grep -r`, `docker -f`, `sort -f`, etc.) were incorrectly blocked for all commands. They are now blocked only for the specific commands where they are dangerous: `make -f` (arbitrary Makefile path) and `node`/`ts-node`/`tsx -r` (arbitrary module pre-require). Uses new `DANGEROUS_FLAGS_FOR_COMMAND` per-command table.

### Fixed
- 19 regression tests added for v2.5.2 security/bug fixes (1341 total, 0 failures).

---

## [2.5.2] — 2026-03-23

### Security
- **CRITICAL — OAuth open redirect**: `handleRegister` now stores `redirect_uris` in a `registeredClients` map. Both `GET /oauth/authorize` (via `parseAuthorizeParams`) and `POST /oauth/authorize` (approve and deny paths) validate the presented `redirect_uri` against the registered set before issuing any redirect. An unregistered URI returns 400 instead of following the attacker-controlled location.
- **HIGH — `handleRegister` URI validation**: Each `redirect_uri` is validated as an absolute URL with `https:` scheme or `localhost`/`127.0.0.1` host. Non-HTTPS non-localhost URIs are rejected with 400.
- **HIGH — curl output flags blocked**: `-o`, `--output`, `-O`, `--remote-name`, `-D`, `--dump-header`, `-K` added to `DANGEROUS_PATH_FLAGS` in `runCommand`. These flags allow writing files to arbitrary paths on VPS deployments.
- **MEDIUM — scope validation on registration**: `handleRegister` now rejects any requested scope not in `SUPPORTED_SCOPES` (currently `["mcp"]`) with 400 `invalid_client_metadata`.

### Fixed
- **HIGH — `runInTerminal` double-execution**: When the extension times out waiting for shell integration output, the tool now returns a clear error instead of falling through to the subprocess fallback. The command was already dispatched to the VS Code terminal; re-executing it via subprocess could double-invoke non-idempotent operations.
- **MEDIUM — `applyEditsToContent` invalid range**: Edits where `endLine < line` or (`endLine === line` and `endColumn < column`) now throw a descriptive error instead of silently producing a no-op splice.
- **MEDIUM — `isValidRef` too restrictive**: Refs like `HEAD~3`, `HEAD^`, `HEAD^2`, and `stash@{0}` are now valid. The character class was expanded from `[\w.\-/]` to `[\w.\-/^~@{}]`. Leading-dash and `..` range syntax are still rejected.
- **MEDIUM — vitestJest silent failure**: Both vitest and jest runners now throw when `execSafe` returns exit code 127 (command not found) or null (killed by signal), instead of returning an empty results array indistinguishable from "0 tests passed".
- **LOW — automation cooldown on failed enqueue**: `lastTrigger.set` is now called only after `orchestrator.enqueue()` succeeds. A failed enqueue no longer imposes a spurious cooldown on the next trigger attempt.
- **Clarified `O_NOFOLLOW ?? 0` in `lockfile.ts`**: Added detailed comment explaining why `O_EXCL` alone is sufficient on Windows (where `O_NOFOLLOW` is undefined). No behavior change.

---

## [2.5.3] — 2026-03-23

_Contains the same security and bug fixes as v2.5.2. Published separately due to a registry slot conflict (v2.5.2 was retracted after a brief publish window)._

---

## [2.4.0] — 2026-03-18

### Added
- **OAuth 2.0 Authorization Server** (`src/oauth.ts`) — full RFC 6749 authorization code grant with PKCE (S256), RFC 8414 discovery metadata, and RFC 7009 token revocation. Enables authenticated remote MCP server registration on claude.ai.
  - `GET /.well-known/oauth-authorization-server` — RFC 8414 discovery document
  - `GET /oauth/authorize` — approval page (requires bridge token to initiate)
  - `POST /oauth/authorize` — form submission; issues single-use auth codes (5 min TTL)
  - `POST /oauth/token` — exchanges code + PKCE verifier for access token (1 h TTL)
  - `POST /oauth/revoke` — RFC 7009 token revocation
  - Backward-compatible: existing static bearer tokens continue to work
- `--issuer-url <url>` CLI flag and `CLAUDE_IDE_BRIDGE_ISSUER_URL` env var to set the OAuth issuer URL
- `docs/privacy-policy.md` — privacy policy for the plugin marketplace submission
- `docs/ip-allowlist.md` — network access and IP allowlist documentation for self-hosters
- `claude-ide-bridge-plugin/examples/` — three working example walkthroughs for the plugin directory listing:
  - `01-debug-failing-test.md`
  - `02-review-pull-request.md`
  - `03-refactor-with-lsp.md`

### Changed
- Safety annotations: `setHandoffNote` now declares `destructiveHint: true, idempotentHint: true`; `getHandoffNote` declares `readOnlyHint: true`

### Tests
- 23 new tests for `OAuthServerImpl` covering discovery, authorize GET/POST, token issuance, PKCE verification, code reuse rejection, revocation, and `resolveBearerToken`

---

## [2.3.0] — 2026-03-01

### Fixed (SSH remote issues)
- `runInTerminal` subprocess fallback for SSH remotes
- LSP cold-start retry with 0→4→8s exponential backoff
- Probe detects `tsc`, `biome`, `rg` via `node_modules/.bin`
- `searchAndReplace` glob normalisation (`*.ts` → `**/*.ts`)
- `closeTab` `realpathSync` fix
- `captureScreenshot` headless error message

### Added
- `@vscode/ripgrep` dependency with postinstall symlink
- `smoke-test-v2.mjs` regression gate (26 PASS / 0 FAIL baseline)
- Extension v1.0.9

### Tests
- 1237 unit tests across 101 test files
