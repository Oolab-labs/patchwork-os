import { readFileSync, readdirSync } from "fs";
import { homedir } from "os";
import path from "path";
import WebSocket from "ws";

// Find lockfile - accept port as argument or find most recent
const targetPort = process.argv[2] ? parseInt(process.argv[2], 10) : null;
const lockDir = path.join(homedir(), ".claude", "ide");
const lockFiles = readdirSync(lockDir).filter(f => f.endsWith(".lock"));
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
  // Find most recently modified
  lockFile = lockFiles
    .map(f => ({ name: f, mtime: readFileSync(path.join(lockDir, f)).length }))
    .sort((a, b) => b.name.localeCompare(a.name))[0].name;
}

const port = parseInt(path.basename(lockFile, ".lock"), 10);
const content = JSON.parse(readFileSync(path.join(lockDir, lockFile), "utf-8"));
const token = content.authToken;

console.log(`Connecting to bridge on port ${port}...`);

const ws = new WebSocket(`ws://127.0.0.1:${port}`, {
  headers: { "x-claude-code-ide-authorization": token },
});

let msgId = 1;
const pending = new Map();
let passed = 0;
let failed = 0;

function check(name, condition, detail) {
  if (condition) {
    console.log(`  PASS: ${name}${detail ? " - " + detail : ""}`);
    passed++;
  } else {
    console.log(`  FAIL: ${name}${detail ? " - " + detail : ""}`);
    failed++;
  }
}

function send(method, params) {
  return new Promise((resolve) => {
    const id = msgId++;
    pending.set(id, resolve);
    ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
  });
}

ws.on("message", (data) => {
  const msg = JSON.parse(data.toString());
  const resolver = pending.get(msg.id);
  if (resolver) {
    pending.delete(msg.id);
    resolver(msg);
  }
});

ws.on("open", async () => {
  try {
    // 1. Initialize
    console.log("\n=== MCP Protocol ===");
    const init = await send("initialize", {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "smoke-test", version: "1.0" },
    });
    check("initialize", init.result !== undefined);
    check("protocolVersion", init.result?.protocolVersion === "2025-03-26", init.result?.protocolVersion);
    check("serverInfo", init.result?.serverInfo?.name === "claude-ide-bridge", JSON.stringify(init.result?.serverInfo));
    check("no false prompts capability", init.result?.capabilities?.prompts === undefined);
    check("no false logging capability", init.result?.capabilities?.logging === undefined);
    check("tools capability", init.result?.capabilities?.tools !== undefined);

    // 2. Ping
    const ping = await send("ping", {});
    check("ping returns empty object", JSON.stringify(ping.result) === "{}");

    // 3. Tools list
    console.log("\n=== Tools ===");
    const list = await send("tools/list", {});
    const tools = list.result?.tools || [];
    const toolNames = tools.map(t => t.name);
    check("tools/list returns tools", tools.length > 10, `${tools.length} tools`);
    console.log(`  Tools: ${toolNames.join(", ")}`);

    // Check additionalProperties
    const searchTool = tools.find(t => t.name === "searchWorkspace");
    check("additionalProperties: false", searchTool?.inputSchema?.additionalProperties === false);

    // Check annotations
    const diagTool = tools.find(t => t.name === "getDiagnostics");
    check("readOnlyHint annotation", diagTool?.annotations?.readOnlyHint === true);
    const fmtTool = tools.find(t => t.name === "formatFile");
    check("destructiveHint annotation", fmtTool?.annotations?.destructiveHint === true);

    // 4. Tool calls
    console.log("\n=== Tool Calls ===");

    const caps = await send("tools/call", { name: "getToolCapabilities", arguments: {} });
    if (caps.error) { console.log("  getToolCapabilities error:", caps.error.message); }
    const capsData = caps.result ? JSON.parse(caps.result?.content?.[0]?.text || "{}") : {};
    check("getToolCapabilities", capsData.extensionConnected !== undefined, `extensionConnected=${capsData.extensionConnected}, features=${JSON.stringify(capsData.features).slice(0,80)}`);

    for (const [toolName, toolArgs, validator] of [
      ["getGitStatus", {}, (d) => d.branch !== undefined || d.available === false],
      ["getFileTree", {}, (d) => d.entries?.length > 0],
      ["searchWorkspace", { query: "McpTransport" }, (d) => d.totalMatches > 0],
      ["findFiles", { pattern: "*.ts" }, (d) => d.files !== undefined],
      ["getGitLog", {}, (d) => d.entries?.length > 0 || d.error !== undefined],
      ["getGitDiff", {}, (d) => d.diff !== undefined || d.error !== undefined],
    ]) {
      const resp = await send("tools/call", { name: toolName, arguments: toolArgs });
      if (resp.error) {
        check(toolName, false, `error: ${resp.error.message}`);
      } else {
        const data = JSON.parse(resp.result?.content?.[0]?.text || "{}");
        check(toolName, validator(data), JSON.stringify(data).slice(0, 80));
      }
    }

    // 5. Error handling
    console.log("\n=== Error Handling ===");
    const badTool = await send("tools/call", { name: "nonexistent_tool", arguments: {} });
    check("invalid tool returns -32602", badTool.error?.code === -32602, `code=${badTool.error?.code}`);

    const unknownMethod = await send("unknown/method", {});
    check("unknown method returns -32601", unknownMethod.error?.code === -32601, `code=${unknownMethod.error?.code}`);

    // 6. Security
    console.log("\n=== Security ===");
    const escape = await send("tools/call", {
      name: "findFiles",
      arguments: { pattern: "*.ts", directory: "../../etc" },
    });
    check("path traversal blocked", escape.error !== undefined || JSON.parse(escape.result?.content?.[0]?.text || "{}").files?.length === 0);

    // Summary
    console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
    ws.close();
    process.exit(failed > 0 ? 1 : 0);
  } catch (err) {
    console.error("ERROR:", err.message, err.stack);
    ws.close();
    process.exit(1);
  }
});

ws.on("error", (err) => {
  console.error("WebSocket error:", err.message);
  process.exit(1);
});

setTimeout(() => {
  console.error("TIMEOUT");
  process.exit(1);
}, 15000);
