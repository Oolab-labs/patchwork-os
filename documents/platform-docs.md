# Claude IDE Bridge — Platform Documentation

Complete feature reference for the Claude IDE Bridge MCP server and VS Code extension.

## Overview

Claude IDE Bridge is a standalone MCP (Model Context Protocol) server that gives Claude Code full IDE integration. It exposes 137+ tools over WebSocket, handling file operations, diagnostics, LSP features, terminal control, git, and more. It works with any editor (VS Code, Windsurf, Cursor) and optionally pairs with a companion VS Code extension for real-time editor state.

The bridge connects to **Claude Desktop** via a stdio shim and to **Claude Code CLI** via WebSocket — both sessions share the same running bridge, enabling seamless context handoff between the two clients.

---

## Bridge Native Tools (no extension required)

### File Operations
| Tool | Description |
|------|-------------|
| `openFile` | Open files in editor with optional line navigation; tracks opened files |
| `openDiff` | Open side-by-side diff view between two files or file versions |
| `closeAllDiffTabs` | Close all open diff tabs |
| `findFiles` | File search using `fd` (preferred) or `find` fallback |
| `getFileTree` | Directory tree view with configurable depth |
| `searchWorkspace` | Content search using `rg` (preferred) or `grep` fallback |
| `searchAndReplace` | Find and replace across workspace files |

### Git
| Tool | Description |
|------|-------------|
| `getGitStatus` | Working tree status (staged, unstaged, untracked) |
| `getGitDiff` | Diff output — staged, unstaged, or between commit ranges |
| `getGitLog` | Commit history with formatting options |
| `getCommitDetails` | Detailed info for a specific commit |
| `getDiffBetweenRefs` | Diff between any two git refs |
| `gitAdd` | Stage files |
| `gitCommit` | Create commits |
| `gitCheckout` | Switch branches or restore files |
| `gitBlame` | Line-by-line blame annotation |
| `gitFetch` | Fetch from remotes |
| `gitListBranches` | List local and remote branches |
| `gitPull` | Pull from remote |
| `gitPush` | Push to remote |
| `gitStash` | Stash changes |
| `gitStashPop` | Pop stashed changes |
| `gitStashList` | List stashes |

### Linting & Testing
| Tool | Description |
|------|-------------|
| `getDiagnostics` | Errors/warnings — uses extension if connected, falls back to CLI linters (`tsc --noEmit`, `eslint`, `pyright`, `ruff`, `cargo check`, `go vet`, `biome`) |
| `runTests` | Run tests via auto-detected runner (vitest, jest, pytest, cargo test, go test) |
| `diffDebugger` | Combined diagnostics + test failure analysis in one call |

### Formatting
| Tool | Description |
|------|-------------|
| `formatDocument` | Format via VS Code's formatter (extension) or CLI fallback (prettier, black, gofmt, rustfmt, biome) |

### Command Execution
| Tool | Description |
|------|-------------|
| `runCommand` | Execute allowlisted shell commands with configurable timeout (default 30s, max 120s) |

### HTTP
| Tool | Description |
|------|-------------|
| `sendHttpRequest` | Send HTTP requests with configurable method, headers, body |
| `parseHttpFile` | Parse `.http` files into structured request objects |

### GitHub Integration (requires `gh` CLI)
| Tool | Description |
|------|-------------|
| `githubCreatePR` | Create pull requests |
| `githubListPRs` | List pull requests with filters |
| `githubViewPR` | View PR details |
| `githubGetPRDiff` | Get PR diff content |
| `githubPostPRReview` | Post review comments on PRs |
| `githubListIssues` | List issues with filters |
| `githubGetIssue` | View issue details |
| `githubCreateIssue` | Create new issues |
| `githubCommentIssue` | Comment on issues |
| `githubListRuns` | List GitHub Actions workflow runs |
| `githubGetRunLogs` | Get logs from workflow runs |

### Workspace Management
| Tool | Description |
|------|-------------|
| `getProjectInfo` | Auto-detect project type, dependencies, structure |
| `getToolCapabilities` | List available CLI tools, linters, and features |
| `getWorkspaceFolders` | Workspace path info (enhanced with extension data when connected) |
| `setActiveWorkspaceFolder` | Switch active workspace in multi-root setups |

