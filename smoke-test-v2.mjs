/**
 * smoke-test-v2.mjs — Comprehensive bridge smoke test
 *
 * Covers all 6 areas addressed in v2.2.0:
 *   1. runInTerminal   — subprocess fallback (SSH remote / no PTY)
 *   2. LSP tools       — cold-start retry, returns results not timeout errors
 *   3. Probe / PATH    — tsc + biome detected via node_modules/.bin
 *   4. searchAndReplace glob — bare *.ts normalised to **∕*.ts
 *   5. getToolCapabilities  — feature flags accurate
 *   6. captureScreenshot    — graceful error on headless
 *
 * Usage:
 *   node smoke-test-v2.mjs [port]
 *
 * Exit 0 = all pass, Exit 1 = failures present.
 */

import { readFileSync, readdirSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import WebSocket from "ws";

// ── Connection config ─────────────────────────────────────────────────────────
// Usage:
//   node smoke-test-v2.mjs                  → auto-discover via lock file
//   node smoke-test-v2.mjs <port>           → connect to lock-file port
//   node smoke-test-v2.mjs <port> <token>   → connect directly (no lock file)

const args = process.argv.slice(2);
const explicitPort = args[0] ? Number.parseInt(args[0], 10) : null;
const explicitToken = args[1] ?? null;

let port, token;

if (explicitPort && explicitToken) {
  // Direct mode — no lock file needed (used for --fixed-token bridges)
  port = explicitPort;
  token = explicitToken;
} else {
  // Lock file discovery
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
  const lockFile = explicitPort
    ? `${explicitPort}.lock`
    : lockFiles.sort((a, b) => b.localeCompare(a))[0];
  const lockPath = path.join(lockDir, lockFile);
  let lockContent;
  try {
    lockContent = JSON.parse(readFileSync(lockPath, "utf-8"));
  } catch {
    console.error(`Cannot read lock file: ${lockPath}`);
    process.exit(1);
  }
  port = Number.parseInt(path.basename(lockFile, ".lock"), 10);
  token = lockContent.authToken;
}
console.log(`\nConnecting to bridge on port ${port} (v2.2.0 smoke test)...\n`);

// ── WebSocket + JSON-RPC ──────────────────────────────────────────────────────
const ws = new WebSocket(`ws://127.0.0.1:${port}`, {
  headers: { "x-claude-code-ide-authorization": token },
});

let msgId = 1;
const pending = new Map();

const results = { pass: 0, warn: 0, fail: 0, sections: [] };
let currentSection = "";

function section(name) {
  currentSection = name;
  console.log(`\n=== ${name} ===`);
  results.sections.push({ name, items: [] });
}

function record(status, name, detail = "") {
  const icon = status === "PASS" ? "✅" : status === "WARN" ? "⚠️ " : "❌";
  console.log(`  ${icon} ${name}${detail ? `  (${detail})` : ""}`);
  results[status === "PASS" ? "pass" : status === "WARN" ? "warn" : "fail"]++;
  results.sections.at(-1).items.push({ status, name, detail });
}

function pass(name, detail) { record("PASS", name, detail); }
function warn(name, detail) { record("WARN", name, detail); }
function fail(name, detail) { record("FAIL", name, detail); }

function send(method, params) {
  return new Promise((resolve, reject) => {
    const id = msgId++;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`Timeout waiting for ${method} (id=${id})`));
    }, 25_000);
    pending.set(id, (msg) => {
      clearTimeout(timer);
      resolve(msg);
    });
    ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
  });
}

function tool(name, args = {}) {
  return send("tools/call", { name, arguments: args });
}

function parse(resp) {
  if (resp.error) return { _error: resp.error };
  try {
    return JSON.parse(resp.result?.content?.[0]?.text ?? "{}");
  } catch {
    return { _raw: resp.result?.content?.[0]?.text };
  }
}

ws.on("message", (data) => {
  const msg = JSON.parse(data.toString());
  const resolver = pending.get(msg.id);
  if (resolver) { pending.delete(msg.id); resolver(msg); }
});

