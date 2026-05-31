## Verify the bridge is running

The bridge is the background process that connects Claude to VS Code. The extension auto-starts it on first open, but if you see "Bridge disconnected" in the status bar you can start it manually.

### Manual start

```bash
# macOS / Linux
claude-ide-bridge start-all

# Windows (PowerShell or cmd)
claude-ide-bridge start-all
```

`start-all` launches the bridge, Claude (--ide), and the dashboard, then keeps them alive.

### How to tell it's working

- Status bar shows "Connected to bridge"
- The Analytics panel under the Claude icon in the activity bar opens without a "no bridge found" message
- A lock file appears at `~/.claude/ide/<port>.lock` (Windows: `%USERPROFILE%\.claude\ide\<port>.lock`)

### Troubleshooting

- **Port already in use** — another bridge instance is running. `claude-ide-bridge halts --window 1h` shows recent activity.
- **`claude-ide-bridge: command not found`** — install with `npm i -g patchwork-os`. Restart your shell after install.
- **Extension still shows disconnected** — click **Reconnect** above. The extension polls `~/.claude/ide/` and reconnects within ~2s of the lock file appearing.
