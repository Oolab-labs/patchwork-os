/**
 * Headless parity CLI subcommands — start-task, quick-task, continue-handoff.
 *
 * All three POST to the local bridge's HTTP endpoints using the auth token
 * from the lock file (same discovery pattern as `notify`). Sidebar + CLI + MCP
 * share the same preset module (src/quickTaskPresets.ts), so behaviour is
 * identical across surfaces.
 */

import { readFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  findBridgeLock,
  type LockDiscoveryDeps,
} from "../bridgeLockDiscovery.js";
import { QUICK_TASK_PRESET_IDS } from "../quickTaskPresets.js";

interface LockInfo {
  port: number;
  authToken: string;
}

function defaultLockDir(): string {
  return path.join(
    process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), ".claude"),
    "ide",
  );
}

function defaultIsLive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve the running bridge to dispatch a task to.
 *
 * Auto-discovery delegates to the shared `findBridgeLock()` primitive
 * (filters `isBridge:true` + live PID) — the same one used by `recipe run`,
 * `halts`, `judgments`, and `kill-switch`. The previous local implementation
 * picked the most recently MODIFIED `*.lock` with NO isBridge filter and NO
 * liveness check, so it could select an IDE-owned lock or a dead bridge and
 * POST a Bearer token to the wrong port.
 *
 * For an explicit `--port` override we read that single lock and verify it is
 * a live `isBridge:true` lock before returning — same guarantees as the
 * auto-discovery path. Returns `null` (rather than process.exit) so callers
 * can attach their own usage messaging; the `findLock()` wrapper below handles
 * the exit-on-failure behaviour the CLI surfaces expect.
 *
 * `deps` is a test-injection seam (temp dir + synthetic `isLive`).
 */
export function findBridgeLockForTask(
  overridePort?: number,
  deps: LockDiscoveryDeps = {},
): LockInfo | null {
  const lockDir = deps.lockDir ?? defaultLockDir();
  const isLive = deps.isLive ?? defaultIsLive;

  if (overridePort !== undefined) {
    const lockFile = path.join(lockDir, `${overridePort}.lock`);
    try {
      const parsed = JSON.parse(readFileSync(lockFile, "utf-8")) as {
        pid?: number;
        authToken?: string;
        isBridge?: boolean;
      };
      // Same gate as findBridgeLock: must be a live bridge, not an IDE lock.
      if (!parsed.isBridge) return null;
      if (!parsed.pid || !isLive(parsed.pid)) return null;
      if (!parsed.authToken) return null;
      return { port: overridePort, authToken: parsed.authToken };
    } catch {
      return null;
    }
  }

  const found = findBridgeLock({ lockDir, isLive });
  if (!found?.authToken) return null;
  return { port: found.port, authToken: found.authToken };
}

function findLock(overridePort?: number): LockInfo {
  const lock = findBridgeLockForTask(overridePort);
  if (lock) return lock;

  if (overridePort !== undefined) {
    process.stderr.write(
      `Error: No live bridge lock for port ${overridePort} ` +
        "(missing, IDE-owned, or dead process).\n",
    );
    process.exit(1);
  }
  process.stderr.write(
    `Error: No live bridge found in ${defaultLockDir()}\n` +
      "Start the bridge first: claude-ide-bridge --watch --full --driver subprocess\n",
  );
  process.exit(1);
}

interface QuickTaskResponse {
  ok: boolean;
  error?: string;
  code?: string;
  result?: {
    taskId?: string;
    presetId?: string;
    status?: string;
    resumed?: boolean;
    startedAt?: number;
  };
}

interface ParsedArgs {
  positional: string[];
  json: boolean;
  port?: number;
  source?: string;
}

function parseArgs(argv: string[]): ParsedArgs {
  const out: ParsedArgs = { positional: [], json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--json") out.json = true;
    else if (a === "--port") {
      const next = argv[++i];
      if (next) out.port = Number(next);
    } else if (a === "--source") {
      const next = argv[++i];
      if (next) out.source = next;
    } else if (a === "--help" || a === "-h") {
      out.positional.push("--help");
    } else if (a && !a.startsWith("--")) {
      out.positional.push(a);
    }
  }
  return out;
}

