/**
 * CC Routines Phase 3 — thin MCP tools for Claude Code Routines API.
 *
 * The `claude routines` subcommand is part of a research preview
 * (API identifier: experimental-cc-routine-2026-04-01) gated on
 * claude.ai accounts. These tools are registered unconditionally so
 * they appear in the MCP handshake and fail gracefully when the API
 * is not yet available on the host account.
 *
 * TODO: ungate when API exits research preview
 */

import { execFile } from "node:child_process";
import { ToolErrorCodes } from "../errors.js";
import { error, successStructured } from "./utils.js";

const UNAVAILABLE_ERROR = {
  error: "cc_routines_unavailable",
  message:
    "Claude Code Routines API not yet available on this account. See https://claude.ai/code/routines",
} as const;

export type RoutinesExecutor = (
  binary: string,
  args: string[],
) => Promise<{ stdout: string }>;

/** Default executor using node:child_process execFile. */
export const defaultExecutor: RoutinesExecutor = (binary, args) =>
  new Promise((resolve, reject) => {
    execFile(
      binary,
      args,
      { timeout: 30_000, env: process.env },
      (err, stdout) => {
        if (err) reject(err);
        else resolve({ stdout });
      },
    );
  });

/** Run `claude routines <args>` and return stdout, or null if unavailable. */
async function runRoutinesCli(
  args: string[],
  claudeBinary: string,
  executor: RoutinesExecutor,
): Promise<{ stdout: string } | { unavailable: true } | { execError: string }> {
  try {
    const { stdout } = await executor(claudeBinary, ["routines", ...args]);
    return { stdout };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    // Detect "unknown command" / "not found" variants that indicate the
    // routines subcommand is not available on this build/account.
    if (
      msg.includes("unknown command") ||
      msg.includes("is not a claude command") ||
      msg.includes("not found") ||
      msg.includes("Unknown argument: routines")
    ) {
      return { unavailable: true };
    }
    return { execError: msg };
  }
}

// ---------------------------------------------------------------------------
// listRoutines
// ---------------------------------------------------------------------------

export function createListRoutinesTool(
  claudeBinary = "claude",
  executor: RoutinesExecutor = defaultExecutor,
) {
  return {
    schema: {
      name: "listRoutines",
      description:
        "List all Claude Code Routines configured on this account. Returns an array of routine summaries including id, name, schedule, lastRun, and status. Requires the CC Routines research-preview feature.",
      annotations: {
        title: "List CC Routines",
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: true,
      },
      inputSchema: {
        type: "object" as const,
        properties: {},
        additionalProperties: false as const,
      },
      outputSchema: {
        type: "object",
        properties: {
          routines: {
            type: "array",
            items: {
              type: "object",
              properties: {
                id: { type: "string" },
                name: { type: "string" },
                schedule: { type: "string" },
                lastRun: { type: "string" },
                status: { type: "string" },
              },
              required: ["id", "name"],
            },
          },
          error: { type: "string" },
          message: { type: "string" },
        },
      },
    },
    handler: async (_args: Record<string, unknown>) => {
      const result = await runRoutinesCli(
        ["list", "--json"],
        claudeBinary,
        executor,
      );

      if ("unavailable" in result) {
        return {
          content: [
            { type: "text" as const, text: JSON.stringify(UNAVAILABLE_ERROR) },
          ],
          isError: true,
        };
      }

      if ("execError" in result) {
        return error(
          `Failed to list routines: ${result.execError}`,
          ToolErrorCodes.EXTERNAL_COMMAND_FAILED,
        );
      }

      try {
        const parsed = JSON.parse(result.stdout.trim() || "[]");
        const routines = Array.isArray(parsed)
          ? parsed
          : (parsed.routines ?? []);
        return successStructured({ routines });
      } catch {
        // Non-JSON output — surface as raw text in a best-effort parse
        const lines = result.stdout.trim().split("\n").filter(Boolean);
        const routines = lines.map((line, i) => ({
          id: String(i),
          name: line,
        }));
        return successStructured({ routines });
      }
    },
  };
}

// ---------------------------------------------------------------------------
// runRoutine
// ---------------------------------------------------------------------------

