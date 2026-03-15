#!/usr/bin/env node
/**
 * mcp-stdio-shim.js — Connect to a running claude-ide-bridge via WebSocket,
 * relaying MCP JSON-RPC messages between stdio and the bridge.
 *
 * Usage (auto-discover from lock file — normal .mcp.json usage):
 *   node scripts/mcp-stdio-shim.js
 *
 * Usage (explicit port + token):
 *   node scripts/mcp-stdio-shim.js <port> <authToken>
 *
 * This shim is used by .mcp.json so Claude Code connects to the ALREADY-RUNNING
 * bridge instead of spawning a new one. This prevents extension oscillation when
 * both start-all.sh and a remote Claude Code session are active.
 *
 * Lock-file watcher: when the bridge restarts on a new port, the shim detects
 * the new lock file via fs.watch and reconnects automatically — no need to
 * restart Claude Desktop or the MCP client.
 */

"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

// Resolve ws from the bridge's own node_modules (script lives in scripts/)
const { WebSocket } = require(path.join(__dirname, "..", "node_modules", "ws"));

function findLockFile() {
  const lockDir = path.join(
    process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude"),
    "ide",
  );
  let bridgeLock = null;
  let bridgeMtime = 0;
  let fallbackLock = null;
  let fallbackMtime = 0;
  try {
    for (const f of fs.readdirSync(lockDir)) {
      if (!f.endsWith(".lock")) continue;
      const fullPath = path.join(lockDir, f);
      try {
        const stat = fs.statSync(fullPath);
        let isBridge = false;
        try {
          const data = JSON.parse(fs.readFileSync(fullPath, "utf8"));
          isBridge = data.isBridge === true;
        } catch {
          // unparseable — treat as non-bridge
        }
        if (isBridge) {
          if (stat.mtimeMs > bridgeMtime) {
            bridgeMtime = stat.mtimeMs;
            bridgeLock = fullPath;
          }
        } else {
          if (stat.mtimeMs > fallbackMtime) {
            fallbackMtime = stat.mtimeMs;
            fallbackLock = fullPath;
          }
        }
      } catch {
        // skip unreadable files
      }
    }
  } catch {
    // lock dir doesn't exist
  }
  // Prefer a lock explicitly written by the bridge; fall back to mtime winner
  return bridgeLock ?? fallbackLock;
}

function parseLock(lockPath) {
  const raw = fs.readFileSync(lockPath, "utf8");
  const data = JSON.parse(raw);
  const port = Number(path.basename(lockPath, ".lock"));
  return { port, authToken: data.authToken };
}

// --- State ---
let ws = null;
let currentPort = null;
let buffer = "";
const pendingLines = [];
let reconnectTimer = null;
let pollTimer = null;
const RECONNECT_DEBOUNCE_MS = 500;
const POLL_INTERVAL_MS = 3000; // fallback poll when disconnected
const MAX_PENDING_LINES = 1000;

// --- Explicit args (bypass auto-discover and watcher) ---
const explicitPort =
  process.argv[2] && process.argv[3] ? Number(process.argv[2]) : null;
const explicitToken = process.argv[3] ?? null;

function flushPending() {
  while (pendingLines.length > 0 && ws && ws.readyState === WebSocket.OPEN) {
    ws.send(pendingLines.shift());
  }
}

