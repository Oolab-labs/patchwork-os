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
 *   WARNING: authToken passed as argv is visible in `ps aux` / process listings.
 *   Prefer the lock-file discovery mode (no args) which reads the token from disk.
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
const { randomUUID } = require("node:crypto");

// Resolve ws from the bridge's own node_modules (script lives in scripts/)
const { WebSocket } = require(path.join(__dirname, "..", "node_modules", "ws"));

function findLockFile() {
  const lockDir = path.join(
    process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude"),
    "ide",
  );
  // Three-tier preference: orchestrator > bridge > any lock (each by newest mtime).
  // Orchestrator locks win because child bridge restarts produce newer lock files,
  // which would hijack the shim away from the orchestrator if we only used mtime.
  let orchestratorLock = null;
  let orchestratorMtime = 0;
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
        let isOrchestrator = false;
        try {
          const data = JSON.parse(fs.readFileSync(fullPath, "utf8"));
          isBridge = data.isBridge === true;
          isOrchestrator = data.orchestrator === true;
        } catch {
          // unparseable — treat as non-bridge
        }
        if (isOrchestrator) {
          if (stat.mtimeMs > orchestratorMtime) {
            orchestratorMtime = stat.mtimeMs;
            orchestratorLock = fullPath;
          }
        } else if (isBridge) {
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
  // Prefer orchestrator > bridge > fallback (each newest mtime within tier)
  return orchestratorLock ?? bridgeLock ?? fallbackLock;
}

function parseLock(lockPath) {
  const raw = fs.readFileSync(lockPath, "utf8");
  const data = JSON.parse(raw);
  const port = Number(path.basename(lockPath, ".lock"));
  // Note: lock type (orchestrator / bridge / fallback) is NOT returned here —
  // only { port, authToken } are extracted. findLockFile() enforces tier priority
  // before this is called, so all three call sites (startPoll, scheduleReconnect,
  // initial startup) are safe. If parseLock is ever called on an arbitrary path
  // the caller will be blind to whether it is connecting to an orchestrator, a
  // child bridge, or an IDE-owned lock — and will connect regardless.
  return { port, authToken: data.authToken };
}

// --- State ---
// Stable session identity for this shim process. Sent as X-Claude-Code-Session-Id
// on every connection attempt so the bridge can reattach to the same session
// during its grace period instead of creating a new one.
const CLIENT_SESSION_ID = randomUUID();
let ws = null;
let currentPort = null;
let hasConnectedSuccessfully = false; // true after first successful ws open
let buffer = "";
const pendingLines = [];
let reconnectTimer = null;
let pollTimer = null;
const RECONNECT_DEBOUNCE_MS = 500;
const POLL_INTERVAL_MS = 3000; // fallback poll when disconnected
const MAX_PENDING_LINES = 1000;

// Backoff state — differentiated retry delays by error category
const MAX_UNREACHABLE_MS =
  Number(process.env.SHIM_MAX_UNREACHABLE_MS) || 5 * 60 * 1000;
let firstUnreachableAt = 0; // epoch ms of first consecutive failure in current streak
let currentBackoffMs = 0; // 0 = not in a backoff sequence
let backoffTimer = null; // pending setTimeout for next reconnect attempt

// --- Backoff helpers ---

/**
 * Returns the next retry delay (ms) for a given error category and mutates
 * currentBackoffMs so successive calls produce exponential growth.
 *
 * Categories:
 *   "429"         – rate-limited: start 1s, double, cap 30s, full jitter
 *   "unreachable" – ECONNREFUSED / ETIMEDOUT: start 1s, double, cap 30s
 *   "other"       – falls back to flat POLL_INTERVAL_MS
 */
function nextBackoffMs(errorType) {
  if (errorType === "other") {
    currentBackoffMs = 0;
    return POLL_INTERVAL_MS;
  }
  const CAP_MS = 30_000;
  currentBackoffMs =
    currentBackoffMs === 0 ? 1000 : Math.min(currentBackoffMs * 2, CAP_MS);
  // Full jitter for 429 (avoids thundering herd on a recovering bridge)
  return errorType === "429"
    ? Math.floor(Math.random() * currentBackoffMs)
    : currentBackoffMs;
}

function resetBackoff() {
  currentBackoffMs = 0;
  firstUnreachableAt = 0;
  if (backoffTimer) {
    clearTimeout(backoffTimer);
    backoffTimer = null;
  }
}

/**
 * Schedule a reconnect attempt after a computed backoff delay.
 * Replaces any pending backoffTimer. Does NOT call startPoll().
 */
function scheduleBackoffReconnect(errorType) {
  if (backoffTimer) clearTimeout(backoffTimer);
  const delay = nextBackoffMs(errorType);
  process.stderr.write(
    `mcp-stdio-shim: Will retry in ${Math.round(delay / 1000)}s (reason: ${errorType}).\n`,
  );
  backoffTimer = setTimeout(() => {
    backoffTimer = null;
    const lockFile = findLockFile();
    if (!lockFile) {
      startPoll();
      return;
    }
    let parsed;
    try {
      parsed = parseLock(lockFile);
    } catch {
      startPoll();
      return;
    }
    connect(parsed.port, parsed.authToken);
  }, delay);
}

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
  const isReconnect = currentPort !== null;
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
    headers: {
      "x-claude-code-ide-authorization": authToken,
      // Stable per-process ID — lets the bridge resume the same session during
      // its grace period rather than starting a fresh MCP handshake each time.
      "x-claude-code-session-id": CLIENT_SESSION_ID,
    },
  });

  // Per-connect flag: set when the error handler classifies this attempt as 429
  // so the close handler knows not to call startPoll() and instead backs off.
  let lastErrorWas429 = false;

  ws.on("error", (err) => {
    const code = err.code; // e.g. "ECONNREFUSED", "ETIMEDOUT", or undefined
    process.stderr.write(
      `mcp-stdio-shim: WebSocket error [${code ?? "unknown"}]: ${err.message}\n`,
    );

    if (explicitPort !== null) {
      process.exit(1);
    }

    if (code === "ECONNREFUSED" || code === "ETIMEDOUT") {
      if (firstUnreachableAt === 0) firstUnreachableAt = Date.now();
      if (Date.now() - firstUnreachableAt > MAX_UNREACHABLE_MS) {
        process.stderr.write(
          "mcp-stdio-shim: Bridge unreachable for >5 minutes — giving up.\n",
        );
        process.exit(1);
      }
      scheduleBackoffReconnect("unreachable");
    } else if (err.message?.includes("429")) {
      lastErrorWas429 = true;
      if (firstUnreachableAt === 0) firstUnreachableAt = Date.now();
      if (Date.now() - firstUnreachableAt > MAX_UNREACHABLE_MS) {
        process.stderr.write(
          "mcp-stdio-shim: Bridge rate-limiting for >5 minutes — giving up.\n",
        );
        process.exit(1);
      }
      scheduleBackoffReconnect("429");
    } else if (
      err.message &&
      (err.message.includes("401") || err.message.includes("403"))
    ) {
      process.stderr.write(
        "mcp-stdio-shim: Auth failure (401/403) — exiting.\n",
      );
      process.exit(1);
    }
    // Other errors fall through to the close handler
  });

  ws.on("close", (code, reason) => {
    const reasonStr = reason?.toString() || "";
    process.stderr.write(
      `mcp-stdio-shim: Connection closed (${code} ${reasonStr})\n`,
    );
    if (explicitPort !== null) process.exit(0);

    // Auth rejected — exit immediately, retrying will not help
    if (code === 4001) {
      process.stderr.write(
        "mcp-stdio-shim: Authorization rejected (4001) — token mismatch. Exiting.\n",
      );
      process.exit(1);
    }

    // If the error handler already scheduled a backoff reconnect, don't also start polling
    if (backoffTimer) return;

    // 1006 = abnormal closure (often accompanies a 429 rejection before handshake)
    if (lastErrorWas429) {
      scheduleBackoffReconnect("429");
      return;
    }

    // Normal closure or other codes: resume flat polling (existing behavior)
    startPoll();
  });

  // Bridge → stdout (one JSON-RPC message per line)
  ws.on("message", (data) => {
    process.stdout.write(`${data.toString()}\n`);
  });

  ws.on("open", () => {
    process.stderr.write("mcp-stdio-shim: Connected.\n");
    stopPoll();
    resetBackoff();
    // On reconnect (after a prior successful connection), drop stale pending messages —
    // they reference old session state (e.g. the previous initialize handshake) and must
    // not be replayed. A failed first attempt does NOT count — pendingLines must be kept
    // so the initialize message can be flushed to the new bridge session.
    if (isReconnect && hasConnectedSuccessfully) pendingLines.length = 0;
    hasConnectedSuccessfully = true;
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
      try {
        ws.send(trimmed);
      } catch (sendErr) {
        process.stderr.write(
          `mcp-stdio-shim: ws.send failed (${sendErr.message}) — queuing message.\n`,
        );
        if (pendingLines.length < MAX_PENDING_LINES) {
          pendingLines.push(trimmed);
        }
      }
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
  if (ws) {
    try {
      ws.close();
    } catch {
      /* ignore */
    }
  }
  process.exit(0);
});

process.stdin.on("error", (err) => {
  // EPIPE / ERR_STREAM_DESTROYED means the MCP host closed the pipe — clean shutdown.
  if (err.code === "EPIPE" || err.code === "ERR_STREAM_DESTROYED") {
    process.stderr.write(
      `mcp-stdio-shim: stdin closed (${err.code}) — shutting down.\n`,
    );
    if (ws) {
      try {
        ws.close();
      } catch {
        /* ignore */
      }
    }
    process.exit(0);
  }
  process.stderr.write(`mcp-stdio-shim: stdin error: ${err.message}\n`);
});
