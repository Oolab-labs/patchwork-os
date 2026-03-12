# Claude IDE Bridge

Companion VS Code extension for [claude-ide-bridge](https://github.com/Oolab-labs/claude-ide-bridge) — gives Claude Code real-time visibility into your editor.

## What it does

When the bridge server is running, this extension streams live editor state to Claude Code:

- **Open files & active selection** — Claude knows what you're looking at
- **Diagnostics** — lint errors and type errors are pushed to Claude automatically
- **Terminal output** — Claude can run commands and read results in your IDE terminal
- **File system events** — Claude is notified when files change

## Requirements

- VS Code 1.93+ (or a compatible fork: Cursor, Windsurf)
- [claude-ide-bridge](https://www.npmjs.com/package/claude-ide-bridge) running locally or on a remote machine

## Setup

**1. Install the bridge:**
```bash
npm install -g claude-ide-bridge
```

**2. Start the bridge:**
```bash
npx claude-ide-bridge --workspace /your/project
```

**3. The extension connects automatically** on startup. Check the output channel (`Claude IDE Bridge: Show Logs`) to confirm.

## Commands

| Command | Description |
|---|---|
| `Claude IDE Bridge: Reconnect` | Manually reconnect to the bridge |
| `Claude IDE Bridge: Show Logs` | Open the output channel |
| `Claude IDE Bridge: Copy Connection Info` | Copy bridge URL and token to clipboard |

## Configuration

| Setting | Default | Description |
|---|---|---|
| `claudeIdeBridge.logLevel` | `info` | Log verbosity: `info`, `debug`, or `warn` |
| `claudeIdeBridge.autoConnect` | `true` | Connect automatically on startup |
| `claudeIdeBridge.lockFileDir` | `` | Override lock file directory (default: `~/.claude/ide/`) |

## Links

- [GitHub](https://github.com/Oolab-labs/claude-ide-bridge)
- [npm](https://www.npmjs.com/package/claude-ide-bridge)
- [Issues](https://github.com/Oolab-labs/claude-ide-bridge/issues)