function usageQuickTask(): never {
  process.stderr.write(
    `Usage: claude-ide-bridge quick-task <preset> [--json] [--port N] [--source NAME]\n\n` +
      `Presets: ${QUICK_TASK_PRESET_IDS.join(", ")}\n\n` +
      "Runs a context-aware Claude task using the same preset logic as the VS Code sidebar.\n" +
      "Requires bridge running with --driver subprocess.\n",
  );
  process.exit(2);
}

function usageStartTask(): never {
  process.stderr.write(
    `Usage: claude-ide-bridge start-task "<description>" [--json] [--port N]\n\n` +
      "Enqueues a Claude task with the given description, merging workspace context\n" +
      "(active file, errors, last commit) and any existing handoff note.\n",
  );
  process.exit(2);
}

function printQuickTaskResult(
  res: QuickTaskResponse,
  httpStatus: number,
  json: boolean,
): void {
  if (json) {
    process.stdout.write(`${JSON.stringify({ httpStatus, ...res })}\n`);
    return;
  }
  if (!res.ok) {
    process.stderr.write(
      `Error${res.code ? ` (${res.code})` : ""}: ${res.error ?? "unknown"}\n`,
    );
    return;
  }
  const r = res.result ?? {};
  process.stdout.write(
    `Task started: ${r.taskId ?? "unknown"}\n` +
      `  Preset:  ${r.presetId ?? "?"}\n` +
      `  Status:  ${r.status ?? "?"}\n` +
      (r.resumed ? `  Resumed: yes\n` : ""),
  );
}

/** `claude-ide-bridge quick-task <preset> [--json] [--port N] [--source NAME]` */
export async function runQuickTask(argv: string[]): Promise<void> {
  const parsed = parseArgs(argv);
  if (parsed.positional[0] === "--help" || parsed.positional.length === 0) {
    usageQuickTask();
  }
  const presetId = parsed.positional[0] ?? "";
  if (!(QUICK_TASK_PRESET_IDS as readonly string[]).includes(presetId)) {
    process.stderr.write(
      `Unknown preset "${presetId}".\nValid: ${QUICK_TASK_PRESET_IDS.join(", ")}\n`,
    );
    process.exit(2);
  }
  const lock = findLock(parsed.port);
  const resp = await fetch(`http://127.0.0.1:${lock.port}/launch-quick-task`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${lock.authToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ presetId, source: parsed.source ?? "cli" }),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await resp.text();
  let body: QuickTaskResponse;
  try {
    body = text ? (JSON.parse(text) as QuickTaskResponse) : { ok: false };
  } catch {
    body = { ok: false, error: text };
  }
  printQuickTaskResult(body, resp.status, parsed.json);
  process.exit(body.ok ? 0 : 1);
}

/**
 * Dispatch runClaudeTask via the MCP streamable HTTP transport.
 * Mirrors the pattern used by the VS Code sidebar's _callBridgeTool so that
 * all three surfaces (sidebar, CLI, MCP) use the same dispatch path.
 */
