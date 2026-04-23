import {
  error,
  execSafe,
  optionalBool,
  optionalInt,
  optionalString,
  successStructured,
  successStructuredLarge,
} from "../utils.js";
import {
  GH_NOT_AUTHED,
  GH_NOT_FOUND,
  isNotAuthed,
  isNotFound,
} from "./shared.js";

const MAX_RUN_LOG_BYTES = 100 * 1024; // 100 KB — gh run logs can be enormous

export function createGithubListRunsTool(
  workspace: string,
  defaultRepo: string | null = null,
) {
  return {
    schema: {
      name: "githubListRuns",
      description:
        "[Deprecated: use githubActions instead] " +
        "List GitHub Actions workflow runs. Use to check CI status after a push. " +
        "Pass the run ID (databaseId) to githubGetRunLogs to retrieve failure details.",
      annotations: { readOnlyHint: true },
      inputSchema: {
        type: "object" as const,
        properties: {
          branch: {
            type: "string",
            description: "Filter by branch name. Omit for all branches.",
          },
          workflow: {
            type: "string",
            description:
              "Filter by workflow file name (e.g. 'ci.yml') or workflow name",
          },
          status: {
            type: "string",
            description:
              "Filter by status: queued/in_progress/completed/failure/success/cancelled. Omit for all.",
          },
          limit: {
            type: "integer",
            description: "Max runs to return (default: 10, max: 50)",
          },
        },
        additionalProperties: false as const,
      },
      outputSchema: {
        type: "object",
        properties: {
          runs: {
            type: "array",
            items: {
              type: "object",
              properties: {
                databaseId: { type: "integer" },
                name: { type: "string" },
                status: { type: "string" },
                conclusion: { type: ["string", "null"] },
                headBranch: { type: "string" },
                headSha: { type: "string" },
                url: { type: "string" },
                createdAt: { type: "string" },
                updatedAt: { type: "string" },
                workflowName: { type: "string" },
                event: { type: "string" },
              },
            },
          },
          count: { type: "integer" },
        },
        required: ["runs", "count"],
      },
    },
    handler: async (args: Record<string, unknown>, signal?: AbortSignal) => {
      const branch = optionalString(args, "branch", 256);
      const workflow = optionalString(args, "workflow", 256);
      const status = optionalString(args, "status", 64);
      const limit = optionalInt(args, "limit", 1, 50) ?? 10;

      const listArgs = [
        "run",
        "list",
        "--limit",
        String(limit),
        "--json",
        "databaseId,name,status,conclusion,headBranch,headSha,url,createdAt,updatedAt,workflowName,event",
      ];
      if (branch) listArgs.push("--branch", branch);
      if (workflow) listArgs.push("--workflow", workflow);
      if (status) listArgs.push("--status", status);
      if (defaultRepo) listArgs.push("--repo", defaultRepo);

      const result = await execSafe("gh", listArgs, {
        cwd: workspace,
        signal,
        timeout: 30_000,
      });

      if (result.exitCode !== 0) {
        const msg = result.stderr.trim() || result.stdout.trim();
        if (isNotFound(msg)) return error(GH_NOT_FOUND);
        if (isNotAuthed(msg)) return error(GH_NOT_AUTHED);
        return error(`gh run list failed: ${msg}`);
      }

      let runs: unknown;
      try {
        runs = JSON.parse(result.stdout.trim());
      } catch {
        return error(`Failed to parse gh output: ${result.stdout.trim()}`);
      }

      return successStructured({
        runs,
        count: Array.isArray(runs) ? runs.length : 0,
      });
    },
  };
}

export function createGithubGetRunLogsTool(
  workspace: string,
  defaultRepo: string | null = null,
) {
  return {
    schema: {
      name: "githubGetRunLogs",
      description:
        "[Deprecated: use githubActions instead] " +
        "Get logs from a GitHub Actions workflow run. By default returns only the failed steps' logs. " +
        "Pass the databaseId from githubListRuns as the runId.",
      annotations: { readOnlyHint: true },
      inputSchema: {
        type: "object" as const,
        required: ["runId"],
        properties: {
          runId: {
            type: "integer",
            description: "Workflow run ID (databaseId from githubListRuns)",
          },
          failedOnly: {
            type: "boolean",
            description:
              "Return only logs from failed steps (default: true). Set false for full logs.",
          },
        },
        additionalProperties: false as const,
      },
      outputSchema: {
        type: "object",
        properties: {
          runId: { type: "integer" },
          failedOnly: { type: "boolean" },
          logs: { type: "string" },
          truncated: { type: "boolean" },
          note: { type: "string" },
        },
        required: ["logs"],
      },
    },
    handler: async (args: Record<string, unknown>, signal?: AbortSignal) => {
      const runId =
        typeof args.runId === "number" ? Math.floor(args.runId) : undefined;
      if (!runId || runId < 1) return error("runId must be a positive integer");
      const failedOnly = optionalBool(args, "failedOnly") ?? true;

      const viewArgs = [
        "run",
        "view",
        String(runId),
        failedOnly ? "--log-failed" : "--log",
      ];
      if (defaultRepo) viewArgs.push("--repo", defaultRepo);

      const result = await execSafe("gh", viewArgs, {
        cwd: workspace,
        signal,
        timeout: 60_000,
      });

      if (result.exitCode !== 0) {
        const msg = result.stderr.trim() || result.stdout.trim();
        if (isNotFound(msg)) return error(GH_NOT_FOUND);
        if (isNotAuthed(msg)) return error(GH_NOT_AUTHED);
        if (msg.includes("no failed") || msg.includes("no logs")) {
          return successStructured({
            logs: "",
            note: "No failed step logs found — the run may have succeeded or logs may have expired.",
          });
        }
        if (msg.includes("Could not find") || msg.includes("not found")) {
          return error(`Run #${runId} not found.`);
        }
        if (msg.includes("in progress") || msg.includes("still running")) {
          return error(
            `Run #${runId} is still in progress. Wait for it to complete before fetching logs.`,
          );
        }
        return error(`gh run view failed: ${msg}`);
      }

      let logs = result.stdout;
      let truncated = false;
      if (Buffer.byteLength(logs, "utf8") > MAX_RUN_LOG_BYTES) {
        logs = `...[truncated — showing last portion]\n${logs.slice(-MAX_RUN_LOG_BYTES)}`;
        truncated = true;
      }

      return successStructuredLarge({
        runId,
        failedOnly,
        logs,
        truncated: truncated || undefined,
      });
    },
  };
}
