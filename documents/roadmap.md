# Claude IDE Bridge — Roadmap

Development direction and exploration guidance. Living document — update as priorities shift.

---

## Current State (v1.4.2 — 2026-03-13)

- 124+ MCP tools registered; extension-first with native fs fallback pattern established
- VS Code extension with full handler coverage; installable into VS Code, Windsurf, Cursor, and Antigravity
- Production-grade connection hardening (circuit breaker, backoff, heartbeat, grace period)
- Multi-linter and multi-test-runner support (auto-detected)
- GitHub integration (PRs, issues, actions)
- Remote control support via start-all.sh orchestrator
- Workspace snapshots and plan persistence
- Activity logging with Prometheus metrics
- Per-session stats + session-end UX (summary log + VS Code notification)
- Claude Code Platform Integration fully shipped (skills, subagents, plugin, hooks, /ide-monitor)
- 665 tests (419 bridge + 246 extension) across 43+10 files; CI on Node 20 + 22
- Deep security hardening: SSRF three-layer defense (lexical + DNS pre-resolution + IP pinning), Origin header validation, rate limit error codes, JSON parse error responses, interpreter flag blocklist, backpressure guards, slow-loris mitigations

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

### Performance *(baselined 2026-03-13)*
- Benchmark script: `node scripts/benchmark.mjs`
- Baseline (50 iterations, loopback): all representative tools measure p50=0 ms, p99=1 ms — at Node.js timer resolution floor
- No backpressure or large-result concerns observed at current workspace size
- Re-run after significant tool additions or when workspace grows substantially
- Remaining open: profiling under sustained load and large file scenarios (`getBufferContent`, large `searchWorkspace` results)

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
