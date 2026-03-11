# Claude IDE Bridge

[![npm version](https://img.shields.io/npm/v/claude-ide-bridge)](https://www.npmjs.com/package/claude-ide-bridge)
[![CI](https://github.com/Oolab-labs/claude-ide-bridge/actions/workflows/ci.yml/badge.svg)](https://github.com/Oolab-labs/claude-ide-bridge/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

A standalone MCP bridge that gives [Claude Code](https://claude.ai/code) full IDE integration — **115+ tools** for LSP, debugging, terminals, Git, GitHub, diagnostics, and more. Works with any VS Code-compatible editor (VS Code, Windsurf, Cursor) and pairs with a companion extension for real-time editor state.

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

# Start the bridge
claude-ide-bridge --workspace /path/to/your-project
```

Or from source:

```bash
git clone https://github.com/Oolab-labs/claude-ide-bridge.git
cd claude-ide-bridge
npm install && npm run build
npm start -- --workspace /path/to/your-project
```

Install the VS Code extension for full capabilities:

```bash
cd vscode-extension
npm install && npm run build && npm run package
# Install the .vsix in your editor
```

Then start Claude Code and connect:

```bash
claude
# The bridge MCP server will be available
```

## Full Orchestrator

The `start-all` script launches everything in a tmux session (bridge + Claude Code + remote control):

```bash
npm run start-all -- --workspace /path/to/your-project
```

## Claude Code Plugin

The bridge ships as a **Claude Code plugin** with 6 skills, 3 subagents, and 3 hooks:

```bash
# Load the plugin
claude --plugin-dir ./claude-ide-bridge-plugin
```

### Skills

| Skill | Description |
|-------|-------------|
| `/ide-debug` | Full debug cycle: run tests, set breakpoints, evaluate expressions, fix, verify |
| `/ide-review` | Deep PR review using LSP code intelligence + GitHub tools |
| `/ide-quality` | Multi-language lint sweep + auto-fix + format + optional commit |
| `/ide-refactor` | Safe refactoring with snapshot checkpoints and auto-rollback |
| `/ide-explore` | Codebase exploration using LSP (runs in isolated Explore agent) |
| `/ide-monitor` | Continuous monitoring for diagnostics, tests, or terminal output |

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

## 115+ MCP Tools

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
bash scripts/install-extension.sh --ide <name>
```

## CLI Options

```
--workspace <path>        Workspace folder (default: cwd)
--ide-name <name>         IDE name shown to Claude (default: auto-detect)
--editor <cmd>            Editor CLI command (default: auto-detect)
--port <number>           Force specific port (default: random)
--linter <name>           Enable specific linter (repeatable; default: auto-detect)
--allow-command <cmd>     Add command to execution allowlist (repeatable)
--timeout <ms>            Command timeout in ms (default: 30000, max: 120000)
--max-result-size <KB>    Max output size in KB (default: 512, max: 4096)
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
    tools/            115+ MCP tool implementations
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
- 601 tests across bridge and extension

## Building

```bash
# Bridge
npm run build        # TypeScript compilation
npm run dev          # Development with tsx
npm test             # Run 359 bridge tests

# Extension
cd vscode-extension
npm run build        # esbuild bundle
npm run package      # Create .vsix
npm test             # Run 242 extension tests
```

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup, code style, and how to add new tools.

## Support

If Claude IDE Bridge saves you time, consider [sponsoring the project](https://github.com/sponsors/Oolab-labs).

## License

MIT
