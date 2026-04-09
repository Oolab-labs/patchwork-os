# Troubleshooting — Why aren't my tools showing up?

Start here: open a Claude Code session and type `/mcp`. You'll see connection status for every registered MCP server. `claude-ide-bridge` should show as connected. If it doesn't, one of the issues below is the cause.

---

## Issue 1: Wrong config file

**Symptom:** Tools are missing in Claude Code, but `claude-ide-bridge --watch` is running.

**Cause:** Claude Code has three config scopes:

| File | When it loads |
|------|---------------|
| `~/.claude.json` | Always — every `claude` session, every directory |
| `.mcp.json` (project) | Only when you run `claude` manually from that directory |
| `.claude/settings.local.json` | Claude Code settings, not MCP servers |

**The trap:** When VS Code, Windsurf, or Cursor launches Claude Code, it injects `--mcp-config` pointing at its own config. This **overrides** any project `.mcp.json`. Only `~/.claude.json` is guaranteed to load.

**Fix:** Run `claude-ide-bridge init` — it registers the shim in `~/.claude.json` automatically. If you've already run init, confirm the entry exists:

```bash
cat ~/.claude.json | grep -A5 claude-ide-bridge
```

Expected output:
```json
"claude-ide-bridge": {
  "command": "claude-ide-bridge",
  "args": ["shim"],
  "type": "stdio"
}
```

If it's missing, add it manually or re-run `claude-ide-bridge init`.

---

## Issue 2: Bridge not running

**Symptom:** `/mcp` shows `claude-ide-bridge` as disconnected or not responding.

**Cause:** The shim auto-discovers a running bridge via lock files in `~/.claude/ide/`. If no bridge is running, there's nothing to connect to.

**Fix:** Start the bridge in your project directory:

```bash
cd /your/project
claude-ide-bridge --watch
```

The `--watch` flag keeps it running and auto-restarts on crash. Confirm it started:

```bash
ls ~/.claude/ide/
# Should show a .lock file, e.g. 55000.lock
```

---

## Issue 3: Extension not installed or not active

**Symptom:** Bridge is running, `/mcp` shows connected, but tools like `getDiagnostics` or `getOpenEditors` return "extension not connected."

**Cause:** The VS Code extension is what gives the bridge access to IDE state. Without it, only filesystem tools work.

**Fix:**

If you have an old version installed, uninstall it first:
```bash
code --uninstall-extension oolab-labs.claude-ide-bridge-extension
```

Then reinstall:
```bash
code --install-extension oolab-labs.claude-ide-bridge-extension
```

Then reload VS Code: `Cmd+Shift+P` → `Developer: Reload Window`.

Confirm it's active: look for the Claude IDE Bridge status bar item at the bottom of VS Code.

---

## Issue 4: PATH issues (Windows / WSL)

**Symptom:** `claude-ide-bridge init` reports "no supported editor found on PATH" or the shim fails with a command not found error.

**Cause on WSL:** VS Code is installed on the Windows host but the WSL shell can't find the `code` binary. VS Code's WSL integration normally adds a `code` shim to the Linux PATH, but this requires the Remote - WSL extension to be active.

**Fix for WSL:**
1. Open VS Code on Windows and install the **Remote - WSL** extension
2. Open your project folder in WSL via `File > Open Folder` or `code .` from WSL terminal
3. Re-run `claude-ide-bridge init` from inside the WSL terminal

If `code` still isn't found, specify the editor manually:

```bash
claude-ide-bridge install-extension code
```

**Cause on Windows (non-WSL):** npm global bin directory not in PATH.

**Fix:**
```bash
npm config get prefix
# Add <prefix>\bin to your PATH in System Environment Variables
```

---

## Issue 5: Port conflict

**Symptom:** Bridge fails to start with "address already in use."

**Cause:** Another process (or a previous bridge instance) is using the default port (55000).

**Fix:** Start on a different port:

```bash
claude-ide-bridge --port 55001 --watch
```

Or find and stop the conflicting process:

```bash
lsof -i :55000   # macOS/Linux
netstat -ano | findstr :55000   # Windows
```