function connect(port, authToken) {
  if (ws) {
    try {
      ws.terminate();
    } catch {
      /* ignore */
    }
    ws = null;
  }
  currentPort = port;
  const wsUrl = `ws://127.0.0.1:${port}`;
  process.stderr.write(`mcp-stdio-shim: Connecting to bridge at ${wsUrl}\n`);

  ws = new WebSocket(wsUrl, {
    headers: { "x-claude-code-ide-authorization": authToken },
  });

  ws.on("error", (err) => {
    process.stderr.write(`mcp-stdio-shim: WebSocket error: ${err.message}\n`);
    // In explicit mode exit immediately; in auto-discover mode wait for a new lock
    if (explicitPort !== null) process.exit(1);
  });

  ws.on("close", (code, reason) => {
    process.stderr.write(
      `mcp-stdio-shim: Connection closed (${code} ${reason})\n`,
    );
    if (explicitPort !== null) process.exit(0);
    // Auto-discover mode: start polling as fallback in case fs.watch misses the event
    startPoll();
  });

  // Bridge → stdout (one JSON-RPC message per line)
  ws.on("message", (data) => {
    process.stdout.write(`${data.toString()}\n`);
  });

  ws.on("open", () => {
    process.stderr.write("mcp-stdio-shim: Connected.\n");
    stopPoll();
    flushPending();
  });
}

function stopPoll() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

function startPoll() {
  if (pollTimer) return; // already polling
  pollTimer = setInterval(() => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      stopPoll();
      return;
    }
    const lockFile = findLockFile();
    if (!lockFile) return;
    let parsed;
    try {
      parsed = parseLock(lockFile);
    } catch {
      return;
    }
    process.stderr.write(
      `mcp-stdio-shim: Poll found bridge on port ${parsed.port} — reconnecting.\n`,
    );
    connect(parsed.port, parsed.authToken);
  }, POLL_INTERVAL_MS);
}

// --- Initial connection ---
if (explicitPort !== null) {
  connect(explicitPort, explicitToken);
} else {
  const lockFile = findLockFile();
  if (!lockFile) {
    process.stderr.write(
      "mcp-stdio-shim: No bridge lock file found — waiting for bridge to start.\n",
    );
    // Poll until a lock file appears (bridge may still be starting up)
    startPoll();
  } else {
    let parsed;
    try {
      parsed = parseLock(lockFile);
    } catch (err) {
      process.stderr.write(
        `mcp-stdio-shim: Failed to parse lock file: ${err.message}\n`,
      );
      process.exit(1);
    }
    connect(parsed.port, parsed.authToken);
  }
}

// --- Lock-file watcher (auto-discover mode only) ---
// Watches ~/.claude/ide/ for .lock file changes. When a new bridge lock appears
// on a different port, reconnects automatically. This means Claude Desktop never
// needs to be restarted when the bridge restarts on a new port.
if (explicitPort === null) {
  const lockDir = path.join(
    process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude"),
    "ide",
  );

  const scheduleReconnect = () => {
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      const lockFile = findLockFile();
      if (!lockFile) return;
      let parsed;
      try {
        parsed = parseLock(lockFile);
      } catch {
        return;
      }
      const wsNotOpen = !ws || ws.readyState !== WebSocket.OPEN;
      if (parsed.port !== currentPort || wsNotOpen) {
        process.stderr.write(
          `mcp-stdio-shim: New bridge on port ${parsed.port} — reconnecting.\n`,
        );
        connect(parsed.port, parsed.authToken);
      }
    }, RECONNECT_DEBOUNCE_MS);
  };

  try {
    fs.watch(lockDir, (_event, filename) => {
      if (filename?.endsWith(".lock")) {
        scheduleReconnect();
      }
    });
  } catch {
    // Lock dir not watchable — non-fatal, shim still works without auto-reconnect
  }
}

// --- stdin → bridge (newline-delimited JSON-RPC) ---
// Messages that arrive before the WebSocket is open are queued and flushed on connect.
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  const lines = buffer.split("\n");
  buffer = lines.pop() ?? "";
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(trimmed);
    } else if (pendingLines.length < MAX_PENDING_LINES) {
      pendingLines.push(trimmed);
    } else {
      process.stderr.write(
        `mcp-stdio-shim: pendingLines overflow (${MAX_PENDING_LINES}) — dropping message (bridge not connected)\n`,
      );
    }
  }
});

process.stdin.on("end", () => {
  if (ws) ws.close();
});