export function createRunRoutineTool(
  claudeBinary = "claude",
  executor: RoutinesExecutor = defaultExecutor,
) {
  return {
    schema: {
      name: "runRoutine",
      description:
        "Trigger a Claude Code Routine by ID. Optionally pass an input JSON string. Returns a taskId and initial status. Requires the CC Routines research-preview feature.",
      annotations: {
        title: "Run CC Routine",
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: true,
      },
      inputSchema: {
        type: "object" as const,
        properties: {
          id: {
            type: "string",
            description: "Routine ID to run.",
          },
          input: {
            type: "string",
            description:
              "Optional JSON string passed as --input to the routine.",
          },
        },
        required: ["id"] as const,
        additionalProperties: false as const,
      },
      outputSchema: {
        type: "object",
        properties: {
          taskId: { type: "string" },
          status: { type: "string" },
          error: { type: "string" },
          message: { type: "string" },
        },
      },
    },
    handler: async (args: Record<string, unknown>) => {
      const id = args.id;
      if (typeof id !== "string" || id.trim() === "") {
        return error(
          "id must be a non-empty string",
          ToolErrorCodes.INVALID_ARGS,
        );
      }

      const cliArgs = ["run", id.trim(), "--json"];
      if (typeof args.input === "string" && args.input.trim() !== "") {
        cliArgs.push("--input", args.input.trim());
      }

      const result = await runRoutinesCli(cliArgs, claudeBinary, executor);

      if ("unavailable" in result) {
        return {
          content: [
            { type: "text" as const, text: JSON.stringify(UNAVAILABLE_ERROR) },
          ],
          isError: true,
        };
      }

      if ("execError" in result) {
        return error(
          `Failed to run routine: ${result.execError}`,
          ToolErrorCodes.EXTERNAL_COMMAND_FAILED,
        );
      }

      try {
        const parsed = JSON.parse(result.stdout.trim() || "{}");
        return successStructured({
          taskId: parsed.taskId ?? parsed.id ?? id,
          status: parsed.status ?? "running",
        });
      } catch {
        return successStructured({ taskId: id, status: "running" });
      }
    },
  };
}

// ---------------------------------------------------------------------------
// getRoutineStatus
// ---------------------------------------------------------------------------

export function createGetRoutineStatusTool(
  claudeBinary = "claude",
  executor: RoutinesExecutor = defaultExecutor,
) {
  return {
    schema: {
      name: "getRoutineStatus",
      description:
        "Get the current status, last run time, next scheduled run, and most recent output for a Claude Code Routine. Requires the CC Routines research-preview feature.",
      annotations: {
        title: "Get CC Routine Status",
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: true,
      },
      inputSchema: {
        type: "object" as const,
        properties: {
          id: {
            type: "string",
            description: "Routine ID to query.",
          },
        },
        required: ["id"] as const,
        additionalProperties: false as const,
      },
      outputSchema: {
        type: "object",
        properties: {
          id: { type: "string" },
          status: { type: "string" },
          lastRun: { type: "string" },
          nextRun: { type: "string" },
          output: { type: "string" },
          error: { type: "string" },
          message: { type: "string" },
        },
      },
    },
    handler: async (args: Record<string, unknown>) => {
      const id = args.id;
      if (typeof id !== "string" || id.trim() === "") {
        return error(
          "id must be a non-empty string",
          ToolErrorCodes.INVALID_ARGS,
        );
      }

      const result = await runRoutinesCli(
        ["status", id.trim(), "--json"],
        claudeBinary,
        executor,
      );

      if ("unavailable" in result) {
        return {
          content: [
            { type: "text" as const, text: JSON.stringify(UNAVAILABLE_ERROR) },
          ],
          isError: true,
        };
      }

      if ("execError" in result) {
        return error(
          `Failed to get routine status: ${result.execError}`,
          ToolErrorCodes.EXTERNAL_COMMAND_FAILED,
        );
      }

      try {
        const parsed = JSON.parse(result.stdout.trim() || "{}");
        return successStructured({
          id: parsed.id ?? id.trim(),
          status: parsed.status ?? "unknown",
          lastRun: parsed.lastRun ?? parsed.last_run ?? undefined,
          nextRun: parsed.nextRun ?? parsed.next_run ?? undefined,
          output: parsed.output ?? undefined,
        });
      } catch {
        return successStructured({ id: id.trim(), status: "unknown" });
      }
    },
  };
}
