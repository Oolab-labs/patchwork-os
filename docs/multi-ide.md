# Multi-IDE and Multi-Session Support

## Overview

The claude-ide-bridge supports multiple simultaneous connections. Each WebSocket client gets its own session. Multiple VS Code windows, multiple Claude Code terminals, and Claude Desktop can all connect to the same bridge instance simultaneously.

## How Sessions Work

- Each connecting client gets a session ID (UUID)
- Tool calls are scoped to the calling session
- VS Code extension state (open editors, diagnostics) is shared — it reflects the currently active VS Code window
- Max 5 concurrent HTTP sessions (oldest idle > 60s evicted on capacity); WebSocket sessions have no hard cap

## Running Multiple VS Code Windows

All VS Code windows share one bridge instance (same port). The extension that last sent a heartbeat is considered "active". Tool results reflect the active window's state.

To target a specific window's context: use `openFile` to focus a file in that window before calling LSP tools.

## Multiple Claude Sessions (Agent Teams)

Multiple Claude Code sessions can connect simultaneously. Use case: orchestrator + parallel subagents.

The `team-status` prompt summarizes workspace state across active sessions:

```
/team-status
```

Each session:

- Has its own rate limit bucket (60 calls/min default, configurable via `--tool-rate-limit`)
- Has its own call/error counters
- Shares the same bridge tool set

## Session Continuity

When switching between sessions (e.g. CLI → Desktop):

1. Call `setHandoffNote` in the outgoing session
2. The new session calls `getHandoffNote` on startup (or `onInstructionsLoaded` hook does it automatically)

Grace period (default 120s): if a session disconnects, the bridge preserves state. Reconnecting with the same `X-Claude-Code-Session-Id` reattaches — no re-initialization needed.

## Remote IDE: VS Code Remote-SSH / Cursor SSH

The VS Code extension has `extensionKind: ["workspace"]` — it runs on the remote machine (VPS/container) automatically when you connect via SSH. Full LSP, debug, and extension tool support works over SSH.

Steps:

1. Install VS Code Remote-SSH extension (or use Cursor's built-in SSH)
2. Connect to remote machine
3. Install claude-ide-bridge VS Code extension in the remote workspace
4. Bridge runs on the remote machine (or start it manually with `claude-ide-bridge --full --watch`)
5. Claude Code connects via the bridge on the remote machine

## JetBrains and Other Editors

Currently, full tool support (LSP, debugger, editor state) requires the VS Code extension. In headless mode (no VS Code), a subset of tools remain available via fallbacks:

- `goToDefinition`, `findReferences`, `getTypeSignature` → `typescript-language-server` fallback
- `searchWorkspaceSymbols` → `ctags` fallback
- `navigateToSymbolByName` → `rg` declaration-pattern fallback
- `findFiles`, `searchWorkspace`, `getFileTree` → filesystem directly

See [headless-quickstart.md](headless-quickstart.md) for the full probe table.

## Cursor IDE

Cursor connects identically to VS Code — install the same VS Code extension (available on Open VSX). Full tool support.

## Neovim / Emacs / Other Editors

No extension available. Run bridge in headless mode. LSP fallback tools work if `typescript-language-server` is on PATH.

## Port Management

Default port: 18765. To run multiple bridge instances (e.g. one per project):

```bash
claude-ide-bridge --port 18766 --workspace /path/to/project2
```

Each port has its own lock file: `~/.claude/ide/<port>.lock`. Each lock file stores the auth token for that instance.

## Troubleshooting Multiple Sessions

**"Only one session sees tool results":**
Tool results go to the calling session. If you want another session to see state, use `setHandoffNote` + `getHandoffNote`.

**"Extension shows connected but wrong editor state":**
Multiple VS Code windows share one extension slot. The last active window's state is returned. Use `openFile` to focus the correct window.

**"Rate limit hit in multi-agent scenario":**
Each session has its own bucket. Raise per-session limit: `--tool-rate-limit 120`.

**"Second bridge won't start on same port":**
Lock file exists. Either stop the first bridge, or use `--port` to select a different port.
