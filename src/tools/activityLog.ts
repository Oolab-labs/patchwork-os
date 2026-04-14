import {
  type ActivityLog,
  DEFAULT_CO_OCCURRENCE_WINDOW_MS,
} from "../activityLog.js";
import type { ActivityEntry } from "../activityTypes.js";
import {
  optionalBool,
  optionalInt,
  optionalString,
  successStructured,
} from "./utils.js";

const WATCH_ACTIVITY_MAX_ENTRIES = 50;
const WATCH_ACTIVITY_MIN_INTERVAL_MS = 1_000;
const WATCH_ACTIVITY_DEFAULT_INTERVAL_MS = 2_000;
const WATCH_ACTIVITY_MAX_INTERVAL_MS = 30_000;

export function createGetActivityLogTool(activityLog: ActivityLog) {
  return {
    schema: {
      name: "getActivityLog",
      description:
        "Query recent tool call log: names, timing, status, percentiles, co-occurrence.",
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
            description: "Recent entries to return (default: 50, max: 200)",
          },
          showStats: {
            type: "boolean" as const,
            description:
              "Include per-tool stats (call count, avg duration, error count). Default: false",
          },
          showPercentiles: {
            type: "boolean" as const,
            description:
              "Include per-tool p50/p95/p99 duration percentiles (requires showStats). Default: false",
          },
          showCoOccurrence: {
            type: "boolean" as const,
            description:
              "Include tool-pair co-occurrence within the time window. Default: false",
          },
          coOccurrenceWindowMs: {
            type: "number" as const,
            description: `Sliding window for co-occurrence in ms (default: ${DEFAULT_CO_OCCURRENCE_WINDOW_MS} = 5 min, max: 3600000)`,
          },
        },
        additionalProperties: false as const,
      },
      outputSchema: {
        type: "object",
        properties: {
          entries: { type: "array" },
          count: { type: "integer" },
          stats: {
            type: "object",
            description:
              "Per-tool stats: count, avgDurationMs, errors, and optional percentiles",
          },
          percentiles: {
            type: "object",
            description:
              "Per-tool p50/p95/p99 duration in ms with sample count (only when showStats+showPercentiles)",
          },
          coOccurrence: {
            type: "array",
            items: {
              type: "object",
              properties: {
                pair: { type: "string" },
                count: { type: "integer" },
              },
              required: ["pair", "count"],
            },
            description:
              "Tool pairs called within coOccurrenceWindowMs of each other, sorted by count desc",
          },
        },
        required: ["entries", "count"],
      },
    },
    handler: async (args: Record<string, unknown>) => {
      const tool = optionalString(args, "tool");
      const status = optionalString(args, "status");
      const last = optionalInt(args, "last", 1, 200) ?? 50;
      const showStats = optionalBool(args, "showStats") ?? false;
      const showPercentiles = optionalBool(args, "showPercentiles") ?? false;
      const showCoOccurrence = optionalBool(args, "showCoOccurrence") ?? false;
      const coOccurrenceWindowMs = Math.min(
        optionalInt(args, "coOccurrenceWindowMs", 1_000, 3_600_000) ??
          DEFAULT_CO_OCCURRENCE_WINDOW_MS,
        3_600_000,
      );

      const entries = activityLog.query({ tool, status, last });
      const result: Record<string, unknown> = {
        entries,
        count: entries.length,
      };

      if (showStats) {
        result.stats = activityLog.stats();
        if (showPercentiles) {
          result.percentiles = activityLog.percentiles();
        }
      }

      if (showCoOccurrence) {
        result.coOccurrence = activityLog.coOccurrence(coOccurrenceWindowMs);
      }

      return successStructured(result);
    },
  };
}

export function createWatchActivityLogTool(activityLog: ActivityLog) {
  return {
    schema: {
      name: "watchActivityLog",
      description:
        "Long-poll for new activity log entries. Pass lastId as sinceId on next call.",
      annotations: { readOnlyHint: true },
      inputSchema: {
        type: "object" as const,
        properties: {
          sinceId: {
            type: "number" as const,
            description:
              "Return entries with id > sinceId. Omit on first call.",
          },
          maxEntries: {
            type: "number" as const,
            description: `Max entries to return (default: 10, max: ${WATCH_ACTIVITY_MAX_ENTRIES})`,
          },
          timeoutMs: {
            type: "number" as const,
            description: `Max wait in milliseconds (default: ${WATCH_ACTIVITY_DEFAULT_INTERVAL_MS}, min: ${WATCH_ACTIVITY_MIN_INTERVAL_MS}, max: ${WATCH_ACTIVITY_MAX_INTERVAL_MS})`,
          },
        },
        additionalProperties: false as const,
      },
      outputSchema: {
        type: "object",
        properties: {
          entries: { type: "array" },
          count: { type: "integer" },
          lastId: { type: "number" },
          timedOut: { type: "boolean" },
        },
        required: ["entries", "count", "lastId", "timedOut"],
      },
    },
    handler: async (args: Record<string, unknown>) => {
      const sinceId = optionalInt(args, "sinceId", 0) ?? 0;
      const maxEntries = Math.min(
        optionalInt(args, "maxEntries", 1, WATCH_ACTIVITY_MAX_ENTRIES) ?? 10,
        WATCH_ACTIVITY_MAX_ENTRIES,
      );
      const timeoutMs = Math.min(
        Math.max(
          optionalInt(args, "timeoutMs", WATCH_ACTIVITY_MIN_INTERVAL_MS) ??
            WATCH_ACTIVITY_DEFAULT_INTERVAL_MS,
          WATCH_ACTIVITY_MIN_INTERVAL_MS,
        ),
        WATCH_ACTIVITY_MAX_INTERVAL_MS,
      );

      // Collect buffered entries already past sinceId
      const existing = activityLog
        .query({ last: 200 })
        .filter((e: ActivityEntry) => e.id > sinceId)
        .slice(-maxEntries);

      if (existing.length > 0) {
        const lastId = existing[existing.length - 1]?.id;
        return successStructured({
          entries: existing,
          count: existing.length,
          lastId,
          timedOut: false,
        });
      }

      // Capture the current high-water mark before entering the long-poll.
      // If we time out with no new entries, we return this value as lastId so
      // the client advances past entries that already existed — preventing it
      // from re-polling forever with the same sinceId.
      const highestKnownId = activityLog.getHighestId();

      // Long-poll: wait for a new entry or timeout
      const newEntries: ActivityEntry[] = [];
      let resolved = false;
      let timeoutId: ReturnType<typeof setTimeout>;

      const result = await new Promise<{
        entries: ActivityEntry[];
        timedOut: boolean;
      }>((resolve) => {
        const unsubscribe = activityLog.subscribe((kind, entry) => {
          if (kind !== "tool") return;
          const toolEntry = entry as ActivityEntry;
          if (toolEntry.id <= sinceId) return;
          if (resolved) return;
          newEntries.push(toolEntry);
          if (newEntries.length >= maxEntries) {
            resolved = true;
            clearTimeout(timeoutId);
            unsubscribe();
            resolve({ entries: newEntries, timedOut: false });
          }
        });

        timeoutId = setTimeout(() => {
          if (!resolved) {
            resolved = true;
            unsubscribe();
            resolve({ entries: newEntries, timedOut: true });
          }
        }, timeoutMs);
      });

      const lastId =
        result.entries.length > 0
          ? result.entries[result.entries.length - 1]?.id
          : highestKnownId;

      return successStructured({
        entries: result.entries,
        count: result.entries.length,
        lastId,
        timedOut: result.timedOut,
      });
    },
  };
}
