/**
 * Shared helpers for claude-ide-bridge smoke tests.
 */

import fs from "node:fs";
import http from "node:http";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

const require = createRequire(import.meta.url);
const WebSocket = require("ws");

// ── ANSI ──────────────────────────────────────────────────────────────────────
export const GREEN = "\x1b[32m";
export const RED = "\x1b[31m";
export const YELLOW = "\x1b[33m";
export const RESET = "\x1b[0m";

// ── Lock file ─────────────────────────────────────────────────────────────────
export function lockDir() {
  const base =
    process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), ".claude");
  return path.join(base, "ide");
}

export function readLock(port) {
  const p = path.join(lockDir(), `${port}.lock`);
  return JSON.parse(fs.readFileSync(p, "utf-8"));
}

export function lockExists(port) {
  return fs.existsSync(path.join(lockDir(), `${port}.lock`));
}

// ── HTTP helpers ──────────────────────────────────────────────────────────────
export function httpGet(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { headers }, (res) => {
      let body = "";
      res.on("data", (d) => (body += d));
      res.on("end", () =>
        resolve({ status: res.statusCode, headers: res.headers, body }),
      );
    });
    req.on("error", reject);
    req.setTimeout(5000, () => {
      req.destroy();
      reject(new Error("timeout"));
    });
  });
}

export function httpPost(url, data, headers = {}) {
  return new Promise((resolve, reject) => {
    const body = typeof data === "string" ? data : JSON.stringify(data);
    const contentType = headers["Content-Type"] ?? "application/json";
    const opts = new URL(url);
    const req = http.request(
      {
        hostname: opts.hostname,
        port: opts.port,
        path: opts.pathname + opts.search,
        method: "POST",
        headers: {
          "Content-Type": contentType,
          "Content-Length": Buffer.byteLength(body),
          ...headers,
        },
      },
      (res) => {
        let resp = "";
        res.on("data", (d) => (resp += d));
        res.on("end", () =>
          resolve({ status: res.statusCode, headers: res.headers, body: resp }),
        );
      },
    );
    req.on("error", reject);
    req.setTimeout(5000, () => {
      req.destroy();
      reject(new Error("timeout"));
    });
    req.write(body);
    req.end();
  });
}

export function httpDelete(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const opts = new URL(url);
    const req = http.request(
      {
        hostname: opts.hostname,
        port: opts.port,
        path: opts.pathname,
        method: "DELETE",
        headers,
      },
      (res) => {
        let body = "";
        res.on("data", (d) => (body += d));
        res.on("end", () =>
          resolve({ status: res.statusCode, headers: res.headers, body }),
        );
      },
    );
    req.on("error", reject);
    req.setTimeout(5000, () => {
      req.destroy();
      reject(new Error("timeout"));
    });
    req.end();
  });
}

// ── Bridge readiness ──────────────────────────────────────────────────────────
export async function waitForBridge(port, timeoutMs = 10_000, claudeConfigDir) {
  // Wait for lock file — written just before bridge accepts WS connections.
  const dir = claudeConfigDir ? path.join(claudeConfigDir, "ide") : lockDir();
  const lockPath = path.join(dir, `${port}.lock`);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(lockPath)) {
      await sleep(200); // tiny buffer for WS listener to bind after lock write
      return;
    }
    await sleep(100);
  }
  throw new Error(
    `Bridge lock file for port ${port} not found after ${timeoutMs}ms`,
  );
}

export function readLockFrom(port, claudeConfigDir) {
  const p = path.join(claudeConfigDir, "ide", `${port}.lock`);
  return JSON.parse(fs.readFileSync(p, "utf-8"));
}

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ── WebSocket MCP handshake ───────────────────────────────────────────────────
export function wsConnect(port, token, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`, {
      headers: { "x-claude-code-ide-authorization": token, ...extraHeaders },
    });
    ws.on("open", () => resolve(ws));
    ws.on("unexpected-response", (_req, res) => {
      reject(
        Object.assign(new Error(`HTTP ${res.statusCode}`), {
          statusCode: res.statusCode,
        }),
      );
    });
    ws.on("error", reject);
    setTimeout(() => reject(new Error("WS connect timeout")), 5000);
  });
}

export function wsSend(ws, msg) {
  return new Promise((resolve, reject) => {
    const id = msg.id;
    const onMsg = (data) => {
      try {
        const m = JSON.parse(data);
        if (m.id === id) {
          ws.off("message", onMsg);
          resolve(m);
        }
      } catch {
        /* ignore non-JSON */
      }
    };
    ws.on("message", onMsg);
    ws.send(JSON.stringify(msg));
    setTimeout(() => {
      ws.off("message", onMsg);
      reject(new Error(`Timeout waiting for response to id=${id}`));
    }, 10_000);
  });
}

export async function mcpHandshake(port, token, extraHeaders = {}) {
  const ws = await wsConnect(port, token, extraHeaders);
  const resp = await wsSend(ws, {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "smoke-test", version: "1.0.0" },
    },
  });
  if (resp.error)
    throw new Error(`initialize failed: ${JSON.stringify(resp.error)}`);
  ws.send(
    JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
  );
  return ws;
}

export async function listTools(ws) {
  const resp = await wsSend(ws, {
    jsonrpc: "2.0",
    id: 2,
    method: "tools/list",
    params: {},
  });
  if (resp.error)
    throw new Error(`tools/list failed: ${JSON.stringify(resp.error)}`);
  const tools = resp.result.tools ?? [];
  // Paginate if needed
  let cursor = resp.result.nextCursor;
  while (cursor) {
    const next = await wsSend(ws, {
      jsonrpc: "2.0",
      id: Math.random(),
      method: "tools/list",
      params: { cursor },
    });
    tools.push(...(next.result.tools ?? []));
    cursor = next.result.nextCursor;
  }
  return tools;
}

// ── Test runner ───────────────────────────────────────────────────────────────
let _pass = 0;
let _fail = 0;
const _failures = [];

export function assert(condition, label) {
  if (condition) {
    _pass++;
    process.stdout.write(`  ${GREEN}✓${RESET} ${label}\n`);
  } else {
    _fail++;
    _failures.push(label);
    process.stdout.write(`  ${RED}✗${RESET} ${label}\n`);
  }
}

export function assertEq(actual, expected, label) {
  assert(
    actual === expected,
    `${label} (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`,
  );
}

export function summary(category) {
  const total = _pass + _fail;
  const status = _fail === 0 ? `${GREEN}PASS` : `${RED}FAIL`;
  console.log(`\n[${category}] ${status}${RESET} ${_pass}/${total}`);
  if (_failures.length) {
    for (const f of _failures) console.log(`  ${RED}✗${RESET} ${f}`);
  }
  process.exit(_fail > 0 ? 1 : 0);
}
