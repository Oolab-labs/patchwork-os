# Claude IDE Bridge — Roadmap

Development direction and exploration guidance. Living document — update as priorities shift.

---

## Current State (v2.1.10 — 2026-03-15)

- 137+ MCP tools; 926 bridge tests, 0 failures; CI on Node 20 + 22 (Ubuntu + Windows)
- Extension v1.0.1 on VS Code Marketplace + Open VSX; installable into VS Code, Windsurf, Cursor, and Antigravity (npm `2.1.10`)
- **Three transports**: WebSocket (Claude Code), stdio shim (Claude Desktop), Streamable HTTP (remote MCP clients)
- Production-grade connection hardening (circuit breaker, backoff, heartbeat, grace period, generation counter)
- Multi-linter and multi-test-runner support (auto-detected)
- GitHub integration (PRs, issues, actions, releases)
- Remote control support via `start-all.sh` orchestrator (tmux, health monitor, exponential backoff)
- Activity logging with Prometheus metrics; session checkpoint every 30s
- Claude Code Platform Integration fully shipped (6 skills, 3 subagents, plugin, hooks, `/ide-monitor`)
- MCP resources (`resources/list` + `resources/read`): workspace-confined, 1 MB cap, cursor-paginated
- MCP elicitation (`elicitation: {}` capability): `McpTransport.elicit()` sends `elicitation/create` to Claude Code 2.1.76+
- Deep security hardening: SSRF three-layer defense, Origin validation, rate limiting, lstatSync everywhere, TOCTOU mitigations, structured error codes
- Claude Desktop + Cowork integration documented; `setHandoffNote`/`getHandoffNote` for cross-session context

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

## Near-Term Exploration Areas

### Multi-Editor Support *(baselined)*
- Architecture is editor-agnostic (bridge doesn't import vscode)
- Extension installable into VS Code, Windsurf, Cursor, and Antigravity via `install-extension` command
- Auto-detection and name mapping for all four editors tested and passing
- JetBrains: no extension yet — would require a separate plugin (different extension API)

### Native Fallback Improvements *(partial — one item remains)*
- Currently: extension disconnect → hide 27 tools (audited 2026-03-12)
- `listTasks` fallback shipped — parses `.vscode/tasks.json` + Makefile targets
- `watchDiagnostics` fallback shipped — runs detected CLI linters immediately, returns snapshot
- Remaining viable fallback: `organizeImports` (prettier/biome) — low priority
- All others (terminal, debugger, LSP, decorations, VS Code commands) have no viable fallback — intentionally `extensionRequired`

### Test Coverage *(healthy — no integration gap)*
- 926 tests, 85 files; integration tests exist (6 files, full WebSocket round-trip coverage)
- `searchAndReplace` core logic now tested on all platforms via mocked-rg suite
- Original rg-integration suite still gates on binary availability for CI

### Performance *(CI-gated 2026-03-14)*
- Benchmark script: `node scripts/benchmark.mjs [--json] [--threshold <ms>]`
- CI runs benchmark on every push to main: 100 iterations, p99 > 100ms = build failure
- Baseline (50 iterations, loopback): all representative tools measure p50=0 ms, p99=1 ms — at Node.js timer resolution floor
- Benchmark results archived as GitHub Actions artifacts (30-day retention) for trend analysis
- Remaining open: profiling under sustained load and large file scenarios (`getBufferContent`, large `searchWorkspace` results)

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

### Plugin System
- Allow third-party tool registration without forking
- Dynamic tool loading from npm packages or local paths
- Plugin manifest format (schema, handler entry point, dependencies)

### Persistent Session State
- Survive bridge restarts (currently all state is in-memory)
- Serialize: openedFiles, diagnostics cache, activity log
- Resume sessions after crash/restart

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
