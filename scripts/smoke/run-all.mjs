#!/usr/bin/env node
// Cross-platform smoke test runner — replaces run-all.sh.
// Works on Windows (PowerShell/cmd), macOS, and Linux.
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BRIDGE = process.env.BRIDGE ?? "claude-ide-bridge";
const PORT = 37210;
const CAT2_PORT = 37211;

// Security: shell metacharacters that could enable command injection.
// On Windows `\` is the path separator (D:\…\bridge.cmd), not an injection
// vector. Same fix PR #527 applied to scripts/start-all.mjs.
const SHELL_METACHARACTERS =
  process.platform === "win32"
    ? /[;&|`$(){}[\]<>"'\n\r]/
    : /[;&|`$(){}[\]<>"'\\\n\r]/;

/**
 * Validate that a binary path is safe to execute.
 * Prevents command injection by checking for shell metacharacters.
 * @throws Error if path contains dangerous characters
 */
function validateBinaryPath(binaryPath) {
  if (!binaryPath || typeof binaryPath !== "string") {
    throw new Error("Binary path is empty or invalid");
  }
  if (SHELL_METACHARACTERS.test(binaryPath)) {
    throw new Error(
      `Binary path contains shell metacharacters (potential injection): ${binaryPath}`,
    );
  }
}

// Validate BRIDGE path on startup
try {
  validateBinaryPath(BRIDGE);
} catch (err) {
  console.error(`ERROR: ${err.message}`);
  process.exit(1);
}

const TMPWS = fs.mkdtempSync(path.join(os.tmpdir(), "patchwork-smoke-ws-"));
const CLAUDE_CFG = fs.mkdtempSync(
  path.join(os.tmpdir(), "patchwork-smoke-cfg-"),
);
fs.mkdirSync(path.join(CLAUDE_CFG, "ide"), { recursive: true });

process.env.CLAUDE_CONFIG_DIR = CLAUDE_CFG;

let bridgePid = null;
let cat2Pid = null;
let cat2Cfg = null;

function cleanup() {
  for (const pid of [bridgePid, cat2Pid]) {
    if (pid == null) continue;
    try {
      process.kill(pid);
    } catch {
      /* already gone */
    }
  }
  for (const dir of [TMPWS, CLAUDE_CFG, cat2Cfg]) {
    if (!dir) continue;
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
}

process.on("exit", cleanup);
process.on("SIGINT", () => process.exit(1));
process.on("SIGTERM", () => process.exit(1));

function waitForLock(cfgDir, port, timeoutMs = 10_000) {
  const lockPath = path.join(cfgDir, "ide", `${port}.lock`);
  const deadline = Date.now() + timeoutMs;
  while (!fs.existsSync(lockPath)) {
    if (Date.now() > deadline) return false;
    // busy-wait in 100ms increments — same as the bash script
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
  }
  return true;
}

// Spawn bridge for the given port and config dir. Captures stderr so a
// startup failure can be surfaced — `stdio: "ignore"` would swallow it
// and leave the operator staring at "lock file not written after 10s".
function startBridge(port, cfgDir, wsDir) {
  // Security: BRIDGE path already validated on startup
  const proc = spawn(BRIDGE, ["--port", String(port), "--workspace", wsDir], {
    env: { ...process.env, CLAUDE_CONFIG_DIR: cfgDir },
    stdio: ["ignore", "ignore", "pipe"],
    // On Windows, npm global bins are .cmd wrappers that need shell:true
    // Safe because BRIDGE path is validated for injection chars on startup
    shell: process.platform === "win32",
  });
  proc.stderrBuf = "";
  proc.stderr.on("data", (d) => {
    proc.stderrBuf += d.toString();
  });
  return proc;
}

// ── Start main bridge ─────────────────────────────────────────────────────────
console.log(`Starting bridge on port ${PORT}...`);
const bridgeProc = startBridge(PORT, CLAUDE_CFG, TMPWS);
bridgePid = bridgeProc.pid;

if (!waitForLock(CLAUDE_CFG, PORT)) {
  console.error("ERROR: bridge lock file not written after 10s");
  console.error(
    `Bridge stderr (last 4 KB):\n${(bridgeProc.stderrBuf || "(empty)").slice(-4096)}`,
  );
  process.exit(1);
}
// tiny extra buffer for WS listener to bind
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);

const TOKEN = execFileSync(BRIDGE, ["print-token", "--port", String(PORT)], {
  encoding: "utf-8",
  shell: process.platform === "win32",
}).trim();

console.log(`Bridge ready. Token: ${TOKEN.slice(0, 8)}...\n`);

// ── Start CAT-2 bridge (separate instance — CAT-2 kills the bridge it tests) ─
cat2Cfg = fs.mkdtempSync(path.join(os.tmpdir(), "patchwork-smoke-cat2-"));
fs.mkdirSync(path.join(cat2Cfg, "ide"), { recursive: true });

const cat2Proc = startBridge(CAT2_PORT, cat2Cfg, TMPWS);
cat2Pid = cat2Proc.pid;
waitForLock(cat2Cfg, CAT2_PORT);
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);

