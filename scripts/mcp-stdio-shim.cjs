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
  let bestLock = null;
  let bestMtime = 0;
  try {
    for (const f of fs.readdirSync(lockDir)) {
      if (!f.endsWith(".lock")) continue;
      const fullPath = path.join(lockDir, f);
      try {
        const stat = fs.statSync(fullPath);
        if (stat.mtimeMs > bestMtime) {
          bestMtime = stat.mtimeMs;
          bestLock = fullPath;
        }
      } catch {
        // skip unreadable files
      }
    }
  } catch {
    // lock dir doesn't exist
  }
  return bestLock;
}

function parseLock(lockPath) {
  const raw = fs.readFileSync(lockPath, "utf8");
  const data = JSON.parse(raw);
  const port = Number(path.basename(lockPath, ".lock"));
  return { port, authToken: data.authToken };
}

// --- Resolve port + token ---
let port, authToken;

if (process.argv[2] && process.argv[3]) {
  port = Number(process.argv[2]);
  authToken = process.argv[3];
} else {
  const lockFile = findLockFile();
  if (!lockFile) {
    process.stderr.write(
      "mcp-stdio-shim: No bridge lock file found. Start the bridge first (npm run start-all).\n",
    );
    process.exit(1);
  }
  try {
    ({ port, authToken } = parseLock(lockFile));
  } catch (err) {
    process.stderr.write(
      `mcp-stdio-shim: Failed to parse lock file: ${err.message}\n`,
    );
    process.exit(1);
  }
}

const wsUrl = `ws://127.0.0.1:${port}`;
process.stderr.write(`mcp-stdio-shim: Connecting to bridge at ${wsUrl}\n`);

const ws = new WebSocket(wsUrl, {
  headers: { "x-claude-code-ide-authorization": authToken },
});

ws.on("open", () => {
  process.stderr.write("mcp-stdio-shim: Connected.\n");
});

ws.on("error", (err) => {
  process.stderr.write(`mcp-stdio-shim: WebSocket error: ${err.message}\n`);
  process.exit(1);
});

ws.on("close", (code, reason) => {
  process.stderr.write(
    `mcp-stdio-shim: Connection closed (${code} ${reason})\n`,
  );
  process.exit(0);
});

// Bridge → stdout (one JSON-RPC message per line)
ws.on("message", (data) => {
  process.stdout.write(data.toString() + "\n");
});

// stdin → bridge (newline-delimited JSON-RPC)
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  const lines = buffer.split("\n");
  buffer = lines.pop() ?? "";
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(trimmed);
    }
  }
});

process.stdin.on("end", () => {
  ws.close();
});
