#!/usr/bin/env node
/**
 * Cross-platform orchestrator: bridge + Claude + dashboard + health monitor.
 * Replaces start-all.sh for native Windows, and works identically on macOS/Linux.
 *
 * Usage:
 *   node scripts/start-all.mjs [options]
 *   npm run start-all:node -- --workspace /my/project
 *
 * Options:
 *   --workspace <path>     Directory to open in Claude (default: current directory)
 *   --full                 Register all ~170 tools (git, terminal, file ops, HTTP, GitHub)
 *   --no-dashboard         Skip the Patchwork dashboard
 *   --dashboard-port <N>   Dashboard port (default: 3200)
 *   --bridge-port <N>      Bridge port (auto-assigned if omitted)
 *   --notify <topic>       ntfy.sh topic for push notifications
 *   --no-remote            Skip starting claude remote-control
 *   --automation-policy <path>  Path to automation policy JSON
 *   --driver <name>        AI driver (default: subprocess)
 */

import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// ── Arg parsing ───────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
function flag(name) {
  const i = args.indexOf(name);
  if (i === -1) return null;
  return args[i + 1] ?? true;
}
function boolFlag(name) {
  return args.includes(name);
}

const WORKSPACE = path.resolve(flag("--workspace") || ".");
const FULL_MODE = boolFlag("--full");
const NO_DASHBOARD = boolFlag("--no-dashboard");
const NO_REMOTE = boolFlag("--no-remote");
const DASHBOARD_PORT = parseInt(flag("--dashboard-port") || "3200", 10);
let BRIDGE_PORT = parseInt(flag("--bridge-port") || "0", 10);
const NTFY_TOPIC = flag("--notify") || "";
const AUTO_POLICY = flag("--automation-policy") || "";
const DRIVER = flag("--driver") || "subprocess";

if (!fs.existsSync(WORKSPACE)) {
  console.error(`Error: workspace directory not found: ${WORKSPACE}`);
  process.exit(1);
}

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const BRIDGE_DIR = path.resolve(SCRIPT_DIR, "..");
const DASH_DIR = path.join(BRIDGE_DIR, "dashboard");
const DIST_INDEX = path.join(BRIDGE_DIR, "dist", "index.js");
const IS_WIN = process.platform === "win32";

