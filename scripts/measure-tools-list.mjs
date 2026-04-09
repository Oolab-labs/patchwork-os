#!/usr/bin/env node

/**
 * measure-tools-list.mjs
 *
 * Connect to a running claude-ide-bridge, call tools/list, and report:
 *   - Total response bytes
 *   - Estimated tokens (bytes / 4)
 *   - Per-tool breakdown sorted by description length
 *
 * Usage:
 *   node scripts/measure-tools-list.mjs [--port N] [--token <tok>]
 *
 * If --token is omitted, the script reads it from the lock file at
 * ~/.claude/ide/<port>.lock.
 */

import { readdirSync, readFileSync } from "node:fs";
import { createConnection } from "node:net";
import { homedir } from "node:os";
import path from "node:path";

// ── parse args ────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
let port = 3284;
let token = null;

for (let i = 0; i < args.length; i++) {
  if (args[i] === "--port" && args[i + 1]) port = Number(args[++i]);
  if (args[i] === "--token" && args[i + 1]) token = args[++i];
}

// ── resolve token from lock file if not provided ─────────────────────────────

if (!token) {
  const lockDir = path.join(homedir(), ".claude", "ide");
  try {
    const lockFile = path.join(lockDir, `${port}.lock`);
    const lock = JSON.parse(readFileSync(lockFile, "utf8"));
    token = lock.authToken;
  } catch {
    // Try any lock file if port-specific one not found
    try {
      const locks = readdirSync(lockDir).filter((f) => f.endsWith(".lock"));
      if (locks.length > 0) {
        const lock = JSON.parse(
          readFileSync(path.join(lockDir, locks[0]), "utf8"),
        );
        token = lock.authToken;
        port = Number(locks[0].replace(".lock", "")) || port;
      }
    } catch {
      // ignore
    }
  }
  if (!token) {
    console.error(
      "Error: no token found. Run the bridge first or pass --token <tok>.",
    );
    process.exit(1);
  }
}

// ── connect and send tools/list ───────────────────────────────────────────────

const requestId = 1;
const jsonRpcRequest = JSON.stringify({
  jsonrpc: "2.0",
  id: requestId,
  method: "tools/list",
  params: {},
});

// Build a minimal HTTP/WebSocket upgrade request
const wsKey = Buffer.from("claude-measure-tools-list").toString("base64");
const httpUpgrade = [
  `GET /mcp HTTP/1.1`,
  `Host: 127.0.0.1:${port}`,
  `Upgrade: websocket`,
  `Connection: Upgrade`,
  `Sec-WebSocket-Key: ${wsKey}`,
  `Sec-WebSocket-Version: 13`,
  `x-claude-code-ide-authorization: ${token}`,
  ``,
  ``,
].join("\r\n");

let buffer = Buffer.alloc(0);
let upgraded = false;
let responseBytes = 0;
let responseText = "";

const socket = createConnection({ host: "127.0.0.1", port }, () => {
  socket.write(httpUpgrade);
});

socket.setTimeout(10_000);
socket.on("timeout", () => {
  console.error("Error: connection timed out.");
  socket.destroy();
  process.exit(1);
});

