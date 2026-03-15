/**
 * Bridge Benchmark — measures p50/p95/p99/max RTT for representative tool calls.
 *
 * Usage:
 *   node scripts/benchmark.mjs [port] [--iterations N] [--json] [--threshold <ms>]
 *
 * Requires a running bridge instance. Discovers it via lockfile (same as smoke-test.mjs).
 * Output is a table of latency percentiles in milliseconds.
 *
 * --json        Emit structured JSON to stdout instead of the human table.
 * --threshold N Fail (exit 1) if any tool's p99 RTT exceeds N ms. Useful in CI.
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
let jsonMode = false;
let thresholdMs = null; // p99 failure threshold (ms); null = no gate

for (let i = 0; i < args.length; i++) {
  if (args[i] === "--iterations" && args[i + 1]) {
    iterations = Number.parseInt(args[i + 1], 10);
    i++;
  } else if (args[i] === "--threshold" && args[i + 1]) {
    thresholdMs = Number.parseInt(args[i + 1], 10);
    i++;
  } else if (args[i] === "--json") {
    jsonMode = true;
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
  if (!jsonMode) {
    console.log(
      `\nBridge benchmark — port ${port}, ${iterations} iterations (+${WARMUP} warmup each)\n`,
    );
  }

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
    if (!jsonMode) process.stdout.write(`  Measuring ${label.trim()}...`);
    try {
      const r = await measure(label, method, params, iterations);
      results.push(r);
      if (!jsonMode) process.stdout.write(" done\n");
    } catch (err) {
      if (!jsonMode) process.stdout.write(` ERROR: ${err.message}\n`);
      results.push({
        label,
        p50: null,
        p95: null,
        p99: null,
        max: null,
        min: null,
        error: err.message,
      });
    }
  }

  if (jsonMode) {
    // ── JSON output ───────────────────────────────────────────────────────────
    const output = {
      timestamp: new Date().toISOString(),
      port,
      iterations,
      threshold: thresholdMs,
      results: results.map((r) => ({ ...r, label: r.label.trim() })),
    };
    process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
  } else {
    // ── Print table ─────────────────────────────────────────────────────────
    const col = (v, w) => String(v ?? "—").padStart(w);
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
    console.log("\nTip: run with --json --threshold <ms> to gate on p99.\n");
  }

  // ── Threshold gate ───────────────────────────────────────────────────────────
  if (thresholdMs !== null) {
    const violations = results.filter(
      (r) => typeof r.p99 === "number" && r.p99 > thresholdMs,
    );
    if (violations.length > 0) {
      const lines = violations.map(
        (r) => `  ${r.label.trim()}: p99=${r.p99}ms > ${thresholdMs}ms`,
      );
      console.error(
        `\nBenchmark threshold exceeded (p99 > ${thresholdMs}ms):\n${lines.join("\n")}\n`,
      );
      ws.close();
      process.exit(1);
    }
  }

  ws.close();
  process.exit(0);
});

setTimeout(() => {
  console.error("TIMEOUT — bridge not responding");
  process.exit(1);
}, 30_000);
