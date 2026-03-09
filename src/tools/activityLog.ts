import type { ActivityLog } from "../activityLog.js";
import { optionalBool, optionalString, optionalInt, success } from "./utils.js";

export function createGetActivityLogTool(activityLog: ActivityLog) {
  return {
    schema: {
      name: "getActivityLog",
      description:
        "Query the log of recent tool calls. Shows what tools were called, their timing, and status. Useful for reviewing what actions have been taken in this session.",
      annotations: { readOnlyHint: true },
      inputSchema: {
        type: "object" as const,
        properties: {
          tool: {
            type: "string" as const,
            description: "Filter by tool name",
          },
          status: {
            type: "string" as const,
            enum: ["success", "error"],
            description: "Filter by status",
          },
          last: {
            type: "number" as const,
            description:
              "Number of recent entries to return (default: 50, max: 200)",
          },
          showStats: {
            type: "boolean" as const,
            description:
              "If true, include per-tool statistics (call count, avg duration, error count). Default: false",
          },
        },
        additionalProperties: false as const,
      },
    },
    handler: async (args: Record<string, unknown>) => {
      const tool = optionalString(args, "tool");
      const status = optionalString(args, "status");
      const last = optionalInt(args, "last", 1, 200) ?? 50;
      const showStats = optionalBool(args, "showStats") ?? false;

      const entries = activityLog.query({ tool, status, last });
      const result: Record<string, unknown> = {
        entries,
        count: entries.length,
      };
      if (showStats) {
        result.stats = activityLog.stats();
      }
      return success(result);
    },
  };
}
