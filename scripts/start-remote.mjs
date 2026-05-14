#!/usr/bin/env node
/**
 * Cross-platform auto-restart wrapper for claude remote-control.
 * Replaces start-remote.sh — works on Windows, macOS, and Linux without tmux.
 *
 * Usage:
 *   node scripts/start-remote.mjs [--notify <ntfy-topic>]
 *   npm run remote:node
 *
 * Controls:
 *   Ctrl+C  — exit cleanly (no restart)
 */

import { spawn } from "node:child_process";

const args = process.argv.slice(2);
function flag(name) {
  const i = args.indexOf(name);
  return i !== -1 ? (args[i + 1] ?? null) : null;
}

const NTFY_TOPIC = flag("--notify") ?? "";
const RESTART_BASE_MS = 5_000;
const RESTART_MAX_MS = 300_000;
const HEALTHY_MS = 60_000;
const MAX_FAILURES = 50;
const IS_WIN = process.platform === "win32";

function ts() {
  return new Date().toLocaleTimeString();
}
function log(msg) {
  process.stdout.write(`[${ts()}] ${msg}\n`);
}

function notify(msg, priority = "default") {
  if (!NTFY_TOPIC) return;
  fetch(`https://ntfy.sh/${NTFY_TOPIC}`, {
    method: "POST",
    body: msg,
    headers: { Title: "Claude Remote", Priority: priority },
    signal: AbortSignal.timeout(10_000),
  }).catch(() => {});
}

console.log("=== Remote Control auto-restart wrapper ===");
console.log("  Ctrl+C to exit cleanly");
if (NTFY_TOPIC) console.log(`  Push notifications: ntfy.sh/${NTFY_TOPIC}`);
console.log("");

let stopping = false;
let delayMs = RESTART_BASE_MS;
let failures = 0;
let currentProc = null;

process.on("SIGINT", () => {
  stopping = true;
  currentProc?.kill();
});
process.on("SIGTERM", () => {
  stopping = true;
  currentProc?.kill();
});

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

while (!stopping) {
  const startMs = Date.now();

  const exitCode = await new Promise((resolve) => {
    currentProc = spawn(
      IS_WIN ? "cmd.exe" : "claude",
      IS_WIN
        ? ["/c", "claude", "remote-control", "--spawn=session"]
        : ["remote-control", "--spawn=session"],
      { stdio: "inherit", shell: false },
    );
    currentProc.on("exit", (code) => resolve(code ?? 0));
    currentProc.on("error", (err) => {
      log(`Spawn error: ${err.message}`);
      resolve(1);
    });
  });

  currentProc = null;
  if (stopping) break;

  // Ctrl+C propagated from child exits with 130
  if (exitCode === 130) {
    log("Exited by user.");
    break;
  }

  const elapsed = Date.now() - startMs;
  if (elapsed >= HEALTHY_MS) {
    failures = 0;
    delayMs = RESTART_BASE_MS;
  } else {
    failures++;
    delayMs = Math.min(
      RESTART_BASE_MS * 2 ** Math.min(failures - 1, 6),
      RESTART_MAX_MS,
    );
  }

  if (failures >= MAX_FAILURES) {
    log(`Too many consecutive failures (${MAX_FAILURES}). Giving up.`);
    notify(`Circuit breaker: ${MAX_FAILURES} failures. Giving up.`, "high");
    process.exit(1);
  }

  log(
    `Remote control disconnected (exit ${exitCode}). Restarting in ${delayMs / 1000}s...`,
  );
  notify(
    `Disconnected (exit ${exitCode}). Restarting in ${delayMs / 1000}s...`,
  );

  await sleep(delayMs);
}
