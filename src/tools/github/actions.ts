import {
  error,
  execSafe,
  optionalBool,
  optionalInt,
  optionalString,
  success,
} from "../utils.js";
import {
  GH_NOT_AUTHED,
  GH_NOT_FOUND,
  isNotAuthed,
  isNotFound,
} from "./shared.js";

const MAX_RUN_LOG_BYTES = 100 * 1024; // 100 KB — gh run logs can be enormous

export function createGithubListRunsTool(workspace: string) {
  return {
    schema: {
      name: "githubListRuns",
      description:
        "List GitHub Actions workflow runs for the current repository using the GitHub CLI (gh). " +
        "Use this to check CI status after a push or PR. The run ID (databaseId) can be passed to " +
        "githubGetRunLogs to retrieve failure details. Requires gh to be installed and authenticated.",
      annotations: { readOnlyHint: true },
      inputSchema: {
        type: "object" as const,
        properties: {
          branch: {
            type: "string",
            description:
              "Filter by branch name. Omit to see runs across all branches.",
          },
          workflow: {
            type: "string",
            description:
              "Filter by workflow file name (e.g. 'ci.yml') or workflow name",
          },
          status: {
            type: "string",
            description:
              "Filter by run status: queued, in_progress, completed, failure, success, cancelled. " +
              "Omit to see all statuses.",
          },
          limit: {
            type: "integer",
            description:
              "Maximum number of runs to return (default: 10, max: 50)",
          },
        },
        additionalProperties: false as const,
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

      return success({ runs, count: Array.isArray(runs) ? runs.length : 0 });
    },
  };
}

export function createGithubGetRunLogsTool(workspace: string) {
  return {
    schema: {
      name: "githubGetRunLogs",
      description:
        "Get logs from a GitHub Actions workflow run using the GitHub CLI (gh). " +
        "By default returns only the failed steps' logs (most useful for diagnosing CI failures). " +
        "Pass the databaseId from githubListRuns as the runId. " +
        "Requires gh to be installed and authenticated.",
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
        `--log${failedOnly ? "-failed" : ""}`,
      ];

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
          return success({
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

      return success({
        runId,
        failedOnly,
        logs,
        truncated: truncated || undefined,
      });
    },
  };
}