### Snapshots & Plans
| Tool | Description |
|------|-------------|
| `createSnapshot` | Capture workspace state (file tree + key file contents) |
| `listSnapshots` | List saved snapshots |
| `showSnapshot` | View snapshot contents |
| `diffSnapshot` | Diff current state against a snapshot |
| `restoreSnapshot` | Restore workspace to snapshot state |
| `deleteSnapshot` | Remove a snapshot |
| `savePlan` | Persist an implementation plan to disk |
| `loadPlan` | Load a saved plan |
| `listPlans` | List saved plans |
| `deletePlan` | Remove a saved plan |
| `getPlanStatus` | Check plan completion status |

### Flow & Activity
| Tool | Description |
|------|-------------|
| `checkScope` | Verify current work stays within defined scope |
| `expandScope` | Request scope expansion with justification |
| `getActivityLog` | Session metrics — tool call counts, durations, errors |
| `setHandoffNote` | Persist a free-text context summary to `~/.claude/ide/handoff-note.json`. Shared across all MCP sessions (Desktop, CLI, HTTP). Use when switching clients mid-task. |
| `getHandoffNote` | Read the handoff note left by a previous session. Returns `note`, `updatedAt`, `updatedBy` (session ID), and human-readable `age`. Returns `null` note if none saved. |

---

## Extension-Enhanced Tools (require VS Code extension)

### Editor State
| Tool | Description |
|------|-------------|
| `getCurrentSelection` | Get current editor selection (text + position) |
| `getLatestSelection` | Get cached selection state (no round-trip) |
| `getOpenEditors` | List open editor tabs with dirty/language info |
| `checkDocumentDirty` | Check if a file has unsaved changes |
| `saveDocument` | Save an open document |
| `closeTab` | Close a specific editor tab |
| `getBufferContent` | Get current in-memory content of an open file |

### LSP Features
| Tool | Description |
|------|-------------|
| `goToDefinition` | Jump to symbol definition |
| `findReferences` | Find all references to a symbol |
| `getHover` | Get hover/type information at position |
| `getHoverAtCursor` | Get hover info at current cursor position |
| `getCodeActions` | List available code actions for a range |
| `applyCodeAction` | Apply a specific code action |
| `renameSymbol` | Rename symbol across entire workspace (15s timeout) |
| `searchWorkspaceSymbols` | Search symbols across workspace |
| `getCallHierarchy` | Get incoming/outgoing call hierarchy (15s timeout) |
| `getDocumentSymbols` | List all symbols in a document |
| `getInlayHints` | Get inlay hints for a line range |
| `getTypeHierarchy` | Get type hierarchy (supertypes/subtypes, 15s timeout) |

### Text Editing
| Tool | Description |
|------|-------------|
| `editText` | Apply precise text edits through VS Code API |
| `replaceBlock` | Replace a block of text by matching old content |
| `createFile` | Create files/directories via extension |
| `deleteFile` | Delete files with optional trash/recursive |
| `renameFile` | Rename/move files |

### Code Quality
| Tool | Description |
|------|-------------|
| `fixAllLintErrors` | Auto-fix all lint errors via VS Code or CLI (eslint --fix, biome, ruff) |
| `organizeImports` | Organize imports via VS Code |
| `watchDiagnostics` | Long-poll for diagnostic changes |

### Terminal
| Tool | Description |
|------|-------------|
| `listTerminals` | List VS Code integrated terminals |
| `getTerminalOutput` | Get recent output (ring buffer, up to 5000 lines) |
| `createTerminal` | Create new terminal with optional name/cwd/env |
| `disposeTerminal` | Close a terminal |
| `sendTerminalCommand` | Send text to terminal (allowlist enforced) |
| `runInTerminal` | Execute command and capture output (allowlist enforced) |
| `waitForTerminalOutput` | Wait for pattern match in terminal output |

### File Watching
| Tool | Description |
|------|-------------|
| `watchFiles` | Watch file patterns for changes |
| `unwatchFiles` | Stop watching a file pattern |