ws.on("error", (err) => { console.error("WebSocket error:", err.message); process.exit(1); });

ws.on("open", async () => {
  try {
    // ── Protocol handshake ───────────────────────────────────────────────────
    section("Protocol");
    const init = await send("initialize", {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "smoke-test-v2", version: "2.0" },
    });
    init.result ? pass("initialize") : fail("initialize", JSON.stringify(init.error));
    const pv = init.result?.protocolVersion;
    ["2025-03-26", "2025-11-25"].includes(pv)
      ? pass("protocolVersion", pv)
      : warn("protocolVersion", `got ${pv}`);
    const si = init.result?.serverInfo?.name;
    si === "claude-ide-bridge" ? pass("serverInfo", si) : fail("serverInfo", si);

    // MCP 2025-11-25: notify server that client init is complete
    ws.send(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }));

    const ping = await send("ping", {});
    JSON.stringify(ping.result) === "{}" ? pass("ping") : fail("ping", JSON.stringify(ping.result));

    // ── Tools list ────────────────────────────────────────────────────────────
    section("Tools list");
    const list = await send("tools/list", {});
    const tools = list.result?.tools ?? [];
    const toolNames = new Set(tools.map((t) => t.name));
    tools.length > 50
      ? pass("tool count", `${tools.length} tools`)
      : fail("tool count", `only ${tools.length}`);

    for (const t of ["runInTerminal", "searchAndReplace", "getDiagnostics", "getHover", "captureScreenshot"]) {
      toolNames.has(t) ? pass(`${t} registered`) : fail(`${t} registered`);
    }

    // runInTerminal should NOT have extensionRequired: true (it has a fallback now)
    const ritSchema = tools.find((t) => t.name === "runInTerminal");
    ritSchema?.extensionRequired !== true
      ? pass("runInTerminal.extensionRequired absent (fallback enabled)")
      : warn("runInTerminal.extensionRequired still true (fallback may not activate)");

    // ── 1. runInTerminal subprocess fallback ──────────────────────────────────
    section("1 · runInTerminal subprocess fallback");
    const rit = await tool("runInTerminal", { command: "npm --version", timeout: 20 });
    const ritData = parse(rit);
    if (ritData._error) {
      fail("runInTerminal", `error: ${ritData._error.message}`);
    } else if (typeof ritData.exitCode === "number") {
      pass("runInTerminal returns exitCode", `exitCode=${ritData.exitCode}`);
      typeof ritData.stdout === "string" && ritData.stdout.trim().match(/^\d+\.\d+/)
        ? pass("stdout contains npm version", ritData.stdout.trim().slice(0, 20))
        : warn("stdout unexpected", JSON.stringify(ritData.stdout ?? "").slice(0, 40));
      ritData.fallback === "subprocess"
        ? pass("fallback=subprocess (shell integration unavailable)")
        : pass("no fallback flag (shell integration active)");
    } else if (ritData.success === false && ritData.error?.includes("Terminal not found")) {
      // Extension connected but no active terminal in this MCP session — subprocess
      // fallback only triggers on null/timeout, not on "terminal not found" errors.
      // This is expected when testing via a fixed-token bridge with no open terminals.
      warn("runInTerminal: no active terminal in session", "open a terminal in Windsurf or test via lock-file bridge");
    } else {
      fail("runInTerminal unexpected response", JSON.stringify(ritData).slice(0, 80));
    }

    // ── 2. LSP tools ──────────────────────────────────────────────────────────
    section("2 · LSP tools");
    const lspTools = ["goToDefinition", "findReferences", "getHover", "getDocumentSymbols", "searchWorkspaceSymbols"];
    const knownFile = "src/tools/terminal.ts";

    for (const t of lspTools) {
      if (!toolNames.has(t)) { warn(t, "not in tools list"); continue; }
    }

    // getDocumentSymbols — most reliable LSP call (doesn't need position)
    const syms = await tool("getDocumentSymbols", { filePath: knownFile });
    const symsData = parse(syms);
    if (symsData._error) {
      fail("getDocumentSymbols", symsData._error.message);
    } else if (symsData.source === "lsp" && symsData.count > 0) {
      pass("getDocumentSymbols via LSP", `${symsData.count} symbols`);
    } else if (symsData.count > 0) {
      warn("getDocumentSymbols via fallback", `source=${symsData.source}, count=${symsData.count}`);
    } else {
      warn("getDocumentSymbols returned 0", JSON.stringify(symsData).slice(0, 60));
    }

    // getHover at a known symbol position
    const hover = await tool("getHover", { filePath: knownFile, line: 1, column: 8 });
    const hoverData = parse(hover);
    if (hoverData._error) {
      const msg = hoverData._error.message ?? "";
      msg.includes("timed out after retries")
        ? warn("getHover LSP cold-start (retry budget exhausted)", msg.slice(0, 60))
        : fail("getHover", msg.slice(0, 80));
    } else if (hoverData.found === false) {
      warn("getHover no hover at line 1:8", "try a different position");
    } else {
      pass("getHover returned content", JSON.stringify(hoverData).slice(0, 60));
    }

    // searchWorkspaceSymbols — workspace-wide
    const wsyms = await tool("searchWorkspaceSymbols", { query: "createRunInTerminalTool" });
    const wsymsData = parse(wsyms);
    if (wsymsData._error) {
      fail("searchWorkspaceSymbols", wsymsData._error.message?.slice(0, 60));
    } else if (wsymsData.count > 0) {
      pass("searchWorkspaceSymbols found symbol", `count=${wsymsData.count}`);
    } else {
      warn("searchWorkspaceSymbols 0 results", "LSP may not be indexed yet");
    }

    // ── 3. Probe / PATH detection ─────────────────────────────────────────────
    section("3 · Probe / PATH detection (node_modules/.bin)");
    const caps = parse(await tool("getToolCapabilities"));
    if (caps._error) {
      fail("getToolCapabilities", caps._error.message);
    } else {
      pass("getToolCapabilities ok", `extensionConnected=${caps.extensionConnected}`);

      // After a bridge restart with workspace arg, these should be true
      caps.linters?.tsc === true
        ? pass("tsc detected (global or local bin)")
        : warn("tsc NOT detected", "restart bridge to pick up local node_modules/.bin probe");
      caps.linters?.biome === true
        ? pass("biome detected")
        : warn("biome NOT detected", "restart bridge to pick up local node_modules/.bin probe");

      // git should always be on global PATH
      caps.cliTools?.git === true
        ? pass("git on global PATH")
        : fail("git not detected");

      // Feature flags
      caps.features?.lsp === "available (VS Code LSP)"
        ? pass("LSP feature available")
        : warn("LSP feature", caps.features?.lsp);
      caps.features?.terminalOutput
        ? pass("terminalOutput feature", caps.features.terminalOutput.slice(0, 50))
        : warn("terminalOutput feature missing");
    }

    // ── 4. searchAndReplace glob normalisation ────────────────────────────────
    section("4 · searchAndReplace glob normalisation");

    // dryRun with bare glob — should find ts files in subdirectories
    const sarBare = await tool("searchAndReplace", {
      pattern: "ExtensionTimeoutError",
      replacement: "ExtensionTimeoutError",
      glob: "*.ts",
      dryRun: true,
    });
    const sarBareData = parse(sarBare);
    if (sarBareData._error) {
      fail("searchAndReplace bare glob", sarBareData._error.message?.slice(0, 60));
    } else if (sarBareData.matched > 0) {
      pass("bare *.ts glob matches nested files", `matched=${sarBareData.matched} files`);
    } else if (sarBareData.message?.includes("No files")) {
      // rg not available — grep fallback doesn't support --glob, so 0 matches expected
      warn("bare *.ts glob matched 0 files", "rg not on PATH — glob normalisation untestable without rg");
    } else {
      warn("bare *.ts glob matched 0 files", JSON.stringify(sarBareData).slice(0, 60));
    }

    // dryRun with explicit **/*.ts — same result expected
    const sarDouble = await tool("searchAndReplace", {
      pattern: "ExtensionTimeoutError",
      replacement: "ExtensionTimeoutError",
      glob: "**/*.ts",
      dryRun: true,
    });
    const sarDoubleData = parse(sarDouble);
    if (!sarDoubleData._error && sarDoubleData.matched > 0) {
      pass("**/*.ts glob baseline", `matched=${sarDoubleData.matched} files`);
      if (sarBareData.matched > 0) {
        sarBareData.matched === sarDoubleData.matched
          ? pass("bare *.ts and **/*.ts produce identical results")
          : warn("match counts differ", `bare=${sarBareData.matched}, double=${sarDoubleData.matched}`);
      }
    } else if (!sarDoubleData._error && sarDoubleData.matched === 0) {
      warn("**/*.ts baseline matched 0", "rg not on PATH — install ripgrep for full glob support");
    } else {
      warn("**/*.ts baseline", JSON.stringify(sarDoubleData).slice(0, 60));
    }

    // Negation glob sanity check (dryRun, should not error)
    const sarNeg = await tool("searchAndReplace", {
      pattern: "ExtensionTimeoutError",
      replacement: "ExtensionTimeoutError",
      glob: "!*.md",
      dryRun: true,
    });
    const sarNegData = parse(sarNeg);
    sarNegData._error
      ? fail("negation glob !*.md errored", sarNegData._error.message?.slice(0, 60))
      : pass("negation glob !*.md accepted without error");

    // ── 5. captureScreenshot graceful degradation ─────────────────────────────
    section("5 · captureScreenshot headless graceful error");
    const shot = await tool("captureScreenshot");
    const shotData = parse(shot);
    if (shot.result?.content?.[0]?.type === "image") {
      pass("captureScreenshot returned image (display available)");
    } else if (shotData._error) {
      fail("captureScreenshot threw", shotData._error.message?.slice(0, 60));
    } else {
      const errText = shot.result?.content?.[0]?.text ?? "";
      if (errText.includes("headless") || errText.includes("display server") || errText.includes("SSH remote")) {
        pass("captureScreenshot returns actionable error on headless", errText.slice(0, 80));
      } else if (errText.includes("not connected") || errText.includes("requires the extension")) {
        // Extension disconnected — can't reach the headless check yet, that's fine
        warn("captureScreenshot: extension disconnected (reconnect to test headless message)", errText.slice(0, 60));
      } else {
        warn("captureScreenshot error message generic", errText.slice(0, 80));
      }
    }

    // ── Error handling ────────────────────────────────────────────────────────
    section("Error handling");
    const bad = await send("tools/call", { name: "nonexistent_tool", arguments: {} });
    // Bridge returns -32003 (tool not found) or -32602 (invalid params) — both acceptable
    const badCode = bad.error?.code;
    (badCode === -32003 || badCode === -32602)
      ? pass("invalid tool → tool-not-found error", `code=${badCode}`)
      : fail("invalid tool error code", JSON.stringify(bad.error));

    const unknownMethod = await send("unknown/method", {});
    unknownMethod.error?.code === -32601
      ? pass("unknown method → -32601")
      : fail("unknown method error code", JSON.stringify(unknownMethod.error));

    // ── Summary ───────────────────────────────────────────────────────────────
    console.log("\n" + "─".repeat(56));
    console.log(`  ✅ PASS  ${String(results.pass).padStart(3)}`);
    console.log(`  ⚠️  WARN  ${String(results.warn).padStart(3)}  (expected before bridge restart)`);
    console.log(`  ❌ FAIL  ${String(results.fail).padStart(3)}`);
    console.log("─".repeat(56));

    if (results.warn > 0) {
      console.log("\nWARNs resolve after: pkill -f 'node dist/index.js' && npm run start");
    }

    ws.close();
    process.exit(results.fail > 0 ? 1 : 0);

  } catch (err) {
    console.error("\nFATAL:", err.message);
    console.error(err.stack);
    ws.close();
    process.exit(1);
  }
});

setTimeout(() => {
  console.error("GLOBAL TIMEOUT — bridge not responding in 60s");
  process.exit(1);
}, 60_000);
