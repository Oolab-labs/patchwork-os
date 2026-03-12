/**
 * Bridge Benchmark — measures p50/p95/p99/max RTT for representative tool calls.
 *
 * Usage:
 *   node scripts/benchmark.mjs [port] [--iterations N]
 *
 * Requires a running bridge instance. Discovers it via lockfile (same as smoke-test.mjs).
 * Output is a table of latency percentiles in milliseconds.
 *
 * Results are point-in-time. Run against a cold and a warm bridge for comparison.
 */

import { readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import WebSocket from "ws";

// ── CLI args ──────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
let targetPort = null;
let iterations = 50;

for (let i = 0; i < args.length; i++) {
  if (args[i] === "--iterations" && args[i + 1]) {
    iterations = Number.parseInt(args[i + 1], 10);
    i++;
  } else if (/^\d+$/.test(args[i])) {
    targetPort = Number.parseInt(args[i], 10);
  }
}

const WARMUP = 3;

// ── Lockfile discovery ────────────────────────────────────────────────────────

const lockDir = path.join(homedir(), ".claude", "ide");
let lockFiles;
try {
  lockFiles = readdirSync(lockDir).filter((f) => f.endsWith(".lock"));
} catch {
  console.error("Cannot read lock dir — is the bridge running?");
  process.exit(1);
}
if (lockFiles.length === 0) {
  console.error("No lockfile found. Start the bridge first.");
  process.exit(1);
}

let lockFile;
if (targetPort) {
  lockFile = `${targetPort}.lock`;
  if (!lockFiles.includes(lockFile)) {
    console.error(`Lockfile for port ${targetPort} not found.`);
    process.exit(1);
  }
} else {
  lockFile = lockFiles.sort((a, b) => b.localeCompare(a))[0];
}

const port = Number.parseInt(path.basename(lockFile, ".lock"), 10);
const lockContent = JSON.parse(
  readFileSync(path.join(lockDir, lockFile), "utf-8"),
);
const token = lockContent.authToken;

// ── WebSocket + JSON-RPC ──────────────────────────────────────────────────────

let msgId = 1;
const pending = new Map();

const ws = new WebSocket(`ws://127.0.0.1:${port}`, {
  headers: { "x-claude-code-ide-authorization": token },
});

ws.on("message", (data) => {
  const msg = JSON.parse(data.toString());
  if (pending.has(msg.id)) {
    pending.get(msg.id)(msg);
    pending.delete(msg.id);
  }
});

ws.on("error", (err) => {
  console.error("WebSocket error:", err.message);
  process.exit(1);
});

function send(method, params) {
  return new Promise((resolve) => {
    const id = msgId++;
    pending.set(id, resolve);
    ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
  });
}

// ── Percentile helper ─────────────────────────────────────────────────────────

function percentile(sorted, p) {
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

function stats(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  return {
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    p99: percentile(sorted, 99),
    max: sorted[sorted.length - 1],
    min: sorted[0],
  };
}

// ── Measure a tool call N times ───────────────────────────────────────────────

async function measure(label, method, params, n) {
  // Warmup
  for (let i = 0; i < WARMUP; i++) {
    await send(method, params);
  }

  const samples = [];
  for (let i = 0; i < n; i++) {
    const t0 = Date.now();
    await send(method, params);
    samples.push(Date.now() - t0);
  }
  return { label, ...stats(samples) };
}

// ── Tool call wrapper ─────────────────────────────────────────────────────────

function toolCall(name, args) {
  return ["tools/call", { name, arguments: args }];
}

// ── Main ──────────────────────────────────────────────────────────────────────

ws.on("open", async () => {
  console.log(
    `\nBridge benchmark — port ${port}, ${iterations} iterations (+${WARMUP} warmup each)\n`,
  );

  // Initialize MCP session
  await send("initialize", {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "benchmark", version: "1.0" },
  });

  const benches = [
    ["tools/list          ", "tools/list", {}],
    ["getFileTree         ", ...toolCall("getFileTree", {})],
    [
      "getWorkspaceFiles   ",
      ...toolCall("getWorkspaceFiles", { maxFiles: 200 }),
    ],
    [
      "searchWorkspace     ",
      ...toolCall("searchWorkspace", { query: "function", maxResults: 20 }),
    ],
    ["getDiagnostics      ", ...toolCall("getDiagnostics", {})],
  ];

  const results = [];
  for (const [label, method, params] of benches) {
    process.stdout.write(`  Measuring ${label.trim()}...`);
    try {
      const r = await measure(label, method, params, iterations);
      results.push(r);
      process.stdout.write(" done\n");
    } catch (err) {
      process.stdout.write(` ERROR: ${err.message}\n`);
      results.push({ label, p50: "—", p95: "—", p99: "—", max: "—", min: "—" });
    }
  }

  // ── Print table ─────────────────────────────────────────────────────────────

  const col = (v, w) => String(v).padStart(w);
  const hdr = `\n${"Tool".padEnd(22)}  ${col("min", 6)}  ${col("p50", 6)}  ${col("p95", 6)}  ${col("p99", 6)}  ${col("max", 6)}  (ms)`;
  const sep = "─".repeat(hdr.length - 6);

  console.log(hdr);
  console.log(sep);
  for (const r of results) {
    console.log(
      `${r.label.padEnd(22)}  ${col(r.min, 6)}  ${col(r.p50, 6)}  ${col(r.p95, 6)}  ${col(r.p99, 6)}  ${col(r.max, 6)}`,
    );
  }
  console.log(sep);
  console.log(
    "\nRecord these numbers in project_remaining_todos.md as your baseline.\n",
  );

  ws.close();
  process.exit(0);
});

setTimeout(() => {
  console.error("TIMEOUT — bridge not responding");
  process.exit(1);
}, 30_000);