// ── Security helpers ──────────────────────────────────────────────────────────
// On Windows `\` is the path separator (e.g. `C:\Program Files\nodejs\node.exe`),
// not a shell-injection vector. cmd.exe's actual metacharacters are
// `^ & < > | ( )` — `\` does not need escaping. Including it in the regex
// would reject every legitimate Windows path that spawnProc validates
// (process.execPath, npm.cmd, npx.cmd, etc.) and fail-stop the whole script.
// Same fix that PR #525 applied to vscode-extension/src/bridgeProcess.ts.
const SHELL_METACHARACTERS = IS_WIN
  ? /[;&|`$(){}[\]<>"'\n\r]/
  : /[;&|`$(){}[\]<>"'\\\n\r]/;

/**
 * Validate that a command path is safe to execute.
 * Prevents command injection by checking for shell metacharacters.
 * @param {string} cmdPath - Path to validate
 * @param {string} label - Label for error messages
 * @throws {Error} If path contains shell metacharacters or is empty
 */
function validateCommandPath(cmdPath, label) {
  if (!cmdPath || typeof cmdPath !== "string") {
    throw new Error(`${label}: command path is empty or invalid`);
  }
  if (SHELL_METACHARACTERS.test(cmdPath)) {
    throw new Error(
      `${label}: command path contains shell metacharacters: ${cmdPath}`,
    );
  }
  // Additional check: on Windows, .cmd files are allowed but must not have spaces without proper quoting
  if (IS_WIN && cmdPath.endsWith(".cmd") && cmdPath.includes(" ")) {
    // This is handled by using cmd.exe explicitly, not shell:true
    // We validate the path doesn't have injection chars above
  }
}

/**
 * Validate command arguments don't contain injection vectors.
 * @param {string[]} args - Arguments to validate
 * @param {string} label - Label for error messages
 */
function validateCommandArgs(args, label) {
  if (!Array.isArray(args)) {
    throw new Error(`${label}: arguments must be an array`);
  }
  for (const arg of args) {
    if (typeof arg !== "string") {
      throw new Error(`${label}: all arguments must be strings`);
    }
  }
}

// ── Colour helpers ────────────────────────────────────────────────────────────
const C = {
  cyan: (s) => `\x1b[36m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  grey: (s) => `\x1b[90m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
};

function ts() {
  return new Date().toLocaleTimeString();
}
function log(label, msg, col = C.cyan) {
  process.stdout.write(`${C.grey(ts())} ${col(`[${label}]`)} ${msg}\n`);
}

// ── ntfy notifications ────────────────────────────────────────────────────────
let lastNotifyMs = 0;
const NOTIFY_COOLDOWN_MS = 60_000;

function notify(msg, priority = "default") {
  log("notify", msg);
  if (!NTFY_TOPIC) return;
  const now = Date.now();
  if (priority !== "high" && now - lastNotifyMs < NOTIFY_COOLDOWN_MS) return;
  lastNotifyMs = now;
  // Fire-and-forget via fetch (Node 18+)
  fetch(`https://ntfy.sh/${NTFY_TOPIC}`, {
    method: "POST",
    body: msg,
    headers: { Title: "Claude IDE Bridge", Priority: priority },
    signal: AbortSignal.timeout(10_000),
  }).catch(() => {});
}

// ── Process registry ──────────────────────────────────────────────────────────
const procs = new Map(); // name → ChildProcess

function spawnProc(name, cmd, cmdArgs, opts = {}) {
  // Validate command and arguments to prevent injection attacks
  validateCommandPath(cmd, `spawnProc[${name}]`);
  validateCommandArgs(cmdArgs, `spawnProc[${name}]`);

  // shell:false everywhere — on Windows we always invoke cmd.exe explicitly
  // for .cmd shim resolution, so shell:true would only widen the attack
  // surface by interpolating env-derived paths into a shell string.
  const child = spawn(cmd, cmdArgs, {
    stdio: ["ignore", "pipe", "pipe"],
    shell: false,
    cwd: opts.cwd ?? BRIDGE_DIR,
    env: { ...process.env, ...opts.env },
  });

  child.stdout?.on("data", (d) => {
    for (const l of d.toString().split("\n").filter(Boolean))
      log(name, l, C.grey);
  });
  child.stderr?.on("data", (d) => {
    for (const l of d.toString().split("\n").filter(Boolean))
      log(name, l, C.yellow);
  });
  child.on("error", (err) => log(name, `spawn error: ${err.message}`, C.red));

  procs.set(name, child);
  return child;
}

function killProc(name) {
  const p = procs.get(name);
  if (!p || p.exitCode !== null) return;
  try {
    if (IS_WIN) p.kill();
    else p.kill("SIGTERM");
  } catch {
    /* best-effort */
  }
  procs.delete(name);
}

function killAll() {
  for (const name of [...procs.keys()]) killProc(name);
}

// ── Cleanup on exit ───────────────────────────────────────────────────────────
let cleanedUp = false;
function cleanup() {
  if (cleanedUp) return;
  cleanedUp = true;
  log("orchestrator", "Stopping all processes...", C.yellow);
  killAll();
}

process.on("exit", cleanup);
process.on("SIGINT", () => {
  cleanup();
  process.exit(0);
});
process.on("SIGTERM", () => {
  cleanup();
  process.exit(0);
});

// ── Wait helpers ──────────────────────────────────────────────────────────────
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function waitForLock(cfgDir, port, timeoutMs = 30_000) {
  return new Promise((resolve) => {
    const lockPath = path.join(cfgDir, "ide", `${port}.lock`);
    const deadline = Date.now() + timeoutMs;
    const poll = setInterval(() => {
      if (fs.existsSync(lockPath)) {
        clearInterval(poll);
        resolve(lockPath);
        return;
      }
      if (Date.now() > deadline) {
        clearInterval(poll);
        resolve(null);
      }
    }, 150);
  });
}

// Find the lock file written by the newly spawned bridge (any new lock in ide/).
function waitForNewLock(cfgDir, knownLocks, timeoutMs = 30_000) {
  return new Promise((resolve) => {
    const ideDir = path.join(cfgDir, "ide");
    const deadline = Date.now() + timeoutMs;
    const poll = setInterval(() => {
      let locks = [];
      try {
        locks = fs.readdirSync(ideDir).filter((f) => f.endsWith(".lock"));
      } catch {}
      const newLock = locks.find((l) => !knownLocks.has(l));
      if (newLock) {
        clearInterval(poll);
        resolve(path.join(ideDir, newLock));
        return;
      }
      if (Date.now() > deadline) {
        clearInterval(poll);
        resolve(null);
      }
    }, 200);
  });
}

function waitForPort(port, timeoutMs = 60_000) {
  return new Promise((resolve) => {
    const deadline = Date.now() + timeoutMs;
    function attempt() {
      const sock = net.createConnection({ port, host: "127.0.0.1" });
      sock.on("connect", () => {
        sock.destroy();
        resolve(true);
      });
      sock.on("error", () => {
        if (Date.now() > deadline) {
          resolve(false);
          return;
        }
        setTimeout(attempt, 500);
      });
    }
    attempt();
  });
}

function readLock(lockPath) {
  try {
    return JSON.parse(fs.readFileSync(lockPath, "utf-8"));
  } catch {
    return null;
  }
}

// ── Resolve bridge binary ─────────────────────────────────────────────────────
// Prefer dist/index.js when available (npm install); fallback to src via tsx for local dev.
function bridgeBin() {
  if (fs.existsSync(DIST_INDEX)) return [process.execPath, [DIST_INDEX]];
  const srcIndex = path.join(BRIDGE_DIR, "src", "index.ts");
  if (fs.existsSync(srcIndex)) {
    // On Windows the spawnProc helper uses shell:false, so we must point at
    // the .cmd shim directly — bare "npx" would ENOENT.
    const npx = IS_WIN ? "npx.cmd" : "npx";
    return [npx, ["tsx", srcIndex]];
  }
  console.error("Error: dist/index.js not found. Run 'npm run build' first.");
  process.exit(1);
}

// ── Cross-platform browser open ───────────────────────────────────────────────
function openBrowser(url) {
  try {
    if (IS_WIN) {
      spawn("cmd.exe", ["/c", "start", url], { stdio: "ignore", shell: false });
    } else if (process.platform === "darwin") {
      spawn("open", [url], { stdio: "ignore" });
    } else {
      spawn("xdg-open", [url], { stdio: "ignore" });
    }
  } catch {
    /* best-effort */
  }
}

// ── Dependency checks ─────────────────────────────────────────────────────────
function probe(bin) {
  try {
    execFileSync(IS_WIN ? "where" : "which", [bin], {
      stdio: "pipe",
      timeout: 3_000,
    });
    return true;
  } catch {
    return false;
  }
}

if (!probe("claude")) {
  console.error(
    "Error: claude CLI not found on PATH. Install from https://docs.anthropic.com/en/docs/claude-code",
  );
  process.exit(1);
}

// ── Banner ────────────────────────────────────────────────────────────────────
console.log(
  C.bold("\n=== Claude IDE Bridge — Cross-Platform Orchestrator ==="),
);
console.log(`  Workspace  : ${WORKSPACE}`);
console.log(
  `  Tools      : ${FULL_MODE ? "full (~170)" : "slim (27 IDE-only)"}`,
);
if (!NO_DASHBOARD)
  console.log(`  Dashboard  : http://localhost:${DASHBOARD_PORT}`);
if (NTFY_TOPIC) console.log(`  Notify     : ntfy.sh/${NTFY_TOPIC}`);
console.log(`  Ctrl+C     : stop everything\n`);

// ── State ─────────────────────────────────────────────────────────────────────
const CLAUDE_CFG =
  process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), ".claude");
