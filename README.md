# Claude IDE Bridge

[![npm version](https://img.shields.io/npm/v/claude-ide-bridge)](https://www.npmjs.com/package/claude-ide-bridge)
[![CI](https://github.com/Oolab-labs/claude-ide-bridge/actions/workflows/ci.yml/badge.svg)](https://github.com/Oolab-labs/claude-ide-bridge/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

A standalone MCP bridge that gives [Claude Code](https://claude.ai/code) full IDE integration — **137+ tools** for LSP, debugging, terminals, Git, GitHub, diagnostics, code analysis, and more. Works with any VS Code-compatible editor (VS Code, Windsurf, Cursor) and pairs with a companion extension for real-time editor state.

## How It Works

```
Your Phone / Laptop                    Your Computer
┌──────────────┐                      ┌─────────────────────────────┐
│  Claude Code  │───── SSH/local ─────│  Bridge Server              │
│  (CLI)        │◄── remote control ──│    ↕ WebSocket              │
└──────────────┘                      │  IDE Extension (VS Code)    │
                                      │    ↕ Real-time state        │
       ┌──────────────────────────────│  Your Code & Editor         │
       │   runClaudeTask              └─────────────────────────────┘
       ▼
┌──────────────┐
│  claude -p   │  Autonomous subprocess — full tools, no approval loop
│  subprocess  │  Output streams back to VS Code output channel
└──────────────┘
```

Claude Code connects to the bridge, which connects to your IDE extension. Claude can then open files, run tests, set breakpoints, check diagnostics, commit to Git, create PRs — everything a developer at the keyboard can do.

**Use it from your phone**: SSH into your dev machine, send a message via remote control, and delegate autonomous work to a `claude -p` subprocess running on your home machine. Watch it fix bugs, run tests, and commit — then go back to sleep.

**Autonomous task mode**: With `--claude-driver subprocess`, the bridge can spawn Claude subprocesses on demand via the `runClaudeTask` MCP tool. Tasks run in parallel (up to 10 concurrent), stream output to VS Code in real time, and can be triggered automatically by diagnostics or file saves via an automation policy.

## Quick Start

**Prerequisites:** [Claude Code CLI](https://claude.ai/code), Node.js ≥ 20, tmux (`brew install tmux`)

**Step 1 — Install the VS Code extension**

Search `oolab-labs.claude-ide-bridge-extension` in the VS Code / Windsurf / Cursor extension marketplace, or install from the command line:

```bash
code --install-extension oolab-labs.claude-ide-bridge-extension
# Windsurf: windsurf --install-extension oolab-labs.claude-ide-bridge-extension
# Cursor:   cursor --install-extension oolab-labs.claude-ide-bridge-extension
```

**Step 2 — Install and start the bridge**

```bash
npm install -g claude-ide-bridge
cd /your/project
claude-ide-bridge
```

The bridge starts, writes a lock file to `~/.claude/ide/`, and waits for connections. Your editor extension connects automatically.

> **One bridge per workspace.** Each project directory needs its own bridge instance. If you work across multiple repos, start a separate `claude-ide-bridge` in each workspace.

> **For long-running use**, add `--watch` to auto-restart the bridge if it crashes:
> ```bash
> claude-ide-bridge --watch
> ```
> The supervisor uses exponential backoff (2s → 30s) and is safe to leave running indefinitely.

**Step 3 — Connect Claude Code**

In a new terminal in your project directory:

```bash
claude
```

Claude Code auto-discovers the bridge. Type `/ide` to confirm the connection — you'll see your open files, diagnostics, and editor state.

**That's it.** Claude can now read your diagnostics, navigate your code, run tests, commit to Git, and more.

---

**Optional — full orchestrator with health monitoring:**

```bash
claude-ide-bridge start-all --workspace /your/project
```

Launches bridge + Claude Code + remote control in a tmux session with automatic restart on failure. Requires `tmux`.

## Full Orchestrator

The `start-all` command launches everything in a tmux session: bridge + Claude Code + remote control, with automatic health monitoring and process restart.

```bash
# Via npm global install or npx
claude-ide-bridge start-all --workspace /path/to/your-project

# Or the dedicated alias
claude-ide-bridge-start --workspace /path/to/your-project

# From source
npm run start-all -- --workspace /path/to/your-project
```

Options:

| Flag | Description |
|------|-------------|
| `--workspace <path>` | Project directory (default: `.`) |
| `--notify <topic>` | ntfy.sh topic for push notifications |
| `--ide <name>` | IDE name hint (e.g. `windsurf`) |

Requires `tmux` and the `claude` CLI to be on `PATH`.

## Claude Code Plugin

The bridge ships as a **Claude Code plugin** with 9 skills, 3 subagents, and 3 hooks:

```bash
# Load the plugin
claude --plugin-dir ./claude-ide-bridge-plugin
```

### Skills

| Skill | Description | Remote Session |
|-------|-------------|:-:|
| `/ide-diagnostics-board` | Visual diagnostics dashboard (HTML) across the workspace | CLI fallback |
| `/ide-coverage` | Test coverage heatmap (HTML) from lcov/JSON data | CLI fallback |
| `/ide-quality` | Multi-language lint sweep + auto-fix + format + optional commit | CLI fallback |
| `/ide-debug` | Full debug cycle: run tests, set breakpoints, evaluate expressions, fix, verify | Requires bridge |
| `/ide-review` | Deep PR review using LSP code intelligence + GitHub tools | Requires bridge |
| `/ide-refactor` | Safe refactoring with snapshot checkpoints and auto-rollback | Requires bridge |
| `/ide-explore` | Codebase exploration using LSP (runs in isolated Explore agent) | Requires bridge |
| `/ide-deps` | Interactive dependency graph (HTML) for a file or symbol | Requires bridge |
| `/ide-monitor` | Continuous monitoring for diagnostics, tests, or terminal output | Requires bridge |

> **Remote sessions** (`claude remote-control`): Skills marked "CLI fallback" work without the bridge by using built-in Claude Code tools. Skills marked "Requires bridge" need the `claude --ide` session.

### Subagents

| Agent | Description |
|-------|-------------|
| `ide-code-reviewer` | Evidence-based code review using LSP tools, with persistent memory |
| `ide-debugger` | Autonomous debug cycles with breakpoints and expression evaluation |
| `ide-test-runner` | Runs tests, categorizes failures, applies fixes |

### Hooks

| Event | What it does |
|-------|-------------|
| `PostToolUse` on Edit/Write | Reminds Claude to check diagnostics after file edits |
| `SessionStart` | Reports bridge status, connection, and tool count |
| `SubagentStart` | Verifies bridge is alive before IDE subagents run |

## 137+ MCP Tools

### File Operations (7)
`openFile` · `openDiff` · `saveDocument` · `close_tab` · `closeAllDiffTabs` · `checkDocumentDirty` · `getOpenEditors`

### LSP / Code Intelligence (12)
`goToDefinition` · `findReferences` · `getHover` · `getCodeActions` · `applyCodeAction` · `renameSymbol` · `searchSymbols` · `getDocumentSymbols` · `getCallHierarchy` · `getTypeHierarchy` · `getImplementations` · `getInlayHints`

### Debugging (5)
`setDebugBreakpoints` · `startDebugging` · `evaluateInDebugger` · `getDebugState` · `stopDebugging`

### Terminal (7)
`createTerminal` · `runInTerminal` · `waitForTerminalOutput` · `getTerminalOutput` · `listTerminals` · `sendTerminalInput` · `closeTerminal`

### Git (15)
`gitStatus` · `gitDiff` · `gitLog` · `gitAdd` · `gitCommit` · `gitPush` · `gitPull` · `gitBranch` · `gitCheckout` · `gitStash` · `gitBlame` · `gitMerge` · `gitRebase` · `gitTag` · `gitRemote`

### GitHub (11)
`githubCreatePR` · `githubViewPR` · `githubGetPRDiff` · `githubPostPRReview` · `githubListPRs` · `githubMergePR` · `githubCreateIssue` · `githubListIssues` · `githubViewIssue` · `githubListReleases` · `githubCreateRelease`

### Diagnostics & Testing (3)
`getDiagnostics` · `runTests` · `diffDebug`

### Code Quality (3)
`fixAllLintErrors` · `formatDocument` · `organizeImports`

### Snapshots & Plans (10)
`createSnapshot` · `restoreSnapshot` · `diffSnapshot` · `listSnapshots` · `deleteSnapshot` · `createPlan` · `updatePlan` · `getPlan` · `listPlans` · `deletePlan`

### Editor State (7)
`getCurrentSelection` · `getLatestSelection` · `getOpenEditors` · `getActiveEditor` · `getVisibleRange` · `revealRange` · `showMessage`

### Code Analysis & Security (7)
`auditDependencies` · `getSecurityAdvisories` · `detectUnusedCode` · `refactorExtractFunction` · `generateAPIDocumentation` · `getDependencyTree` · `getGitHotspots`

### And More
Text editing · Workspace management · HTTP requests · File watchers · Decorations · VS Code commands

| Category | Count | Extension Required |
|----------|------:|:-:|
| File Operations | 7 | No |
| Git | 15 | No |
| GitHub | 11 | No (requires `gh`) |
| LSP / Code Intelligence | 12 | Yes (with fallbacks) |
| Editor State | 7 | Yes |
| Text Editing | 5 | Yes |
| Terminal | 7 | Yes |
| Diagnostics & Testing | 3 | Mixed |
| Code Analysis & Security | 7 | No |
| Code Quality | 3 | Yes |
| Debug | 5 | Yes |
| Decorations | 2 | Yes |
| Workspace Management | 4 | No |
| Snapshots & Plans | 10 | No |
| HTTP | 2 | No |
| VS Code Integration | 8 | Yes |
| **Total** | **~107** | |

## MCP Prompts (Slash Commands)

The bridge exposes 7 built-in slash commands via the MCP `prompts/list` + `prompts/get` protocol. These appear as `/mcp__bridge__<name>` in any MCP client that supports prompts.

| Prompt | Argument | Description |
|--------|----------|-------------|
| `/mcp__bridge__review-file` | `file` (required) | Code review for a specific file using current diagnostics |
| `/mcp__bridge__explain-diagnostics` | `file` (required) | Explain and suggest fixes for all diagnostics in a file |
| `/mcp__bridge__generate-tests` | `file` (required) | Generate a test scaffold for the exported symbols in a file |
| `/mcp__bridge__debug-context` | _(none)_ | Snapshot current debug state, open editors, and diagnostics |
| `/mcp__bridge__git-review` | `base` (optional, default: `main`) | Review all changes since a git base branch |
| `/mcp__bridge__cowork` | `task` (optional) | Gather full IDE context and propose a Cowork action plan — run this **before** opening a Cowork session |
| `/mcp__bridge__set-effort` | `level` (optional: `low`/`medium`/`high`, default: `medium`) | Prepend an effort-level instruction to tune Claude's thoroughness for the next task |

> **Cowork sessions and MCP tools:** MCP tools (including all bridge tools) are **not available inside a Cowork session**. Use a two-step workflow: run `/mcp__bridge__cowork` in a regular Claude Code chat first — it gathers full IDE context and produces an action plan — then open a Cowork session armed with that context.

Prompts are served directly from the bridge — no extension required. Implemented in `src/prompts.ts`.

---

## Claude Orchestration & Automation

The bridge can spawn Claude subprocesses, queue tasks, and drive event-driven automation directly from VS Code events.

### Starting with automation enabled

```bash
# Enable subprocess driver + event-driven automation with a policy file
claude-ide-bridge --workspace /path/to/project \
  --claude-driver subprocess \
  --automation \
  --automation-policy ./automation-policy.json
```

### Automation policy file

```json
{
  "onDiagnosticsError": {
    "enabled": true,
    "minSeverity": "error",
    "prompt": "Fix the errors in {{file}}:\n{{diagnostics}}",
    "cooldownMs": 30000
  },
  "onFileSave": {
    "enabled": true,
    "patterns": ["**/*.ts", "!node_modules/**"],
    "prompt": "Review the saved file: {{file}}",
    "cooldownMs": 10000
  },
  "onPostCompact": {
    "enabled": true,
    "prompt": "Context was compacted. Call getOpenEditors and getDiagnostics to rebuild your understanding of the current state.",
    "cooldownMs": 60000
  },
  "onInstructionsLoaded": {
    "enabled": true,
    "prompt": "Call getToolCapabilities to confirm the bridge is connected and note which tools are available for this session."
  }
}
```

When automation is active, VS Code save events and diagnostic errors automatically enqueue Claude tasks. Output streams to the "Claude IDE Bridge" output channel in real time.

**Policy triggers:**

| Trigger | When it fires | Key fields |
|---------|--------------|------------|
| `onDiagnosticsError` | VS Code reports new errors/warnings for a file | `enabled`, `minSeverity` (`error`/`warning`), `prompt` (supports `{{file}}` and `{{diagnostics}}`), `cooldownMs` |
| `onFileSave` | A file matching `patterns` is saved | `enabled`, `patterns` (minimatch globs), `prompt` (supports `{{file}}`), `cooldownMs` |
| `onPostCompact` | Claude compacts its context (Claude Code 2.1.76+) | `enabled`, `prompt`, `cooldownMs` |
| `onInstructionsLoaded` | Claude loads CLAUDE.md at session start (Claude Code 2.1.76+) | `enabled`, `prompt` |

> **Cloud sessions**: If `CLAUDE_CODE_REMOTE=true` (Claude Code on the web), automation tasks will still enqueue but the bridge itself runs locally — those tasks will not execute. Guard policy prompts or the `onInstructionsLoaded` hook with an environment check if needed.

### CLI flags

| Flag | Description |
|------|-------------|
| `--claude-driver <mode>` | `subprocess` \| `api` \| `none` (default: `none`) |
| `--claude-binary <path>` | Path to the `claude` binary (default: `claude`) |
| `--automation` | Enable event-driven automation |
| `--automation-policy <path>` | Path to JSON automation policy file |

### Task management tools (registered when `--claude-driver != none`)

| Tool | Description |
|------|-------------|
| `runClaudeTask` | Enqueue a Claude task with optional context files, streaming, and model override (`model` param, e.g. `"claude-haiku-4-5-20251001"`) |
| `getClaudeTaskStatus` | Poll task status and output by task ID |
| `cancelClaudeTask` | Cancel a pending or running task |
| `listClaudeTasks` | List session-scoped tasks with optional status filter |
| `resumeClaudeTask` | Re-enqueue a completed or failed task by ID, preserving its original prompt, context files, and model |

A `GET /tasks` HTTP endpoint (Bearer-auth required) provides a sanitized task list for external monitoring.

---

## Headless / CI Usage

Use with `claude -p` for automation:

```bash
# Fix all lint errors
claude -p "Use getDiagnostics to find all errors, then fix them" \
  --mcp-config ./mcp-bridge.json

# Run tests and fix failures
claude -p "Run tests with runTests, fix any failures, and commit" \
  --mcp-config ./mcp-bridge.json

# Generate architecture overview
claude -p "Map the project using getFileTree, getDocumentSymbols, and getCallHierarchy" \
  --mcp-config ./mcp-bridge.json --output-format json
```

## Supported Editors

| Editor | Status |
|--------|--------|
| VS Code | Supported |
| Windsurf | Supported |
| Cursor | Supported |
| Google Antigravity | Supported |

Install the extension in any supported editor:

```bash
# Auto-detect editor
claude-ide-bridge install-extension

# Specify editor
claude-ide-bridge install-extension windsurf
claude-ide-bridge install-extension cursor

# Or via the install script
bash scripts/install-extension.sh --ide <name>
```

## Use with Claude Desktop

Connect the Claude Desktop app to your running bridge — chat with your IDE using natural language.

```bash
# Generate the config (prints to stdout)
bash scripts/gen-claude-desktop-config.sh

# Write it to the config file (backs up existing config)
bash scripts/gen-claude-desktop-config.sh --write
```

Then restart Claude Desktop. The bridge's stdio shim auto-discovers the running bridge via lock files — no port or token needs to be hard-coded.

**Try it:** Open Claude Desktop and ask *"What diagnostics are in my workspace?"* or *"What files are open in my IDE?"*

You can also use the general config generator:

```bash
bash scripts/gen-mcp-config.sh claude-desktop --write
```

Config location:
- **macOS**: `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows**: `%APPDATA%\Claude\claude_desktop_config.json`

## Streamable HTTP (Remote MCP)

The bridge also exposes an MCP-compliant **Streamable HTTP** transport at `POST/GET/DELETE /mcp`. This lets any MCP client that speaks HTTP (including Claude Desktop via Custom Connectors, or curl) connect without a WebSocket.

```bash
# Start the bridge (listens on localhost by default)
claude-ide-bridge --workspace /path/to/your-project

# Connect remotely by binding to all interfaces
claude-ide-bridge --workspace /path/to/your-project --bind 0.0.0.0
```

> **Security warning:** `--bind 0.0.0.0` exposes the bridge to your entire network. Always put it behind a reverse proxy with TLS and authentication before exposing it to the internet. See [docs/remote-access.md](docs/remote-access.md) for a production-ready Caddy/nginx setup.

The bridge token (from the lock file at `~/.claude/ide/<port>.lock`) is required as a Bearer header:

```bash
TOKEN=$(cat ~/.claude/ide/*.lock | python3 -c "import sys,json; print(json.load(sys.stdin)['authToken'])")

# Initialize a session
curl -X POST http://localhost:PORT/mcp \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"my-client","version":"1.0"}}}'
```

For remote access over the internet, see [docs/remote-access.md](docs/remote-access.md) for Caddy/nginx reverse proxy setup with TLS.

## CLI Reference

### Subcommands

```
claude-ide-bridge start-all [options]   Full tmux orchestrator (bridge + Claude + remote)
claude-ide-bridge install-extension [editor]   Install VS Code extension into your IDE
```

### Bridge options (default mode)

```
--workspace <path>        Workspace folder (default: cwd)
--ide-name <name>         IDE name shown to Claude (default: auto-detect)
--editor <cmd>            Editor CLI command (default: auto-detect)
--port <number>           Force specific port (default: random)
--linter <name>           Enable specific linter (repeatable; default: auto-detect)
--allow-command <cmd>     Add command to execution allowlist (repeatable)
--timeout <ms>            Command timeout in ms (default: 30000, max: 120000)
--max-result-size <KB>    Max output size in KB (default: 512, max: 4096)
--watch                   Supervisor mode: auto-restart on crash (exponential backoff, max 30s)
--auto-tmux               Re-exec inside a tmux session automatically
--tool-rate-limit <n>     Max tool calls per minute per session (default: 60)
--claude-driver <mode>    Claude subprocess driver: subprocess | api | none (default: none)
--claude-binary <path>    Path to claude binary (default: claude)
--automation              Enable event-driven automation
--automation-policy <path> Path to JSON automation policy file
--verbose                 Enable debug logging
--help                    Show this help
```

## Architecture

```
claude-ide-bridge/
  src/
    bridge.ts         Main orchestrator
    server.ts         HTTP/WebSocket server
    transport.ts      MCP transport layer
    extensionClient.ts Extension WebSocket client
    config.ts         CLI args & config
    claudeDriver.ts   IClaudeDriver interface + SubprocessDriver
    claudeOrchestrator.ts Task queue (MAX_CONCURRENT=10, MAX_QUEUE=20)
    automation.ts     AutomationHooks — onDiagnosticsError / onFileSave / onPostCompact / onInstructionsLoaded policies
    tools/            120+ MCP tool implementations
  vscode-extension/
    src/extension.ts  VS Code extension
    src/connection.ts WebSocket connection management
    src/handlers/     Request handlers (terminal, lsp, debug, ...)
  claude-ide-bridge-plugin/
    skills/           9 slash commands
    agents/           3 specialized subagents
    hooks/            3 lifecycle automations
    .mcp.json         MCP server config
```

## Tips

### After restarting the bridge

When you restart the bridge (e.g. after an update or crash), existing sessions need to reconnect:

- **Claude Code (remote):** Start a **new Claude Code conversation** — the old session's MCP connection is tied to the previous bridge process.
- **Claude Desktop:** **Restart the Claude Desktop app** — it will re-connect via the stdio shim on next launch.
- **VS Code extension:** The extension reconnects automatically. If the bridge was updated, **reload the VS Code window** (`Developer: Reload Window`) so the extension picks up the new version.

### Reduce duplicate git instructions

Claude Code ships with its own built-in commit/PR guidance. When using the bridge's dedicated git tools (`gitCommit`, `gitPush`, `gitCreatePR`, etc.), you can suppress the duplicate Claude Code instructions by adding to `~/.claude/settings.json`:

```json
{
  "includeGitInstructions": false
}
```

This keeps the prompt clean and ensures Claude uses the bridge's structured git tools rather than raw shell commands.

---

## Connection Hardening

Production-grade reliability:
- WebSocket heartbeat (20s) with automatic reconnect
- Sleep/wake detection via heartbeat gap monitoring
- Circuit breaker with exponential backoff for timeout cascades
- Generation counter preventing stale handler responses
- Extension-required tool filtering when extension disconnects
- 909 tests (bridge); full WebSocket round-trip integration coverage
- MCP elicitation support (`elicitation: {}` capability) — bridge can send `elicitation/create` mid-task to request structured user input via Claude Code's interactive dialog (Claude Code 2.1.76+)

## Building

```bash
# Bridge
npm run build        # TypeScript compilation
npm run dev          # Development with tsx
npm test             # Run 909 bridge tests

# Extension
cd vscode-extension
npm run build        # esbuild bundle
npm run package      # Create .vsix
npm test             # Run 306 extension tests
```

## Troubleshooting

### Claude says a tool doesn't exist or tool count seems low

When the VS Code extension is disconnected, tools that require extension access are automatically hidden from Claude's tool list. About 50 tools become unavailable (terminal, LSP, debug, editor state, etc.). Check the "Claude IDE Bridge" output channel in VS Code — if you see a disconnection event, use `Claude IDE Bridge: Reconnect` from the command palette, or reload the window.

### Bridge and extension version mismatch

The extension auto-installs the bridge via npm on first use. If you also have a manually installed version, they may diverge. To check:

```bash
claude-ide-bridge --version          # bridge version
# Compare with the version shown in the extension's output channel on startup
```

To force the extension's managed version:

```bash
# Run the Install / Upgrade command from VS Code's command palette:
# "Claude IDE Bridge: Install / Upgrade Bridge"
# Or manually:
npm install -g claude-ide-bridge@latest
```

Then reload the VS Code window.

### Extension keeps reconnecting (oscillation)

Repeated disconnects / `tools/list` changes usually mean multiple old VSIX versions are installed across VS Code forks (e.g. both VS Code and Cursor). Install the latest extension in every editor and reload each window.

### `start-all` launched from inside a Claude Code session

Launching `start-all` from within an active Claude Code session can cause tmux conflicts. Kill the existing tmux server first:

```bash
tmux kill-server
env -u CLAUDECODE claude-ide-bridge start-all --workspace /your/project
```

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup, code style, and how to add new tools.

## Support

If Claude IDE Bridge saves you time, consider [sponsoring the project](https://github.com/sponsors/Oolab-labs).

## License

MIT
