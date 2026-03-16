# Claude IDE Bridge

Give Claude Code real-time visibility into your editor. Claude sees your open files, diagnostics, terminal output, and editor state — and can act on all of it.

Fix a bug from your phone. Let Claude run your tests and commit the result. Ask Claude what lint errors are in your workspace without copy-pasting anything. This extension makes all of that work.

## How It Works

This extension is the VS Code side of [claude-ide-bridge](https://github.com/Oolab-labs/claude-ide-bridge), an MCP server that connects Claude Code to your IDE over WebSockets. The extension streams live editor state to the bridge; Claude Code reads and acts on it through 138+ MCP tools.

When this extension is installed, **the bridge is installed and started automatically** — no terminal commands required to get going.

## Quick Start

**Step 1 — Install this extension.**

The extension detects whether `claude-ide-bridge` is installed globally, installs or upgrades it if needed, then starts it in the background for your workspace.

**Step 2 — Connect Claude Code.**

In your project directory:

```bash
CLAUDE_CODE_IDE_SKIP_VALID_CHECK=true claude --ide
```

> Add `export CLAUDE_CODE_IDE_SKIP_VALID_CHECK=true` to your shell profile so `claude --ide` is all you need going forward.

**Step 3 — Confirm the connection.**

Type `/ide` in Claude Code to see your open files, diagnostics, and editor state. The status bar item in VS Code shows the connection state.

To check bridge logs at any point: run **Claude IDE Bridge: Show Logs** from the command palette.

### Manual setup (optional)

If auto-start is disabled, manage the bridge yourself:

```bash
npm install -g claude-ide-bridge
claude-ide-bridge --workspace /your/project
```

## What Claude Can Do With This Extension

Once connected, Claude has full IDE context and can act on it without you describing your setup:

- **Read your diagnostics** — "Fix all TypeScript errors in this file" works because Claude can call `getDiagnostics` directly.
- **Navigate code** — go to definition, find references, search workspace symbols, get call hierarchies.
- **Run and read terminal output** — create terminals, run commands, wait for output, report results back.
- **Edit and save files** — open files in your editor, apply changes, save documents.
- **Run tests and check coverage** — run your test suite, read failures, fix them, re-run.
- **Set breakpoints and inspect debug state** — start a debug session, evaluate expressions, stop when done.
- **Commit, push, and open PRs** — full Git workflow via structured tools, not raw shell commands.
- **Format, lint, and organize imports** — code quality tools wired to your IDE's language servers.
- **Capture a screenshot** — Claude can see what your editor looks like.
- **Watch files for changes** — register file watchers and react to saves.

Tools that require the extension (~50 of 138+) are automatically hidden from Claude when the extension is not connected. When reconnected, they reappear.

## Requirements

- VS Code 1.93+ (or a compatible fork: Cursor, Windsurf, Google Antigravity)
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
| `claudeIdeBridge.autoConnect` | `true` | Connect automatically on startup |
| `claudeIdeBridge.autoStartBridge` | `true` | Auto-start the bridge process on extension activation |
| `claudeIdeBridge.autoInstallBridge` | `true` | Auto-install/upgrade the bridge via npm if not found or outdated |
| `claudeIdeBridge.logLevel` | `info` | Log verbosity: `info`, `debug`, or `warn` |
| `claudeIdeBridge.lockFileDir` | _(empty)_ | Override lock file directory (default: `~/.claude/ide/`). Useful for multi-bridge setups. |

## After Restarting or Updating the Bridge

| Scenario | What to do |
|---|---|
| Bridge restarted | The extension reconnects automatically — no action needed |
| Bridge updated | Reload the VS Code window (`Developer: Reload Window`) |
| Claude Code session | Start a new Claude Code conversation — old sessions don't survive a bridge restart |
| Claude Desktop | The stdio shim reconnects automatically — only restart if the shim process died |

## Troubleshooting

### Tool count seems low or Claude can't find IDE tools

When the extension loses its connection to the bridge, tools requiring extension access (~50 tools: terminal, LSP, debug, editor state) are automatically hidden from Claude. Open the **Output** panel and select **Claude IDE Bridge** to check connection status. Run **Claude IDE Bridge: Reconnect** from the command palette, or reload the window.

### Bridge and extension version mismatch

The extension auto-manages the `claude-ide-bridge` npm package. If you also installed the bridge manually, versions may diverge. To sync:

1. Run **Claude IDE Bridge: Install / Upgrade Bridge** from the command palette.
2. Reload the VS Code window after the upgrade completes.

### Extension keeps reconnecting

Repeated disconnects usually mean multiple old versions are installed across VS Code forks (e.g. both VS Code and Cursor). Install the latest extension in every editor and reload each window.

### Untrusted workspaces

In untrusted workspaces, bridge auto-install and auto-start are disabled. The extension will watch for a manually-started bridge via lock file, but will not spawn one itself.

## Links

- [GitHub](https://github.com/Oolab-labs/claude-ide-bridge)
- [npm (bridge)](https://www.npmjs.com/package/claude-ide-bridge)
- [Issues](https://github.com/Oolab-labs/claude-ide-bridge/issues)

## Version & Compatibility

| | |
|---|---|
| Extension version | 1.0.5 |
| Bridge package | `claude-ide-bridge` (npm) |
| VS Code requirement | 1.93+ |
| Compatible editors | VS Code, Cursor, Windsurf, Google Antigravity |
| Node.js requirement | 20+ (for bridge auto-install) |