const IDE_DIR = path.join(CLAUDE_CFG, "ide");
fs.mkdirSync(IDE_DIR, { recursive: true });

let lockPath = null;
let restartCount = 0;
let restartDelayMs = 5_000;
let lastStartMs = 0;

// ── Build bridge spawn args ───────────────────────────────────────────────────
function buildBridgeArgs() {
  const [bin, prefix] = bridgeBin();
  const extra = [
    "--workspace",
    WORKSPACE,
    "--driver",
    DRIVER,
    ...(BRIDGE_PORT > 0 ? ["--port", String(BRIDGE_PORT)] : []),
    ...(FULL_MODE ? ["--full"] : []),
    ...(AUTO_POLICY
      ? ["--automation", "--automation-policy", AUTO_POLICY]
      : []),
  ];
  return { bin, args: [...prefix, ...extra] };
}

// ── Start bridge ──────────────────────────────────────────────────────────────
async function startBridge() {
  const existingLocks = new Set(
    fs.existsSync(IDE_DIR)
      ? fs.readdirSync(IDE_DIR).filter((f) => f.endsWith(".lock"))
      : [],
  );

  const { bin, args: bArgs } = buildBridgeArgs();
  log("bridge", `Starting: ${path.basename(bin)} ${bArgs.slice(-4).join(" ")}`);
  lastStartMs = Date.now();

  spawnProc("bridge", bin, bArgs);

  // Wait for lock file (bridge writes it before accepting connections)
  const newLock =
    BRIDGE_PORT > 0
      ? await waitForLock(CLAUDE_CFG, BRIDGE_PORT)
      : await waitForNewLock(CLAUDE_CFG, existingLocks);

  if (!newLock) {
    log(
      "bridge",
      "Lock file not written after 30s — bridge failed to start",
      C.red,
    );
    notify("Bridge failed to start!", "high");
    return null;
  }

  lockPath = newLock;
  const content = readLock(lockPath);
  const port = content?.port ?? parseInt(path.basename(lockPath, ".lock"), 10);

  log("bridge", `Ready on port ${port}`, C.green);
  notify(`Bridge started on port ${port}`);
  return port;
}