async function callRunClaudeTask(
  lock: LockInfo,
  prompt: string,
): Promise<{ taskId?: string; status?: string; raw?: string }> {
  const url = `http://127.0.0.1:${lock.port}/mcp`;
  const baseHeaders = {
    Authorization: `Bearer ${lock.authToken}`,
    "Content-Type": "application/json",
  };

  // Step 1: initialize — obtain session id.
  const initResp = await fetch(url, {
    method: "POST",
    headers: baseHeaders,
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "claude-ide-bridge-cli", version: "1.0" },
      },
    }),
    signal: AbortSignal.timeout(10_000),
  });
  const sessionId = initResp.headers.get("mcp-session-id");
  await initResp.text();
  if (!sessionId) {
    throw new Error("Bridge did not return MCP session id");
  }

  const sessionHeaders = { ...baseHeaders, "mcp-session-id": sessionId };

  try {
    // Step 2: initialized notification.
    await fetch(url, {
      method: "POST",
      headers: sessionHeaders,
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "notifications/initialized",
      }),
      signal: AbortSignal.timeout(5_000),
    });

    // Step 3: tools/call.
    const callResp = await fetch(url, {
      method: "POST",
      headers: sessionHeaders,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "runClaudeTask", arguments: { prompt } },
      }),
      signal: AbortSignal.timeout(30_000),
    });
    const raw = await callResp.text();
    // Response is either SSE (data: <json>\n\n) or raw JSON depending on Accept header.
    const dataLine = raw
      .split("\n")
      .filter((l) => l.startsWith("data:"))
      .pop();
    const jsonStr = dataLine ? dataLine.slice(5).trim() : raw.trim();
    try {
      const parsed = JSON.parse(jsonStr) as {
        result?: {
          structuredContent?: { taskId?: string; status?: string };
          isError?: boolean;
          content?: Array<{ text?: string }>;
        };
      };
      const sc = parsed.result?.structuredContent;
      if (sc?.taskId) {
        return { taskId: sc.taskId, status: sc.status };
      }
      return { raw: raw.slice(0, 500) };
    } catch {
      return { raw: raw.slice(0, 500) };
    }
  } finally {
    // Step 4: release session slot — always runs to prevent leak.
    await fetch(url, {
      method: "DELETE",
      headers: sessionHeaders,
      signal: AbortSignal.timeout(3_000),
    }).catch(() => {});
  }
}

/** `claude-ide-bridge start-task "<description>" [--json] [--port N]` */
export async function runStartTask(argv: string[]): Promise<void> {
  const parsed = parseArgs(argv);
  if (parsed.positional[0] === "--help" || parsed.positional.length === 0) {
    usageStartTask();
  }
  const description = parsed.positional.join(" ").trim();
  if (!description) usageStartTask();

  const lock = findLock(parsed.port);
  // Let Claude call getProjectContext + getHandoffNote itself — keeps this
  // path simple and avoids duplicating prompt-building in the CLI.
  const prompt =
    "Use getProjectContext and getHandoffNote (if present) to understand current workspace state, " +
    `then: ${description}`;

  try {
    const result = await callRunClaudeTask(lock, prompt);
    if (parsed.json) {
      process.stdout.write(
        `${JSON.stringify({ ok: Boolean(result.taskId), result })}\n`,
      );
    } else if (result.taskId) {
      process.stdout.write(
        `Task started: ${result.taskId}\n  Status: ${result.status ?? "?"}\n`,
      );
    } else {
      process.stderr.write(
        `Error: Bridge did not return taskId. Raw: ${result.raw ?? "(empty)"}\n`,
      );
      process.exit(1);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (parsed.json) {
      process.stdout.write(`${JSON.stringify({ ok: false, error: msg })}\n`);
    } else {
      process.stderr.write(`Error: ${msg}\n`);
    }
    process.exit(1);
  }
  process.exit(0);
}

/** `claude-ide-bridge continue-handoff [--json] [--port N]` */
export async function runContinueHandoff(argv: string[]): Promise<void> {
  const parsed = parseArgs(argv);
  if (parsed.positional[0] === "--help") {
    process.stderr.write(
      "Usage: claude-ide-bridge continue-handoff [--json] [--port N]\n\n" +
        "Resumes prior session using the stored handoff note. No-op if the note\n" +
        "looks like an auto-snapshot (bridge metadata rather than user context).\n",
    );
    process.exit(0);
  }
  // Reuse start-task flow. Claude will detect and handle auto-snapshots itself.
  const description =
    "Retrieve the handoff note via getHandoffNote. If it starts with [auto-snapshot, " +
    "greet the user with a fresh session summary (current workspace state, open files, " +
    "any diagnostics) instead. Otherwise, continue from where the prior session left off.";
  const teArgv = [description, ...(parsed.json ? ["--json"] : [])];
  if (parsed.port !== undefined) {
    teArgv.push("--port", String(parsed.port));
  }
  await runStartTask(teArgv);
}
