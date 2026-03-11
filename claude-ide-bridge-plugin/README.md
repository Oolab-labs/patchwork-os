# Claude IDE Bridge Plugin

A Claude Code plugin that provides full IDE integration — 115+ tools for LSP, debugging, terminals, Git, GitHub, diagnostics, and more.

## Prerequisites

- [Claude Code](https://code.claude.com) v1.0.33+
- The bridge server built and available in PATH (see [Bridge Setup](#bridge-setup))
- A VS Code-compatible editor with the companion extension installed

## Installation

### Option 1: Local plugin (development)

```bash
claude --plugin-dir ./claude-ide-bridge-plugin
```

### Option 2: Project-level (team sharing)

Copy the plugin directory into your project and add to `.claude/settings.json`:

```json
{
  "enabledPlugins": [
    { "source": "./claude-ide-bridge-plugin" }
  ]
}
```

## Bridge Setup

The plugin's `.mcp.json` expects `claude-ide-bridge` to be in your PATH. Two options:

### From npm (when published)
```bash
npm install -g claude-ide-bridge
```

### From source
```bash
cd claude-ide-bridge
npm install && npm run build
npm link  # or add dist/index.js to PATH
```

The bridge must be running before Claude Code starts. Start it in a separate terminal:

```bash
claude-ide-bridge --workspace /path/to/your/project
```

Or use the full orchestrator:

```bash
npm run start-all -- --workspace /path/to/your/project
```

## What's Included

### Skills (6 slash commands)

| Skill | Description |
|-------|-------------|
| `/claude-ide-bridge:ide-debug` | Full debug cycle: run tests, set breakpoints, evaluate expressions, fix, verify |
| `/claude-ide-bridge:ide-review` | Deep PR review using LSP code intelligence + GitHub tools |
| `/claude-ide-bridge:ide-quality` | Multi-language lint sweep + auto-fix + format + optional commit |
| `/claude-ide-bridge:ide-refactor` | Safe refactoring with snapshot checkpoints and auto-rollback |
| `/claude-ide-bridge:ide-explore` | Codebase exploration using LSP (runs in isolated Explore agent) |
| `/claude-ide-bridge:ide-monitor` | Continuous monitoring for diagnostics, tests, or terminal output |

### Subagents (3 specialized agents)

| Agent | Model | Description |
|-------|-------|-------------|
| `ide-code-reviewer` | Sonnet | Evidence-based code review using LSP tools, with persistent memory |
| `ide-debugger` | Inherit | Autonomous debug cycles with breakpoints and expression evaluation |
| `ide-test-runner` | Sonnet | Runs tests, categorizes failures, applies fixes |

All agents have `memory: project` enabled — they learn codebase patterns across sessions.

### Hooks (3 lifecycle automations)

| Hook | Event | What it does |
|------|-------|-------------|
| Post-edit diagnostics | `PostToolUse` on Edit/Write | Reminds Claude to check diagnostics after file edits |
| Session info | `SessionStart` | Reports bridge status, connection, and tool count |
| Bridge health check | `SubagentStart` | Verifies bridge is alive before IDE subagents run |

### MCP Server

The plugin configures the bridge as an MCP server, providing 115+ tools:

- **LSP** (12 tools): goToDefinition, findReferences, getHover, renameSymbol, getCallHierarchy, ...
- **Debugging** (5 tools): setDebugBreakpoints, startDebugging, evaluateInDebugger, ...
- **Terminals** (7 tools): createTerminal, runInTerminal, waitForTerminalOutput, ...
- **Git** (15 tools): gitAdd, gitCommit, gitPush, gitBlame, ...
- **GitHub** (11 tools): githubCreatePR, githubViewPR, githubPostPRReview, ...
- **Diagnostics** (3 tools): getDiagnostics, runTests, diffDebug
- **Editor** (7 tools): openFile, getCurrentSelection, getOpenEditors, ...
- **Snapshots** (6 tools): createSnapshot, restoreSnapshot, diffSnapshot, ...
- And many more (file ops, formatting, notebooks, decorations, VS Code commands)

## Scheduled Monitoring

Use `/loop` with the monitor skill for continuous checks:

```
/loop 5m /claude-ide-bridge:ide-monitor diagnostics
/loop 10m /claude-ide-bridge:ide-monitor tests auth
/loop 2m /claude-ide-bridge:ide-monitor terminal dev-server
```

Or set one-shot reminders:
```
in 30 minutes, check if the dev server is still running using getTerminalOutput
```

Note: Scheduled tasks are session-scoped — they stop when you exit Claude Code.

## Headless / Agent SDK Usage

Use the bridge with `claude -p` for CI/CD and automation:

```bash
# Fix all lint errors using IDE-grade diagnostics
claude -p "Use getDiagnostics to find all errors, then fix them" \
  --mcp-config ./mcp-bridge.json

# Run tests and fix failures
claude -p "Run tests with runTests, fix any failures, and commit" \
  --mcp-config ./mcp-bridge.json \
  --allowedTools "Read,Edit,Bash,mcp__claude-ide-bridge__*"

# Generate a codebase architecture overview
claude -p "Map the project architecture using getFileTree, getDocumentSymbols, and getCallHierarchy" \
  --mcp-config ./mcp-bridge.json \
  --output-format json

# Review a PR with deep code intelligence
claude -p "Review PR #42 using githubGetPRDiff, then analyze with goToDefinition and findReferences" \
  --mcp-config ./mcp-bridge.json
```

Create `mcp-bridge.json`:
```json
{
  "mcpServers": {
    "claude-ide-bridge": {
      "command": "claude-ide-bridge",
      "args": ["--workspace", "."]
    }
  }
}
```

The bridge must be running before headless commands execute.

## Tool Categories Quick Reference

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
