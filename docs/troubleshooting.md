# Troubleshooting — claude-ide-bridge v2.30.1

---

## Quick Diagnostic Checklist

Run these five checks before reading further. They catch 90% of issues.

1. **Is `claude-ide-bridge` listed and green in `/mcp`?**
   Type `/mcp` in Claude Code. If the entry is missing entirely, the config file is wrong (see [Tools Not Showing Up](#tools-not-showing-up)). If it shows as errored or disconnected, the bridge process is not running.

2. **Is the bridge process running?**
   ```bash
   ps aux | grep claude-ide-bridge
   # or on a systemd VPS:
   systemctl status claude-ide-bridge
   ```
   If it's not running, start it: `claude-ide-bridge --watch`

3. **Is the VS Code extension installed and showing "Bridge connected"?**
   Look for the Claude IDE Bridge status bar item at the bottom of VS Code. If it's absent, the extension is not installed (see [Extension Disconnected](#extension-disconnected)).

4. **Does the lock file exist?**
   ```bash
   ls ~/.claude/ide/
   # Expected: one or more files named like 55000.lock
   ```
   No lock file means the bridge hasn't started successfully or is writing to the wrong directory.

5. **Is Node.js version 20 or higher?**
   ```bash
   node --version
   # Must be v20.x or higher
   ```
   Upgrade if needed: `nvm install 20 && nvm use 20`

---

## Tools Not Showing Up

### Bridge not in `/mcp` list

**Cause:** Claude Code cannot find the bridge entry in any config file it loads.

**Fix:** Run `claude-ide-bridge init` — it registers the shim in `~/.claude.json` automatically. Confirm the entry:

```bash
cat ~/.claude.json | grep -A5 claude-ide-bridge
```

Expected entry:
```json
"claude-ide-bridge": {
  "command": "claude-ide-bridge",
  "args": ["shim"],
  "type": "stdio"
}
```

> **Note:** When VS Code, Cursor, or Windsurf launches Claude Code, it injects `--mcp-config` that overrides any project `.mcp.json`. Only `~/.claude.json` is guaranteed to load in all launch contexts.

### Bridge listed but 0 tools

**Cause:** The bridge process crashed after the shim connected, or crashed before reporting tools.

**Diagnosis:**
```bash
# Check whether the bridge is actually running
ps aux | grep claude-ide-bridge

# Check for a valid lock file
ls -la ~/.claude/ide/

# Run bridge manually to see crash output
claude-ide-bridge --workspace /your/project
```

Ask Claude to call `bridgeDoctor` for a full health check — it reports lock file state, circuit breaker state, and probe results.

### Fewer tools than expected

**Cause:** The bridge was started with `--slim`, or `"fullMode": false` is set in the config file. Slim mode exposes only ~60 IDE-exclusive tools (LSP, debugger, editor state). Git, terminal, file ops, GitHub, and HTTP tools are hidden.

**Fix:** Drop `--slim` from your start command, or remove `"fullMode": false` from `claude-ide-bridge.config.json`:
```bash
claude-ide-bridge --watch
```

Full mode has been the default since v2.43.0 — all ~140 tools are registered automatically. To confirm which mode is active and which tools are registered, ask Claude to call `getToolCapabilities`.

---

## Extension Disconnected

**Symptom:** Bridge is running and `/mcp` shows it connected, but extension-dependent tools return "extension not connected."

### Extension not installed

```bash
code --install-extension oolab-labs.claude-ide-bridge-extension
# Then reload: Cmd+Shift+P → Developer: Reload Window
```

### Extension version mismatch

Check the version the bridge detected:
```
Ask Claude: getBridgeStatus
Look for: extensionPackageVersion
```

If the version is older than expected, reinstall:
```bash
code --uninstall-extension oolab-labs.claude-ide-bridge-extension
code --install-extension oolab-labs.claude-ide-bridge-extension
```

### Extension host crashed

**Cause:** VS Code's extension host process crashed, taking the bridge extension with it.

**Fix:** `Cmd+Shift+P` → `Developer: Restart Extension Host`. This restarts all extensions without reloading the full window.

### Port mismatch

**Cause:** The bridge started on port X but the extension is configured to connect to port Y.

**Diagnosis:** Check which port the bridge is actually using:
```bash
ls ~/.claude/ide/
# The filename is the port: e.g. 55000.lock means port 55000
```

The extension discovers the port automatically from the lock file. If it's not connecting, verify the lock file exists and that `CLAUDE_CONFIG_DIR` is not set to an unexpected path.

---

## Port Conflicts

**Symptom:** Bridge fails to start with `Error: listen EADDRINUSE`.

**Cause:** Another process (or a previous bridge instance) is holding the port.

The bridge picks a random available port by default. A conflict only occurs if you specify a fixed port that is already in use.

**Find the conflicting process:**
```bash
lsof -i :55000      # macOS/Linux
netstat -ano | findstr :55000   # Windows
```

**Assign a fixed port** (VS Code setting):
```json
"claudeIdeBridge.port": 55001
```

Or via CLI: `claude-ide-bridge --port 55001 --watch`

**Find which port the running bridge is on:**
```bash
ls ~/.claude/ide/
# The .lock filename is the port number
```

---

## Tools Return Errors Unexpectedly

### `isError: true` — "extension required"

**Cause:** The tool requires the VS Code extension, and the extension is not connected. This is expected behavior — tools remain listed even when the extension is disconnected.

**Fix:** Reconnect the extension (see [Extension Disconnected](#extension-disconnected)). The tool will work as soon as the extension reports back.

### Timeout errors / circuit breaker open

**Cause:** The circuit breaker opens after 3 extension timeouts within 30 seconds. When open, all extension-dependent tool calls fail immediately rather than waiting.

**Symptom:** Multiple tools failing with timeout or "circuit breaker open" in the error.

**Fix:** The circuit breaker resets automatically after the backoff window. If it keeps tripping:
1. `Cmd+Shift+P` → `Developer: Restart Extension Host`
2. If that doesn't help, reload the VS Code window: `Developer: Reload Window`
3. Check `getBridgeStatus` → `circuitBreakerState` to confirm it closed

---

## Windows and WSL

### `claude-ide-bridge: command not found`

**Cause:** npm's global bin directory is not on PATH.

**Fix on PowerShell:**
```powershell
npm config get prefix
# Add <prefix>\bin to System Environment Variables → PATH
# Then restart your terminal
```

**Fix on bash/zsh:**
```bash
npm config get prefix
# Returns e.g. /usr/local or /Users/you/.npm-global
export PATH="$(npm config get prefix)/bin:$PATH"
# Add this line to ~/.zshrc or ~/.bashrc
```

### WSL2 — bridge in WSL, Claude Code on Windows

**Cause:** The bridge writes its lock file to the WSL filesystem (`~/.claude/ide/`). Claude Code running on the Windows host cannot read that path, so the shim cannot discover the bridge.

**Recommended approach:** Run both the bridge and Claude Code inside WSL, or both on the Windows host. Do not split them across the WSL boundary.

If you must use the Windows Claude Code with a WSL bridge, bind-mount `~/.claude/ide/` to a Windows-accessible path and set `CLAUDE_CONFIG_DIR` accordingly on both sides.

### File paths in WSL

WSL paths (`/mnt/c/Users/...`) and Windows paths (`C:\Users\...`) are not interchangeable in tool arguments. The bridge treats workspace paths as native OS paths. Use the form native to whichever side the bridge is running on.

---

## Docker

### Lock file not found

**Cause:** Claude Code running outside the container cannot see lock files written inside the container's `~/.claude/ide/`.

**Fix:** Bind-mount the lock directory:
```bash
docker run \
  -v ~/.claude/ide:/root/.claude/ide \
  claude-ide-bridge --watch
```

Or set `CLAUDE_CONFIG_DIR` to a mounted volume path in both the container and your host shell.

### Port unreachable

**Cause:** Container networking isolates the bridge port.

**Fix for local dev** — use host networking:
```bash
docker run --network host claude-ide-bridge --watch
```

**Fix for explicit port mapping:**
```bash
docker run -p 55000:55000 claude-ide-bridge --port 55000 --watch
```

The bridge must bind to `0.0.0.0` (not `127.0.0.1`) for port mapping to work:
```bash
docker run -p 55000:55000 claude-ide-bridge --port 55000 --bind 0.0.0.0 --watch
```

### CLAUDE_CONFIG_DIR in container

Set this to a mounted volume so lock files persist across container restarts:
```bash
docker run \
  -e CLAUDE_CONFIG_DIR=/data/claude \
  -v /host/claude-data:/data/claude \
  claude-ide-bridge --watch
```

---

## Automation Hooks Not Firing

### `--automation` flag missing

Automation requires the flag to be present at startup:
```bash
claude-ide-bridge --watch --automation --automation-policy /path/to/policy.json --claude-driver subprocess
```

All three flags are required: `--automation`, `--automation-policy`, and `--claude-driver subprocess`.

### Claude Code version too old

Some hooks depend on Claude Code hook events introduced in specific versions:

| Hook | Minimum Claude Code version |
|------|----------------------------|
| `onFileChanged`, `onCwdChanged` | ≥ 2.1.83 |
| `onTaskCreated` | ≥ 2.1.84 |
| `onPermissionDenied` | ≥ 2.1.89 |

Check your Claude Code version: `claude --version`

### CC hooks not wired in settings.json

Hooks that fire from Claude Code events (`onPostCompact`, `onInstructionsLoaded`, `onTaskCreated`, `onPermissionDenied`, `onCwdChanged`) require entries in `~/.claude/settings.json`.

**Diagnosis:** Ask Claude to call `getBridgeStatus` and check `unwiredEnabledHooks`. Any hooks listed there need wiring.

**Fix:** Re-run `claude-ide-bridge init` — it wires these automatically. Or add the entries manually:
```json
"hooks": {
  "PostCompact": [
    { "matcher": "", "hooks": [{ "type": "command", "command": "claude-ide-bridge notify PostCompact" }] }
  ]
}
```

### Rate limit or cooldown active

**Diagnosis:** Check `getBridgeStatus` → `automationStats` for `throttledCount` or `cooldownActive`.

Minimum cooldown between triggers for the same file/event is 5 seconds. Some hooks default to 120–600 seconds. If triggers are too frequent, adjust `cooldownMs` in your automation policy.

---

## Bridge Crashes / Restart Loops

### Reading `--watch` output

`--watch` uses exponential backoff: 2s → 4s → 8s → … → 30s (maximum). Log lines show:
```
[watch] bridge exited with code 1, restarting in 4s (attempt 2)
```

If you see the delay stuck at 30s and cycling, the bridge has a persistent crash rather than a transient fault.

### Common crash causes

| Cause | Symptom | Fix |
|-------|---------|-----|
| Port already bound | `EADDRINUSE` in logs | Use a different port or stop the conflicting process |
| Workspace path not found | `ENOENT: workspace` | Pass `--workspace /absolute/path` |
| `package.json` parse error | `SyntaxError` at startup | Fix malformed `package.json` in workspace |
| Node.js below v20 | Various failures | `nvm install 20 && nvm use 20` |

### Getting crash logs

```bash
# systemd
journalctl -u claude-ide-bridge -n 50

# --watch mode (logs go to stderr)
claude-ide-bridge --watch 2>bridge-error.log
tail -f bridge-error.log

# VS Code Output panel
View > Output → select "Claude IDE Bridge"
```

---

## VPS / Remote Deployment

### systemd service `active (failed)`

```bash
systemctl status claude-ide-bridge
journalctl -u claude-ide-bridge -n 50
```

Common causes: wrong `WorkingDirectory` in the unit file, missing `.env.vps`, Node.js not on the service user's PATH. The bootstrap script sets these correctly — if you installed manually, compare against `deploy/claude-ide-bridge.service.template`.

### nginx 502 Bad Gateway

**Cause:** nginx is proxying to the bridge but the bridge is not running, or the WebSocket upgrade headers are missing.

Confirm the bridge is running: `systemctl status claude-ide-bridge`

Confirm the nginx config includes WebSocket upgrade headers:
```nginx
proxy_http_version 1.1;
proxy_set_header Upgrade $http_upgrade;
proxy_set_header Connection "upgrade";
proxy_buffering off;
proxy_read_timeout 86400s;
```

Missing `proxy_buffering off` causes SSE streams to disconnect every few seconds.

### SSL certificate expired

```bash
certbot renew
systemctl reload nginx
```

### Firewall blocking WebSocket

Test with HTTP first, then WebSocket:
```bash
# HTTP check
curl -I https://bridge.yourdomain.com/ping

# WebSocket check (requires wscat: npm install -g wscat)
wscat -c wss://bridge.yourdomain.com --header "Authorization: Bearer $TOKEN"
```

If HTTP works but WebSocket fails, the firewall or proxy is blocking the `Upgrade` header. Ensure port 443 allows long-lived connections.

---

## HTTP Session Capacity (503 error)

**Cause:** The bridge allows a maximum of 5 concurrent HTTP sessions. When all 5 are active, new connections receive `503 Service Unavailable`.

The bridge automatically evicts the oldest idle session (idle > 60s). Sessions expire after 10 minutes of inactivity.

**Fix:** Wait for sessions to expire, or restart the bridge to clear all sessions. For high-traffic setups, run one bridge instance per user.

---

## Reading `bridgeDoctor` Output

Ask Claude to call `bridgeDoctor` (or use `getBridgeStatus` for a lighter version). Key fields:

| Field | Healthy value | What to do if not |
|-------|--------------|-------------------|
| `lockFile` | `found` | Bridge not running — start it with `claude-ide-bridge --watch` |
| `lockFile` | `stale` | Previous bridge died without cleanup — delete stale lock: `rm ~/.claude/ide/*.lock` |
| `extensionConnected` | `true` | Extension not connected — see [Extension Disconnected](#extension-disconnected) |
| `circuitBreakerState` | `closed` | If `open`: extension host unresponsive — restart extension host |
| `ccHookWiring` | All enabled hooks wired | Any unwired hook won't fire — re-run `claude-ide-bridge init` |
| `probes.git` | `found` | Git tools won't work — install git |
| `probes.gh` | `found` | GitHub tools won't work — install GitHub CLI (`gh`) |
| `probes.rg` | `found` | `searchWorkspace` pattern search unavailable — install ripgrep |
| `probes.ctags` | `found` (Universal Ctags) | `searchWorkspaceSymbols` ctags fallback unavailable — install Universal Ctags |
| `probes.tsc` | `found` | TypeScript LSP fallback may be limited — install typescript globally |

`circuitBreakerState: open` means 3+ extension timeouts occurred in the last 30 seconds. It resets automatically; restart the extension host to speed recovery.

---

## SSH / Remote Resilience

When working over SSH, the bridge continues running if SSH drops — as long as processes stay alive. Key points:

- **Use tmux:** `npm run start-all` runs everything in a tmux session. SSH drop → tmux detaches, processes survive. Reconnect: `tmux attach -t claude-all`
- **Grace period:** Default 120 seconds. Increase if you have longer disconnections: `--grace-period 300000`
- **SSH keepalive** (`~/.ssh/config`): `ServerAliveInterval 30` prevents premature disconnection

See [docs/ssh-resilience.md](ssh-resilience.md) for full details.

---

## Getting Help

**GitHub Issues:** https://github.com/Oolab-labs/claude-ide-bridge/issues

When reporting a bug, include:
```bash
claude-ide-bridge --version
node --version
uname -a   # or on Windows: winver
ls ~/.claude/ide/
```

And the output of asking Claude to call `bridgeDoctor` (or `getBridgeStatus`).

Include any relevant log lines from `journalctl -u claude-ide-bridge` (VPS) or the VS Code Output panel.
