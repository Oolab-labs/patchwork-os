# claude-ide-bridge Setup Guide — Development Mode

> **This guide is for running the bridge from source** (contributors and local development).
> For the standard installation using `npm install -g`, see the [README Quick Start](README.md#quick-start).

A standalone MCP bridge that gives Claude Code full IDE integration with Windsurf (or any editor). Opens files, shows diffs, gets diagnostics — without needing the VS Code extension.

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

Type `/ide` inside Claude Code and select the bridge from the list.

> **Note:** The `CLAUDE_CODE_IDE_SKIP_VALID_CHECK=true` env var is required
> for Claude Code to discover the bridge. Without it, Claude Code's internal
> validation may filter it out. You can add this to your shell profile
> (`~/.zshrc` or `~/.bashrc`) to make it permanent:
> ```bash
> export CLAUDE_CODE_IDE_SKIP_VALID_CHECK=true
> ```

## Full Experience: Bridge + Remote Control

Use the bridge for IDE integration AND Remote Control to interact from claude.ai or your phone:

```bash
# Terminal 1: Start the bridge
cd your-project
npx tsx ~/path/to/claude-ide-bridge/src/index.ts --workspace .

# Terminal 2: Start Claude Code and connect to bridge
CLAUDE_CODE_IDE_SKIP_VALID_CHECK=true claude
# Type /ide → select the bridge → then enable Remote Control:
# Type /remote or run: claude remote-control
# Open the link in claude.ai or Claude mobile app

# For persistent remote control (auto-restarts on disconnect):
# Run from the claude-ide-bridge directory:
npm run remote
```

## What Each Piece Does

| Component | What it does |
|-----------|-------------|
| **Bridge** | Claude Code can open files in Windsurf, show diffs, get TypeScript diagnostics |
| **Remote Control** | Control the Claude Code session from claude.ai or your phone |
| **Together** | Full IDE-integrated AI coding from anywhere |

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

## Available Tools (124+)

The bridge exposes 124+ MCP tools across file ops, LSP, git, GitHub, terminals, debugging, diagnostics, planning, and more. See the full reference in [documents/platform-docs.md](documents/platform-docs.md).

**Without extension** (25 tools hidden): Terminal, debug, file watching, tasks, and advanced LSP tools require the VS Code extension. All other tools work with native filesystem/CLI fallbacks.

**In remote sessions** (`claude remote-control`): Remote sessions don't have MCP tools. Skills with CLI fallbacks (`/ide-diagnostics-board`, `/ide-coverage`, `/ide-quality`) work by using built-in Claude Code tools (Glob, Read, Write, Bash). LSP-dependent skills (`/ide-deps`, `/ide-explore`, `/ide-debug`, `/ide-refactor`, `/ide-review`) require the `claude --ide` session.

## Remote Control with Auto-Approve

Remote Control currently cannot forward permission prompts (Yes/No) to the Claude app — this is a known Claude Code limitation ([#29319](https://github.com/anthropics/claude-code/issues/29319)). Without a workaround, you'll need to approve actions at the terminal, defeating the purpose of Remote Control.

### Option A: Accept Edits mode (recommended)

1. Start Claude Code: `CLAUDE_CODE_IDE_SKIP_VALID_CHECK=true claude --ide`
2. Press `Shift+Tab` to cycle to **"Accept Edits"** mode
3. Connect to bridge: `/ide`
4. Start Remote Control: `/remote`

File changes are auto-approved; bash commands still require terminal approval. Best balance of convenience and safety.

### Option B: Skip all permissions (fastest, least safe)

```bash
CLAUDE_CODE_IDE_SKIP_VALID_CHECK=true claude --dangerously-skip-permissions
```

Everything is auto-approved — no prompts at all. Only use this for trusted projects.

### Option C: Pre-approve specific tools via CLAUDE.md (most granular)

Add a `CLAUDE.md` file to your project root:

```markdown
allowedTools:
  - Edit
  - Write
  - Read
  - Glob
  - Grep
```

This pre-approves specific tools so they don't trigger prompts, while keeping bash and other tools gated.

---

## Remote Control Connection Stability

Remote Control is a research preview that may drop connections periodically
([known issue](https://github.com/anthropics/claude-code/issues/28571)).
The bridge includes an auto-restart wrapper that handles reconnection automatically.

**Prerequisites:** `tmux` (`brew install tmux`) and `claude` CLI on PATH. `caffeinate` (macOS built-in) is used automatically when available; on Linux it is skipped.

### Auto-restart wrapper (recommended)

```bash
# From the claude-ide-bridge directory:
./scripts/start-remote.sh
# Or:
npm run remote
```

This runs `claude remote-control` inside tmux with:
- **Sleep prevention** — `caffeinate` keeps macOS from idle-sleeping
- **Auto-restart** — reconnects automatically when the connection drops (with exponential backoff)
- **Clean exit** — Ctrl+C stops the loop instead of restarting
- **Circuit breaker** — stops after 50 rapid consecutive failures
- **Session persistence** — tmux keeps it running if your terminal closes

Detach: `Ctrl+B, D` — Reattach: `tmux attach -t claude-remote`

### Manual alternative

If you prefer not to use the script:

```bash
tmux new -s claude-remote
caffeinate -i bash -c 'while true; do claude remote-control; [ $? -eq 130 ] && break; sleep 5; done'
```

### Full orchestration (manages all three processes)

For a fully managed setup where all processes are started, monitored, and restarted together:

```bash
./scripts/start-all.sh --workspace /path/to/project
# Or:
npm run start-all -- --workspace /path/to/project
```

This creates a tmux session with four panes:
- **Pane 0**: Orchestrator / health monitor
- **Pane 1**: Bridge server
- **Pane 2**: Claude Code CLI (with session ID for auto-resume)
- **Pane 3**: Remote control (auto-restarts on disconnect)

If the bridge crashes, all processes are automatically restarted in the correct order. Claude Code resumes the previous conversation via `--resume`.

Controls:
- `Ctrl+B, D` — detach (everything keeps running)
- `tmux attach -t claude-all` — reattach
- `tmux kill-session -t claude-all` — stop everything

### Push notifications (optional)

Get notified on your phone when connections drop:

1. Install the [ntfy app](https://ntfy.sh) on your phone
2. Subscribe to a random topic (e.g., `claude-myproject-a7f3b`)
3. Pass it to the script:
   ```bash
   ./scripts/start-all.sh --workspace . --notify claude-myproject-a7f3b
   # Or with just remote-control:
   ./scripts/start-remote.sh --notify claude-myproject-a7f3b
   ```

> **Privacy:** ntfy.sh topics are public-by-name. Use a long random string as your topic name. For full privacy, self-host ntfy (Docker one-liner).

### Stability tips

- Use **wired Ethernet** when possible — WiFi transitions cause drops
- Run `/config` → enable "Remote Control for all sessions" to skip manual activation
- `caffeinate` prevents idle sleep but NOT lid-close sleep (laptop lid close will still disconnect)

---

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

**Remote Control doesn't show Yes/No prompts:**
- This is a known Claude Code limitation — Remote Control cannot forward permission prompts to the mobile/web app
- Use one of the auto-approve workarounds in the "Remote Control with Auto-Approve" section above
- Or keep the terminal visible to approve prompts there

**Remote Control keeps restarting in a loop:**
- Check that `claude remote-control` works on its own first
- If it exits immediately every time, the wrapper will back off exponentially (up to 5 minutes)
- After 50 rapid consecutive failures, the wrapper gives up — fix the underlying issue and retry
- Kill the tmux session: `tmux kill-session -t claude-remote`

**`tmux: command not found`:**
- Install tmux: `brew install tmux` (macOS) or `apt install tmux` (Ubuntu/Debian)

**Remote Control session appears stuck/frozen:**
- **From terminal:** Press `Esc` to interrupt the hanging agent, then re-prompt
- **From Remote Control (no Esc available):** Kill the terminal process and restart both the bridge and Claude Code
- **Prevention:** Run Claude Code inside `tmux` or `screen` so you always have terminal access to press `Esc`
- The bridge has a 60-second tool timeout — if a tool call hangs, it will automatically abort and return an error rather than blocking forever

**Full orchestrator (`start-all.sh`) issues:**
- **Bridge won't start:** Check that `npx tsx` works and that the bridge source is built
- **Health monitor doesn't detect crash:** The monitor polls `~/.claude/ide/*.lock` every 10s. If the bridge exited uncleanly, the lock file may persist — delete it manually from `~/.claude/ide/`
- **Kill everything:** `tmux kill-session -t claude-all`