---

## Issue 6: `claude-ide-bridge` not found after install

**Symptom:** `command not found: claude-ide-bridge` after `npm install -g claude-ide-bridge`.

**Cause:** npm's global bin directory isn't in your PATH.

**Fix:**

```bash
npm config get prefix
# Returns something like /usr/local or /Users/you/.npm-global

# Add to ~/.zshrc or ~/.bashrc:
export PATH="$(npm config get prefix)/bin:$PATH"

# Reload:
source ~/.zshrc
```

---

## Issue 7: Tools not visible after IDE-launched Claude Code

**Symptom:** Running `claude --ide` from terminal works, but Claude Code launched from VS Code's command palette or terminal integration doesn't show bridge tools.

**Cause:** IDE-launched Claude Code injects `--mcp-config` which overrides project `.mcp.json`. See Issue 1.

**Fix:** Confirm `~/.claude.json` has the bridge entry (see Issue 1 fix). The global config is always loaded regardless of how Claude Code is launched.

---

## Issue 8: Some tools missing in slim mode (default)

**Symptom:** Tools like `runTests`, `getGitStatus`, `createFile`, or `githubCreatePR` aren't showing up, but LSP tools work fine.

**Cause:** Slim mode (the default) only exposes ~48 IDE-exclusive tools — LSP, debugger, editor state, decorations, and refactoring. Git, terminal, file ops, GitHub, and HTTP tools are only available in `--full` mode.

**Fix:** Start the bridge in full mode:
```bash
claude-ide-bridge --watch --full
```

Or set permanently in `claude-ide-bridge.config.json`:
```json
{ "fullMode": true }
```

To see which mode is active and which tools are registered, ask Claude to call `getToolCapabilities`.

---

## Issue 9: Bridge keeps crashing or restarting

**Symptom:** Bridge process exits unexpectedly; Claude loses connection repeatedly; logs show restart messages.

**Cause:** Common triggers: a tool call that hangs past the timeout, a workspace with unusual permissions, or an out-of-date Node.js version.

**Diagnosis:**
```bash
# Check Node.js version — must be 20+
node --version

# Run the bridge manually (not via --watch) to see the crash output directly
claude-ide-bridge --workspace /your/project
```

**Fixes:**
1. **Upgrade Node.js** if below v20: `nvm install 20 && nvm use 20`
2. **Use `--watch` mode** — it auto-restarts with exponential backoff and is safe for production:
   ```bash
   claude-ide-bridge --watch
   ```
3. **Increase timeout** if a specific tool is timing out:
   ```bash
   claude-ide-bridge --watch --timeout 60000
   ```
4. **Check disk space** — the bridge writes lock files and task persistence to `~/.claude/ide/`. Low disk space causes write failures.
5. Run `bridgeDoctor` via Claude to get a full environment health check.

---

## Issue 10: HTTP session capacity exceeded (503 error)

**Symptom:** Remote MCP clients (claude.ai, Claude Desktop via Custom Connector) get a `503 Service Unavailable` with message `"HTTP session capacity reached"`.

**Cause:** The bridge allows a maximum of **5 concurrent HTTP sessions**. When the limit is reached, the oldest idle session (inactive >60s) is evicted automatically. If all 5 sessions are actively in use, new connections are rejected with 503.

**Fix:** This usually resolves itself as idle sessions expire (10-minute idle TTL). If you're consistently hitting the limit:
- Check whether stale browser tabs or tools are holding sessions open
- Restart the bridge to clear all sessions: `claude-ide-bridge --watch`
- For high-traffic team setups, run multiple bridge instances on different ports (one per user or project)

---

## Still stuck?

1. Check the bridge logs: `claude-ide-bridge --watch` prints connection events to stderr
2. Check the VS Code Output panel: `View > Output` → select `Claude IDE Bridge`
3. Open a GitHub issue: https://github.com/Oolab-labs/claude-ide-bridge/issues

Include the output of:
```bash
claude-ide-bridge --version
node --version
ls ~/.claude/ide/
cat ~/.claude.json
```
