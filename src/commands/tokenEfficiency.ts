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

// ── bridge health + schema stats via HTTP ─────────────────────────────────────

interface BridgeStats {
  uptimeMs: number;
  activeSessions: number;
  extensionConnected: boolean;
  /** Estimated token cost of the tools/list schema payload. */
  schemaTokenEstimate: number;
}

async function fetchBridgeStats(
  port: number,
  token: string,
): Promise<BridgeStats | null> {
  const auth = { Authorization: `Bearer ${token}` };
  try {
    // /health — server-level stats (unauthenticated on some deploys, auth required here)
    const [healthResp, toolsResp] = await Promise.all([
      fetch(`http://127.0.0.1:${port}/health`, {
        headers: auth,
        signal: AbortSignal.timeout(5_000),
      }),
      // tools/list — use its wire size as the schema token estimate
      fetch(`http://127.0.0.1:${port}/mcp`, {
        method: "POST",
        headers: {
          ...auth,
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
        },
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
      }),
    ]);

    if (!healthResp.ok) return null;
    const health = (await healthResp.json()) as Record<string, unknown>;

    // Derive schema token estimate from tools/list wire size
    let schemaTokenEstimate = 0;
    if (toolsResp.ok) {
      const sessionId = toolsResp.headers.get("mcp-session-id");
      if (sessionId) {
        const sessionHeaders = {
          ...auth,
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
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
          signal: AbortSignal.timeout(3_000),
        });
        // Fetch tools/list and measure payload size
        const listResp = await fetch(`http://127.0.0.1:${port}/mcp`, {
          method: "POST",
          headers: sessionHeaders,
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 2,
            method: "tools/list",
            params: {},
          }),
          signal: AbortSignal.timeout(5_000),
        });
        if (listResp.ok) {
          const raw = await listResp.text();
          schemaTokenEstimate = Math.round(raw.length / 4);
        }
        // Close session
        fetch(`http://127.0.0.1:${port}/mcp`, {
          method: "DELETE",
          headers: { ...auth, "mcp-session-id": sessionId },
          signal: AbortSignal.timeout(2_000),
        }).catch(() => {});
      }
    }

    return {
      uptimeMs: typeof health.uptimeMs === "number" ? health.uptimeMs : 0,
      activeSessions:
        typeof health.activeSessions === "number" ? health.activeSessions : 0,
      extensionConnected: health.extensionConnected === true,
      schemaTokenEstimate,
    };
  } catch {
    return null;
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

  const stats = await fetchBridgeStats(found.port, token);

  if (!stats) {
    console.log(
      `\n  Bridge running on port ${found.port} but could not fetch stats\n`,
    );
    return;
  }

  console.log("\nBridge Status (live)");
  console.log(HR);
  console.log(row("Uptime", formatDuration(stats.uptimeMs)));
  console.log(row("Active Sessions", String(stats.activeSessions)));
  console.log(
    row("Extension", stats.extensionConnected ? "connected" : "disconnected"),
  );
  console.log(
    row(
      "Schema Est.",
      stats.schemaTokenEstimate > 0
        ? `~${stats.schemaTokenEstimate.toLocaleString()} tokens`
        : "unknown",
    ),
  );

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
