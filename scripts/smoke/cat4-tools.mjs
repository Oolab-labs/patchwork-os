/**
 * Category 4 — slim vs full tool counts; extensionRequired → isError.
 * Starts its own bridge instances on ports 37220 (slim) and 37221 (full).
 * Usage: node cat4-tools.mjs
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  assert,
  listTools,
  mcpHandshake,
  readLockFrom,
  sleep,
  summary,
  waitForBridge,
  wsSend,
} from "./helpers.mjs";

const SLIM_PORT = 37220;
const FULL_PORT = 37221;
const BRIDGE = process.env.BRIDGE ?? "claude-ide-bridge";

// Tools that must be absent in slim mode
const FULL_ONLY = [
  "getGitStatus",
  "gitCommit",
  "runInTerminal",
  "getGitDiff",
  "runCommand",
];
// Extension-required tools with NO CLI fallback — must return isError when extension disconnected
// Note: getDiagnostics has a CLI/linter fallback (tsc, biome) so it won't return isError
const EXT_REQUIRED = ["getHover"];

const tmpSlim = fs.mkdtempSync(path.join(os.tmpdir(), "smoke-slim-"));
const tmpFull = fs.mkdtempSync(path.join(os.tmpdir(), "smoke-full-"));

const ENV = {
  ...process.env,
  CLAUDE_CONFIG_DIR: fs.mkdtempSync(path.join(os.tmpdir(), "smoke-cat4-cfg-")),
};
fs.mkdirSync(path.join(ENV.CLAUDE_CONFIG_DIR, "ide"), { recursive: true });

function startBridge(port, workspace, extraArgs = []) {
  return spawn(
    BRIDGE,
    ["--port", String(port), "--workspace", workspace, ...extraArgs],
    {
      env: ENV,
      stdio: "ignore",
      detached: false,
    },
  );
}

console.log("\n[CAT-4] Tool listing — slim vs full");

const slimProc = startBridge(SLIM_PORT, tmpSlim, ["--slim"]);
const fullProc = startBridge(FULL_PORT, tmpFull, ["--full"]);

try {
  await Promise.all([
    waitForBridge(SLIM_PORT, 10_000, ENV.CLAUDE_CONFIG_DIR),
    waitForBridge(FULL_PORT, 10_000, ENV.CLAUDE_CONFIG_DIR),
  ]);

  const slimToken = readLockFrom(SLIM_PORT, ENV.CLAUDE_CONFIG_DIR).authToken;
  const fullToken = readLockFrom(FULL_PORT, ENV.CLAUDE_CONFIG_DIR).authToken;

  const slimWs = await mcpHandshake(SLIM_PORT, slimToken);
  const fullWs = await mcpHandshake(FULL_PORT, fullToken);

  const slimTools = await listTools(slimWs);
  const fullTools = await listTools(fullWs);

  // 4.1 slim count in expected range
  assert(
    slimTools.length >= 20 && slimTools.length <= 80,
    `4.1 slim tool count in [20,80] (got ${slimTools.length})`,
  );

  // 4.2 full > slim
  assert(
    fullTools.length > slimTools.length,
    `4.2 full (${fullTools.length}) > slim (${slimTools.length})`,
  );

  // 4.3 full-only tools absent from slim
  const slimNames = new Set(slimTools.map((t) => t.name));
  for (const name of FULL_ONLY) {
    assert(!slimNames.has(name), `4.3 slim excludes: ${name}`);
  }

  // 4.4 full-only tools present in full
  const fullNames = new Set(fullTools.map((t) => t.name));
  for (const name of FULL_ONLY) {
    assert(fullNames.has(name), `4.4 full includes: ${name}`);
  }

  // 4.5 extensionRequired tools return isError when extension not connected
  for (const toolName of EXT_REQUIRED) {
    if (!slimNames.has(toolName)) {
      assert(false, `4.5 ${toolName} not in slim tools/list`);
      continue;
    }
    try {
      const args =
        toolName === "getHover"
          ? { filePath: "/tmp/smoke-x.ts", line: 0, character: 0 }
          : { uri: "file:///tmp/x.ts" };
      const resp = await wsSend(slimWs, {
        jsonrpc: "2.0",
        id: 50,
        method: "tools/call",
        params: { name: toolName, arguments: args },
      });
      // Extension not connected → must return isError:true content
      const content = resp.result?.content ?? [];
      const isErr =
        resp.result?.isError === true ||
        content.some(
          (c) =>
            typeof c.text === "string" &&
            /extension|not connected/i.test(c.text),
        );
      assert(isErr, `4.5 ${toolName} → isError when extension disconnected`);
    } catch (e) {
      assert(false, `4.5 ${toolName} call failed: ${e.message}`);
    }
  }

  slimWs.close();
  fullWs.close();
} finally {
  slimProc.kill();
  fullProc.kill();
  await sleep(500); // allow processes to clean up lock files before rmSync
  fs.rmSync(tmpSlim, { recursive: true, force: true });
  fs.rmSync(tmpFull, { recursive: true, force: true });
  fs.rmSync(ENV.CLAUDE_CONFIG_DIR, { recursive: true, force: true });
}

summary("CAT-4");
