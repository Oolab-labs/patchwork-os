# Claude IDE Bridge

[![npm version](https://img.shields.io/npm/v/claude-ide-bridge)](https://www.npmjs.com/package/claude-ide-bridge)
[![CI](https://github.com/Oolab-labs/claude-ide-bridge/actions/workflows/ci.yml/badge.svg)](https://github.com/Oolab-labs/claude-ide-bridge/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

A standalone MCP bridge that gives [Claude Code](https://claude.ai/code) full IDE integration — **133+ tools** for LSP, debugging, terminals, Git, GitHub, diagnostics, and more. Works with any VS Code-compatible editor (VS Code, Windsurf, Cursor) and pairs with a companion extension for real-time editor state.

## How It Works

```
Your Phone / Laptop                    Your Computer
┌──────────────┐                      ┌─────────────────────────────┐
│  Claude Code  │───── SSH/local ─────│  Bridge Server              │
│  (CLI)        │                     │    ↕ WebSocket              │
└──────────────┘                      │  IDE Extension (VS Code)    │
                                      │    ↕ Real-time state        │
                                      │  Your Code & Editor         │
                                      └─────────────────────────────┘
```

Claude Code connects to the bridge, which connects to your IDE extension. Claude can then open files, run tests, set breakpoints, check diagnostics, commit to Git, create PRs — everything a developer at the keyboard can do.

**Use it from your phone**: SSH into your dev machine, run Claude Code, and control your full IDE from the couch. Watch files change in real-time on your monitor.

## Quick Start

```bash
npm install -g claude-ide-bridge

# Full setup: bridge + Claude Code + remote-control in a tmux session
claude-ide-bridge start-all --workspace /path/to/your-project

# Or run the bridge only (MCP server mode)
claude-ide-bridge --workspace /path/to/your-project
```

No global install needed — use `npx`:

```bash
npx claude-ide-bridge start-all --workspace /path/to/your-project
```

Or from source:

```bash
git clone https://github.com/Oolab-labs/claude-ide-bridge.git
cd claude-ide-bridge
npm install && npm run build
npm run start-all -- --workspace /path/to/your-project
```

Install the VS Code extension for full capabilities:

```bash
# Auto-detects your editor (VS Code, Windsurf, Cursor, Antigravity)
claude-ide-bridge install-extension

# Or specify explicitly
claude-ide-bridge install-extension windsurf
```

Then start Claude Code and connect:

```bash
claude
# The bridge MCP server will be available
```

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

The bridge ships as a **Claude Code plugin** with 6 skills, 3 subagents, and 3 hooks:

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

## 124+ MCP Tools

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

### And More
Text editing · Workspace management · HTTP requests · File watchers · Notebooks · Decorations · VS Code commands

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
| Code Quality | 3 | Yes |
| Debug | 5 | Yes |
| Decorations | 2 | Yes |
| Workspace Management | 4 | No |
| Snapshots & Plans | 10 | No |
| HTTP | 2 | No |
| VS Code Integration | 8 | Yes |
| Notebooks | 3 | Yes |
| **Total** | **~115** | |

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
--auto-tmux               Re-exec inside a tmux session automatically
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
    tools/            124+ MCP tool implementations
  vscode-extension/
    src/extension.ts  VS Code extension
    src/connection.ts WebSocket connection management
    src/handlers/     Request handlers (terminal, lsp, debug, ...)
  claude-ide-bridge-plugin/
    skills/           6 slash commands
    agents/           3 specialized subagents
    hooks/            3 lifecycle automations
    .mcp.json         MCP server config
```

## Connection Hardening

Production-grade reliability:
- WebSocket heartbeat (20s) with automatic reconnect
- Sleep/wake detection via heartbeat gap monitoring
- Circuit breaker with exponential backoff for timeout cascades
- Generation counter preventing stale handler responses
- Extension-required tool filtering when extension disconnects
- 654 tests across bridge and extension (408 bridge + 246 extension)

## Building

```bash
# Bridge
npm run build        # TypeScript compilation
npm run dev          # Development with tsx
npm test             # Run 408 bridge tests

# Extension
cd vscode-extension
npm run build        # esbuild bundle
npm run package      # Create .vsix
npm test             # Run 246 extension tests
```

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup, code style, and how to add new tools.

## Support

If Claude IDE Bridge saves you time, consider [sponsoring the project](https://github.com/sponsors/Oolab-labs).

## License

MIT