// ── Category runner ───────────────────────────────────────────────────────────
let pass = 0;
let fail = 0;
const failures = [];

function runCat(label, scriptFile, args = [], extraEnv = {}) {
  try {
    execFileSync(process.execPath, [scriptFile, ...args], {
      env: { ...process.env, ...extraEnv },
      stdio: "inherit",
    });
    console.log(`\x1b[32m[PASS]\x1b[0m ${label}`);
    pass++;
  } catch {
    console.log(`\x1b[31m[FAIL]\x1b[0m ${label}`);
    fail++;
    failures.push(label);
  }
}

const S = __dirname;
const P = String(PORT);
const T = TOKEN;

runCat(
  "CAT-2 (lockfile)",
  path.join(S, "cat2-lockfile.mjs"),
  [String(CAT2_PORT), String(cat2Pid)],
  { CLAUDE_CONFIG_DIR: cat2Cfg },
);
fs.rmSync(cat2Cfg, { recursive: true, force: true });
cat2Cfg = null;
cat2Pid = null;

runCat("CAT-3 (auth)", path.join(S, "cat3-auth.mjs"), [P, T]);
runCat("CAT-4 (tools)", path.join(S, "cat4-tools.mjs"));
runCat("CAT-5 (http)", path.join(S, "cat5-http.mjs"), [P, T]);
runCat("CAT-6 (oauth)", path.join(S, "cat6-oauth.mjs"));
runCat("CAT-7 (plugin)", path.join(S, "cat7-plugin.mjs"));
runCat("CAT-8 (ratelimit)", path.join(S, "cat8-ratelimit.mjs"), [P, T]);

// Give bridge 1s to reset after CAT-8 saturates the rate limiter
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000);

runCat("CAT-9 (prompts/res)", path.join(S, "cat9-prompts-resources.mjs"), [
  P,
  T,
]);
runCat("CAT-10 (health)", path.join(S, "cat10-health.mjs"), [P, T]);
runCat("CAT-11 (shutdown)", path.join(S, "cat11-shutdown.mjs"));
runCat("CAT-12 (automation)", path.join(S, "cat12-automation.mjs"));

// ── Summary ───────────────────────────────────────────────────────────────────
const total = pass + fail;
console.log("\n═══════════════════════════════════");
if (fail === 0) {
  console.log(`\x1b[32mALL PASS\x1b[0m (${pass}/${total} categories)`);
} else {
  console.log(`\x1b[31mFAILURES: ${fail}/${total} categories\x1b[0m`);
  for (const c of failures) console.log(`  ✗ ${c}`);
}
console.log("═══════════════════════════════════");
process.exit(fail > 0 ? 1 : 0);
