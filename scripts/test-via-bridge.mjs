#!/usr/bin/env node
/**
 * `npm test` entrypoint. If a live patchwork bridge is running for this
 * workspace, routes the run through the bridge's `runTests` MCP tool over
 * Streamable HTTP — the bridge executes the real vitest run itself and fires
 * `onTestRun`, so failures reach the Test Guardian Worker automation trigger
 * exactly like a Claude-session-initiated run. No bridge running (e.g. CI) ->
 * falls straight back to `vitest run`, unchanged behavior.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

function findBridgeLock() {
  const lockDir = path.join(
    process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude"),
    "ide",
  );
  let entries;
  try {
    entries = fs.readdirSync(lockDir).filter((f) => f.endsWith(".lock"));
  } catch {
    return null;
  }
  const cwd = process.cwd();
  const candidates = [];
  for (const entry of entries) {
    try {
      const data = JSON.parse(
        fs.readFileSync(path.join(lockDir, entry), "utf8"),
      );
      // Port is encoded in the filename ("<port>.lock"), not a JSON field.
      const port = Number(entry.slice(0, -".lock".length));
      if (!data.isBridge || !data.authToken || !port) continue;
      try {
        process.kill(data.pid, 0);
      } catch (err) {
        if (err.code !== "EPERM") continue; // ESRCH etc -> dead, skip
      }
      candidates.push({ ...data, port });
    } catch {
      // skip unreadable/malformed lock file
    }
  }
  if (candidates.length === 0) return null;
  const match = candidates.find((c) => {
    if (!c.workspace) return false;
    const rel = path.relative(c.workspace, cwd);
    return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
  });
  return match ?? candidates[0];
}

function httpPostJson(port, body, headers) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        path: "/mcp",
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          "Content-Length": Buffer.byteLength(payload),
          ...headers,
        },
      },
      (res) => {
        let raw = "";
        res.on("data", (chunk) => (raw += chunk));
        res.on("end", () =>
          resolve({ status: res.statusCode, headers: res.headers, body: raw }),
        );
      },
    );
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

function parseSseOrJson(raw) {
  const trimmed = raw.trim();
  if (trimmed.startsWith("{")) return JSON.parse(trimmed);
  // text/event-stream: last "data: {...}" line carries the JSON-RPC payload
  const lines = trimmed.split("\n").filter((l) => l.startsWith("data:"));
  const last = lines[lines.length - 1]?.slice(5).trim();
  return JSON.parse(last);
}

function fallbackToVitest() {
  const args = process.argv.slice(2);
  const result = spawnSync("npx", ["vitest", "run", ...args], {
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  process.exit(result.status ?? 1);
}

/** Maps `-t <pattern>` / a bare positional arg to runTests' `filter` (name pattern or file path). */
function extractFilter(argv) {
  const idx = argv.findIndex((a) => a === "-t" || a === "--testNamePattern");
  if (idx !== -1 && argv[idx + 1]) return argv[idx + 1];
  const positional = argv.find((a) => !a.startsWith("-"));
  return positional;
}

async function main() {
  const lock = findBridgeLock();
  if (!lock) {
    fallbackToVitest();
    return;
  }

  const AUTH = { Authorization: `Bearer ${lock.authToken}` };
  try {
    const init = await httpPostJson(
      lock.port,
      {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "test-via-bridge", version: "1" },
        },
      },
      AUTH,
    );
    if (init.status !== 200) throw new Error(`initialize -> ${init.status}`);
    const SESSION_HEADERS = {
      "Mcp-Session-Id": init.headers["mcp-session-id"],
      "Mcp-Session-Token": init.headers["mcp-session-token"],
    };

    await httpPostJson(
      lock.port,
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { ...AUTH, ...SESSION_HEADERS },
    );

    const filter = extractFilter(process.argv.slice(2));
    const call = await httpPostJson(
      lock.port,
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "runTests",
          arguments: { noCache: true, ...(filter ? { filter } : {}) },
        },
      },
      { ...AUTH, ...SESSION_HEADERS },
    );
    if (call.status !== 200) throw new Error(`tools/call -> ${call.status}`);

    const parsed = parseSseOrJson(call.body);
    const structured = parsed?.result?.structuredContent;
    if (!structured) throw new Error("no structuredContent in response");

    const { summary, failures } = structured;
    console.log(
      `[test-via-bridge] ${summary.passed}/${summary.total} passed` +
        (summary.failed ? `, ${summary.failed} failed` : "") +
        (summary.errored ? `, ${summary.errored} errored` : "") +
        ` (${Math.round(summary.durationMs)}ms) — routed through bridge, onTestRun fired`,
    );
    for (const f of failures ?? []) {
      console.log(
        `  FAIL ${f.name}${f.file ? ` (${f.file}:${f.line ?? "?"})` : ""}`,
      );
      if (f.message) console.log(`    ${f.message.split("\n")[0]}`);
    }
    process.exit(summary.failed > 0 || summary.errored > 0 ? 1 : 0);
  } catch (err) {
    console.error(
      `[test-via-bridge] bridge call failed (${err.message}), falling back to direct vitest run`,
    );
    fallbackToVitest();
  }
}

main();