### Dependency & Security
| Tool | Description |
|------|-------------|
| `getDependencyTree` | Unified dependency graph across npm, pip, cargo, and go mod. Auto-detects from manifest files. Supports configurable depth. |
| `getSecurityAdvisories` | Run security audit (npm audit / cargo audit / pip-audit) and return vulnerabilities with severity, CVE IDs, and remediation. Filter by minimum severity. |
| `getGitHotspots` | Identify most frequently changed files in git history over a time window. Useful for prioritizing refactoring and code review focus. |
| `getPRTemplate` | Generate a pull request body from git commit messages and diff stats. Supports bullet, prose, and conventional commit styles. Pairs with `githubCreatePR`. |

### Code Analysis
| Tool | Description |
|------|-------------|
| `getTypeSignature` | Extract the TypeScript/language type signature at a file position using VS Code hover. Returns the first fenced code block from hover markdown. |
| `getImportTree` | BFS traversal of static/dynamic imports and CommonJS require() starting from a file. Returns tree with depths, cycle detection, and optional external packages. |
| `getCodeCoverage` | Parse coverage reports (lcov, coverage-summary.json, clover.xml). Auto-detects report in workspace. Supports minCoverage filter and sorts worst-covered files first. |
| `generateTests` | Extract exported symbols from a source file and generate a test scaffold (vitest/jest/pytest). Auto-detects framework from config files. |
| `createIssueFromAIComment` | Create a GitHub issue from a cached `// AI:` comment. Derives title from the comment text; supports labels and assignee. Requires `gh` CLI. |

### Claude Orchestration (requires `--claude-driver != none`)

These tools are only registered when the bridge is started with `--claude-driver subprocess` (or `api`). They are hidden from `tools/list` otherwise.

| Tool | Description |
|------|-------------|
| `runClaudeTask` | Enqueue a Claude task. Params: `prompt` (required, max 32 KB), `contextFiles` (optional, max 20, workspace-confined), `timeoutMs` (5000–600000, default 120000), `stream` (bool, default false), `model` (optional, e.g. `"claude-haiku-4-5-20251001"` — passed as `--model` to subprocess). Returns `{ taskId, status }` immediately, or blocks and streams output if `stream: true`. |
| `getClaudeTaskStatus` | Poll a task by ID. Returns `{ taskId, status, output (truncated 500 chars), startedAt?, completedAt?, durationMs? }`. Session-scoped — callers can only see their own tasks. |
| `cancelClaudeTask` | Cancel a pending or running task by ID. Returns `{ taskId, cancelled }`. No-op if task already completed. |
| `listClaudeTasks` | List session-scoped tasks. Optional `status` filter: `pending` \| `running` \| `done` \| `error` \| `cancelled`. Returns array of task summaries (no prompt text, output capped at 200 chars). |
| `resumeClaudeTask` | Re-enqueue a previously completed or failed task by ID. Preserves original `prompt`, `contextFiles`, `timeoutMs`, and `model`. Session-scoped — can only resume own tasks. |

Task status lifecycle: `pending → running → done | error | cancelled`.

**Security hardening:**
- Prompt injection: diagnostic messages sanitized (control character stripping + 500-char cap) on both extension LSP and CLI linter paths; file paths at 500 chars; delimited with `--- BEGIN/END DIAGNOSTIC DATA ---`
- `CLAUDECODE` env var stripped from subprocess to prevent nested-session panic
- 32 KB prompt cap on `runClaudeTask`
- `contextFiles` confined to workspace path

### Automation Policy

When started with `--automation --automation-policy <file>`, the bridge enqueues Claude tasks in response to IDE events. Policy is a JSON file with any of these keys:

