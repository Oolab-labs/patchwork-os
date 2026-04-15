/**
 * `claude-ide-bridge token-efficiency` CLI subcommand.
 *
 * Subcommands:
 *   status        — show current config + live session usage (default)
 *   benchmark     — run scripts/benchmark.mjs with forwarded args
 */

import { spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfigFile } from "../config.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── helpers ───────────────────────────────────────────────────────────────────

function formatDuration(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

function row(label: string, value: string): string {
  return `  ${label.padEnd(20)} ${value}`;
}

const HR = "─".repeat(42);

// ── lockfile discovery (same pattern as notify/print-token) ───────────────────

interface LockFileData {
  authToken?: string;
  pid?: number;
  workspace?: string;
}

function findActiveLockFile(
  lockDir: string,
): { lockFile: string; port: number } | null {
  let bestMtime = 0;
  let lockFile: string | undefined;
  let port: number | undefined;
  try {
    for (const f of readdirSync(lockDir)) {
      if (!f.endsWith(".lock")) continue;
      const p = Number(path.basename(f, ".lock"));
      if (!Number.isFinite(p) || p <= 0) continue;
      const full = path.join(lockDir, f);
      const mtime = statSync(full).mtimeMs;
      if (mtime > bestMtime) {
        bestMtime = mtime;
        lockFile = full;
        port = p;
      }
    }
  } catch {
    // lock dir doesn't exist
  }
  if (!lockFile || !port) return null;
  return { lockFile, port };
}

// ── getSessionUsage via HTTP MCP JSON-RPC ─────────────────────────────────────

interface SessionUsageResult {
  callCount: number;
  errorCount: number;
  schemaTokenEstimate: number | null;
  cacheWarmed: boolean;
  largestResults: Array<{ tool: string; sizeChars: number }>;
  sessionDurationMs: number;
}

async function fetchSessionUsage(
  port: number,
  token: string,
): Promise<SessionUsageResult | null> {
  let sessionId: string | null = null;
  const baseHeaders = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
  };

  try {
    // Initiate HTTP MCP session
    const initResp = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST",
      headers: baseHeaders,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "token-efficiency-cli", version: "1.0.0" },
        },
      }),
      signal: AbortSignal.timeout(5_000),
    });

    if (!initResp.ok) return null;

    sessionId = initResp.headers.get("mcp-session-id");
    if (!sessionId) return null;

    const sessionHeaders: Record<string, string> = {
      ...baseHeaders,
      "mcp-session-id": sessionId,
    };

    // Send initialized notification
    await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST",
      headers: sessionHeaders,
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "notifications/initialized",
        params: {},
      }),
      signal: AbortSignal.timeout(5_000),
    });

    // Call getSessionUsage tool
    const toolResp = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST",
      headers: sessionHeaders,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "getSessionUsage", arguments: {} },
      }),
      signal: AbortSignal.timeout(5_000),
    });

    if (!toolResp.ok) return null;

    // Handle SSE or JSON response
    const contentType = toolResp.headers.get("content-type") ?? "";
    let rpcResult: unknown;

    if (contentType.includes("text/event-stream")) {
      const text = await toolResp.text();
      // Parse SSE lines — skip notification frames (no `result` key), take first response
      for (const line of text.split("\n")) {
        if (line.startsWith("data: ")) {
          try {
            const parsed = JSON.parse(line.slice(6)) as Record<string, unknown>;
            if ("result" in parsed) {
              rpcResult = parsed;
              break;
            }
          } catch {
            // skip malformed lines
          }
        }
      }
    } else {
      rpcResult = await toolResp.json();
    }

    if (!rpcResult || typeof rpcResult !== "object") return null;

    const result = rpcResult as {
      result?: { content?: Array<{ type: string; text?: string }> };
    };

    const content = result.result?.content;
    if (!Array.isArray(content)) return null;

    for (const block of content) {
      if (block.type === "text" && block.text) {
        try {
          const parsed = JSON.parse(block.text) as Record<string, unknown>;
          // Guard against isError blocks or missing required field
          if (typeof parsed.callCount !== "number") continue;
          return parsed as unknown as SessionUsageResult;
        } catch {
          // skip
        }
      }
    }

    return null;
  } catch {
    return null;
  } finally {
    // Always close the MCP session to avoid leaking a session slot
    if (sessionId) {
      fetch(`http://127.0.0.1:${port}/mcp`, {
        method: "DELETE",
        headers: {
          Authorization: `Bearer ${token}`,
          "mcp-session-id": sessionId,
        },
        signal: AbortSignal.timeout(2_000),
      }).catch(() => {
        // best-effort cleanup — ignore errors
      });
    }
  }
}

// ── status command ─────────────────────────────────────────────────────────────

export async function tokenEfficiencyStatus(
  configPath?: string,
): Promise<void> {
  const fileConfig = loadConfigFile(configPath);

  const lspVerbosity = fileConfig.lspVerbosity ?? "normal";

  console.log("\nToken Efficiency Status");
  console.log(HR);
  console.log(row("LSP Verbosity", lspVerbosity));

  // Discover lock file
  const lockDir = path.join(
    process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), ".claude"),
    "ide",
  );

  const found = findActiveLockFile(lockDir);

  if (!found) {
    console.log("\n  Bridge not running — session usage unavailable\n");
    return;
  }

  let token: string;
  try {
    const data = JSON.parse(
      readFileSync(found.lockFile, "utf-8"),
    ) as LockFileData;
    if (!data.authToken) {
      console.log(
        "\n  Bridge lock file missing authToken — cannot query usage\n",
      );
      return;
    }
    token = data.authToken;
  } catch {
    console.log("\n  Could not read bridge lock file\n");
    return;
  }

  const usage = await fetchSessionUsage(found.port, token);

  if (!usage) {
    console.log(
      `\n  Bridge running on port ${found.port} but could not fetch session usage\n`,
    );
    return;
  }

  console.log("\nSession Usage (live)");
  console.log(HR);
  console.log(row("Call Count", String(usage.callCount)));
  console.log(row("Error Count", String(usage.errorCount)));
  console.log(
    row(
      "Schema Est.",
      usage.schemaTokenEstimate !== null
        ? `~${usage.schemaTokenEstimate.toLocaleString()} tokens`
        : "unknown",
    ),
  );
  console.log(row("Cache Warm", usage.cacheWarmed ? "yes" : "no"));
  console.log(row("Session Duration", formatDuration(usage.sessionDurationMs)));

  if (usage.largestResults.length > 0) {
    console.log("\n  Top tool results by size:");
    for (const r of usage.largestResults.slice(0, 5)) {
      console.log(
        `    ${r.tool.padEnd(22)} ${r.sizeChars.toLocaleString()} chars`,
      );
    }
  }

  console.log();
}

// ── benchmark command ──────────────────────────────────────────────────────────

export async function tokenEfficiencyBenchmark(args: string[]): Promise<void> {
  // Resolve scripts/benchmark.mjs relative to the package root
  // __dirname is dist/commands/ at runtime, so go up two levels to package root
  const packageRoot = path.resolve(__dirname, "..", "..");
  const benchmarkScript = path.join(packageRoot, "scripts", "benchmark.mjs");

  if (!existsSync(benchmarkScript)) {
    process.stderr.write(
      `Error: benchmark script not found at ${benchmarkScript}\n`,
    );
    process.exit(1);
  }

  await new Promise<void>((resolve, reject) => {
    const child = spawn("node", [benchmarkScript, ...args], {
      stdio: "inherit",
    });
    child.on("error", reject);
    child.on("close", (code) => {
      process.exitCode = code ?? 0;
      resolve();
    });
  });
}
