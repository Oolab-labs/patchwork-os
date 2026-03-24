# Orchestrator Bridge — Testing Walkthrough

This guide walks through manually testing the orchestrator from scratch: single bridge, multi-bridge, edge cases, and failure recovery.

---

## Prerequisites

- At least one IDE (VS Code, Cursor, Windsurf) with the claude-ide-bridge extension installed and connected
- `claude-ide-bridge` built locally (`npm run build`)
- `claude` CLI on PATH
- `tmux` installed

Verify the extension is running in your IDE — you should see the bridge status indicator in the status bar.

---

## 1. Smoke test — orchestrator starts and writes a lock file

```bash
cd claude-ide-bridge
node dist/index.js orchestrator --port 4746 --verbose
```

**Expected output:**
```
Orchestrator bridge starting on port 4746
Orchestrator bridge ready on port 4746 (token: xxxxxxxx...)
Monitoring N child bridge(s)
```

In another terminal:
```bash
# Lock file should exist
cat ~/.claude/ide/4746.lock | python3 -m json.tool
```

**Expected fields:** `isBridge: true`, `orchestrator: true`, `pid`, `authToken`, `port: 4746`.

```bash
# /ping endpoint is unauthenticated
curl -s http://127.0.0.1:4746/ping
```

**Expected:** `{"ok":true}` or similar 200 response.

Stop the orchestrator with `Ctrl+C`. The lock file should be deleted.

---

## 2. Single-bridge — tools are proxied from a connected IDE

Start the orchestrator and confirm it finds your running IDE bridge:

```bash
node dist/index.js orchestrator --port 4746 --verbose
```

Watch for a line like:
```
Monitoring 1 child bridge(s)
```

Within 10 seconds the orchestrator probes child bridges. With `--verbose`, you'll see:
```
Bridge port XXXX (VS Code) warming up — 3s elapsed
```
then:
```
[health] bridge XXXX healthy — N tools
```

### Connect Claude to the orchestrator

In a second terminal:
```bash
unset CLAUDECODE
CLAUDE_CODE_IDE_SKIP_VALID_CHECK=true claude --ide
```

Claude should connect. Run inside Claude:

```
getOrchestratorStatus
```

**Expected:** JSON with `childBridges` array containing 1 entry, `healthy: true`, `toolCount > 0`.

```
listWorkspaces
```

**Expected:** Your IDE's workspace path listed under "Available workspaces".

```
listBridges
```

**Expected:** Full bridge details including `pid`, `startedAt`, `availableTools` array.

---

## 3. Multi-bridge — two IDEs simultaneously

Open a **second IDE window** (e.g., Cursor) in a different workspace folder. Make sure the bridge extension is active in both. Wait ~15 seconds for the orchestrator's next health cycle.

```
listWorkspaces
```

**Expected:** Two workspaces listed, e.g.:
```
ws1: /projects/alpha
  IDE: VS Code (port 4747)
ws2: /projects/beta
  IDE: Cursor (port 4748)
```

### Tool name namespacing

If both IDEs expose a tool with the same name (e.g., `openFile`), the orchestrator disambiguates:

```
listBridges
```

Look at `availableTools` for each bridge. If both have `openFile`, Claude will see `openFile__VSCode` and `openFile__Cursor` as separate tools.

If only one bridge has a tool, it keeps its original name with no suffix.

### Switch workspace

```
switchWorkspace /projects/beta
```

**Expected:**
```
Switched to workspace: /projects/beta
IDE: Cursor (port 4748)
Tools available: N
```

Subsequent tool calls go to Cursor. Call `switchWorkspace /projects/alpha` to switch back.

---

## 4. npm run start-orchestrator — full tmux launcher

Stop any running orchestrator first, then:

```bash
npm run start-orchestrator
```

This opens a tmux session `claude-orch` with 3 panes:

| Pane | Contents |
|------|----------|
| 0 | Health monitor output |
| 1 | Orchestrator bridge logs |
| 2 | Claude Code CLI |

Navigate panes with `Ctrl+B` then arrow keys.

To stop: `tmux kill-session -t claude-orch` or `Ctrl+C` in pane 0.

**Flags:**
```bash
npm run start-orchestrator -- --port 4747 --notify my-alerts --verbose
```

