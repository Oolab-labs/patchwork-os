# claude-ide-bridge

A standalone MCP bridge that gives Claude Code full IDE integration — file operations, diagnostics, LSP features, terminal output, and more. Works with any editor (VS Code, Windsurf, Cursor) and optionally pairs with a companion VS Code extension for real-time editor state.

## Architecture

```
Claude Code CLI  <--WebSocket/MCP-->  Bridge Server  <--WebSocket-->  VS Code Extension (optional)
```

- **Bridge Server**: Node.js process that exposes MCP tools over WebSocket. Handles file operations, linting, search, git, and command execution natively.
- **VS Code Extension**: Companion extension that pushes real-time diagnostics, selections, AI comments, terminal output, and LSP features to the bridge.

## Quick Start

```bash
cd claude-ide-bridge
npm install
npm run build
npm start -- --workspace /path/to/your-project
```

Then in another terminal:

```bash
CLAUDE_CODE_IDE_SKIP_VALID_CHECK=true claude
# Type /ide and select the bridge
```

See [SETUP.md](SETUP.md) for detailed setup, remote control, and troubleshooting.

## Remote Control

Control your Claude Code session from claude.ai or the Claude mobile app. The bridge includes an auto-restart wrapper that handles connection drops automatically:

```bash
npm run remote                    # just remote-control with auto-restart
npm run start-all -- --workspace . # full orchestrator (bridge + claude + remote)
```