// ── Start Claude --ide ────────────────────────────────────────────────────────
function startClaude(sessionId) {
  const extraArgs = sessionId ? ["--resume", sessionId] : [];
  log("claude", "Starting claude --ide");
  spawnProc(
    "claude",
    IS_WIN ? "cmd.exe" : "claude",
    IS_WIN ? ["/c", "claude", "--ide", ...extraArgs] : ["--ide", ...extraArgs],
    { env: { CLAUDE_CODE_IDE_SKIP_VALID_CHECK: "true" } },
  );
}

// ── Start remote-control ──────────────────────────────────────────────────────
function startRemote() {
  if (NO_REMOTE) return;
  log("remote", "Starting claude remote-control --spawn=session");
  spawnProc(
    "remote",
    IS_WIN ? "cmd.exe" : "claude",
    IS_WIN
      ? ["/c", "claude", "remote-control", "--spawn=session"]
      : ["remote-control", "--spawn=session"],
  );
}

// ── Load ~/.patchwork/.env into process.env ───────────────────────────────────
function loadPatchworkEnv() {
  const envPath = path.join(os.homedir(), ".patchwork", ".env");
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, "utf-8").split("\n")) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2];
  }
}
loadPatchworkEnv();

// ── Start dashboard ───────────────────────────────────────────────────────────
async function startDashboard(bridgePort) {
  if (NO_DASHBOARD) return;
  if (!fs.existsSync(path.join(DASH_DIR, "node_modules"))) {
    log("dashboard", "node_modules not found — installing...", C.yellow);
    try {
      execFileSync(
        IS_WIN ? "cmd.exe" : "npm",
        IS_WIN
          ? ["/c", "npm", "install", "--prefer-offline"]
          : ["install", "--prefer-offline"],
        { cwd: DASH_DIR, stdio: "inherit" },
      );
    } catch {
      log(
        "dashboard",
        "npm install failed — pass --no-dashboard to skip",
        C.red,
      );
      return;
    }
  }

  const dashEnv = {
    PATCHWORK_BRIDGE_PORT: String(bridgePort),
    ...(process.env.DASHBOARD_PASSWORD
      ? { DASHBOARD_PASSWORD: process.env.DASHBOARD_PASSWORD }
      : {}),
    ...(process.env.DASHBOARD_SESSION_SECRET
      ? { DASHBOARD_SESSION_SECRET: process.env.DASHBOARD_SESSION_SECRET }
      : {}),
  };

  log("dashboard", `Starting on http://localhost:${DASHBOARD_PORT}`);
  spawnProc(
    "dashboard",
    IS_WIN ? "cmd.exe" : "npx",
    IS_WIN
      ? ["/c", "npx", "next", "dev", "-p", String(DASHBOARD_PORT)]
      : ["next", "dev", "-p", String(DASHBOARD_PORT)],
    { cwd: DASH_DIR, env: dashEnv },
  );

  const ready = await waitForPort(DASHBOARD_PORT, 60_000);
  if (ready) {
    log(
      "dashboard",
      `Ready — opening http://localhost:${DASHBOARD_PORT}`,
      C.green,
    );
    openBrowser(`http://localhost:${DASHBOARD_PORT}`);
  } else {
    log(
      "dashboard",
      `Did not respond within 60s — open http://localhost:${DASHBOARD_PORT} manually`,
      C.yellow,
    );
  }
}