socket.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);

  if (!upgraded) {
    const headerEnd = buffer.indexOf("\r\n\r\n");
    if (headerEnd === -1) return;
    upgraded = true;
    buffer = buffer.slice(headerEnd + 4);

    // Send the JSON-RPC request as a WebSocket text frame
    const msgBuf = Buffer.from(jsonRpcRequest, "utf8");
    const frameLen = msgBuf.length;
    const maskKey = Buffer.from([0xde, 0xad, 0xbe, 0xef]);
    let headerBuf;
    if (frameLen < 126) {
      headerBuf = Buffer.from([0x81, 0x80 | frameLen]);
    } else if (frameLen < 65536) {
      headerBuf = Buffer.alloc(4);
      headerBuf[0] = 0x81;
      headerBuf[1] = 0x80 | 126;
      headerBuf.writeUInt16BE(frameLen, 2);
    } else {
      headerBuf = Buffer.alloc(10);
      headerBuf[0] = 0x81;
      headerBuf[1] = 0x80 | 127;
      headerBuf.writeBigUInt64BE(BigInt(frameLen), 2);
    }
    const masked = Buffer.alloc(frameLen);
    for (let i = 0; i < frameLen; i++) {
      masked[i] = msgBuf[i] ^ maskKey[i % 4];
    }
    socket.write(Buffer.concat([headerBuf, maskKey, masked]));
  }

  // Parse WebSocket frames
  while (buffer.length >= 2) {
    const fin = (buffer[0] & 0x80) !== 0;
    const opcode = buffer[0] & 0x0f;
    const masked = (buffer[1] & 0x80) !== 0;
    let payloadLen = buffer[1] & 0x7f;
    let offset = 2;

    if (payloadLen === 126) {
      if (buffer.length < 4) break;
      payloadLen = buffer.readUInt16BE(2);
      offset = 4;
    } else if (payloadLen === 127) {
      if (buffer.length < 10) break;
      payloadLen = Number(buffer.readBigUInt64BE(2));
      offset = 10;
    }

    const maskOffset = masked ? offset + 4 : offset;
    const totalLen = maskOffset + payloadLen;
    if (buffer.length < totalLen) break;

    if (opcode === 1 || opcode === 0) {
      // text or continuation frame
      const payload = buffer.slice(maskOffset, totalLen);
      if (masked) {
        const maskKey = buffer.slice(offset, offset + 4);
        for (let i = 0; i < payload.length; i++) {
          payload[i] ^= maskKey[i % 4];
        }
      }
      responseBytes += payload.length;
      responseText += payload.toString("utf8");

      if (fin) {
        try {
          const msg = JSON.parse(responseText);
          if (msg.id === requestId && msg.result) {
            printReport(responseBytes, msg.result.tools || []);
            socket.destroy();
            process.exit(0);
          }
        } catch {
          // not a complete JSON message yet, keep accumulating
        }
        if (!fin) responseText = "";
      }
    } else if (opcode === 8) {
      // close frame
      socket.destroy();
      break;
    }

    buffer = buffer.slice(totalLen);
  }
});

socket.on("error", (err) => {
  console.error(`Error: ${err.message}`);
  process.exit(1);
});

// ── report ────────────────────────────────────────────────────────────────────

function printReport(bytes, tools) {
  const estimatedTokens = Math.ceil(bytes / 4);

  console.log(`\ntools/list measurement`);
  console.log(`${"─".repeat(50)}`);
  console.log(`Response size : ${bytes.toLocaleString()} bytes`);
  console.log(
    `Est. tokens   : ~${estimatedTokens.toLocaleString()} (bytes ÷ 4)`,
  );
  console.log(`Tool count    : ${tools.length}`);

  // Per-tool breakdown sorted by description length (longest first)
  const rows = tools.map((t) => ({
    name: t.name,
    descLen: (t.description || "").length,
  }));
  rows.sort((a, b) => b.descLen - a.descLen);

  const top20 = rows.slice(0, 20);
  const maxNameLen = Math.max(...top20.map((r) => r.name.length), 4);

  console.log(`\nTop tools by description length:`);
  console.log(`${"─".repeat(maxNameLen + 12)}`);
  for (const { name, descLen } of top20) {
    const bar = "█".repeat(Math.round(descLen / 10));
    console.log(
      `  ${name.padEnd(maxNameLen)}  ${String(descLen).padStart(4)} chars  ${bar}`,
    );
  }

  const over200 = rows.filter((r) => r.descLen > 200);
  if (over200.length > 0) {
    console.log(
      `\nWarning: ${over200.length} tool(s) exceed 200 char limit: ${over200.map((r) => r.name).join(", ")}`,
    );
  } else {
    console.log(`\nAll descriptions are within the 200-char limit.`);
  }
}
