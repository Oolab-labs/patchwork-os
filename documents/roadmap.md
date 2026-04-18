# Claude IDE Bridge — Roadmap

Development direction and exploration guidance. Living document — update as priorities shift.

---

## Patchwork Phase 2 — shipped (as of 2026-04-18)

**Oversight infrastructure** (merged to main in PRs #2–#9):
- **Runtime approval gate** ([src/approvalHttp.ts](../src/approvalHttp.ts)) — dashboard is the UI for CC's "ask" rules. `approvalGate` runtime knob (`off` / `high` / `all`) flipped live from settings. Risk signals (destructive flags, non-HTTPS URLs, path escape) surfaced as badges. Managed settings file enforces admin policy above user/project. Precedence + design: [ADR-0006](../docs/adr/0006-approval-gate-design.md).
- **CC PreToolUse hook** — `scripts/patchwork-approval-hook.sh` routes native CC tool calls through the bridge gate, not just MCP transport calls.
- **Recipe system** — YAML/JSON recipes with manual / cron (`@every`) / webhook (`POST /hooks/<name>`) / file-watch triggers. Persistent run-history via `RecipeRunLog` (JSONL at `~/.patchwork/runs.jsonl`, not SQLite). Dashboard `/recipes` + `/recipes/new` composer.
- **Dashboard surfaces** — `/approvals` with pattern-learning hooks + live streaming, `/analytics`, `/sessions`, `/recipes`, `/runs`, `/metrics`.
- **`GET /cc-permissions`** — merged rules tagged with origin (`managed` / `project` / `user`) so the UI explains *why* a rule matched.

**Enrichment Engine** (merged in PRs #10–#11):
- **`enrichCommit`** ([src/tools/enrichCommit.ts](../src/tools/enrichCommit.ts)) — parses `#N` / `GH-N` refs from commit message, fetches each issue via `gh`, classifies close-vs-reference by verb proximity.
- **`CommitIssueLinkLog`** ([src/commitIssueLinkLog.ts](../src/commitIssueLinkLog.ts)) — JSONL persistence for enrichment results (`~/.patchwork/commit_issue_links.jsonl`); dedup on `(workspace, sha, ref)` unless state changes.
- **`getCommitsForIssue`** — reverse lookup without re-running `gh`.
- **`enrichStackTrace`** ([src/tools/enrichStackTrace.ts](../src/tools/enrichStackTrace.ts)) — maps stack frames (Node/Python/browser/generic) to introducing commits via shared `createBlameResolver`.
- Shared helpers: [src/tools/issueRefs.ts](../src/tools/issueRefs.ts) (`extractIssueRefs`, `classifyIssueLink`), [src/tools/blame-utils.ts](../src/tools/blame-utils.ts).

## Patchwork Phase 3 moat — shipped (2026-04-18)

Cross-session memory loop, end-to-end. Merged in PRs #11–#15:

| Direction | Surface | Lands in |
|---|---|---|
| **Agents write** decisions | `ctxSaveTrace` | `DecisionTraceLog` → `~/.patchwork/decision_traces.jsonl` |
| System writes decisions | approval gate, `enrichCommit`, recipe runs | activityLog, `CommitIssueLinkLog`, `RecipeRunLog` |
| **Agents read** (query) | `ctxQueryTraces` (4 traceTypes), `ctxGetTaskContext` | all four logs |
| **Agents read** (injected) | session-start digest ([recentTracesDigest.ts](../src/tools/recentTracesDigest.ts)) | MCP instructions block on connect |
| **Humans read** | `/traces` dashboard page | `GET /traces` + dashboard `[...]/page.tsx` |

All four "phantom tools" previously advertised in the MCP handshake (`ctxGetTaskContext`, `ctxQueryTraces`, `ctxSaveTrace`, plus the digest) are now real handlers. Zero drift between what agents are told and what they can actually call.

**Persistence model:** JSONL across all three logs (not SQLite). Each log has its own dedup / retention semantics; `ctxQueryTraces` is the unified reader. Adding SQLite would be a migration, not a rewrite — deferred until query volume demands it.

**Test state (on main):** 3174 bridge tests passing. Lint 0 errors, 55 warnings (all pre-existing in src/vscode-extension). Dashboard excluded from bridge biome config (own toolchain).

## Remaining Patchwork work

1. **Dogfood the agent-read loop.** Instrumentation already emits `bridge_tool_calls_total{tool="ctxSaveTrace"}` etc. via Prometheus. Need real agent sessions to produce usage data; then decide whether instructions need strengthening to nudge agents toward the ctx tools.
2. **Decision-trace dashboard view.** `/traces` bundles all 4 types; decisions (the agent-authored knowledge base) could use a dedicated tab with search-by-tag. Speculative until usage data warrants.
3. **Freshness scoring + dedup across context sources.** Deferred research; wait until real duplication pain appears in `contextBundle` / `getCommitsForIssue` output.
4. **Upstream connectors** (Sentry, Linear) — Phase 1 federation per `docs/platform-strategy.md`. `enrichStackTrace` already composes with *pasted* stacks; Sentry-as-connector is the next natural extension.

---

## Current State (v2.25.34 / ext v1.3.2 — 2026-04-14)

**v2.25.34 + ext v1.3.2 shipped (2026-04-14) — outputSchema + extension version debugging:**
- v2.25.34: Three bugs fixed from dogfood logs — `getGitStatus` success path missing `required` field `available: true` (outputSchema validation always failed → Claude got plain text); `getBufferContent` extension path returned `source:"vscode-buffer"` but enum only allows `"extension"|"disk"`; `onGitCommit`/`onGitPush` cancelled at default 120s timeout (added `timeoutMs: 180000`).
- ext v1.3.2: Extension sends `packageVersion` (npm package version, e.g. `"1.3.2"`) in `extension/hello` alongside `extensionVersion` (protocol version). Bridge stores it, exposes as `getBridgeStatus.extensionPackageVersion`. Fixes misleading log `version=1.1.0` which looked like a stale extension but was the protocol version. Log now says `protocolVersion=1.1.0, packageVersion=1.3.2`.

**v2.25.27–v2.25.33 shipped (2026-04-14) — token compression sprint:**
- v2.25.27: Clipboard test mock + tool description ≤200 char enforcement.
- v2.25.28: F1/F3/F4 smoketest fixes — `onInstructionsLoaded` checks active automation task before enqueue; `taskTimestamps.push()` moved after enqueue succeeds; `triggerSource` in `_buildTasksPayload`. 6 regression tests.
- v2.25.29: Tool-level descriptions compressed ~50% across 81 files using caveman-ultra rules (drop articles/filler, fragments OK, short synonyms). No logic changes. CI green.
- v2.25.30: Caveman-ultra injected at 4 layers — `buildEnforcementReminder()` (every MCP handshake), `onInstructionsLoaded` hook, `onPostCompact` hook, automation system prompt. All 3 preset templates (strict-lint, security-first, test-driven) updated.
- v2.25.31: MCP prompts in `src/prompts.ts` compressed — review-file, explain-diagnostics, health-check, 6 dispatch prompts, generate-tests, debug-context, 13 LSP-composition prompts.
- v2.25.32: CLAUDE.md caveman-compress pass; `.gitignore` updated for `*.original.md` backup files; preset template hook prompts synced with live policy style.
- v2.25.33: Arg-level descriptions compressed across all 78 tool files (392 entries). Combined with v2.25.29 tool-level compression: ~20% reduction in `tools/list` payload. Also fixed 3 pre-existing biome lint issues surfaced by pre-commit hook.

**v2.25.15–v2.25.26 shipped (2026-04-13) — polish, bug saga, prevention, composites:**
- v2.25.15–16: Loop guards for `onPostCompact`/`onInstructionsLoaded`; `--verbose` regression test; `{{count}}` nonce-wrap; token-efficiency caps on contextBundle/onDiagnosticsError/getDiagnostics relatedInformation/getGitStatus/runTests.
- v2.25.17: Batch A polish — `extensionRequired: true` schema flag added to 4 tools; `findImplementations` cap 50; `getDocumentSymbols` cap 500; SubprocessDriver settings file includes `process.pid` to prevent multi-bridge races.
- v2.25.18: contextBundle `activeFileContent` latent bug — checked `typeof string` on an object, field had never been populated since tool creation. Plus `onGitPush` hash nonce-wrap, `onTaskCreated/Success` non-null assertion cleanup, `getWorkspaceSettings` 200-key cap, `getImportTree` 5000-node cap.
- v2.25.19–21: Five latent shape-mismatch bugs in `extensionClient` — `getWorkspaceFolders` (array wrapper), `getSelection` (error object), `closeTab` (blind boolean cast → always reported failure), `formatDocument`/`fixAllLintErrors` (errors masked as success → CLI fallback unreachable), `writeClipboard` (schema mismatch).
- v2.25.22–23: Systemic prevention helpers — `tryRequest<T>` (auto-unwraps `{error}` convention) and `validatedRequest<T>` (runtime shape predicate) on `ExtensionClient`. `proxy<T>` doc-commented as dangerous. Regression tests for `getSelection`/`getWorkspaceFolders`.
- v2.25.24: Eighth latent bug — `saveFile` same pattern as `closeTab`. Structured `{saved, error?}` return. Negative finding: 10 other methods that looked like migration candidates are actually fine as-is.
- v2.25.25: **Three composite tools shipped** — `formatAndSave`, `jumpToFirstError`, `navigateToSymbolByName`. Plus `getBridgeStatus.toolAvailability` observability field (answers "why can't Claude call X?" in one call). New composite factory dep-injection pattern (dep tools extracted to `const` bindings in `src/tools/index.ts` before composites).
- v2.25.26: Dogfood catch on `toolAvailability` — `extensionFallback: true` spec flag for dual-path tools like `formatDocument`. The observability feature caught its own bug on first live use.

**Earlier baseline (v2.25.4–6, 2026-04-12):**
- v2.25.4: `init` writes CC hooks in `{matcher, hooks:[...]}` nested format; auto-migrates legacy flat entries.
- v2.25.5: Removed 5 redundant notify MCP tools — `claude-ide-bridge notify <Event>` → `POST /notify` is the sole path.
- v2.25.6: `onInstructionsLoaded` now surfaces in `getBridgeStatus` automation block.

- **Full mode default** (v2.43.0): all ~140 tools registered by default; pass `--slim` to restrict to ~60 IDE-exclusive tools (LSP, debugger, editor state, bridge introspection, `watchActivityLog`, `contextBundle`); plugin tools always bypass the slim filter; `--full` retained as no-op for backward compatibility
- **Token-efficient `tools/list`**: all tool descriptions ≤200 chars (slim ≤160), CI audit check #6 enforces limit; `scripts/measure-tools-list.mjs` tracks payload size
- **2,184 bridge tests / 148 files + 564 extension tests / 35 files = 2,748 total**, 0 failures; CI green on Node 20 + 22 (Ubuntu)
- **31 MCP prompts** (slash commands): 15 general/Dispatch + 13 LSP-composition + 3 visual skills (`/ide-coverage`, `/ide-deps`, `/ide-diagnostics-board`)
- **12 plugin skills**, **4 subagents** (including `ide-architect`)
- **59 tools with `outputSchema`/`structuredContent`**; CI audit enforces coverage
- **`promptName`/`promptArgs` in automation policy**: all 15 hooks can reference named MCP prompts instead of inline strings; `{{placeholder}}` substitution works inside `promptArgs` values
- **OAuth token persistence**: bridge token in `~/.claude/ide/bridge-token.json`; access tokens in `~/.claude/ide/oauth-tokens.json` (SHA-256 keyed, configurable TTL via `oauthTokenTtlDays`, max 90d); eliminates re-auth on restart
- **VS Code task tools**: `listVSCodeTasks` + `runVSCodeTask` (full mode); extension handlers use `vscode.tasks.fetchTasks`/`executeTask`/`onDidEndTaskProcess`
- **Local auth reliability**: lock file age filter 2h→24h; WebSocket session resumption via `X-Claude-Code-Session-Id` header; grace period default 30s→120s
- Extension v1.3.2 on VS Code Marketplace + Open VSX; installable into VS Code, Windsurf, Cursor, and Antigravity

- **Multi-IDE Orchestrator**: meta-orchestrator routes across N bridges (validated: 2 Windsurf IDEs); each bridge has isolated LSP/git/terminal context enabling genuinely independent parallel agent verification; `claudeIdeBridge.port` extension setting enables fixed-port auto-start per IDE
- **Three transports**: WebSocket (Claude Code), stdio shim (Claude Desktop), Streamable HTTP (remote MCP clients)
- **Four client surfaces**: Claude Code CLI, Claude Desktop (Cowork + Dispatch), Agent Teams (parallel), Scheduled Tasks (recurring)
- Production-grade connection hardening (circuit breaker, backoff, heartbeat, grace period, generation counter)
- Multi-linter and multi-test-runner support (auto-detected)
- GitHub integration (PRs, issues, actions, releases)
- Remote control support via `start-all.sh` orchestrator (tmux, health monitor, exponential backoff) or systemd service (`deploy/install-vps-service.sh`)
- Activity logging with Prometheus metrics; session checkpoint every 30s
- Claude Code Platform Integration fully shipped (6 skills, 3 subagents, plugin, hooks, `/ide-monitor`)
- MCP resources (`resources/list` + `resources/read`): workspace-confined, 1 MB cap, cursor-paginated
- MCP elicitation (`elicitation: {}` capability): `McpTransport.elicit()` sends `elicitation/create` to Claude Code 2.1.76+
- Deep security hardening: SSRF three-layer defense, Origin validation, rate limiting, lstatSync everywhere, TOCTOU mitigations, structured error codes
- Claude Desktop + Cowork + Dispatch integration documented; `setHandoffNote`/`getHandoffNote` for cross-session context; 5 Dispatch-optimized prompts for phone triggers
- Remote Desktop IDE support: extension runs in remote extension host (SSH/Cursor SSH); `print-token` CLI subcommand for headless VPS setup
- Agent Teams support: multi-session architecture serves parallel teammates out of the box; `team-status` prompt for coordination
- Scheduled Tasks support: 3 ready-made SKILL.md templates (nightly-review, health-check, dependency-audit); `health-check` prompt for ad-hoc runs
- `captureScreenshot` tool: returns MCP image content block directly to Claude (macOS + Linux)
- Full test coverage: all bridge tool files and extension handler files now have unit tests

**v2.24.1 shipped (2026-04-12) — Automation dedupe + timeout observability:**
- Content-aware dedupe for `onDiagnosticsError`: `diagnosticSignature()` order-independent sha256 over `severity|code|source|message`; new policy fields `dedupeByContent` + `dedupeContentCooldownMs` (default 900s); cooldown key extends to `diagnostics:${file}:${sig}` when enabled. `automation-policy.json` opted in.
- Driven by live `/tasks` data: 48 duplicate `onDiagnosticsError` tasks/day on a single file (LSP re-emission thrash); v2.24.1 expected to cut that to ≤2–3/day.
- `SubprocessDriver.run()` now returns `{ wasAborted: true, stderrTail, exitCode: -1 }` on abort instead of throwing. Non-abort errors (ENOENT etc.) still throw. Orchestrator's try block handles `result.wasAborted`; fallback catch block preserves throw-on-abort driver compat.
- `ClaudeTask.cancelReason`: `"timeout" | "user" | "shutdown"`. Private `cancelReasons` map populated by `cancel(id, reason?)` before `controller.abort()`. `_runTask` tracks `timedOut` flag in the setTimeout callback; distinguishes internal timeout from explicit cancels.
- `GET /tasks` exposes `cancelReason`, `stderrTail` (500-char cap), `wasAborted`. Previously 24% of tasks timed out silently with empty output — now surface stderr tail for root-cause investigation.
- Tests 2091→2105 (+14): 5 dedupe + 5 cancel-reason + 4 driver-contract.

**v2.24.0 shipped (2026-04-12) — DX polish & stability:**
- 13 sites in `src/automation.ts` converted from `cfg.prompt?.replace(...)` to `(cfg.prompt ?? "").replace(...)` — eliminates Biome-induced optional-chain type hazard where chained `.replace()` calls could silently return `undefined` at runtime.
- CI grep gate (PCRE, `-P`) added after lint step in `.github/workflows/ci.yml` to guard against the pattern re-entering.
- 2 new `diagnosticTypes` regression tests: `source: "ts"` + policy `["ts"]` fires; `source: "ts"` + policy `["typescript"]` does not — guards the v2.23.1 fix.
- New `automation.integration.test.ts`: 5 end-to-end tests using real `Server` + `makeInstantOrchestrator` covering onDiagnosticsError, onFileSave, onGitCommit, onTestRun placeholder substitution, plus live `POST /notify` route for onPostCompact.
- `SubprocessDriver` `permissions.deny` extended with 11 more `Bash(...)` entries: `rm -rf`, `git reset --hard`, `git clean -f`, `sudo`, `eval`, pipe-to-shell, `kill -9`, `pkill` — defends against crafted prompts or file paths triggering destructive shell.
- `init` Step 6 verification: reports ✓/✗ for bridge-on-PATH, MCP shim in `~/.claude.json`, CC hooks in `~/.claude/settings.json`.
- Tests 2084→2091 (+7).

**v2.23.0–2.23.10 shipped (2026-04-12) — CC hook wiring + automation polish:**
- `POST /notify` HTTP endpoint (auth-protected): dispatches CC lifecycle events directly to `AutomationHooks` handlers without a full MCP session; accepts `{ event, args }` JSON body
- `claude-ide-bridge notify <CcEvent> [--taskId|--prompt|--tool|--reason|--cwd]` CLI subcommand: reads running bridge lock file for port+token, POSTs to `/notify`; usable in `~/.claude/settings.json` hooks
- ~~4 new MCP notify tools~~ (removed in v2.25.5 — use `claude-ide-bridge notify <Event>` CLI + `/notify` HTTP instead)
- `checkCcHookWiring()` upgraded: recognizes `notify <CcEvent>` CLI pattern in CC settings.json; `getBridgeStatus` surfaces `unwiredEnabledHooks` in `suggestedActions`
- `init` auto-wires all 5 CC hook entries in `~/.claude/settings.json` (idempotent, step 5 of 6); eliminates most common new-user gap where `--automation` is active but CC-triggered hooks never fire
- Mystery publish fix (v2.23.5): `SubprocessDriver._writeSettings()` now writes `permissions.deny` list blocking `Bash(npm publish*)`, `Bash(git push*)`, `Bash(npm version*)`; automation subprocess can no longer autonomously publish on release commits
- `diagnosticTypes` filter bug (v2.23.1): `"typescript"` → `"ts"` in all policy files and preset templates
- `runTests` 0-result bug (v2.23.2): `parseJsonReport` now uses `file.assertionResults ?? file.testResults` and `file.name ?? file.testFilePath` (Vitest vs Jest fields)
- `onGitPull` hook: fires after `gitPull` succeeds; `{{remote}}`/`{{branch}}` placeholders; loop guard via `activeGitPullTaskId`
- 3 preset automation policy templates: `templates/automation-policies/strict-lint.json`, `security-first.json`, `test-driven.json`
- `@@ HOOK` metadata prefix on all 15 hook prompts (v2.23.0): `@@ HOOK: <name> | file: <path> | ts: <iso> @@` prepended for all hooks; 15 tests covering every hook variant
- Bridge tests 2,040→2,084 / 143→146 files

**v2.18–v2.22.10 shipped (2026-04-09–2026-04-12) — Tracks A–E + security sweep:**
FileLock `tryAcquire` (non-blocking); `watchActivityLog` + `contextBundle` slim-mode tools; cursor pagination on `findReferences`/`getCallHierarchy`; diagnostic enrichment in `watchDiagnostics` (git blame, per-instance `blameCache`); visual skills (`/ide-coverage`, `/ide-deps`, `/ide-diagnostics-board`); Track B automation (`onDiagnosticsCleared`, condition expressions, `getChangeImpact` in `onGitCommit`, `onTaskSuccess` chained automation, hooks total 11→15); OAuth token persistence (bridge-token.json + oauth-tokens.json, SHA-256 keyed, configurable TTL); VS Code task tools (`listVSCodeTasks`, `runVSCodeTask`); local auth reliability (lock file age 2h→24h, WebSocket session resumption via `X-Claude-Code-Session-Id`, grace period 120s); 22-item security sweep (ws.send bypass fixed, test isolation — vitest no longer kills live MCP session). Bridge tests 1,850→2,040 / 133→143 files; extension tests 472→564 / 28→35 files.

**v2.13.0 shipped (2026-04-09) — Track B LSP primitives:**
- 3 new LSP navigation tools: `findImplementations`, `goToTypeDefinition`, `goToDeclaration`
- Extension handlers + ExtensionClient methods + MCP tool factories with outputSchema
- 12 bridge unit tests + 18 extension handler tests; SLIM count 50 → 53
- Extension v1.2.0; published to npm, VS Marketplace, Open VSX

**v2.12.0 shipped (2026-04-09) — LSP Leverage Round:**
- 12 new MCP slash commands composing existing LSP tools: `find-callers`, `blast-radius`, `why-error`, `unused-in`, `trace-to`, `imports-of`, `circular-deps`, `refactor-preview`, `module-exports`, `type-of`, `deprecations`, `coverage-gap`
- 3 new plugin skills: `ide-dead-code-hunter`, `ide-type-mismatch-fix`, `ide-api-deprecation-tracker`
- New `ide-architect` subagent for architectural health audits (God objects, circular deps, coupling, modularization)
- `templates/automation-policy.example.json` with LSP-aware hook prompts for all 8 hooks
- 22 new tests (1805 → 1827); bridge v2.12.0, extension v1.1.0

**v2.11.16 shipped (2026-04-09) — previewCodeAction LSP tool:**
- New `previewCodeAction` tool in `src/tools/lsp.ts`: shows exact text edits a code action would make without applying them — safe to call before `applyCodeAction`
- Extension handler (`extension/previewCodeAction`) and `extensionClient.previewCodeAction()` already existed; only the bridge tool was missing
- `outputSchema` declared: `{ title, changes[{ file, edits[{ range, newText }] }], totalFiles, totalEdits, note? }`
- Added to `SLIM_TOOL_NAMES` (49 total, up from 48) and `availableTools.lsp` (29 LSP tools)
- 5 new tests in `src/tools/__tests__/previewCodeAction.test.ts`; 1744 bridge tests

**v2.11.15 shipped (2026-04-09) — outputSchema for remaining workflow tools:**
- `outputSchema` + `successStructured` added to 4 tools completing all major tool families:
  - `cancelClaudeTask` → `{ cancelled, taskId }` (completes Claude orchestration family)
  - `resumeClaudeTask` → `{ newTaskId, originalTaskId, prompt, status }` (completes Claude orchestration family)
  - `setHandoffNote` → `{ saved, updatedAt }` / `getHandoffNote` → `{ note, updatedAt?, updatedBy?, age? }` (cross-session context tools)
  - `getPRTemplate` → `{ body, commits, issueRefs, filesChanged, base, style?, note? }` (PR workflow tool)
- `structuredContent.test.ts`: 5 new contract tests (25 total)
- Audit: 37 outputSchema tools (up from 33); all 5 checks pass
- 1739 bridge tests (up from 1734)

**v2.11.14 shipped (2026-04-09) — onPullRequest automation hook:**
- New `OnPullRequestPolicy` + `handlePullRequest()` in `automation.ts`: fires after every successful `githubCreatePR` tool call; placeholders: `{{url}}`, `{{number}}` (null → `"(unknown)"`), `{{title}}`, `{{branch}}`; loop guard + cooldown (min 5s)
- `createGithubCreatePRTool` accepts optional `onPullRequest` callback; resolves current branch via `git rev-parse --abbrev-ref HEAD` before invoking callback; wired in `tools/index.ts`
- `getStatus()` extended with `onPullRequest: { enabled, cooldownMs } | null`
- `loadPolicy` validates + clamps `onPullRequest.cooldownMs` ≥ 5 000 ms
- 9 new tests in `automation.test.ts` (74 total); 1734 bridge tests

**v2.11.13 shipped (2026-04-09) — onBranchCheckout automation hook:**
- New `OnBranchCheckoutPolicy` + `handleBranchCheckout()` in `automation.ts`: fires after every successful `gitCheckout` tool call; placeholders: `{{branch}}`, `{{previousBranch}}` (null → `"(detached HEAD)"`), `{{created}}`; loop guard + cooldown (min 5s)
- `createGitCheckoutTool` accepts optional `onBranchCheckout` callback; wired in `tools/index.ts`
- `getStatus()` extended with `onBranchCheckout: { enabled, cooldownMs } | null`
- `loadPolicy` validates + clamps `onBranchCheckout.cooldownMs` ≥ 5 000 ms
- 9 new tests in `automation.test.ts` (65 total); 1725 bridge tests

**v2.11.12 shipped (2026-04-09) — onGitPush automation hook:**
- New `OnGitPushPolicy` + `handleGitPush()` in `automation.ts`: fires after every successful `gitPush` tool call; placeholders: `{{remote}}`, `{{branch}}`, `{{hash}}`; loop guard + cooldown (min 5s)
- `createGitPushTool` accepts optional `onGitPush` callback; wired in `tools/index.ts`
- `getStatus()` extended with `onGitPush: { enabled, cooldownMs } | null`
- `loadPolicy` validates + clamps `onGitPush.cooldownMs` ≥ 5 000 ms
- 8 new tests in `automation.test.ts` (56 total); 1716 bridge tests

**v2.11.11 shipped (2026-04-09) — onGitCommit automation hook:**
- New `OnGitCommitPolicy` + `handleGitCommit()` in `automation.ts`: fires after every successful `gitCommit` tool call; placeholders: `{{hash}}`, `{{branch}}`, `{{message}}`, `{{count}}`, `{{files}}`; loop guard (blocks re-trigger while prior task running); cooldown (min 5s); file list capped at 20 entries; delimiter-wrapped `{{files}}` block (prompt injection defense)
- `createGitCommitTool` accepts optional `onGitCommit` callback; wired in `tools/index.ts` via `automationHooks.handleGitCommit`
- `getStatus()` extended with `onGitCommit: { enabled, cooldownMs } | null`
- `loadPolicy` validates + clamps `onGitCommit.cooldownMs` ≥ 5 000 ms
- 8 new tests in `automation.test.ts` (48 total); 1708 bridge tests

**v2.11.10 shipped (2026-04-09) — outputSchema for Claude orchestration tools:**
- `outputSchema` + `structuredContent` added to `runClaudeTask`, `getClaudeTaskStatus`, and `listClaudeTasks` — 33 total outputSchema tools (up from 30)
- `structuredContent.test.ts`: 3 new contract tests (20 total); covers non-streaming enqueue, status poll, and empty task list
- All 5 audit checks pass; 1700 bridge tests (up from 1697)

**v2.11.9 shipped (2026-04-09) — outputSchema for getToolCapabilities + auditDependencies:**
- `outputSchema` + `structuredContent` added to `getToolCapabilities` (session-start tool) and `auditDependencies` (dependency audit) — 30 total outputSchema tools (up from 28)
- `structuredContent.test.ts`: 2 new contract tests (17 total); `getToolCapabilities` tests with disconnected extension; `auditDependencies` tests no-manifest path
- All 5 audit checks pass; 1697 bridge tests (up from 1695)

**v2.11.8 shipped (2026-04-09) — structuredContent wiring + audit hardening:**
- `structuredContent` now emitted by all 28 outputSchema tools; previously 10 tools declared `outputSchema` but returned plain text blobs
- `audit-lsp-tools.mjs` extended to 5 checks: added `outputSchema ↔ successStructured` consistency (checks 3 & 4) — immediately caught 3 pre-existing violations in `lsp.ts` (`getHover`, `applyCodeAction`, `searchWorkspaceSymbols`)
- `outputSchema` + `structuredContent` added to 3 more high-frequency tools: `getProjectInfo`, `getActivityLog`, `runCommand` (28 total, up from 25)
- `structuredContent.test.ts`: new cross-cutting contract test file (15 tests) verifying every updated tool emits `structuredContent` and it round-trips through JSON consistently

**v2.11.7 shipped (2026-04-09) — outputSchema expansion + onTestRun hook + LSP consistency:**
- `onTestRun` automation hook: new `OnTestRunPolicy` with `onFailureOnly`, `cooldownMs`, placeholders (`{{runner}}`, `{{failed}}`, `{{passed}}`, `{{total}}`, `{{failures}}`); loop guard prevents re-triggering from tasks spawned by the hook itself; `runTests` wired via callback to avoid circular imports; 10 new tests
- `outputSchema` added to 7 more tools: `runTests`, `searchWorkspace`, `getGitDiff`, `getBufferContent`, `generateTests`, `detectUnusedCode`, `getGitHotspots` — brings total to 22 tools with declared structured output
- LSP tool registry consistency: `SLIM_TOOL_NAMES` ↔ `availableTools.lsp` drift fixed (`getTypeHierarchy`, `getInlayHints`, `getHoverAtCursor` added to slim; `refactorExtractFunction`, `getImportTree` added to caps list); SLIM_TOOL_NAMES: 45 → 48
- `scripts/audit-lsp-tools.mjs`: new audit script deriving tool truth from source — checks SLIM entries have schemas, caps list ⊆ SLIM, no orphaned files; exits 1 on drift
- CI: new `lsp-audit` job runs audit script on every push/PR — prevents future SLIM ↔ caps drift silently regressing

**v2.11.6 shipped (2026-04-09) — Claude Code changelog catch-up:**
- `onFileChanged` automation hook: new policy type (same shape as `onFileSave`) triggering on VS Code buffer-change events (`type === "change"`) rather than explicit saves; wired in `bridge.ts` alongside `handleFileSaved`; `getStatus()` includes it; 6 new tests
- `_meta["anthropic/maxResultSizeChars"]` injection in transport: results > 50 KB now include `_meta: { "anthropic/maxResultSizeChars": N }` so Claude Code 2.1.91+ persists the full content without truncating; 2 new tests
- Docs: automation policy table updated with `onFileChanged`; added `if` condition hook syntax (CC 2.1.85+), `hookSpecificOutput.sessionTitle` pattern (CC 2.1.94+), and `MCP_CONNECTION_NONBLOCKING=true` headless note (CC 2.1.89+) to `platform-docs.md`
- Roadmap: filed Anthropic Managed Agents MCP integration as watch item under Medium-Term Possibilities

**v2.11.5 shipped (2026-04-08) — stale rules fix + transport hardening:**
- `isBridgeToolsFileValid()`: strengthened to require `"batchGetHover"` as 4th keyword — stale files from pre-2.11.4 installations now trigger repair
- `repairBridgeToolsRulesIfStale()`: extracted helper called before both early exits in `gen-claude-md --write`; existing users with complete CLAUDE.md (triggering early-exit) now receive the repaired rules file
- `_meta` strip in transport: MCP clients may embed `_meta` inside `arguments`; stripped before AJV validation to prevent spurious `-32602` errors on tools with `additionalProperties: false`
- Size guard on `rawArgs` (pre-strip): 1 MB check now runs before `_meta` is removed, so a large `_meta` cannot bypass the guard
- `.gitignore`: added `*.bak` (auto-created backups) and `.claude/rules/` (auto-generated rules copy)
- 2 new tests: `_meta` strip verified absent from handler args; permissive-schema strip also confirmed unconditional

**v2.11.4 shipped (2026-04-08) — LSP tools expansion (all phases) + connection hardening:**
- `getSemanticTokens`: decodes delta-encoded semantic token Uint32Array from VS Code; `startLine`/`endLine` filter; caps at 2000 tokens; sanitizes legend (50 entries, 64-char names). Handler uses `vscode.provideDocumentSemanticTokensLegend` + `vscode.provideDocumentSemanticTokens`.
- `getCodeLens`: calls `vscode.executeCodeLensProvider` with `itemResolveCount=100`; omits `commandId` (security); truncates titles to 200 chars (prompt injection defense)
- `getChangeImpact`: composite blast-radius tool — live diagnostics + reference counts for changed symbols; up to 5 concurrent findReferences; blast radius `low`/`medium`/`high`
- `getImportedSignatures`: composite — parses named/default/type imports; resolves each via `goToDefinition` → `getHover`; 5 concurrent; hover truncated to 4000 chars; skips `* as X` namespace imports
- `getDocumentLinks`: extracts file/URL references; workspace containment filter; cap 100 links
- `batchGetHover`, `batchGoToDefinition`: bridge-side fan-out for up to 10 positions via `Promise.allSettled`
- `explainSymbol` extended: new `includeSiblings: boolean` parameter
- `getImportTree` security fix: `resolveFilePath()` replaces bare `path.isAbsolute` check
- Connection hardening: `RECONNECTING` state (Phase 6C); windowed circuit breaker — opens only after ≥3 timeouts in 30s (Phase 6B); RTT tracking + `connectionQuality` in `getBridgeStatus` (Phase 6A); SSE event IDs for Streamable HTTP resumability (Phase 6D); 10 new connection failure tests (Phase 6E)
- SLIM_TOOL_NAMES: 38 → 45 (added `getSemanticTokens`, `getCodeLens`, `getChangeImpact`, `getImportedSignatures`, `getDocumentLinks`, `batchGetHover`, `batchGoToDefinition`)

**v2.11.2 shipped (2026-04-04) — bridge-tools enforcement hardening:**
- `src/instructionsUtils.ts`: shared `buildEnforcementBlock()` — `bridge.ts` and `orchestratorBridge.ts` no longer maintain separate copies
- `@import` auto-patch: `init`/`gen-claude-md --write` inserts missing `@import .claude/rules/bridge-tools.md` into existing CLAUDE.md installations
- `isBridgeToolsFileValid()`: repairs zero-byte or corrupted `bridge-tools.md` instead of skipping
- EACCES/write errors emit `[warn]` with remediation instructions instead of crashing
- Scheduled-tasks nudge added to `init` Next Steps output
- 10 new tests (instructionsUtils unit + init @import patch, repair, idempotency)

**v2.11.1 shipped (2026-04-04) — enforce bridge tools via MCP instructions:**
- `buildInstructions()` in both `bridge.ts` and `orchestratorBridge.ts` injects BRIDGE TOOL ENFORCEMENT block on every MCP handshake (zero-config)
- LSP readiness signal: extension notifies bridge when language server finishes indexing; `lspWithRetry` skips retry delays for known-ready languages

**v2.11.0 shipped (2026-04-04) — bridge-tools rules file + @import:**
- `templates/bridge-tools.md`: mandatory substitution table (runTests/getDiagnostics/gitCommit/searchWorkspace vs shell equivalents)
- `init`/`gen-claude-md --write` write `.claude/rules/bridge-tools.md`; `CLAUDE.bridge.md` template loads it via `@import`
- `orient` prompt Phase 3c scaffolds the file for users who onboard via prompt

**v2.7.x shipped (2026-04-03) — MCP outputSchema + security hardening:**
- v2.7.0: 12 tools declare typed outputSchema + return `structuredContent`; Biome 2.x upgrade; `refactorPreview`/`applyCodeAction` lazy resolution fix
- v2.7.1: OAuth CSRF flowId fix, `structuredContent` AJV validation, HTTP body streaming OOM fix, Origin: null removed

**v2.6.1 shipped (2026-03-26) — `shim` subcommand + init MCP auto-config + orchestrator fix:**
- `shim` subcommand: `claude-ide-bridge shim` replaces the hardcoded `mcp-stdio-shim.cjs` path in MCP configs; stable across npm updates
- `init` now registers the shim in `~/.claude.json` automatically (step 3 of setup)
- Orchestrator 0-tools bug fixed: bridge no longer marked healthy when `listTools()` returns empty; stays warming and retries next cycle
- Help text updated with `shim` subcommand docs

**v2.6.0 shipped (2026-03-25) — slim mode default + `init` subcommand:**
- Default tool set narrowed to 29 IDE-exclusive tools; `--full` restores git/terminal/file ops/HTTP/GitHub (~95 total)
- `SLIM_TOOL_NAMES` exported Set drives both registration filter and tests
- `init` subcommand: one-command setup (install extension + write CLAUDE.md + print next steps)
- `start-all.sh`: `--full` passthrough flag + slim mode warning in pane 0
- Startup banner now prints tool mode (slim/full) with `--full` hint
- 9 new tests in `slimMode.test.ts`; integration tests get `fullMode: true` so they exercise full transport surface
- README Quick Start reduced to 3 lines using `init`; MCP Tools section replaced with two-table slim/full layout
- Multi-IDE Orchestrator: added "when to use" gate (50k+ lines) and "where not worth it" guidance
- Persona 6 (Multi-IDE Orchestrator User) added to ICPs.md

**v2.5.9–2.5.11 shipped (2026-03-25) — dispatch-error restore + CI migration to Oolab-labs:**
- Restored dispatch-error design for `extensionRequired` tools (regression from orchestrator work): tools always visible in `tools/list`; calling while disconnected returns `isError: true`
- CORS OPTIONS preflight now only sends headers when origin validates (server.ts)
- `SubprocessDriver`: settings file re-written before each `run()` to survive `/tmp` cleanup on long-running servers
- `mcp-stdio-shim.cjs`: removed leftover debug comment; `hasConnectedSuccessfully` flag prevents stale message replay on reconnect
- `pluginWatcher.ts`: rollback comment clarifies prefix-rename edge case
- `package.json`: `scripts/start-vps.sh` added to npm `files` array (was missing from published package)
- CI migrated from `kungfuk3nnyyy/claude-ide-bridge` to `Oolab-labs/claude-ide-bridge` as primary repo
- Oolab sync job removed from CI workflow; all secrets (`OOLAB_PAT`, `NPM_TOKEN`, `VSCE_PAT`, `OVSX_PAT`) moved to Oolab repo
- Extension `v1.0.12` published to VS Code Marketplace + Open VSX

**v2.5.8 shipped (2026-03-23) — security hardening + onboarding fixes:**
- 7 security findings resolved: unbounded `registeredClients` DoS cap + GC (HIGH), duplicate `timingSafeEqual` consolidated into `src/crypto.ts` (HIGH), curl `--unix-socket`/`--netrc-file`/`-w` blocked in `runCommand` (MEDIUM), `lastTrigger` set after enqueue in `handleFileSaved`/`handlePostCompact` (MEDIUM), WS Host header allowlist extended to `--cors-origin` hostnames (MEDIUM), `resolveFilePath` fails closed on ancestor walk exhaustion (LOW)
- Onboarding docs: plugin README Quick Start, extension install step, env var, `--watch` default; SETUP.md Remote Control sections removed; `install-extension` positional arg fixed; CHANGELOG gaps filled
- `source: 'settings'` plugin support documented (Option 3 in plugin README)

**v2.5.7 shipped (2026-03-23) — agent frontmatter tightening (Claude Code 2.1.78):**
- All 3 subagents: `maxTurns` limits (30/20/15) + `disallowedTools: deleteFile`; code-reviewer also blocks Edit/Write
- Prevents runaway loops and accidental file deletion

**v2.5.6 shipped (2026-03-23) — regression tests + docs:**
- Bridge: 1349 tests (+8 runCommand tests for -f/-r per-command flag blocking and curl output flags)
- Extension: 406 tests (+12: `httpProbe.test.ts` new, 4 multi-bridge lockfiles tests)
- docs: `platform-docs.md` + `styleguide.md` updated for v2.5.x behavioral changes

**v2.5.5 shipped (2026-03-23) — Claude Code 2.1.80/81 alignment:**
- `-f`/`-r` flags moved from global `DANGEROUS_PATH_FLAGS` to per-command `DANGEROUS_FLAGS_FOR_COMMAND` table
- `effort` frontmatter added to all 9 skills (low/high)
- `session-info.sh`: reads `rate_limits` from hook payload; shows 5h/7d quota when above threshold
- `CHANGELOG.md`: documented all v2.5.x changes

**v2.5.4 shipped (2026-03-23) — Claude Code 2.1.81 hooks:**
- `ElicitationResult` hook + `elicitation-result.sh` script — silent on submit, warns on cancel/timeout
- `SubprocessDriver`: `--bare` flag added to suppress hook loops in scripted `-p` calls
- `effort` frontmatter research + planning

**v2.5.2–2.5.3 shipped (2026-03-23) — security hardening:**
- CRITICAL: OAuth open redirect fixed — `redirect_uri` validated against registered client map
- HIGH: `handleRegister` validates https/localhost + scope against `SUPPORTED_SCOPES`
- HIGH: curl `-o`/`--output`/`-O`/`--remote-name`/`-D`/`--dump-header`/`-K` added to `DANGEROUS_PATH_FLAGS`
- HIGH: `runInTerminal` extension timeout now returns error (no subprocess fallback / double-execute)
- MEDIUM: `isValidRef` now allows `HEAD~3`, `HEAD^`, `stash@{0}`; `applyEditsToContent` validates endLine/endColumn
- MEDIUM: `vitestJest` throws on exitCode 127/null; automation `lastTrigger.set` moved after successful enqueue

**v2.5.1 shipped (2026-03-22) — UX hardening:**
- 401 token mismatch → VS Code notification with "Reload Window" button
- Multiple bridge instances at connect → VS Code warning with port list
- `gen-mcp-config.sh`: `--fixed-token` warning after generating remote config

**v2.4.11 shipped (2026-03-20) — Dispatch, Agent Teams, and Scheduled Tasks integration:**
- 7 new MCP prompts (15 total): 5 Dispatch-optimized (`project-status`, `quick-tests`, `quick-review`, `build-check`, `recent-activity`) + 2 team/schedule (`team-status`, `health-check`)
- Dispatch prompts: read-only information retrieval with phone-screen-friendly output (under 20 lines)
- `team-status`: workspace state, active tasks, recent activity for team leads coordinating parallel agents
- `health-check`: comprehensive project health with HEALTHY/DEGRADED/FAILING grading (tests, diagnostics, security)
- 3 scheduled task SKILL.md templates in `templates/scheduled-tasks/` (nightly-review, health-check, dependency-audit)
- Cowork context template: `templates/dispatch-context.md` maps terse phone commands → bridge tools
- README: 3 new sections (Dispatch, Agent Teams, Scheduled Tasks) with architecture diagrams and setup guides
- `templates/CLAUDE.bridge.md` updated with Dispatch + team/schedule quick-reference tables
- 16 new prompt tests (38 total in prompt suite); build + lint clean

**v2.4.10 shipped (2026-03-19) — Full OAuth 2.0 for claude.ai custom connectors:**
- `--issuer-url <url>` flag: activates OAuth 2.0 mode; sets issuer in all discovery documents
- `--cors-origin <url>` flag (repeatable): adds `Access-Control-Allow-Origin` for specific origin on ALL responses (including 401s); env var `CLAUDE_IDE_BRIDGE_CORS_ORIGINS` (comma-separated)
- RFC 9396 `/.well-known/oauth-protected-resource` endpoint (claude.ai probes this before OAuth)
- RFC 7591 `POST /oauth/register` dynamic client registration (claude.ai registers client_id before PKCE)
- Approval page: bridge token entered in browser at `/oauth/authorize` (no more `?token=` URL)
- POST `/oauth/authorize` route fixed (was GET-only; form submission fell through to 401)
- CORS headers on ALL responses (was only OPTIONS preflight)
- WWW-Authenticate: includes `resource_metadata` link; no `error=invalid_token` when no token presented
- Clean build: `npm run build` always wipes `dist/`; `prepublishOnly` smoke-checks `--issuer-url` in binary
- Comprehensive developer documentation: CLAUDE.md expanded (7 new sections), 5 ADRs, `.cursorrules` for Cursor IDE
- Biome pre-commit hook via husky + lint-staged

**v2.4.1 shipped (2026-03-19) — VPS/headless tool improvements + deploy overhaul:**
- `openInBrowser`: detects headless server (no DISPLAY/WAYLAND_DISPLAY); serves HTML over a one-shot loopback HTTP server and returns URL + SSH tunnel instructions instead of silently calling `xdg-open`
- `getDiagnostics`: timeoutMs 5s → 30s (CLI linters cold-start on VPS disk)
- `getBufferContent`: timeoutMs 5s → 15s (readline streaming on slow storage)
- `runInTerminal`: description leads with subprocess fallback story for VPS/SSH
- `listTerminals`/`getTerminalOutput`: point to `runInTerminal` when extension absent on headless
- `openFile`: headless no-editor message now explains tracked state and suggests `editText`/`getBufferContent`
- `config`: `VPS_ALLOWLIST_EXTRAS` + `--vps` flag adds curl, systemctl, journalctl, nginx, pm2, docker to runCommand allowlist; wired into `start-vps.sh` and systemd service
- `deploy`: full overhaul — `bootstrap-new-vps.sh` handles fresh server end-to-end (Node.js, clone, build, user, ufw, systemd, nginx, Certbot); `install-vps-service.sh` becomes idempotent updater; all paths/domains parameterised via env vars (nothing hardcoded); template reference files added

**v2.1.36 shipped (2026-03-17) — correctness sweep + SecretStorage fix:**
- Signal propagation: `searchAndReplace`, `lsp.ts` tools, `getDocumentSymbols`, `generateTests`, `terminal.ts` — cancellation now flows through to extension requests and file I/O
- `getBufferContent`: fd leak on stream error fixed (rl.close + stream.destroy); `fs.readFile` now receives signal
- Extension `clipboard.ts` + `debug.ts`: `writeText` and `stopDebugging` wrapped in try-catch — returns structured error instead of crashing handler
- `connection.ts` / `extension.ts`: SecretStorage updated on lock file read (not just on successful connect) — stale token no longer persists across bridge restarts
- Tests: `getBufferContent.test.ts` (new), `searchAndReplace` signal tests, clipboard/debug error-path tests
- npm `claude-ide-bridge@2.1.36` published; extension v1.0.8 published to VS Code Marketplace + Open VSX

**Post-v2.1.35 (2026-03-17) — CI fixes + claude.ai web support (no version bump):**
- `scripts/gen-mcp-config.sh`: new `claude-web` target — prints URL/auth/token to paste into claude.ai Settings → Custom Connectors
- `README.md`: new "Use with Claude.ai Web" section with prerequisites, setup command, and token rotation notes
- `biome.json`: added `.claude/worktrees` to ignore list — worktree copies of extension package.json were triggering formatter CI failures
- `vscode-extension/package.json`: biome auto-format (single-item arrays → inline) — was causing CI failures since v1.0.5
- `src/__tests__/bridge-supervisor.test.ts`: 50ms settle delay before SIGTERM — supervisor logs "starting bridge" before spawn(), race was visible on Linux CI
- CI now green on `main` (6776f16)

**v2.1.35 shipped (2026-03-17) — PreToolUse/WorktreeCreate hooks + worktree isolation docs:**
- `claude-ide-bridge-plugin/hooks/hooks.json`: added `PreToolUse` hook (path normalization via `updatedInput`) and `WorktreeCreate` hook (worktree ↔ bridge workspace mapping)
- `claude-ide-bridge-plugin/scripts/pre-tool-use.sh` (new): resolves relative `path`/`filePath`/`uri`/`file` args to absolute paths using the bridge workspace root; skips built-in Claude Code tools; silent no-op when no patch needed
- `claude-ide-bridge-plugin/scripts/worktree-create.sh` (new): same-repo detection via `git rev-parse`; warns about LSP/extension tool limitations in worktree agents
- `docs/worktree-isolation.md` (new): safe vs unsafe tool categories in worktree agents, recommended `disallowedTools` pattern, multi-bridge setup, summary table
- Bridge plugin now has 7 hooks: PreToolUse, PostToolUse, SessionStart, InstructionsLoaded, Elicitation, WorktreeCreate, SubagentStart
- npm `claude-ide-bridge@2.1.36` published; extension unchanged (v1.0.6)

**v2.1.34 shipped (2026-03-17) — Claude Code platform alignment:**
- `claude-ide-bridge-plugin/hooks/hooks.json`: added `InstructionsLoaded` hook (fires on every CLAUDE.md load, not just session start — delivers live bridge status each time Claude refreshes its instructions) and `Elicitation` hook (pre-answers file/path/uri fields in elicitation requests using the active editor, avoiding "which file?" interruptions)
- `claude-ide-bridge-plugin/scripts/instructions-loaded.sh` (new): same status format as `session-info.sh` — port, tool count, extension state, workspace
- `claude-ide-bridge-plugin/scripts/elicitation.sh` (new): reads elicitation schema from stdin, queries bridge `/health` for `activeFile`, returns pre-filled field value or exits silently
- `templates/CLAUDE.bridge.md`: added "Modular rules" section — `.claude/rules/` scoped files + `@import` syntax guidance
- `docs/remote-access.md`: added "Env var expansion" section — `${BRIDGE_TOKEN}` in `.mcp.json` keeps tokens out of config files
- `scripts/gen-mcp-config.sh`: added env var tip to remote target output
- No code changes, no test changes — hooks/scripts/docs only

**v2.1.33 shipped (2026-03-17) — extension disconnect UX, handler correctness, plugin fixes:**
- `transport.ts`: `extensionRequired: true` tools are NO LONGER hidden from `tools/list` when the extension disconnects. They remain always visible. Calling them while disconnected returns `isError: true` with reconnect instructions. The `isExtensionConnectedFn` is now used in the dispatch path (error gate) instead of the list filter.
- `vscode-extension/src/handlers/codeActions.ts`: all `vscode.commands.executeCommand` calls wrapped in try-catch; returns `{ error: msg }` on failure instead of throwing.
- `vscode-extension/src/handlers/lsp.ts`: same try-catch treatment; error shapes return null / empty arrays / `{ applied: false, error }` as appropriate.
- `vscode-extension/src/handlers/screenshot.ts`: replaced `readFileSync` with async `readFile` + 3-attempt retry (50ms apart); unique temp file per call (timestamp + random suffix).
- `vscode-extension/src/bridgeProcess.ts`: `process.kill(pid, 0)` liveness check before connecting to a lock file; dead bridge stale locks skipped immediately.
- `vscode-extension/src/extension.ts`: `deactivate()` logs "Extension deactivating" via output channel.
- `vscode-extension/src/handlers/selection.ts`: returns `{ error: "No active editor" }` instead of `null`.
- `src/pluginLoader.ts`: `BRIDGE_VERSION` now reads from `PACKAGE_VERSION` (was hardcoded `"2.1.23"`).
- `src/index.ts`: `gen-plugin-stub` scaffold now includes `_signal` param.
- `src/tools/handoffNote.ts`: unused `sessionId` param renamed to `_sessionId`.
- Bridge tests: 1222 (unchanged); Extension tests: 369 (↑7 from 362).

**v2.1.32 shipped (2026-03-17) — session persistence correctness & robustness sweep:**
- `sessionCheckpoint.ts`: `CheckpointData` now includes `workspace?: string` field; `loadLatest()` accepts optional `workspace` param and filters checkpoints by workspace — prevents cross-instance contamination when multiple bridge instances share the same `~/.claude/ide/` directory; legacy checkpoints without the field still load (upgrade compat)
- `sessionCheckpoint.ts`: stale checkpoint rejection now emits `console.warn` instead of silently discarding — improves diagnosability on systems with significant clock skew
- `bridge.ts`: workspace passed to `SessionCheckpoint` constructor and `loadLatest()` — ensures checkpoint isolation per workspace
- `claudeOrchestrator.ts`: task file path respects `CLAUDE_CONFIG_DIR` env var instead of being hardcoded to `~/.claude` — consistent with lock file, activity log, and checkpoint path handling
- `handoffNote.ts`: handler enforces 10 000 char limit on `note` content; `updatedBy` is now always `"cli"` (was incorrectly set to the raw session UUID)
- `activityLog.ts`: entries loaded from disk are now type-validated (`status`, `timestamp`, `durationMs` checked) — prevents corrupted on-disk entries from poisoning in-memory state
- 8 new tests (checkpoint workspace filtering: 3, handoff validation: 2, activityLog load validation: 2, orchestrator config dir: 1); 1222 bridge tests total (↑ from 1214)

**v2.1.31 shipped (2026-03-16) — plugin hot-reload bug hunt fixes:**
- `transport.ts`: `deregisterToolsByPrefix("")` empty-prefix guard — prevents accidental wipe of all tools
- `pluginWatcher.ts`: `stopped` flag checked in `scheduleReload` — post-`stop()` timers are no-ops
- `pluginWatcher.ts`: `reloadInFlight` per-spec guard — concurrent reloads for the same plugin are serialised (second reload reschedules rather than racing)
- `pluginWatcher.ts`: per-transport try/catch with rollback — `replaceTool` throw leaves old tools in place instead of split state + unhandled rejection
- `bridge.ts`: `addTransport` moved before `registerAllTools` — closes race where reload fires between the two and new transport never gets patched
- `streamableHttp.ts`: HTTP sessions now receive plugin tools — `getPluginTools` / `getPluginWatcher` callbacks threaded through `StreamableHttpHandler`; HTTP sessions tracked in `PluginWatcher` for live reload
- `config.ts`: warning emitted when `--plugin-watch` is used without `--plugin`
- Tests: false-positive cache-busting test fixed (handlers now called); `timeoutMs` forwarding actually asserted; `FSWatcher.close()` asserted in stop test; zero-transport reload → `getTools()` correctness; `loadPluginsFull` direct coverage; entrypoint path-traversal guard tested; `replaceTool` AJV cache clear proven via schema change; insert path tested; 4 new tests → 1214 total (↑ from 1210)

**v2.1.30 shipped (2026-03-16) — plugin hot-reload:**
- `--plugin-watch` CLI flag (and `pluginWatch: boolean` config key) — re-loads plugins automatically on file change
- `src/pluginWatcher.ts` (new): `PluginWatcher` class with per-plugin `fs.watch()`, 300ms debounce, per-transport `deregisterToolsByPrefix` + `replaceTool`, `getTools()` for new-session correctness, and `stop()` for clean shutdown
- `pluginLoader.ts`: `LoadedPlugin` type (spec + dir + manifest + tools), `loadOnePluginFull()` / `loadPluginsFull()` exported; cache-busting `?t=<timestamp>` import URL prevents Node ESM cache from returning stale module on reload
- `transport.ts`: `replaceTool()` (upsert with AJV cache invalidation) and `deregisterToolsByPrefix()` (bulk remove by prefix)
- Reload safety: failed reload leaves old tools in place; new sessions after reload get fresh tools via `pluginWatcher.getTools()`
- `notifications/tools/list_changed` broadcast after every successful reload
- 14 new tests (pluginWatcher: 8, transport: 3, pluginLoader: 3); 1210 bridge tests (↑ from 1196)

**v2.1.29 shipped (2026-03-16) — correctness sweep:**
- `bridge.ts`: restored `openedFiles` Set now copied (`new Set(captured)`) — sessions no longer share a mutable reference; null-out is atomic with capture (H-1, H-2)
- `pluginLoader.ts`: `existingNames.add()` moved inside `loadOnePlugin` — collision guard correct even if loader is ever parallelised (H-3); entrypoint escape check uses `path.relative` not string prefix (L-2)
- `organizeImports.ts`: both post-operation `readFileSync` calls wrapped in try/catch — graceful error instead of unhandled throw if file deleted after organize (H-4)
- `transport.ts`: elicitation response detection requires `result` or `error` field — malformed requests no longer routed to `pendingElicitations` (M-1); misleading `safeResult` variable removed (M-2)
- `sessionCheckpoint.ts`: `loadLatest` selects newest file by `savedAt` JSON field, not filesystem mtime — correct under file-copy/backup scenarios (M-3)
- `getOpenEditors.ts`: `openedFiles.delete()` deferred until after iteration completes — transiently-unresolvable files no longer permanently evicted (M-4)
- `index.ts`: gen-claude-md writes `.tmp` before backup rename — original intact if write fails (M-6); scoped npm package names (`@org/pkg`) produce valid `name` in generated package.json (L-4)

**v2.1.28 shipped (2026-03-16) — security hardening round 2:**
- Plugin entrypoint path traversal (CRITICAL): `pluginLoader.ts` containment check before `import()` — `startsWith(pluginDir + sep)` guard
- Checkpoint path injection (CRITICAL): `extractRestoredFiles` now calls `resolveFilePath` per file; workspace-escaping paths silently dropped
- `gen-plugin-stub` code injection (HIGH): `--name` format validated `/^[a-zA-Z0-9@._/-]{1,100}$/`; all template interpolations use `JSON.stringify()`
- `install-extension` arbitrary executable (HIGH): `KNOWN_EDITORS` allowlist check for bare editor names before `execFileSync`
- `resources.ts` multi-hop symlink bypass (HIGH): `realpathSync` re-check after `lstatSync` catches ancestor directory symlinks
- Elicitation prototype pollution (MEDIUM): `__proto__` / `constructor` / `prototype` keys rejected in elicitation result handler
- Checkpoint future timestamp bypass (MEDIUM): `savedAt > Date.now() + 5_000` guard in `loadLatest`
- `automation.ts` pattern validation (LOW): `onFileSave.patterns` capped at ≤100 entries × ≤1024 chars each
- `getOpenEditors` fallback path safety (supporting fix): `resolveFilePath` called before `stat()` in native fallback loop
- 1196 bridge tests (↑ from 1195)

**v2.1.27 shipped (2026-03-16) — persistent session state (openedFiles restore):**
- `extractRestoredFiles(checkpoint)` — exported pure function collects union of openedFiles across all checkpoint sessions
- `Bridge.restoredOpenedFiles` — consumed by the first connecting session after restart, then cleared; subsequent sessions start empty
- `Bridge.getPort()` / `Bridge.getAuthToken()` — accessors for test inspection without calling `Bridge.start()`
- Checkpoint log improved: now reports file count and port rather than listing all paths
- 10 new tests in `src/__tests__/bridge-session-restore.test.ts` (5 unit + 5 integration scaffold)
- 1195 bridge tests (↑ from 1185)

**v2.1.26 shipped (2026-03-16) — plugin type exports:**
- `package.json` `exports` map: `"."` → `dist/index.{js,d.ts}`, `"./plugin"` → `dist/plugin.{js,d.ts}`
- `types` field added for tooling that doesn't read `exports`
- `import type { PluginContext } from 'claude-ide-bridge/plugin'` now resolves correctly for TypeScript plugin authors
- No new tests needed — covered by existing typecheck + build

**v2.1.25 shipped (2026-03-16) — plugin developer experience:**
- `gen-plugin-stub <dir> [--name <org/name>] [--prefix <prefix>]` subcommand — scaffolds manifest + `index.mjs` + `package.json` in one command
- `documents/plugin-authoring.md` — full plugin author reference (manifest schema, PluginContext API, tool schema, security model, npm distribution guide)
- Help text updated: all four subcommands now listed under `Subcommands:` in `--help`

**v2.1.24 shipped (2026-03-16) — plugin system + test gap closure:**
- Dynamic plugin loading: `--plugin <path>` CLI flag + `plugins` config file key
- `src/plugin.ts`: public type contract for plugin authors (`PluginContext`, `PluginManifest`, `PluginRegistration`, `PluginSafeConfig`)
- `src/pluginLoader.ts`: manifest validation, `toolNamePrefix` enforcement, cross-plugin collision detection, dedup, error isolation, inline semver check, authToken exclusion from `PluginSafeConfig`
- Transport: `registerTool()` now throws on duplicate name; `ToolSchema` exported
- 20 new pluginLoader tests; 5 new config tests (`--plugin` flag); 1 new transport test (duplicate-name throw)
- 1195 bridge tests (↑ from 1180)

**v2.1.23 shipped (2026-03-16) — extension handler test coverage:**
- 51 tests across 6 previously uncovered extension handler files (clipboard, inlayHints, typeHierarchy, validation, vscodeCommands, workspaceSettings)
- Fixed `__reset()` to also reset `env.clipboard.readText`
- Extension: 362 tests (↑ from 311); Bridge: 1158 tests

**v2.1.22 shipped (2026-03-16) — coverage sweep complete:**
- 38 new tests covering 7 previously untested tools: activityLog, setEditorDecorations, clearEditorDecorations, getCurrentSelection, getLatestSelection, getInlayHints, setActiveWorkspaceFolder, getTypeHierarchy, getWorkspaceSettings, setWorkspaceSetting
- Bridge tool files now have full test coverage

**v2.1.21 shipped (2026-03-16) — 2 correctness fixes:**
- `fileOperations`: `deleteFile` with `useTrash: true` on a directory returned "recursive required" instead of "cannot trash without extension" — useTrash guard now runs before stat()
- `editText`: `applyEditsToContent` now validates that delete/replace edits include both `endLine` and `endColumn`; previously undefined `endColumn` silently produced a zero-width no-op

**v2.1.20 shipped (2026-03-16) — 4 bug fixes (openFile, clipboard, symlink):**
- `openFile`: `startLine` now correctly takes precedence over `startText` in the extension path (was inverted)
- `clipboard`: `truncateToBytes()` uses `Buffer.byteLength` for UTF-8 byte counting (not UTF-16 code units); `writeClipboard` enforces 1 MB server-side before invoking extension
- `utils`: `resolveFilePath` walks ancestor tree to catch symlinks at grandparent levels (e.g. `workspace/link/nonexistent/file.txt`)

**v2.1.19 shipped (2026-03-16) — test coverage round (+83 tests):**
- New test files: editText, fileOperations, cancelClaudeTask/getClaudeTaskStatus/listClaudeTasks, openFile, clipboard
- 1109 bridge tests (↑ from 1026)

**v2.1.18 shipped (2026-03-16) — 8 bug fixes (input validation, cache key, session header, JSON parser):**
- HIGH: `getSecurityAdvisories` cache key used raw `"auto"` not resolved manager; `isValidRef` accepted leading-dash refs (git flag injection); `findFiles` find fallback accepted `-`-prefixed patterns; streamableHttp sent session header in 504 response (client could reuse destroyed session)
- MEDIUM: `searchAndReplace` null byte in non-regex pattern caused misleading output; `vitestJest` JSON fast-path accepted wrong-shaped first match
- LOW: `cargoTest` PANIC regex mis-matched timestamp strings; `httpClient` timeout error name check missed Node <18.14 naming

**v2.1.17 shipped (2026-03-16) — captureScreenshot tool + test coverage:**
- `captureScreenshot`: `screencapture -x` (macOS) / `import -window root` (Linux); returns `{ type: "image", data, mimeType: "image/png" }` MCP image content block
- +72 tests across debug, getDocumentSymbols, fixAllLintErrors, formatDocument, fileWatcher, screenshot
- Bridge: 1017 tests; Extension: 311 tests

**v2.1.16 shipped (2026-03-15) — Remote Desktop IDE support:**
- `extensionKind: ["workspace"]` in extension package.json — loads in remote extension host for VS Code Remote-SSH and Cursor SSH
- `print-token [--port]` CLI subcommand — prints bridge auth token from lock file for headless VPS setup
- `scripts/gen-mcp-config.sh` `remote` target — generates HTTP MCP config from `--host` and `--token` without needing a lock file
- Extension bumped to v1.0.2

**v2.1.15 shipped (2026-03-15) — 2 correctness fixes:**
- Notification off-by-one: `notifCount > 500` → `>= 500` so the 500th notification is the first dropped
- `gitCheckout` detached HEAD: `previousBranch` now returns `null` (was the literal string `"HEAD"`); added `wasDetached: true` and `previousCommit` (12-char hash) for safe navigation back

**v2.1.14 shipped (2026-03-15) — 4 correctness fixes:**
- `getDiagnostics`: pre-aborted caller signal returns `[]` immediately (no subprocess spawned)
- `searchAndReplace`: glob values starting with `-` rejected (rg flag injection prevention)
- `auditDependencies`: resolved manager name used as cache key (`"auto"` + `"npm"` now share one entry)
- `httpClient`: abort forwarder cleaned up from caller signal to prevent listener accumulation

**v2.1.13 shipped (2026-03-15) — 7 security/correctness fixes:**
- CRITICAL: `watchDiagnostics` TDZ ReferenceError when diagnostic update arrived mid-handler
- HIGH (security): `runCommand` `--flag=value` form bypassed dangerous-flag blocklist; `httpClient` user Host header could overwrite IP-pinning Host; terminal Unicode line/paragraph separators (U+2028/U+2029) bypassed newline injection check
- HIGH (correctness): `cargoTest` PANIC regex mis-match; `runTests` noCache eviction race (stale cache clobber); `getSecurityAdvisories` per-severity cache key caused redundant subprocesses
- 28 new regression tests; 937 total

**v2.1.12 shipped (2026-03-15) — template fixes:**
- `templates/CLAUDE.bridge.md`: added "Bug fix methodology" section (write failing test → fix → confirm); corrected stale tool names (`gitStatus` → `getGitStatus`, `gitDiff` → `getGitDiff`)

**v2.1.11 shipped (2026-03-15) — Quick Start accuracy + install-extension npm-global fix:**
- README Step 3: `CLAUDE_CODE_IDE_SKIP_VALID_CHECK=true claude --ide` — env var required for bridge discovery; omitting it silently broke all new users
- `install-extension` subcommand: falls back to marketplace ID when `vscode-extension/` absent (npm-global install); previously crashed with ENOENT
- README tool table: 12 wrong names corrected, 8 phantom tools removed, 8 missing tools added, header 137+→124+
- SETUP.md: labelled as development-mode guide

**v2.1.10 shipped (2026-03-15) — B2 dedup fix + A7 isCommand flag:**
- `getDiagnostics`: `runningPromises` stores `{promise, originSignal}`; aborted-origin entries cleared before dedup; `.finally()` uses reference equality to avoid evicting newer runs
- `sendTerminalCommand`: `isCommand?: boolean` (default `true`) — set `false` for REPL input to bypass shell-command validation

**v2.1.9 shipped (2026-03-15) — debug AbortSignal + watchDiagnostics pre-abort + gen-claude-md:**
- `debug.ts`: `signal?: AbortSignal` threaded through all four tool handlers to extensionClient
- `watchDiagnostics`: synchronous pre-abort check before Promise executor allocates resources
- `gen-claude-md` subcommand + MCP prompt: generates `CLAUDE.md` bridge workflow section; `templates/CLAUDE.bridge.md` ships with npm package

**v2.1.8 shipped (2026-03-15) — persistent task queue:**
- Task queue persists across bridge restarts via `~/.claude/ide/tasks-<port>.json` (v1 envelope)
- `flushTasksToDisk()` synchronous pre-shutdown flush; pending tasks re-enqueued on startup with stable IDs
- Running tasks saved as `"interrupted"` status; `loadPersistedTasks()` handles v0/v1 format + overflow demotion
- 10 new persistence tests; `flushTasksToDisk` called before `cancel()` in shutdown sequence

**v2.1.7 shipped (2026-03-15) — 8 tools-layer bug fixes:**
- `searchAndReplace`: per-file `new RegExp(regex.source, regex.flags)` — eliminates `lastIndex` race in `Promise.all`
- `getDiagnostics`: `linterErrors.delete(linter.name)` on success; `linterErrors: {}` on all response paths
- `runTests`: `runningPromises.delete(key)` in `noCache` block alongside `caches.delete`
- `watchDiagnostics`: re-check timestamp after `addDiagnosticsListener` to close TOCTOU window
- `gitWrite`: post-commit `git diff-tree --no-commit-id -r --name-only HEAD` for accurate file list; blame parser `!currentHash` guard
- `fileOperations`: hardlink cleanup on `unlink` failure in native rename fallback
- `terminal.ts`: `timeoutMs` raised to 310 000 ms on `waitForTerminalOutput` + `runInTerminal`

**v2.1.6 shipped (2026-03-15) — schema/description QoL fixes:**
- `getDiagnostics`: `linterErrors` always present (empty `{}` when clean); removed conditional spread
- `getFileTree`: schema description documents skipped dirs (node_modules, .git, dist, etc.)

**v2.1.2–v2.1.5 shipped (2026-03-15) — getSecurityAdvisories cargo + pip-audit:**
- `runCargoAudit()`: `cargo audit --json` parser; RUSTSEC advisory format; patched versions as fix hint
- `runPipAudit()`: `pip-audit --format=json` parser; per-dep multi-vuln expansion; PYSEC IDs
- `detectAuditor()`: Cargo.toml → cargo; requirements.txt / pyproject.toml → pip
- Schema enum: `auto/npm/yarn/pnpm/cargo/pip`; ENOENT install hints for both tools
- 8 new tests (cargo: 3, pip: 4, no-manifest: covered); 926 bridge tests total

**v2.1.1 shipped (2026-03-15) — getSecurityAdvisories yarn/pnpm parity:**
- `runYarnAudit()`: JSONL `auditAdvisory` event parsing for `yarn audit --json`
- `runPnpmAudit()`: same npm v7 JSON shape via `pnpm audit --json`
- `detectAuditor()`: lock-file priority pnpm > yarn > npm (parity with `auditDependencies`)
- Shared `parseNpmAuditJson()` helper; schema enum updated to `auto/npm/yarn/pnpm/cargo/pip`
- 4 new tests; 909 bridge tests total

**v2.1.0 shipped (2026-03-15) — Phase 3: /stream SSE + yarn/pnpm audit + CI hardening:**
- `GET /stream`: SSE endpoint for real-time activity log push (Bearer auth, keep-alive pings, per-connection unsubscribe)
- `activityLog.subscribe()`: listener/unsubscribe pattern; disk I/O converted to async fire-and-forget
- `auditDependencies`: yarn 1.x (JSONL table-event) + pnpm support; lock-file detection order
- CI: loose 500ms PR threshold; strict 100ms on main only; `publish-extension.yml` workflow fixed
- Extension v0.9.9 / v1.0.0 (VS Code Marketplace); bridge v2.1.0; 905 tests

**v2.0.9 shipped (2026-03-15) — P2/P3 code review fixes:**
- Double `list_changed` broadcast eliminated; `callCount`/`errorCount` stat skew fixed
- `activityLog` async disk I/O; `generateAPIDocumentation` O(N²) + regex backtracking fixes
- `resources.ts` MAX_WALK_DEPTH=20; CORS `corsOrigin()` http-only; 897 tests

**v2.0.8 shipped (2026-03-15) — Supervisor mode + serverInfo meta + Cowork UX:**
- `--watch` flag: self-supervising wrapper with exponential backoff (2s→30s, SIGTERM-safe)
- `serverInfo._meta.packageVersion` in MCP `initialize` response (disambiguates protocol vs package version)
- `/cowork` prompt: two-step handoff framing, `setHandoffNote` template, Cowork MCP gap warning
- CI matrix expanded to Ubuntu + Windows × Node 20 + 22; 873 tests

**v2.0.7 shipped (2026-03-15) — Security hardening + critical/major/minor bug fixes:**
- CORS lockdown, lockfile TOCTOU fix, concurrent tool call routing, atomic checkpoints
- Elicitation validation, OTel coordination, DebugState safe extraction, resources URI decoding
- Extension fixes: terminal handler, events readyState, clearAllTerminalBuffers guard; 864 tests

**v2.0.6 shipped (2026-03-15) — 8-gap remediation:**
- E2E integration tests, per-session rate limiting, `/ping` endpoint, untrusted workspace gate
- Windows CI matrix, `claudeDriver.ts` unit tests, `extension.ts` unit tests; 864 tests

**v2.0.5 shipped (2026-03-15) — Extension auto-installs and auto-starts bridge:**
- `BridgeInstaller`, `BridgeProcess`, `connectDirect()` — install extension → done

**v2.0.1 shipped (2026-03-14) — Desktop reliability + cross-session handoff:**
- Lock file now includes `isBridge: true`; stdio shim `findLockFile()` prefers bridge locks over IDE-owned locks — fixes auto-discovery collision when Windsurf (or any other IDE) writes its own lock file to `~/.claude/ide/`
- New tools: `setHandoffNote` / `getHandoffNote` — file-backed (`~/.claude/ide/handoff-note.json`), shared across all MCP sessions; enables context handoff between Claude Desktop and Claude Code CLI
- **Shim lock-file watcher**: `fs.watch(~/.claude/ide/)` in auto-discover mode — shim reconnects automatically when bridge restarts on a new port; Claude Desktop no longer needs a full quit+relaunch on bridge restart
- 4 new tests in `src/tools/__tests__/handoffNote.test.ts`

**v2.0.0 shipped (2026-03-14) — Streamable HTTP + Claude Desktop:**
- New transport: `src/streamableHttp.ts` — MCP Streamable HTTP spec (POST/GET/DELETE /mcp), SSE server push, session management (30min TTL, max 5)
- `HttpAdapter` class bridges HTTP request/response into WebSocket-like interface so `McpTransport.attach()` works unchanged
- Claude Desktop integration: `scripts/gen-claude-desktop-config.sh` writes stdio shim config; verified end-to-end
- `docs/remote-access.md`: Caddy/nginx reverse proxy setup, TLS, endpoint reference
- Security headers: `X-Content-Type-Options: nosniff` + `Cache-Control: no-store` on all responses
- 22 new tests in `src/__tests__/streamableHttp.test.ts` (828 total)
- Published: npm `claude-ide-bridge@2.0.0` ✅; Open VSX extension v0.9.0 ✅; tagged v2.0.0 on GitHub ✅

**v1.9.0 shipped (2026-03-14) — Claude Code 2.1.76+ compatibility:**
- Elicitation: `McpTransport.elicit()`, `elicitation: {}` in `initialize` capabilities and server card
- Automation: `OnPostCompactPolicy` (re-snapshot IDE state after compaction) + `OnInstructionsLoadedPolicy` (inject tool summary at session start) — both fire via Claude Code 2.1.76+ hooks
- `model` param on `runClaudeTask` + `resumeClaudeTask` (passed as `--model` to SubprocessDriver)
- `set-effort` MCP prompt: 6th slash command (low/medium/high effort instruction)
- `start-all.sh`: `--name bridge:<workspace>` session display; `CLAUDE_CODE_SESSIONEND_HOOKS_TIMEOUT_MS=10000`
- `--config` path length bound (4096 chars); `notifCount` reset comment; `CLAUDE_CODE_REMOTE` guard documented

**v1.8.0 shipped (2026-03-14) — Security hardening:**
- 13 security findings resolved across 3 High / 6 Medium / 3 Low / 1 Info
- `lstatSync` everywhere (symlink bypass prevention); walk cache TTL (5s) for resources
- Rate-limit-on-reconnect fix (no reset on `detach()`); hardlink guard via `{ write: true }` path
- `resumeClaudeTask` tool: re-enqueue completed/failed tasks preserving prompt + context
- httpClient SSRF guard (RFC 1918, link-local, CGNAT, hex IP); gitPush force-push blocked on main/master
- Structured `ToolErrorCodes` in `src/errors.ts`
- Extension: `syncInProgress` guard against concurrent `makeConnection` calls

**v1.7.0 shipped (2026-03-14) — Best Practices Hardening:**
- Tool annotations: `readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint` on all tools
- Lock file `chmod 600`; health monitor exponential backoff (5s→300s)
- `/.well-known/mcp/server-card.json` + `/.well-known/mcp` (MCP registry discovery, SEP-1649)
- OpenTelemetry: `src/telemetry.ts` wraps every tool call; activate via `OTEL_EXPORTER_OTLP_ENDPOINT`
- Token-aware concurrency: `MAX_TOKEN_BUDGET=500K` alongside `MAX_CONCURRENT=10`
- Task persistence to `~/.claude/ide/tasks-<port>.json`; `resumeClaudeTask` re-enqueues by ID
- Extension: `LogOutputChannel` (structured log levels); SecretStorage fallback for auth token

**v1.6.0 shipped (2026-03-14):**
- Claude Code Server Mode Integration: `claudeDriver.ts`, `claudeOrchestrator.ts`, `automation.ts`; 4 MCP tools; `GET /tasks`; `onDiagnosticsError` + `onFileSave` automation policies
- MCP Prompts: 5 slash commands (`review-file`, `explain-diagnostics`, `generate-tests`, `debug-context`, `git-review`)
- getDiagnostics hardening: control char stripping + 500-char cap on message text

---

## Claude Code Server Mode Integration *(Shipped — v1.6.0)*

The bridge can now spawn Claude subprocesses, queue tasks, and drive event-driven automation.

- `src/claudeDriver.ts`: `IClaudeDriver` interface + `SubprocessDriver` (spawns `claude -p`) + `ApiDriver` stub
- `src/claudeOrchestrator.ts`: Task queue with `MAX_CONCURRENT=10`, `MAX_QUEUE=20`, `MAX_HISTORY=100`. Exposes `enqueue()`, `runAndWait()`, `cancel()`, `list()`, `getTask()`
- `src/automation.ts`: `AutomationHooks` + `loadPolicy()` — handles `onDiagnosticsError` and `onFileSave` with cooldown and loop guard
- 4 new MCP tools: `runClaudeTask`, `getClaudeTaskStatus`, `cancelClaudeTask`, `listClaudeTasks` (session-scoped; only visible when `--claude-driver != none`)
- `GET /tasks` HTTP endpoint (Bearer-auth) for external monitoring
- VS Code output channel receives streamed Claude output in real time (`bridge/claudeTaskOutput` push notification)
- New CLI flags: `--claude-driver`, `--claude-binary`, `--automation`, `--automation-policy`
- Security: 32 KB prompt cap, `CLAUDECODE` env stripped from subprocess, workspace path confinement on context files, diagnostic message sanitization with delimiters
- **Bug fixes (2026-03-14 live test)**: Removed bogus `--workspace` flag from `claude -p` spawn args (flag doesn't exist in the CLI); added `stdio: ['ignore', 'pipe', 'pipe']` to prevent subprocess blocking on open stdin pipe; stripped all `CLAUDE_CODE_*` + `MCP_*` env vars from subprocess to prevent attaching to parent session ingress; added `--strict-mcp-config` to suppress `.mcp.json` auto-discovery in the workspace

---

## MCP Prompts *(Shipped — v1.6.0)*

5 built-in slash commands surfaced via the MCP `prompts` capability:

- `review-file` — code review using current diagnostics for a file
- `explain-diagnostics` — plain-English explanation + fix suggestions for all errors in a file
- `generate-tests` — test scaffold for exported symbols in a file
- `debug-context` — snapshot current debug state, editors, and diagnostics
- `git-review` — review all changes since a base branch (default: `main`)

Implemented in `src/prompts.ts`. No extension required. Transport handles `prompts/list` and `prompts/get` with the same cursor-pagination and validation as `tools`.

---

## Claude Code Platform Alignment (Shipped — v2.1.34–35)

Research (2026-03-17) against current Claude Code docs revealed gaps between the bridge's platform integration and what's now available. All items shipped.

### Shipped (v2.1.34)
- **`gen-claude-md` template** — `.claude/rules/` modular scoping and `@import` syntax documented
- **Env var expansion** — `${VAR:-default}` in `.mcp.json` documented in `docs/remote-access.md`
- **`InstructionsLoaded` hook** — live bridge status injected every time CLAUDE.md loads
- **`Elicitation` hook** — pre-answers file/path/uri fields using the active editor

### Shipped (v2.1.35)
- **`PreToolUse` hook with `updatedInput`** — resolves relative path args to absolute before bridge tools execute
- **`WorktreeCreate` hook** — reports bridge ↔ worktree relationship; warns about LSP tool limitations
- **`docs/worktree-isolation.md`** — safe vs unsafe tool categories, `disallowedTools` pattern, summary table

### Remaining (deferred)
- Verify Tool Search compatibility — with 135+ tools active; low priority (automatic, no bridge changes needed)
- Agent Teams — when Claude Code's multi-session Teams feature ships; plan session namespacing then
- **Claude Code Routines integration** — revisit when API exits research preview (`experimental-cc-routine-2026-04-01`). Immediate value: thin `runRoutine`/`getRoutineStatus`/`listRoutines` MCP tools (Phase 3 only — ~1 file, no driver changes). Full `RoutinesDriver` (`--claude-driver routines`) deferred until auth is stable (currently claude.ai accounts only, not open API). Policy-layer `routineId` on automation hooks also deferred. See: https://claude.ai/code/routines

---

## Near-Term Exploration Areas

### Subprocess Stdin Interaction — Auto-answer Claude prompts *(shipped)*
- **Resolved**: `SubprocessDriver` now passes `--dangerously-skip-permissions` by default (opt-out via `skipPermissions: false` in `ClaudeTaskInput`)
- stdout-scan + stdin-write approach was investigated and rejected: prompt injection attack vector, semantic ambiguity ("Delete all files?" and "Proceed?" look identical), chunk-boundary races, and fragility against CLI format changes
- **Known limitation**: session-selection and editor-selection prompts are not permission prompts — they may still hang. Requires a `--non-interactive` flag from the Claude CLI team (not yet available)

### `source: 'settings'` Plugin Support *(shipped — v2.5.8)*
- Documented `enabledPlugins` settings.json approach in `claude-ide-bridge-plugin/README.md` as Option 3 — no CLI flags needed; Claude Code loads the plugin automatically from the project root on startup

### Visual Output Skills *(medium-term)*
- Skills generating interactive HTML from bridge data (dependency graphs, test heatmaps, diagnostic dashboards)
- Uses `getCallHierarchy` + `findReferences` + `getCodeCoverage` output → D3 or similar
- No bridge code changes needed — skill-only

### Multi-Editor Support *(baselined)*
- Architecture is editor-agnostic (bridge doesn't import vscode)
- Extension installable into VS Code, Windsurf, Cursor, and Antigravity via `install-extension` command
- Auto-detection and name mapping for all four editors tested and passing
- JetBrains: no extension yet — would require a separate plugin (different extension API)

### Native Fallback Improvements *(complete)*
- Currently: extension disconnect → tools remain visible; calling them returns `isError: true` with reconnect instructions (changed in v2.1.33 — previously hid 27 tools)
- `listTasks` fallback shipped — parses `.vscode/tasks.json` + Makefile targets
- `watchDiagnostics` fallback shipped — runs detected CLI linters immediately, returns snapshot
- `organizeImports` fallback shipped — biome → prettier chain; 3 tests covering both CLI paths and the "no CLI available" error
- All others (terminal, debugger, LSP, decorations, VS Code commands) have no viable fallback — intentionally `extensionRequired`

### Test Coverage *(complete — 2026-03-17)*
- 1222+ bridge tests + 369 extension tests, 100 files; 0 failures
- Integration tests: 6 files, full WebSocket round-trip coverage
- All bridge tool files and extension handler files now have unit tests
- `searchAndReplace` rg-integration suite now runs on macOS (Claude binary shim) in addition to Linux CI; mocked-rg logic suite runs on all platforms

### Performance *(CI-gated 2026-03-14; sustained-load closed 2026-03-16)*
- Benchmark script: `node scripts/benchmark.mjs [--json] [--threshold <ms>]`
- CI runs benchmark on every push to main: 100 iterations, p99 > 100ms = build failure
- Baseline (50 iterations, loopback): all tools p50=0ms, p99=1ms — at Node.js timer resolution floor; confirmed for `searchWorkspace×200` and `getBufferContent` disk-path scenarios
- Benchmark results archived as GitHub Actions artifacts (30-day retention) for trend analysis
- `getBufferContent` large-file bug fixed (2026-03-16): size cap was checked before slicing — `startLine`/`endLine` params silently failed on files >512KB despite the error message instructing users to use them. Fixed via `stat()` + readline streaming for large files with a range; no-range requests on large files still error as before.

### Multi-Workspace Support *(shipped 2026-03-14)*
- Extension now connects to one bridge per VS Code workspace folder in multi-root workspaces
- `readAllMatchingLockFiles()` returns all valid lock files matching open workspace folders
- `BridgeConnection.workspaceOverride` scopes each connection to its workspace
- `registerEvents` broadcasts all VS Code events to all connected bridges
- Status bar shows aggregate state: "N/M connected"
- Workspace folder changes (add/remove) automatically create/dispose connections
- Non-VS Code editors (JetBrains, Neovim): not yet supported; WebSocket protocol documented in data-reference.md for community adapters

---

## Claude Code Platform Integration (NEW)

### Skills & Slash Commands (Shipped)
- 5 pre-built skills in `.claude/skills/`: `/ide-debug`, `/ide-review`, `/ide-quality`, `/ide-refactor`, `/ide-explore`
- Package existing use-case workflows as one-command invocations
- `disable-model-invocation: true` for action skills, `context: fork` for exploration
- Skills reference bridge MCP tools by name — no bridge code changes needed

### Custom Subagents (Shipped)
- 3 subagent definitions in `.claude/agents/`: `ide-code-reviewer`, `ide-debugger`, `ide-test-runner`
- Each uses bridge MCP tools in isolated context
- `memory: project` enabled for cross-session learning
- Subagents produce verbose output (LSP queries, terminal logs) that stays out of main context

### Plugin Packaging (Shipped)
- Full plugin in `claude-ide-bridge-plugin/`: manifest, skills, agents, hooks, MCP config, README
- Load with `claude --plugin-dir ./claude-ide-bridge-plugin`
- Includes 6 skills, 3 agents, 3 hooks, MCP server config
- Ready for marketplace distribution when bridge is published to npm

### Hook Integration (Shipped)
- `PostToolUse` on Edit/Write → reminds Claude to check diagnostics after edits
- `SessionStart` → reports bridge status, connection, tool count
- `SubagentStart` on ide-* agents → verifies bridge health before subagent runs
- All hooks in `claude-ide-bridge-plugin/hooks/hooks.json` with scripts in `scripts/`

### Scheduled IDE Monitoring (Shipped)
- `/ide-monitor` skill with 3 modes: diagnostics, tests, terminal
- Use with `/loop` for recurring checks: `/loop 5m /claude-ide-bridge:ide-monitor diagnostics`
- Session-scoped (requires active Claude Code session)

### Headless/Agent SDK Integration (Documented)
- Bridge MCP enables `claude -p` (headless mode) to have IDE capabilities
- CI/CD examples documented in plugin README
- Already works via `--mcp-config` pointing to bridge

### Agent Team Support
- Claude Code's experimental Agent Teams: multiple sessions sharing one bridge
- 3-5 agents working in parallel (security review + test fixing + PR creation)
- Requires: multi-session safety, file edit coordination, terminal namespacing
- Aligns with existing "Collaborative Features" roadmap item

### Visual Output Skills
- Skills that generate interactive HTML using bridge data
- Dependency graphs from `getCallHierarchy` + `findReferences`
- Test coverage heatmaps, diagnostic dashboards
- Follows Claude Code's codebase-visualizer pattern

---

## Medium-Term Possibilities

### Plugin Hot-Reload *(Shipped — v2.1.30)*
- `--plugin-watch` flag triggers `PluginWatcher` which monitors each plugin directory with `fs.watch()`
- 300ms debounce coalesces rapid editor saves into a single reload
- ESM cache-busting via `?t=<timestamp>` query param on dynamic `import()`
- Failed reload keeps old tools in place; `notifications/tools/list_changed` sent on success

### Plugin System *(Shipped — v2.1.24)*
- `--plugin <path>` CLI flag + `plugins` config file key
- `claude-ide-bridge-plugin.json` manifest: `schemaVersion`, `name`, `entrypoint`, `toolNamePrefix`, `minBridgeVersion`
- `PluginContext` passed to `register(ctx)`: `workspace`, `workspaceFolders`, `config` (`PluginSafeConfig` — no authToken), `logger`
- Accepts named `export function register()` or default export
- Collision detection, dedup, prefix enforcement, per-plugin error isolation

### Persistent Session State *(Shipped — v2.1.27; correctness fixes in v2.1.32)*
- `openedFiles` restored from checkpoint on restart — first connecting session is seeded with the union of all previously-tracked files
- Checkpoint data is now workspace-scoped (`workspace` field in `CheckpointData`) — multiple bridge instances no longer cross-contaminate each other's checkpoints
- All persistence paths (`checkpoint`, `activity log`, `task queue`) respect `CLAUDE_CONFIG_DIR` env var
- Activity log entries are type-validated on load from disk; `handoffNote.updatedBy` is always `"cli"` (stable, not a session UUID)
- Activity log already persisted to disk (v2.0.x); diagnostics are live from extension/CLI (no cache to restore)
- Task queue already persisted (v2.1.8)

### Spawn-a-Bridge *(exploration)*
- `spawnWorkspace(path)` tool: programmatically launch a bridge + IDE for a given path, block until extension handshake completes, return a ws handle
- Removes the manual two-IDE setup step — Claude could autonomously spin up a fresh reviewer workspace for a task
- **Target environment:** headless `code-server` deployments (VPS/CI) — desktop IDE spawn is too platform-specific and fragile
- **Prerequisite:** `code-server` installed with the extension pre-loaded; `--fixed-token` so the spawned bridge is discoverable
- **Mechanism:** bridge subprocess + lock file polling with timeout; orchestrator adopts the new lock file once extension connects
- **CI use case:** spin up a `code-server` + bridge per PR review, run staged LSP review via ws2, tear down after — no other tool offers this
- **Implement when:** there's a concrete CI/VPS workflow that needs it; the `init` subcommand already covers the setup half

### Anthropic Managed Agents MCP Integration *(watch — revisit when beta stabilises)*

Anthropic's [Claude Managed Agents](https://platform.claude.com/docs/en/managed-agents/overview) (beta as of 2026-04-08) supports attaching external MCP servers to an agent definition. The bridge is an MCP server and already has a remote-deployment path (OAuth 2.0 mode, `--bind 0.0.0.0`, nginx TLS, `deploy/` scripts), so the plumbing exists.

**Potentially interesting scenario:** VPS-hosted bridge attached to a Managed Agent session, giving the cloud agent real LSP grounding (live diagnostics, `findReferences`, `getCallHierarchy`, `getChangeImpact`) from an actual developer workspace rather than static file reads. This is something no Managed Agents built-in tool currently offers.

**Why it doesn't fit today:**
- Managed Agents run in cloud containers — they can't reach a user's *local* IDE. Extension-side tools (LSP hover, debugger, editor state) require the VS Code extension to be co-located.
- Built-in Bash + file ops in Managed Agents make the bridge's file/git tools redundant inside a container.
- Users running VS Code on a VPS (the one case where co-location works) are a small subset.
- MCP server attachment in Managed Agents is beta and the API surface may shift.

**Implement when:** Managed Agents exits beta *and* there's a concrete request from VPS/remote-IDE users who want long-running cloud tasks with real LSP intelligence. The OAuth 2.0 deployment track is the prerequisite — no new bridge work needed beyond that.

### Multi-Workspace Bridging
- One bridge instance serving multiple workspaces
- Currently: one bridge per workspace
- Challenges: tool scoping, lock file format changes, workspace isolation

### Collaborative Features
- Multiple Claude Code sessions sharing one bridge
- Coordination of file edits (optimistic locking?)
- Shared activity log visible to all sessions

---

## Architectural Constraints

These cannot change without breaking compatibility:

| Constraint | Value | Why |
|-----------|-------|-----|
| Lock file location | `~/.claude/ide/<port>.lock` | Claude Code CLI reads this path |
| Lock file format | `{ authToken, pid, workspace, ideName, isBridge: true }` | Contract with Claude Code; `isBridge` added for shim auto-discovery |
| MCP protocol version | `2025-11-25` | Must stay compatible with Claude Code's MCP client |
| Extension API | VS Code `^1.93.0` | Minimum supported VS Code version |
| Node.js | `>=20` | Uses modern APIs (crypto.randomUUID, etc.) |
| Tool name format | `/^[a-zA-Z0-9_]+$/` | MCP protocol requirement |

---

## Round Proposal Template

When proposing a new development round:

```markdown
## Round N: <Name>

### Problem
What issue or gap does this round address?

### Scope
- [ ] Task 1
- [ ] Task 2
- [ ] Task 3

### Affected Files
- `src/...`
- `vscode-extension/src/...`

### Test Plan
How will we verify correctness?

### Rollback Strategy
How do we revert if something goes wrong?

### Dependencies
What must be completed first?
```