| Trigger | Required fields | Optional fields | Notes |
|---------|----------------|-----------------|-------|
| `onDiagnosticsError` | `enabled`, `prompt`, `cooldownMs` | `minSeverity` (`error`/`warning`) | Placeholders: `{{file}}`, `{{diagnostics}}` (wrapped in delimiters) |
| `onFileSave` | `enabled`, `prompt`, `cooldownMs`, `patterns` | — | `patterns`: minimatch globs. Placeholder: `{{file}}` |
| `onPostCompact` | `enabled`, `prompt`, `cooldownMs` | — | Fires when Claude compacts context (Claude Code 2.1.76+). Use to re-snapshot IDE state. |
| `onInstructionsLoaded` | `enabled`, `prompt` | — | Fires once at session start when CLAUDE.md loads (Claude Code 2.1.76+). No cooldown. |

Minimum `cooldownMs` enforced at 5000 ms. Loop guard prevents re-triggering while a prior task for the same file is still pending/running.

> **Cloud sessions**: `CLAUDE_CODE_REMOTE=true` is set in Anthropic cloud VMs (Claude Code on the web). Automation events will enqueue tasks, but the bridge runs locally and those tasks won't execute remotely. Add a guard in hook scripts if needed: `if [ "$CLAUDE_CODE_REMOTE" = "true" ]; then exit 0; fi`.

### AI Comments
| Tool | Description |
|------|-------------|
| `getAIComments` | Scan for `// AI:` comments with severity levels (fix, todo, question, warn, task) |

### Debug
| Tool | Description |
|------|-------------|
| `getDebugState` | Get active debug session state (breakpoints, call stack, scopes) |
| `evaluateInDebugger` | Evaluate expressions in debug context |
| `setDebugBreakpoints` | Set breakpoints with conditions |
| `startDebugging` | Start a debug session (15s timeout) |
| `stopDebugging` | Stop active debug session |

### Decorations
| Tool | Description |
|------|-------------|
| `setEditorDecorations` | Apply visual decorations (info, warning, error, focus, strikethrough, dim) |
| `clearEditorDecorations` | Remove decorations |

### VS Code Integration
| Tool | Description |
|------|-------------|
| `executeVSCodeCommand` | Execute arbitrary VS Code commands |
| `listVSCodeCommands` | List available commands with optional filter |
| `getWorkspaceSettings` | Read VS Code settings |
| `setWorkspaceSetting` | Write VS Code settings |
| `listTasks` | List VS Code tasks (15s timeout) |
| `runTask` | Run a VS Code task |
| `readClipboard` | Read system clipboard |
| `writeClipboard` | Write to system clipboard |

### Notebooks
| Tool | Description |
|------|-------------|
| `getNotebookCells` | Get cells from a Jupyter notebook |
| `runNotebookCell` | Execute a notebook cell |
| `getNotebookOutput` | Get output from a notebook cell |

---

## MCP Prompts

The bridge serves 6 built-in prompts via `prompts/list` + `prompts/get`. These appear as `/mcp__bridge__<name>` in any MCP client that supports the MCP prompts protocol. No extension required.

| Prompt | Argument | Description |
|--------|----------|-------------|
| `review-file` | `file` (required) | Code review for a specific file using current diagnostics |
| `explain-diagnostics` | `file` (required) | Explain all diagnostics in a file and suggest fixes |
| `generate-tests` | `file` (required) | Generate a test scaffold for exported symbols in a file |
| `debug-context` | _(none)_ | Snapshot current debug state, open editors, and diagnostics |
| `git-review` | `base` (optional, default: `main`) | Review all changes since a git base branch |
| `set-effort` | `level` (optional: `low`/`medium`/`high`, default: `medium`) | Prepend an effort-level instruction to tune Claude's thoroughness for the next task |

Implementation: `src/prompts.ts`. Tests: `src/__tests__/prompts.test.ts`, `src/__tests__/transport-prompts.test.ts`.

---

## Architecture

### Connection Model
```
Claude Code CLI  <--WebSocket (MCP/JSON-RPC 2.0)-->  Bridge Server  <--WebSocket-->  VS Code Extension
```

### Protocol
- JSON-RPC 2.0 over WebSocket
- MCP protocol version: `2025-11-25`
- Server capabilities: `tools` (with `listChanged`), `logging`, `prompts`, `resources`, `elicitation: {}`
- `elicitation: {}` capability enables the bridge to send `elicitation/create` mid-task to request structured user input via Claude Code's interactive dialog (Claude Code 2.1.76+). Pending elicitations are rejected on disconnect. API: `McpTransport.elicit(message, requestedSchema, timeoutMs?)` → resolves with the client's response object.

