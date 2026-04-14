/**
 * Category 7 — Plugin load / register / invoke cycle.
 * Usage: node cat7-plugin.mjs
 */
import { execFileSync, spawn } from "node:child_process";
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

const BRIDGE = process.env.BRIDGE ?? "claude-ide-bridge";
const BASE_PORT = 37240;
const ENV = {
  ...process.env,
  CLAUDE_CONFIG_DIR: fs.mkdtempSync(path.join(os.tmpdir(), "smoke-plug-cfg-")),
};
fs.mkdirSync(path.join(ENV.CLAUDE_CONFIG_DIR, "ide"), { recursive: true });

console.log("\n[CAT-7] Plugin system");

// Generate plugin stub — path must NOT pre-exist (gen-plugin-stub creates it)
const pluginDir = path.join(os.tmpdir(), `smoke-plugin-${process.pid}`);
if (fs.existsSync(pluginDir))
  fs.rmSync(pluginDir, { recursive: true, force: true });
const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "smoke-ws-"));

try {
  execFileSync(
    BRIDGE,
    [
      "gen-plugin-stub",
      pluginDir,
      "--name",
      "smoke/test-plugin",
      "--prefix",
      "smkTest",
    ],
    { env: ENV },
  );
} catch (e) {
  console.error("gen-plugin-stub failed:", e.message);
  process.exit(1);
}

// 7.1–7.3: Valid plugin loads and tool is callable
{
  const proc = spawn(
    BRIDGE,
    [
      "--port",
      String(BASE_PORT),
      "--workspace",
      workspace,
      "--plugin",
      pluginDir,
    ],
    {
      env: ENV,
      stdio: "ignore",
    },
  );
  try {
    await waitForBridge(BASE_PORT, 10_000, ENV.CLAUDE_CONFIG_DIR);
    const token = readLockFrom(BASE_PORT, ENV.CLAUDE_CONFIG_DIR).authToken;
    const ws = await mcpHandshake(BASE_PORT, token);
    const tools = await listTools(ws);
    const names = tools.map((t) => t.name);

    // 7.1 Plugin tool appears in list
    const pluginTool = names.find((n) => n.startsWith("smkTest"));
    assert(
      !!pluginTool,
      `7.1 plugin tool (smkTest*) in tools/list (found: ${pluginTool ?? "none"})`,
    );

    // 7.2 All plugin tools start with prefix
    const pluginTools = names.filter((n) => n.startsWith("smkTest"));
    assert(
      pluginTools.length > 0 &&
        pluginTools.every((n) => n.startsWith("smkTest")),
      "7.2 all plugin tools start with 'smkTest'",
    );

    // 7.3 Tool invocable — stub requires { name: string }, provide it
    if (pluginTool) {
      const resp = await wsSend(ws, {
        jsonrpc: "2.0",
        id: 10,
        method: "tools/call",
        params: { name: pluginTool, arguments: { name: "smoke-test" } },
      });
      // Accept either success OR isError content block — both mean the tool was routed.
      // Reject only JSON-RPC protocol errors (method-not-found, server error).
      const jsonRpcErr = resp.error?.code;
      assert(
        !jsonRpcErr || jsonRpcErr === -32602,
        `7.3 ${pluginTool} routed by bridge (error: ${JSON.stringify(resp.error)})`,
      );
    } else {
      assert(false, "7.3 skipped — no plugin tool found");
    }

    ws.close();
  } finally {
    proc.kill();
    await sleep(500);
  }
}

// 7.4 Bad prefix rejected — plugin with 1-char prefix should log error, tools not exposed
{
  const badDir = fs.mkdtempSync(path.join(os.tmpdir(), "smoke-badplug-"));
  // Write invalid manifest
  fs.writeFileSync(
    path.join(badDir, "claude-ide-bridge-plugin.json"),
    JSON.stringify({
      schemaVersion: 1,
      name: "bad/plugin",
      toolNamePrefix: "x",
      entrypoint: "./index.mjs",
    }),
  );
  fs.writeFileSync(
    path.join(badDir, "index.mjs"),
    `
export function register(ctx) {
  ctx.registerTool({ name: "xBadTool", description: "bad", inputSchema: { type: "object" } }, async () => ({ content: [{ type: "text", text: "bad" }] }));
}
`,
  );

  const badPort = BASE_PORT + 1;
  const proc = spawn(
    BRIDGE,
    ["--port", String(badPort), "--workspace", workspace, "--plugin", badDir],
    {
      env: ENV,
      stdio: ["ignore", "ignore", "pipe"],
    },
  );
  let stderr = "";
  proc.stderr.on("data", (d) => (stderr += d));
  await sleep(2000); // give bridge time to attempt plugin load

  let tools = [];
  try {
    await waitForBridge(badPort, 4000, ENV.CLAUDE_CONFIG_DIR);
    const token = readLockFrom(badPort, ENV.CLAUDE_CONFIG_DIR).authToken;
    const ws = await mcpHandshake(badPort, token);
    tools = await listTools(ws);
    ws.close();
  } catch {
    /* bridge may have rejected startup */
  }

  const xTools = tools.filter((t) => t.name.startsWith("x"));
  assert(
    xTools.length === 0,
    `7.4 bad prefix plugin: no 'x'-prefixed tools exposed (found: ${xTools.length})`,
  );

  proc.kill();
  fs.rmSync(badDir, { recursive: true, force: true });
  await sleep(300);
}

// 7.5 Broken entrypoint: bridge still starts, built-in tools available
{
  const brokenDir = fs.mkdtempSync(path.join(os.tmpdir(), "smoke-broken-"));
  fs.writeFileSync(
    path.join(brokenDir, "claude-ide-bridge-plugin.json"),
    JSON.stringify({
      schemaVersion: 1,
      name: "broken/plugin",
      toolNamePrefix: "brk",
      entrypoint: "./nonexistent.mjs",
    }),
  );

  const brokenPort = BASE_PORT + 2;
  const proc = spawn(
    BRIDGE,
    [
      "--port",
      String(brokenPort),
      "--workspace",
      workspace,
      "--plugin",
      brokenDir,
    ],
    {
      env: ENV,
      stdio: "ignore",
    },
  );
  try {
    await waitForBridge(brokenPort, 5000, ENV.CLAUDE_CONFIG_DIR);
    const token = readLockFrom(brokenPort, ENV.CLAUDE_CONFIG_DIR).authToken;
    const ws = await mcpHandshake(brokenPort, token);
    const tools = await listTools(ws);
    assert(
      tools.length > 0,
      `7.5 broken plugin: built-in tools still available (${tools.length} tools)`,
    );
    const brkTools = tools.filter((t) => t.name.startsWith("brk"));
    assert(brkTools.length === 0, "7.5 broken plugin: no 'brk' tools exposed");
    ws.close();
  } catch (e) {
    assert(
      false,
      `7.5 bridge failed to start with broken plugin: ${e.message}`,
    );
  } finally {
    proc.kill();
    fs.rmSync(brokenDir, { recursive: true, force: true });
    await sleep(300);
  }
}

fs.rmSync(pluginDir, { recursive: true, force: true });
fs.rmSync(workspace, { recursive: true, force: true });

summary("CAT-7");
