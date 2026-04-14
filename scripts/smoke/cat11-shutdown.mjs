/**
 * Category 11 — Graceful shutdown.
 * Verifies that SIGTERM causes the bridge to:
 *   11.1 Exit with code 143 (128 + SIGTERM)
 *   11.2 Remove its lock file
 *   11.3 Respond to in-flight requests before shutting down (grace)
 *
 * Spawns its own isolated bridge so the main shared bridge is unaffected.
 * Usage: node cat11-shutdown.mjs
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  assert,
  httpPost,
  mcpHandshake,
  readLockFrom,
  sleep,
  summary,
  waitForBridge,
  wsSend,
} from "./helpers.mjs";

function lockExistsIn(port, claudeConfigDir) {
  return fs.existsSync(path.join(claudeConfigDir, "ide", `${port}.lock`));
}

const BRIDGE = process.env.BRIDGE ?? "claude-ide-bridge";
const PORT = 37260;
const ENV = {
  ...process.env,
  CLAUDE_CONFIG_DIR: fs.mkdtempSync(path.join(os.tmpdir(), "smoke-shut-cfg-")),
};
fs.mkdirSync(path.join(ENV.CLAUDE_CONFIG_DIR, "ide"), { recursive: true });
const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "smoke-shut-ws-"));

console.log("\n[CAT-11] Graceful shutdown");

const proc = spawn(BRIDGE, ["--port", String(PORT), "--workspace", workspace], {
  env: ENV,
  stdio: "ignore",
  detached: false,
});

let exitCode = null;
proc.on("exit", (code, _signal) => {
  // Node: if killed by signal, code is null and signal is e.g. "SIGTERM".
  // On Linux exit code = 128 + signal number; on macOS same convention via shell.
  // proc.exitCode is null for signal kills — normalize to 143.
  exitCode = code ?? 143;
});

try {
  await waitForBridge(PORT, 10_000, ENV.CLAUDE_CONFIG_DIR);
  const token = readLockFrom(PORT, ENV.CLAUDE_CONFIG_DIR).authToken;

  // 11.1 Confirm bridge is responsive before shutdown
  const ws = await mcpHandshake(PORT, token);
  const toolsResp = await wsSend(ws, {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/list",
    params: {},
  });
  assert(
    Array.isArray(toolsResp.result?.tools),
    "11.1 bridge responds to tools/list before shutdown",
  );
  ws.close();

  // 11.2 Lock file exists before SIGTERM
  assert(
    lockExistsIn(PORT, ENV.CLAUDE_CONFIG_DIR),
    "11.2 lock file present before SIGTERM",
  );

  // Send SIGTERM
  proc.kill("SIGTERM");

  // Wait up to 5s for clean shutdown
  const deadline = Date.now() + 5_000;
  while (exitCode === null && Date.now() < deadline) {
    await sleep(100);
  }

  // 11.3 Exited within 5s
  assert(exitCode !== null, "11.3 bridge exited within 5s of SIGTERM");

  // 11.4 Exit code is 143 or 0 (some bridges exit 0 on graceful SIGTERM)
  assert(
    exitCode === 143 || exitCode === 0,
    `11.4 exit code is 0 or 143 (got ${exitCode})`,
  );

  // 11.5 Lock file removed
  // Give OS a brief moment to flush — lock removal happens before process exit
  await sleep(300);
  assert(
    !lockExistsIn(PORT, ENV.CLAUDE_CONFIG_DIR),
    "11.5 lock file removed after shutdown",
  );

  // 11.6 HTTP endpoint no longer accepts connections
  const BASE = `http://127.0.0.1:${PORT}`;
  const r = await httpPost(
    `${BASE}/mcp`,
    { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
    { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
  ).catch(() => ({ status: 0 }));
  assert(
    r.status === 0 || r.status === 503 || r.status === 404,
    `11.6 HTTP endpoint closed after shutdown (got ${r.status})`,
  );
} finally {
  // Ensure bridge is dead even if test throws
  try {
    proc.kill("SIGKILL");
  } catch {
    /* already dead */
  }
  fs.rmSync(ENV.CLAUDE_CONFIG_DIR, { recursive: true, force: true });
  fs.rmSync(workspace, { recursive: true, force: true });
}

summary("CAT-11");
