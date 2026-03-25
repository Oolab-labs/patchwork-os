# Claude IDE Bridge Plugin

If you're using this, a star helps more people find it — [github.com/Oolab-labs/claude-ide-bridge](https://github.com/Oolab-labs/claude-ide-bridge)

A Claude Code plugin that provides full IDE integration — 136+ tools for LSP, debugging, terminals, Git, GitHub, diagnostics, OAuth 2.0, and more.

## Quick Start

The fastest path from zero to working:

```bash
# 1. Install the bridge
npm install -g claude-ide-bridge

# 2. Install the VS Code extension (auto-installs, or use the command below)
claude-ide-bridge install-extension

# 3. Add the required env var (add to ~/.zshrc or ~/.bashrc to make permanent)
export CLAUDE_CODE_IDE_SKIP_VALID_CHECK=true

# 4. Start the bridge (supervised, auto-restarts on crash)
claude-ide-bridge --watch --workspace /path/to/your/project

# 5. In a new terminal, open Claude Code with the plugin
claude --plugin-dir $(npm root -g)/claude-ide-bridge/claude-ide-bridge-plugin
```

### Verify it's working

Inside Claude Code, type `/ide` and select the bridge from the list. You should see a confirmation with the tool count (136+ tools when the extension is connected, ~111 without it).

The session start hook also prints bridge status automatically — look for a summary line at the top of each new conversation.

---

## Prerequisites