See [SETUP.md — Connection Stability](SETUP.md#remote-control-connection-stability) for details.

## VS Code Extension

The companion extension provides enhanced capabilities when connected:

```bash
cd vscode-extension
npm install
npm run build
# Install via: code --install-extension claude-ide-bridge-extension-0.1.0.vsix
```

### Extension Features

- **Status bar**: Shows connection state (connected/disconnected/reconnecting)
- **Output channel**: "Claude IDE Bridge" channel for structured logs
- **Commands** (via Command Palette):
  - `Claude IDE Bridge: Reconnect` — force reconnect to bridge
  - `Claude IDE Bridge: Show Logs` — open the output channel
  - `Claude IDE Bridge: Copy Connection Info` — copy state/version to clipboard
- **Auto-reconnect**: Exponential backoff with jitter, sleep/wake detection, escalating notifications after 3 failures
- **Real-time push**: Diagnostics, selections, active file, AI comments, file saves

## Available MCP Tools

### File Operations
| Tool | Description |
|------|-------------|
| `openFile` | Open files in editor with line navigation |
| `openDiff` | Open side-by-side diff view |
| `saveDocument` | Save open document (real save with extension, stub without) |
| `close_tab` | Close editor tab (requires extension) |
| `closeAllDiffTabs` | Close all diff tabs |
| `checkDocumentDirty` | Check for unsaved changes (accurate with extension) |
| `getOpenEditors` | List open editor tabs |

### Search & Navigation
| Tool | Description |
|------|-------------|
| `searchWorkspace` | Content search (uses `rg` if available, falls back to grep) |
| `findFiles` | File search (uses `fd` if available, falls back to find) |
| `getFileTree` | Directory tree view |
| `getCurrentSelection` | Get editor selection (requires extension) |
| `getLatestSelection` | Get cached selection state |

### Diagnostics & LSP (requires extension)
| Tool | Description |
|------|-------------|
| `getDiagnostics` | Get errors/warnings (extension or `tsc --noEmit` fallback) |
| `goToDefinition` | Jump to symbol definition |
| `findReferences` | Find all references to symbol |
| `getHover` | Get hover/type information |
| `getCodeActions` | List available code actions |
| `applyCodeAction` | Apply a code action |
| `renameSymbol` | Rename symbol across workspace |
| `searchSymbols` | Search workspace symbols |

### Git
| Tool | Description |
|------|-------------|
| `getGitStatus` | Working tree status |
| `getGitDiff` | Diff output (staged/unstaged/commit ranges) |
| `getGitLog` | Commit history |

### PR Code Review
| Tool | Description |
|------|-------------|
| `githubGetPRDiff` | Fetch PR metadata and unified diff |
| `githubPostPRReview` | Post review with overview + inline comments |

Use `/review-pr <number>` for a structured review workflow: fetches the PR, analyzes for bugs/security/performance issues, ranks by severity, verifies findings, and posts a review to GitHub.

### Linting & Formatting
| Tool | Description |
|------|-------------|
| `runLinter` | Run project linters (tsc, eslint, pyright, ruff, cargo, go, biome) |
| `formatFile` | Format files (prettier, black, gofmt, rustfmt) |
| `formatDocument` | Format via VS Code's formatter (extension) or CLI fallback |
| `fixAllLintErrors` | Auto-fix all lint errors via extension or CLI (eslint --fix, biome, ruff) |
| `organizeImports` | Organize imports via VS Code (requires extension) |

### Terminal (requires extension)
| Tool | Description |
|------|-------------|
| `listTerminals` | List VS Code integrated terminals |
| `getTerminalOutput` | Get recent terminal output (ring buffer, up to 5000 lines) |

### Workspace & Utilities
| Tool | Description |
|------|-------------|
| `getWorkspaceFolders` | Workspace path info |
| `getToolCapabilities` | Available features, CLI tools, and linters |
| `runCommand` | Execute allowlisted commands |
| `watchFiles` / `unwatchFiles` | File system watchers (requires extension) |
| `getAIComments` | Scan for `// AI:` comments (requires extension) |
| `diffDebugger` | Analyze and validate diffs |
| `activityLog` | Track session activity |
| `workspaceSnapshots` | Capture/restore workspace state |
| `flowGuardian` | Workflow state management |
| `planPersistence` | Save/load implementation plans |

## Multi-Workspace Usage

One bridge instance per workspace is the intended model — start the bridge with `--workspace /path/to/project` and leave it running for that project. For monorepos or multi-root workspaces, pass the repository root as `--workspace` so that all paths resolve correctly and the workspace snapshot/plan tools share a consistent root. Open multiple terminals with separate bridge instances if you need to work across completely independent projects simultaneously.

## CLI Options

```
--workspace <path>        Workspace folder (default: cwd)
--ide-name <name>         IDE name shown to Claude (default: "External")
--editor <cmd>            Editor CLI command (default: auto-detect windsurf/code/cursor)
--port <number>           Force specific port (default: random)
--linter <name>           Enable specific linter (repeatable; default: auto-detect)
--allow-command <cmd>     Add command to execution allowlist (repeatable)
--timeout <ms>            Command timeout in ms (default: 30000, max: 120000)
--max-result-size <KB>    Max output size in KB (default: 512, max: 4096)
--verbose                 Enable debug logging
--jsonl                   Emit structured JSONL events to stderr
--help                    Show this help
```

### Environment Variables

| Variable | Description |
|----------|-------------|
| `CLAUDE_IDE_BRIDGE_EDITOR` | Editor command override |
| `CLAUDE_IDE_BRIDGE_LINTERS` | Comma-separated linter list |
| `CLAUDE_IDE_BRIDGE_TIMEOUT` | Command timeout in ms |
| `CLAUDE_IDE_BRIDGE_MAX_RESULT_SIZE` | Max output size in KB |
| `CLAUDE_CONFIG_DIR` | Override `~/.claude` directory |

## Connection Hardening

The bridge and extension include production-grade connection handling:

- **WebSocket heartbeat** (20s ping/pong) with automatic reconnect on timeout
- **Sleep/wake detection** via heartbeat tick gap monitoring
- **Try-catch guards** around all `ws.send()` calls for check-then-send race conditions
- **Concurrent connect prevention** via `connecting` flag
- **Pong listener lifecycle management** to prevent listener stacking
- **Handler timeout** (30s) to prevent VS Code API hangs
- **Exponential backoff** with full jitter and 500ms minimum floor
- **`unexpected-response`** handling for rejected WebSocket upgrades
- **Graceful HTTP server shutdown** with error callback
- **Send buffer monitoring** (warns at >1MB buffered)

## Project Structure

```
claude-ide-bridge/
  src/
    index.ts          Entry point
    bridge.ts         Main bridge orchestrator
    server.ts         HTTP/WebSocket server
    transport.ts      MCP transport layer
    config.ts         CLI arg parsing & config
    probe.ts          Tool availability detection
    extensionClient.ts Extension WebSocket client
    logger.ts         Logging infrastructure
    tools/            MCP tool implementations
      index.ts        Tool registry
      utils.ts        Shared utilities
      ...             Individual tool files
  vscode-extension/
    src/extension.ts  VS Code extension
    package.json      Extension manifest
    esbuild.mjs       Build config
```

## Building

```bash
# Bridge
npm run build        # TypeScript compilation
npm run dev          # Development with tsx
npm test             # Run vitest tests

# Extension
cd vscode-extension
npm run build        # esbuild bundle
npm run package      # Create .vsix
```