---

## 5. Duplicate workspace — same path open in two IDEs

Open the **same folder** in both VS Code and Cursor. After the next health cycle:

```
listWorkspaces
```

**Expected:** Warning annotation:
```
ws1: /projects/shared
  IDE: VS Code (port 4747)
  [WARNING: same workspace also open in Cursor (port 4748)]
```

```
switchWorkspace /projects/shared
```

**Expected:** Disambiguation prompt:
```
Workspace "/projects/shared" is open in 2 IDE instances:
  port 4747: VS Code
  port 4748: Cursor

Call switchWorkspace again with the "port" argument to specify which one.
```

Resolve it:
```
switchWorkspace /projects/shared 4747
```

---

## 6. Startup grace period — new IDE connects mid-session

With the orchestrator already running and Claude connected, open a **third IDE window** in a new workspace. Watch the orchestrator logs (pane 1 if using tmux):

```
Bridge port XXXX (Cursor) warming up — 2s elapsed
Bridge port XXXX (Cursor) warming up — 12s elapsed
[health] bridge XXXX healthy — N tools
```

During the 15-second grace window, health failures don't count against the bridge. After it passes healthy, run:

```
listWorkspaces
```

**Expected:** Three workspaces now listed.

---

## 7. Bridge failure — BRIDGE_UNAVAILABLE error

With two IDEs connected, kill one IDE process (or stop the extension):

```bash
kill <IDE-PID>  # or just close the IDE window
```

After up to 10 seconds, attempt to call a tool that was only on the killed bridge. The orchestrator returns:

```
[BRIDGE_UNAVAILABLE] Child bridge on port XXXX (VS Code) is unavailable.
Tool "openFile" was not executed.
Last successful workspace: /projects/alpha
Reason: ...

Call listBridges to see current bridge status, or switchWorkspace to target a different IDE.
```

Session sticky affinity is cleared automatically. Calling `listBridges` shows `healthy: false` and `consecutiveFailures > 0` for the dead bridge.

---

## 8. Invalid / unsupported IDE lock files

The orchestrator silently skips lock files from IDEs that don't have the bridge extension (JetBrains family) and lock files with unexpected formats.

To test this manually, write a fake lock file:

```bash
# Simulate a JetBrains lock (should be silently skipped)
echo '{"pid":9999,"isBridge":true,"ideName":"IntelliJ IDEA","authToken":"x","workspaceFolders":["/tmp"],"startedAt":1}' \
  > ~/.claude/ide/9999.lock
```

After the next health cycle, run:

```
listBridges
```

**Expected:** An `[INFO] Skipped lock files` section at the bottom:
```
[INFO] Skipped lock files (non-bridge or invalid processes):
  port 9999: known non-bridge IDE: IntelliJ IDEA
```

The orchestrator logs no warning for this (it's expected). Clean up:
```bash
rm ~/.claude/ide/9999.lock
```

---

## 9. Orchestrator status tool

```
getOrchestratorStatus
```

Returns JSON — key fields to verify:

| Field | Expected value |
|-------|---------------|
| `orchestratorPort` | 4746 |
| `uptimeSeconds` | > 0 |
| `activeSessions` | 1 (your Claude session) |
| `childBridges[*].healthy` | `true` for connected IDEs |
| `childBridges[*].warmingUp` | `false` once probed |
| `skippedLockFiles` | count of invalid/non-bridge locks seen |

---

## 10. Health interval — speed up for testing

The default health probe is every 10 seconds. Speed it up during testing:

```bash
node dist/index.js orchestrator --port 4746 --health-interval 2000 --verbose
```

Bridge state changes (new IDE connects, IDE dies) will now be reflected within ~2 seconds.

---

## CLI reference

```
claude-ide-bridge orchestrator [flags]

Flags:
  --port <N>              Port to listen on (default: 4746)
  --bind <addr>           Bind address (default: 127.0.0.1)
  --lock-dir <path>       Lock file directory (default: ~/.claude/ide)
  --health-interval <ms>  Health probe interval in ms (default: 10000, min: 1000)
  --fixed-token <token>   Static auth token (survives restarts)
  --verbose               Verbose logging
  --jsonl                 JSONL activity log output
  --watch                 Auto-restart with exponential backoff
```