### Auth
- Bridge generates random UUID auth token on startup
- Token written to lock file: `~/.claude/ide/<port>.lock`
- Lock file contains: `{ authToken, pid, workspace, ideName, isBridge: true }`
- `isBridge: true` lets the stdio shim distinguish bridge lock files from IDE-owned lock files (e.g. Windsurf writes its own lock); shim always prefers a bridge lock over a non-bridge lock when auto-discovering
- Claude Code reads lock file and connects with token in WebSocket upgrade headers
- Extension authenticates via `x-claude-ide-extension` header

### Tool Filtering
- Tools with `extensionRequired: true` are hidden from `tools/list` when extension is disconnected
- Extension connect/disconnect triggers `notifications/tools/list_changed` to Claude Code

### Limits & Timeouts
| Setting | Default | Max |
|---------|---------|-----|
| Tool timeout | 60s | per-tool override |
| Command timeout | 30s | 120s |
| Max result size | 512 KB | 4096 KB |
| Rate limit | 200 req/min | — |
| Concurrent tools | 10 | — |
| Extension request timeout | 10s | — |

### Connection Hardening
- WebSocket heartbeat (20s ping/pong) with automatic reconnect
- Sleep/wake detection via heartbeat gap monitoring
- All `ws.send()` calls wrapped in readyState check + try-catch
- Extension circuit breaker with exponential backoff (AWS full jitter)
- Generation counter prevents stale handlers from responding
- 30s grace period for Claude Code reconnection (preserves state)
- Send buffer monitoring (warns at >1MB buffered)
- Backpressure-aware sending with drain waiting

### Agent Team Support (Multi-Session)

The bridge supports up to 5 concurrent Claude Code sessions sharing a single bridge instance.

| Property | Details |
|----------|---------|
| Max concurrent sessions | 5 (active, non-grace) |
| Session isolation | Each session gets its own `McpTransport`, `openedFiles`, `terminalPrefix` |
| Terminal namespacing | Terminals prefixed per-session (e.g., `s1a2b3c4-build`) — each agent sees only its own |
| File locking | `FileLock` promise-chain mutex serializes concurrent file edits across sessions |
| Min connection interval | 50ms between connections (prevents connection-storm DoS) |
| Grace period | 30s after disconnect — session state preserved for reconnection |
| Activation | `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1 claude` |

Session lifecycle:
1. Claude Code connects → new `AgentSession` created with unique ID
2. Session gets isolated transport, opened-files set, terminal prefix
3. Tool calls routed to the session's transport
4. On disconnect → grace period starts (30s default, configurable via `--grace-period`)
5. If reconnected within grace → session resumes; otherwise → session cleaned up

### Health & Metrics
- `/health` endpoint: Claude Code connected, extension connected, circuit breaker state
- `/status` endpoint: full session and activity summary (JSON)
- `/ready` endpoint: 200 when bridge is initialized and ready to accept connections
- `/metrics` endpoint: Prometheus-format session metrics (tool calls, durations, errors)
- `/tasks` endpoint: sanitized task list (Bearer-auth required; no prompt text, output capped at 200 chars). Only present when `--claude-driver != none`.

---

## Claude Desktop & Cowork Integration

### Claude Desktop

The bridge connects to Claude Desktop via the stdio shim (`scripts/mcp-stdio-shim.cjs`). All bridge tools are available inside Claude Desktop chat alongside any other Desktop integrations. Set up with:

```bash
bash scripts/gen-claude-desktop-config.sh
```

The shim auto-discovers the bridge lock file (`~/.claude/ide/<port>.lock`) by preferring files with `isBridge: true`. This prevents the shim from accidentally connecting to an IDE-owned lock file (e.g. Windsurf writes its own lock in the same directory).

The shim also watches `~/.claude/ide/` via `fs.watch` (500 ms debounce) and auto-reconnects when a new bridge lock file appears. **Claude Desktop no longer needs a full quit and relaunch when the bridge restarts on a new port** — the shim detects the new lock and reconnects within ~500 ms.

