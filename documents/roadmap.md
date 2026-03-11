# Claude IDE Bridge — Roadmap

Development direction and exploration guidance. Living document — update as priorities shift.

---

## Current State (v1.1.0)

- ~100 MCP tools registered (60 native, 40 extension-enhanced)
- VS Code extension with full handler coverage
- Production-grade connection hardening (circuit breaker, backoff, heartbeat, grace period)
- Multi-linter and multi-test-runner support (auto-detected)
- GitHub integration (PRs, issues, actions)
- Remote control support via start-all.sh orchestrator
- Workspace snapshots and plan persistence
- Activity logging with Prometheus metrics

---

## Near-Term Exploration Areas

### Multi-Editor Support
- Architecture is editor-agnostic in theory (bridge doesn't import vscode)
- Companion extensions for Cursor, Windsurf, JetBrains?
- Define minimal handler interface that other editors must implement
- Priority: assess demand vs. effort

### Native Fallback Improvements
- Currently: extension disconnect → hide 40+ tools
- Better: graceful degradation for some tools (e.g., file operations via fs, symbols via ctags)
- Audit each `extensionRequired` tool for possible CLI fallback

### Test Coverage
- Audit which tools lack unit tests
- Add integration tests for extension ↔ bridge protocol
- Test circuit breaker behavior under load
- Test reconnect grace period edge cases

### Performance
- Profile tool call latency for common operations
- WebSocket backpressure handling under sustained load
- Large file handling (getBufferContent, searchWorkspace results exceeding maxResultSize)
- Batch tool call patterns

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
