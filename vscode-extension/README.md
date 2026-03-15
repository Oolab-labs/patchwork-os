# Claude IDE Bridge

Companion VS Code extension for [claude-ide-bridge](https://github.com/Oolab-labs/claude-ide-bridge) — gives Claude Code real-time visibility into your editor.

## What it does

When the bridge server is running, this extension streams live editor state to Claude Code:

- **Open files & active selection** — Claude knows what you're looking at
- **Diagnostics** — lint errors and type errors are pushed to Claude automatically
- **Terminal output** — Claude can run commands and read results in your IDE terminal
- **File system events** — Claude is notified when files change

## Setup

**Install this extension** — the bridge is automatically installed and started for you.

The extension detects whether `claude-ide-bridge` is installed globally (via npm), installs or upgrades it if needed, then starts it in the background for your workspace. No manual steps required.

To verify it's running, open the output channel: `Claude IDE Bridge: Show Logs`.

### Manual setup (optional)

If auto-start is disabled, you can manage the bridge manually:

```bash
npm install -g claude-ide-bridge
claude-ide-bridge --workspace /your/project
```

## Requirements

- VS Code 1.93+ (or a compatible fork: Cursor, Windsurf)
- Node.js 20+ on `PATH` (for auto-install)

## Commands

| Command | Description |
|---|---|
| `Claude IDE Bridge: Reconnect` | Manually reconnect to the bridge |
| `Claude IDE Bridge: Show Logs` | Open the output channel |
| `Claude IDE Bridge: Copy Connection Info` | Copy bridge URL and token to clipboard |
| `Claude IDE Bridge: Start Bridge` | Manually start the bridge for this workspace |
| `Claude IDE Bridge: Install / Upgrade Bridge` | Install or upgrade the bridge via npm |

## Configuration

| Setting | Default | Description |
|---|---|---|
| `claudeIdeBridge.logLevel` | `info` | Log verbosity: `info`, `debug`, or `warn` |
| `claudeIdeBridge.autoConnect` | `true` | Connect automatically on startup |
| `claudeIdeBridge.autoStartBridge` | `true` | Auto-start the bridge process on extension activation |
| `claudeIdeBridge.autoInstallBridge` | `true` | Auto-install/upgrade the bridge via npm if not found or outdated |
| `claudeIdeBridge.lockFileDir` | `` | Override lock file directory (default: `~/.claude/ide/`) |

## Troubleshooting

### Tool count seems low or Claude can't find IDE tools

When the extension loses its connection to the bridge, tools that require extension access (~50 tools: terminal, LSP, debug, editor state, etc.) are automatically hidden from Claude. Open the **Output** panel and select **Claude IDE Bridge** to check connection status. Use `Claude IDE Bridge: Reconnect` from the command palette to reconnect, or reload the window.

### Bridge and extension version mismatch

This extension auto-installs and manages the `claude-ide-bridge` npm package. If you also installed the bridge manually, the versions may diverge. To sync them:

1. Open the command palette and run **Claude IDE Bridge: Install / Upgrade Bridge**
2. Reload the VS Code window after the upgrade completes

### Extension keeps reconnecting

Repeated disconnects usually mean multiple old versions of the extension are installed across VS Code forks (e.g. both VS Code and Cursor). Install the latest extension in every editor and reload each window.

## After restarting or updating the bridge

| Scenario | What to do |
|---|---|
| Bridge restarted | The extension reconnects automatically — no action needed |
| Bridge updated | **Reload the VS Code window** (`Developer: Reload Window`) so the extension picks up the new version |
| Claude Code (remote) session | **Start a new Claude Code conversation** — the old session's MCP connection doesn't survive a bridge restart |
| Claude Desktop | **Restart the Claude Desktop app** — it reconnects via the stdio shim on next launch |

## Links

- [GitHub](https://github.com/Oolab-labs/claude-ide-bridge)
- [npm](https://www.npmjs.com/package/claude-ide-bridge)
- [Issues](https://github.com/Oolab-labs/claude-ide-bridge/issues)