### Cowork (Computer Use)

Cowork is Claude Desktop's ability to control the OS, browser, and desktop apps. When used alongside the bridge, the two capabilities compose:

| Bridge | Cowork |
|--------|--------|
| Reads IDE state (diagnostics, open files, git, terminals) | Acts on the world (clicks, types, navigates apps) |
| Understands *why* something is broken | Can fix it in tools outside the editor |

**Example workflows:**

- **End-to-end deploy**: Bridge runs tests and checks git status → Cowork opens CI dashboard in Chrome, monitors the run, approves the deploy gate
- **Bug report to ticket**: Bridge reads the failing stack trace → Claude writes the fix → Cowork opens Linear/Jira, creates the ticket with the diff
- **Live API testing**: Bridge watches terminal output → Cowork fires requests in the browser, reads responses
- **Code review**: Bridge reads diagnostics and call hierarchy → Cowork navigates GitHub PR in Chrome, leaves inline comments
- **Config sync**: Bridge reads environment variables → Cowork opens the cloud console, updates the service config

### Session Context Handoff

Claude Desktop and Claude Code CLI are separate MCP sessions on the same bridge. Use `setHandoffNote` / `getHandoffNote` to pass context between them:

```
# In Claude Desktop (finishing a debug session):
setHandoffNote("auth bug in login.ts:42 — token expiry off by 1s in verifyJWT(). Next: fix the ±1s skew.")

# In Claude Code CLI (picking up the work):
getHandoffNote()  →  { note: "auth bug in login.ts:42 ...", age: "4m ago" }
```

### "Browse Plugins" Compatibility

The bridge is not yet listed in Claude's plugin marketplace ("Browse plugins" — Anthropic-curated). It works via **manual MCP config** (the stdio shim), which is equivalent in capability. The `/.well-known/mcp/server-card.json` endpoint (SEP-1649) is in place for future registry discovery. When Anthropic opens plugin submission to third parties, the bridge will need: an updated manifest with icon/category fields, and submission through Anthropic's partner portal.

---

## Deployment

### Single Command
```bash
npm start -- --workspace /path/to/project
```

### Full Orchestrator
```bash
npm run start-all -- --workspace /path/to/project
```
Launches tmux session with 4 panes: orchestrator, bridge, Claude CLI, remote control.

### CLI Options
```
--workspace <path>        Workspace folder (default: cwd)
--ide-name <name>         IDE name shown to Claude (default: "External")
--editor <cmd>            Editor CLI command (default: auto-detect)
--port <number>           Force specific port (default: random)
--linter <name>           Enable specific linter (repeatable)
--allow-command <cmd>     Add to command allowlist (repeatable)
--timeout <ms>            Command timeout (default: 30000)
--max-result-size <KB>    Max output size (default: 512)
--claude-driver <mode>    Claude subprocess driver: subprocess | api | none (default: none)
--claude-binary <path>    Path to claude binary (default: claude)
--automation              Enable event-driven automation hooks
--automation-policy <path> Path to JSON automation policy file
--verbose                 Debug logging
--jsonl                   Structured JSONL events to stderr
```

### Environment Variables
| Variable | Description |
|----------|-------------|
| `CLAUDE_IDE_BRIDGE_EDITOR` | Editor command override |
| `CLAUDE_IDE_BRIDGE_LINTERS` | Comma-separated linter list |
| `CLAUDE_IDE_BRIDGE_TIMEOUT` | Command timeout in ms |
| `CLAUDE_IDE_BRIDGE_MAX_RESULT_SIZE` | Max output size in KB |
| `CLAUDE_CONFIG_DIR` | Override `~/.claude` directory |

### VS Code Extension
- Status bar: connection state indicator (connected/disconnected/reconnecting)
- Output channel: "Claude IDE Bridge" structured logs
- Commands: Reconnect, Show Logs, Copy Connection Info
- Auto-reconnect: exponential backoff with jitter, sleep detection, escalating notifications
- Real-time push: diagnostics, selections, active file, AI comments, file saves, debug state