// ── Health monitor ────────────────────────────────────────────────────────────
// Bridge restarts keep the existing `claude --ide` process alive rather than
// killing/relaunching it — there's no working session-resume wired up here,
// so a forced restart previously meant an unconditional cold-start of the
// user's live IDE session on every bridge hiccup. Now that BRIDGE_PORT is
// pinned (see below), the bridge comes back on the same port and `claude`'s
// own lock-file discovery reconnects without needing to be restarted.
let restarting = false;

async function restartAll() {
  if (restarting) {
    log("health", "Restart already in progress — skipping", C.grey);
    return;
  }
  restarting = true;
  try {
    log("health", "Bridge unhealthy — restarting...", C.yellow);
    notify("Bridge died! Restarting...", "high");

    killProc("bridge");
    killProc("remote");
    await sleep(2_000); // let processes wind down

    // Exponential backoff on rapid restarts
    const uptime = Date.now() - lastStartMs;
    if (uptime < 60_000) {
      log(
        "health",
        `Crashed quickly (${Math.round(uptime / 1000)}s) — backing off ${restartDelayMs / 1000}s (restart #${restartCount})`,
        C.yellow,
      );
      await sleep(restartDelayMs);
      restartDelayMs = Math.min(restartDelayMs * 2, 300_000);
      restartCount++;
    } else {
      restartDelayMs = 5_000;
      restartCount = 0;
    }

    const port = await startBridge();
    if (!port) return;

    startRemote();
  } finally {
    restarting = false;
  }
}

// Actual liveness check, not just "does the lock file exist" — a wedged
// bridge (stuck on an internal await) keeps its lock file and would
// otherwise never get restarted.
function checkBridgeHealth(port, timeoutMs = 5_000) {
  return new Promise((resolve) => {
    const req = http.get(
      { host: "127.0.0.1", port, path: "/health", timeout: timeoutMs },
      (res) => {
        res.resume();
        resolve(res.statusCode != null && res.statusCode < 500);
      },
    );
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
    req.on("error", () => resolve(false));
  });
}

function startHealthMonitor() {
  setInterval(async () => {
    if (!lockPath) return;
    if (!fs.existsSync(lockPath)) {
      await restartAll();
      return;
    }
    const content = readLock(lockPath);
    const port = content?.port ?? BRIDGE_PORT;
    if (!port) return;
    const healthy = await checkBridgeHealth(port);
    if (!healthy) await restartAll();
  }, 10_000);
}

// ── Main ──────────────────────────────────────────────────────────────────────
const bridgePort = await startBridge();
if (!bridgePort) {
  cleanup();
  process.exit(1);
}
// Pin the auto-assigned port so every subsequent restartAll()-triggered
// startBridge() lands on the same port instead of a fresh random one, and
// takes the exact-path waitForLock() branch instead of the racy
// waitForNewLock() guess.
if (BRIDGE_PORT === 0) BRIDGE_PORT = bridgePort;

startClaude();
startRemote();
startHealthMonitor();
await startDashboard(bridgePort);

// Keep process alive (health monitor runs on setInterval)
log("orchestrator", "All processes started. Ctrl+C to stop.", C.green);
await new Promise(() => {}); // never resolves — process lives until Ctrl+C
