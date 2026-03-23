# claude-ide-bridge Setup Guide — Development Mode

> **This guide is for running the bridge from source** (contributors and local development).
> For the standard installation using `npm install -g`, see the [plugin README](claude-ide-bridge-plugin/README.md#quick-start).

A standalone MCP bridge that gives Claude Code full IDE integration. Opens files, shows diffs, gets diagnostics, runs tests, and more — via 136+ MCP tools.

## Prerequisites

- Node.js 18+
- A supported IDE: VS Code, Windsurf, Cursor, or Google Antigravity
- `tmux` (for `start-all.sh`): `brew install tmux` (macOS) or `apt install tmux` (Linux)
- **Required env var** — Claude Code won't discover the bridge without this:
  ```bash
  export CLAUDE_CODE_IDE_SKIP_VALID_CHECK=true
  ```
  Add to your `~/.zshrc` or `~/.bashrc` to make it permanent.

## Quick Start

From the `claude-ide-bridge` directory:

```bash
cd claude-ide-bridge
npm run dev -- --workspace /path/to/your-project
```

Or from any directory using the full path:

```bash
npx tsx ~/path/to/claude-ide-bridge/src/index.ts --workspace .
```

Then in another terminal (same project directory):

```bash
CLAUDE_CODE_IDE_SKIP_VALID_CHECK=true claude
```

Type `/ide` inside Claude Code and select the bridge from the list. You should see a tool count confirmation — 136+ tools when the VS Code extension is connected, ~111 without it.

## Full Orchestration

For a fully managed setup where all processes are started, monitored, and restarted together:

```bash
./scripts/start-all.sh --workspace /path/to/project
# Or:
npm run start-all -- --workspace /path/to/project
```

This creates a tmux session (`claude-all`) with four panes:
- **Pane 0**: Orchestrator / health monitor
- **Pane 1**: Bridge server
- **Pane 2**: Claude Code CLI (with session ID for auto-resume)
- **Pane 3**: Extension watcher

Controls:
- `Ctrl+B then D` — detach (everything keeps running)
- `tmux attach -t claude-all` — reattach
- `tmux kill-session -t claude-all` — stop everything

## Options

```
--workspace <path>   Project folder (default: current directory)
--ide-name <name>    IDE name shown to Claude (default: "External")
--editor <cmd>       Editor CLI command (default: auto-detect windsurf/code/cursor)
--port <number>      Force specific port (default: random 10000-65535)
--verbose            Show debug logs
```

## How It Works

1. The bridge starts a WebSocket server on localhost
2. It writes a lock file to `~/.claude/ide/<port>.lock`
3. Claude Code discovers the lock file and connects over WebSocket
4. Claude Code can now call IDE tools (open files, get diagnostics, etc.)
5. The lock file is automatically cleaned up when the bridge stops

## Available Tools (136+)

The bridge exposes 136+ MCP tools across file ops, LSP, git, GitHub, terminals, debugging, diagnostics, planning, and more. See the full reference in [documents/platform-docs.md](documents/platform-docs.md).

**Without extension** (25 tools hidden): Terminal, debug, file watching, tasks, and advanced LSP tools require the VS Code extension. All other tools work with native filesystem/CLI fallbacks.

## Building from Source

```bash
cd claude-ide-bridge
npm install
npm run build
npm start -- --workspace /path/to/project
```

## Troubleshooting

### Claude Desktop: bridge tools unavailable after bridge restart

When the bridge restarts (new port), the stdio shim subprocess in Claude Desktop still points to the old port. The **Reconnect** button in Claude Desktop settings does NOT fix this — it retries the existing shim process.

**Fix:** Fully quit Claude Desktop (`Cmd+Q` on Mac, not just closing the window) and relaunch it. The new shim will discover the updated lock file.

### Switching between CLI and Desktop sessions

Each Claude Code CLI session and Desktop chat session is independent. Context is not automatically shared. Use `setHandoffNote` before switching contexts to persist your working state. The bridge also auto-snapshots a handoff note when a new session connects and the existing note is stale (>5 min).

### Cowork sessions use git worktrees

Claude Desktop's Cowork (computer-use) mode operates in an isolated git worktree — a separate branch and working copy, not your main workspace root. This means:

- Files written by Cowork land in the worktree, not your main working tree
- `git status` on main won't show Cowork's changes until the worktree branch is merged
- Add **"write all files to the workspace root, not a subdirectory"** as the first instruction in your `CLAUDE.md` when using Cowork on a synced workspace, to prevent files landing in unexpected subdirectory paths within the worktree
- After a Cowork session, review the worktree branch and merge it back manually

See [docs/cowork-workflow.md](docs/cowork-workflow.md) for the full workflow.

**Bridge exits immediately on startup:**
- Check for a stale lock file: `ls ~/.claude/ide/` — delete any `.lock` files from processes that are no longer running
- Run with `--verbose` to see startup errors
- Check Node.js version: `node --version` (requires 18+)

**Port already in use:**
- Another bridge instance may already be running. Check: `ls ~/.claude/ide/*.lock`
- Stop the existing bridge or use `--port <different-port>`

**Lock file not cleaned up:**
- If the bridge crashed, delete stale lock files: `rm ~/.claude/ide/<port>.lock`
- The bridge cleans up lock files on graceful exit (SIGTERM/SIGINT) but not on crash (SIGKILL)

**Claude Code doesn't see the bridge:**
- Start Claude Code with `CLAUDE_CODE_IDE_SKIP_VALID_CHECK=true claude`
- Make sure the bridge is running before typing `/ide` in Claude Code
- Check `~/.claude/ide/` for the lock file
- Try `--verbose` flag for debug output

**Files don't open in editor:**
- Verify `windsurf` (or `code`/`cursor`) is on your PATH
- Use `--editor <command>` to specify the editor CLI explicitly

**Stale lock files:**
- The bridge warns about stale lock files on startup
- If needed, manually delete files in `~/.claude/ide/`

**`tmux: command not found`:**
- Install tmux: `brew install tmux` (macOS) or `apt install tmux` (Ubuntu/Debian)

**Full orchestrator (`start-all.sh`) issues:**
- **Bridge won't start:** Check that `npx tsx` works and that the bridge source is built
- **Health monitor doesn't detect crash:** The monitor polls `~/.claude/ide/*.lock` every 10s. If the bridge exited uncleanly, the lock file may persist — delete it manually from `~/.claude/ide/`
- **Kill everything:** `tmux kill-session -t claude-all`
