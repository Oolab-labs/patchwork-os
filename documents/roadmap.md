# Claude IDE Bridge — Roadmap

Development direction and exploration guidance. Living document — update as priorities shift.

---

## Current State (v1.6.0 — 2026-03-14)

- 137+ MCP tools registered; extension-first with native fs fallback pattern established
- **Claude Code Server Mode Integration shipped (v1.6.0)**: `claudeDriver.ts`, `claudeOrchestrator.ts`, `automation.ts`; 4 new MCP tools (`runClaudeTask`, `getClaudeTaskStatus`, `cancelClaudeTask`, `listClaudeTasks`); `GET /tasks` endpoint; event-driven automation via policy file
- Phase 1 new tools complete: `getTypeSignature`, `getImportTree`, `getCodeCoverage`, `generateTests`, `createIssueFromAIComment` (v1.5.0)
- Earlier tools: `getDependencyTree`, `getSecurityAdvisories`, `getGitHotspots`, `getPRTemplate` (v1.4.x)
- VS Code extension with full handler coverage; installable into VS Code, Windsurf, Cursor, and Antigravity
- Production-grade connection hardening (circuit breaker, backoff, heartbeat, grace period)
- Multi-linter and multi-test-runner support (auto-detected)
- GitHub integration (PRs, issues, actions)
- Remote control support via start-all.sh orchestrator
- Activity logging with Prometheus metrics
- Per-session stats + session-end UX (summary log + VS Code notification)
- Claude Code Platform Integration fully shipped (skills, subagents, plugin, hooks, /ide-monitor)
- 1028 tests (782 bridge + 246 extension) across 62+16 files; CI on Node 20 + 22
- **MCP Prompts shipped (v1.6.0)**: 5 slash commands via `prompts/list` + `prompts/get` (`review-file`, `explain-diagnostics`, `generate-tests`, `debug-context`, `git-review`); `src/prompts.ts`
- **getDiagnostics hardening (v1.6.0)**: diagnostic message text sanitized (control char stripping + 500-char cap) on both extension LSP and CLI linter paths
- Deep security hardening: SSRF three-layer defense (lexical + DNS pre-resolution + IP pinning), Origin header validation, rate limit error codes, JSON parse error responses, interpreter flag blocklist, backpressure guards, slow-loris mitigations

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
- 408 tests, 40 files; integration tests exist (6 files, full WebSocket round-trip coverage)
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
| Lock file format | `{ authToken, pid, workspace, ideName }` | Contract with Claude Code |
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