- [Claude Code](https://code.claude.com) v1.0.33+
- Node.js 18+
- A VS Code-compatible editor: VS Code, Windsurf, Cursor, or Google Antigravity
- The companion VS Code extension (installed via `claude-ide-bridge install-extension` or from the [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=oolab-labs.claude-ide-bridge-extension))

---

## Installation

### Option 1: npm (recommended)

```bash
npm install -g claude-ide-bridge
claude --plugin-dir $(npm root -g)/claude-ide-bridge/claude-ide-bridge-plugin
```

### Option 2: Local plugin (development)

```bash
git clone https://github.com/Oolab-labs/claude-ide-bridge
cd claude-ide-bridge
npm install && npm run build
claude --plugin-dir ./claude-ide-bridge-plugin
```

### Option 3: Project-level (team sharing)

Copy the plugin directory into your project and reference it in `.claude/settings.json` so everyone on the team gets it automatically:

```json
{
  "enabledPlugins": [
    { "source": "./claude-ide-bridge-plugin" }
  ]
}
```

No CLI flags needed — Claude Code loads the plugin from the project root on startup.

---

## Bridge Setup

### Install the extension

The VS Code extension provides LSP, debugging, terminal, and editor tools. Without it, ~27 tools are unavailable.

```bash
# Install via subcommand (detects your IDE automatically)
claude-ide-bridge install-extension

# Or specify the IDE explicitly (positional argument):
claude-ide-bridge install-extension windsurf
claude-ide-bridge install-extension cursor
claude-ide-bridge install-extension antigravity

# Or install from the marketplace manually:
# VS Code Marketplace: search "Claude IDE Bridge" (oolab-labs.claude-ide-bridge-extension)
# Open VSX: oolab-labs.claude-ide-bridge-extension
```

### Start the bridge

The bridge must be running before Claude Code starts. Use `--watch` for supervised auto-restart:

```bash
claude-ide-bridge --watch --workspace /path/to/your/project
```

Or use the full orchestrator (tmux + all processes managed together):

```bash
npm run start-all -- --workspace /path/to/your/project
```

### Required env var

Claude Code requires this env var to discover the bridge:

```bash
export CLAUDE_CODE_IDE_SKIP_VALID_CHECK=true
```

Add it to your `~/.zshrc` or `~/.bashrc` to make it permanent. Without it, Claude Code's internal validation will silently filter out the bridge.

---

## What's Included

### Skills (9 slash commands)

| Skill | Description |
|-------|-------------|
| `/claude-ide-bridge:ide-debug` | Full debug cycle: run tests, set breakpoints, evaluate expressions, fix, verify |
| `/claude-ide-bridge:ide-review` | Deep PR review using LSP code intelligence + GitHub tools |
| `/claude-ide-bridge:ide-quality` | Multi-language lint sweep + auto-fix + format + optional commit |
| `/claude-ide-bridge:ide-refactor` | Safe refactoring with snapshot checkpoints and auto-rollback |
| `/claude-ide-bridge:ide-explore` | Codebase exploration using LSP (runs in isolated Explore agent) |
| `/claude-ide-bridge:ide-monitor` | Continuous monitoring for diagnostics, tests, or terminal output |
| `/claude-ide-bridge:ide-coverage` | Coverage report generation and gap analysis |
| `/claude-ide-bridge:ide-deps` | Dependency audit and security advisory review |
| `/claude-ide-bridge:ide-diagnostics-board` | Visual diagnostics dashboard for the active workspace |

### Subagents (3 specialized agents)

| Agent | Model | Description |
|-------|-------|-------------|
| `ide-code-reviewer` | Sonnet | Evidence-based code review using LSP tools, with persistent memory |
| `ide-debugger` | Inherit | Autonomous debug cycles with breakpoints and expression evaluation |
| `ide-test-runner` | Sonnet | Runs tests, categorizes failures, applies fixes |

All agents have `memory: project` enabled — they learn codebase patterns across sessions.

### Hooks (16 lifecycle automations)

| Hook | Event | What it does |
|------|-------|--------------|
| Pre-tool path normalization | `PreToolUse` | Resolves relative file/path args to absolute paths before tools execute |
| Post-edit diagnostics | `PostToolUse` on Edit/Write | Reminds Claude to check diagnostics after file edits |
| Session info | `SessionStart` | Reports bridge status, connection state, and tool count |
| Instructions loaded | `InstructionsLoaded` | Re-injects live bridge status each time CLAUDE.md reloads |
| Elicitation pre-fill | `Elicitation` | Pre-answers file/path/uri fields using the active editor |
| Elicitation result | `ElicitationResult` | Logs user responses (or cancellations) to MCP elicitation dialogs |
| Post-compact re-inject | `PostCompact` | Re-injects bridge status after Claude compacts context |
| Worktree create | `WorktreeCreate` | Reports bridge ↔ worktree relationship; warns about LSP tool limitations |
| Worktree remove | `WorktreeRemove` | Warns that IDE state (open files, diagnostics) may be stale after worktree removal |
| Bridge health check | `SubagentStart` on ide-* agents | Verifies bridge is alive before IDE subagents run |
| Subagent stop | `SubagentStop` | Surfaces subagent final response summary for parent agent awareness |
| Teammate idle | `TeammateIdle` | Reports bridge health when a team agent finishes and waits for coordination |
| Task completed | `TaskCompleted` | Logs task completion summary and confirms bridge availability for follow-up |
| Config change | `ConfigChange` | Warns if changed config files (MCP, permissions) require a bridge restart |
| Stop | `Stop` | Logs session end and surfaces final response summary for automated workflows |
| Stop failure | `StopFailure` | Logs API errors (rate limits, auth) that ended the turn; checks bridge health |

### MCP Server

The plugin configures the bridge as an MCP server, providing 136+ tools:

- **LSP** (13 tools): goToDefinition, findReferences, getHover, renameSymbol, getCallHierarchy, getTypeHierarchy, getInlayHints, ...
- **Debugging** (5 tools): setDebugBreakpoints, startDebugging, evaluateInDebugger, getDebugState, stopDebugging
- **Terminals** (7 tools): createTerminal, runInTerminal, waitForTerminalOutput, sendTerminalCommand, ...
- **Git** (15 tools): gitAdd, gitCommit, gitPush, gitBlame, getDiffBetweenRefs, getGitHotspots, ...
- **Diagnostics** (3 tools): getDiagnostics, runTests, watchDiagnostics
- **Editor** (7 tools): openFile, getCurrentSelection, getOpenEditors, getBufferContent, ...
- **File Operations** (7 tools): createFile, deleteFile, renameFile, findFiles, getFileTree, ...
- **Code Quality** (5 tools): fixAllLintErrors, formatDocument, organizeImports, detectUnusedCode, generateAPIDocumentation
- **Analysis** (8 tools): getImportTree, getCallHierarchy, getCodeCoverage, getDependencyTree, getSecurityAdvisories, ...
- **Planning** (5 tools): createPlan, updatePlan, getPlan, deletePlan, listPlans
- **HTTP** (2 tools): sendHttpRequest, parseHttpFile
- **VS Code Integration** (8 tools): executeVSCodeCommand, getWorkspaceSettings, setWorkspaceSetting, ...
- **AI Comments** (2 tools): `getAIComments` — scans open documents for `// AI: fix/todo/question/warn` annotations and caches them; `createGithubIssueFromAIComment` — files a GitHub issue from a specific cached comment (call `getAIComments` first)
- **File Watching** (2 tools): `watchFiles`, `unwatchFiles` — register glob patterns and receive notifications when matching files change
- **Inlay Hints** (1 tool): `getInlayHints` — returns LSP inlay hints (inferred types, parameter names) for a file range
- **Type Hierarchy** (1 tool): `getTypeHierarchy` — walks class/interface inheritance trees up and down
- **Decorations** (2 tools): `setDecorations`, `clearDecorations` — render inline editor annotations and highlights
- **Clipboard** (2 tools): `readClipboard`, `writeClipboard` — read and write the system clipboard (1 MB cap)
- **Snapshots, notebooks, OAuth, activity log**: see [Platform Docs](../documents/platform-docs.md) for full reference

---

## Scheduled Monitoring

Use `/loop` with the monitor skill for continuous checks:

```
/loop 5m /claude-ide-bridge:ide-monitor diagnostics
/loop 10m /claude-ide-bridge:ide-monitor tests auth
/loop 2m /claude-ide-bridge:ide-monitor terminal dev-server
```

---

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

---

## Tool Categories Quick Reference

| Category | Count | Extension Required |
|----------|------:|:-:|
| File Operations | 7 | No |
| Git | 15 | No |
| LSP / Code Intelligence | 13 | Yes (with fallbacks) |
| Editor State | 7 | Yes |
| Text Editing | 5 | Yes |
| Terminal | 7 | Yes |
| Diagnostics & Testing | 3 | Mixed |
| Code Quality | 5 | Yes |
| Analysis | 8 | Mixed |
| Debug | 5 | Yes |
| Planning & Snapshots | 10 | No |
| Decorations | 2 | Yes |
| Workspace Management | 4 | No |
| HTTP | 2 | No |
| VS Code Integration | 8 | Yes |
| Notebooks | 3 | Yes |
| Activity & OAuth | 4 | No |
| **Total** | **~138** | |

---

## Remote Access

The bridge supports remote access via Streamable HTTP for use with Claude Desktop, Cowork, or the Claude.ai web interface:

```bash
# Generate MCP config for remote access
npm run remote -- --host your-server.example.com --token your-token
```

See [docs/remote-access.md](../docs/remote-access.md) for full setup instructions.

---

## Links

- [GitHub Repository](https://github.com/Oolab-labs/claude-ide-bridge)
- [Setup Guide](../SETUP.md)
- [Changelog](../CHANGELOG.md)
- [Plugin Authoring Docs](../documents/plugin-authoring.md)
