import type { ChildProcess, SpawnOptions } from "node:child_process";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import type { ToolResult } from "../fp/result.js";
import { err, okS, toCallToolResult } from "../fp/result.js";

export interface SpawnWorkspaceResult {
  pid: number;
  port: number;
  workspace: string;
  authToken: string;
  lockFile: string;
}

interface LockFileContents {
  pid: number;
  workspace: string;
  authToken: string;
  isBridge: boolean;
  port?: number;
}

export type SpawnFn = (
  cmd: string,
  args: string[],
  opts: SpawnOptions,
) => Pick<ChildProcess, "pid" | "unref">;

function getLockDir(): string {
  const configDir =
    process.env.CLAUDE_CONFIG_DIR || path.join(homedir(), ".claude");
  return path.join(configDir, "ide");
}

async function findLockForPid(
  lockDir: string,
  pid: number,
): Promise<{ lockFile: string; data: LockFileContents } | null> {
  let entries: string[];
  try {
    entries = await fs.readdir(lockDir);
  } catch {
    return null;
  }

  for (const entry of entries) {
    if (!entry.endsWith(".lock")) continue;
    const lockPath = path.join(lockDir, entry);
    try {
      const raw = await fs.readFile(lockPath, "utf-8");
      const data = JSON.parse(raw) as LockFileContents;
      if (data.pid === pid && data.isBridge === true) {
        return { lockFile: lockPath, data };
      }
    } catch {
      // skip unreadable / non-JSON files
    }
  }
  return null;
}

export function createSpawnWorkspaceTool(spawnFn: SpawnFn = spawn) {
  return {
    schema: {
      name: "spawnWorkspace",
      description:
        "Spawn a new claude-ide-bridge process for a workspace directory. Returns connection info (pid, port, authToken) once the lock file appears.",
      inputSchema: {
        type: "object" as const,
        properties: {
          path: {
            type: "string",
            description: "Absolute path to the workspace directory to open",
          },
          port: {
            type: "integer",
            description:
              "Port for the spawned bridge (optional; picks a free port if omitted)",
          },
          timeoutMs: {
            type: "integer",
            description:
              "Max ms to wait for bridge lock file to appear (default: 30000)",
          },
          token: {
            type: "string",
            description: "Fixed auth token for the spawned bridge (optional)",
          },
        },
        required: ["path"],
        additionalProperties: false as const,
      },
      outputSchema: {
        type: "object",
        properties: {
          pid: { type: "number" },
          port: { type: "number" },
          workspace: { type: "string" },
          authToken: { type: "string" },
          lockFile: { type: "string" },
        },
        required: ["pid", "port", "workspace", "authToken", "lockFile"],
      },
    },
    handler: async (args: Record<string, unknown>) => {
      return toCallToolResult(await spawnWorkspace(args, spawnFn));
    },
  };
}

async function spawnWorkspace(
  args: Record<string, unknown>,
  spawnFn: SpawnFn,
): Promise<ToolResult<SpawnWorkspaceResult>> {
  const rawPath = args.path;
  if (typeof rawPath !== "string" || rawPath.trim() === "") {
    return err("invalid_arg", "path must be a non-empty string");
  }
  if (rawPath.includes("\x00")) {
    return err("invalid_arg", "path must not contain null bytes");
  }
  const workspacePath = path.resolve(rawPath);

  const timeoutMs =
    typeof args.timeoutMs === "number" && args.timeoutMs > 0
      ? args.timeoutMs
      : 30_000;

  const portArg =
    typeof args.port === "number" && Number.isInteger(args.port)
      ? args.port
      : undefined;

  const tokenArg =
    typeof args.token === "string" && args.token.length > 0
      ? args.token
      : undefined;

  // Locate the bridge entry point: dist/index.js (one dir above this file)
  const bridgeBin = path.resolve(
    new URL(".", import.meta.url).pathname,
    "..",
    "index.js",
  );

  const spawnArgs: string[] = [bridgeBin, "--workspace", workspacePath];
  if (portArg !== undefined) {
    spawnArgs.push("--port", String(portArg));
  }
  if (tokenArg !== undefined) {
    spawnArgs.push("--fixed-token", tokenArg);
  }

  let child: Pick<ChildProcess, "pid" | "unref">;
  try {
    child = spawnFn(process.execPath, spawnArgs, {
      detached: true,
      stdio: "ignore",
    });
  } catch (e) {
    return err(
      "exec_failed",
      `Failed to spawn bridge: ${e instanceof Error ? e.message : String(e)}`,
    );
  }

  if (child.pid === undefined) {
    return err("exec_failed", "Failed to spawn bridge: no PID assigned");
  }

  // Let the child survive past parent exit
  child.unref();

  const pid = child.pid;
  const lockDir = getLockDir();
  const deadline = Date.now() + timeoutMs;
  const pollInterval = 500;

  while (Date.now() < deadline) {
    const found = await findLockForPid(lockDir, pid);
    if (found !== null) {
      const port = found.data.port ?? portArg ?? 0;
      return okS<SpawnWorkspaceResult>({
        pid,
        port,
        workspace: found.data.workspace,
        authToken: found.data.authToken,
        lockFile: found.lockFile,
      });
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await new Promise<void>((resolve) =>
      setTimeout(resolve, Math.min(pollInterval, remaining)),
    );
  }

  // Timed out — kill the child
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    // ignore — already exited
  }

  return err(
    "timeout",
    `Bridge did not write lock file within ${timeoutMs}ms (pid=${pid}, workspace=${workspacePath})`,
  );
}
