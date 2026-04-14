import type { ActivityLog } from "../activityLog.js";
import type { ClaudeOrchestrator } from "../claudeOrchestrator.js";
import { successStructured } from "./utils.js";

const DEFAULT_WINDOW_HOURS = 24;
const TOP_TOOLS_LIMIT = 10;
const RECENT_TASKS_LIMIT = 20;
const TIMELINE_QUERY_LIMIT = 500;

/**
 * getAnalyticsReport — surfaces existing analytics data as structured output.
 *
 * No new data collection — exposes what ActivityLog and ClaudeOrchestrator
 * already capture: top tools by call count, lifecycle hook events in the last
 * windowHours, and recent automation task summaries.
 */
export function createGetAnalyticsReportTool(
  activityLog: ActivityLog,
  orchestrator: ClaudeOrchestrator | null,
) {
  return {
    schema: {
      name: "getAnalyticsReport",
      description:
        "Session analytics: top tools by call count, hook events, recent automation tasks.",
      annotations: { readOnlyHint: true },
      inputSchema: {
        type: "object" as const,
        additionalProperties: false as const,
        properties: {
          windowHours: {
            type: "number" as const,
            description:
              "How many hours back to count lifecycle hook events. Default: 24.",
            minimum: 1,
            maximum: 168,
          },
        },
      },
      outputSchema: {
        type: "object",
        properties: {
          generatedAt: { type: "string" },
          windowHours: { type: "number" },
          topTools: {
            type: "array",
            items: {
              type: "object",
              properties: {
                tool: { type: "string" },
                calls: { type: "number" },
                errors: { type: "number" },
                avgMs: { type: "number" },
              },
              required: ["tool", "calls", "errors", "avgMs"],
            },
          },
          hooksLast24h: { type: "number" },
          recentAutomationTasks: {
            type: "array",
            items: {
              type: "object",
              properties: {
                id: { type: "string" },
                status: { type: "string" },
                triggerSource: { type: "string" },
                durationMs: { type: "number" },
                createdAt: { type: "string" },
              },
              required: ["id", "status", "createdAt"],
            },
          },
          hint: { type: "string" },
        },
        required: [
          "generatedAt",
          "windowHours",
          "topTools",
          "hooksLast24h",
          "recentAutomationTasks",
          "hint",
        ],
      },
    },

    handler: async (params: { windowHours?: number }) => {
      const windowHours =
        typeof params.windowHours === "number" && params.windowHours >= 1
          ? params.windowHours
          : DEFAULT_WINDOW_HOURS;

      // --- topTools: from activityLog.stats(), sorted by count desc, top 10 ---
      const statsMap = activityLog.stats();
      const topTools = Object.entries(statsMap)
        .map(([tool, s]) => ({
          tool,
          calls: s.count,
          errors: s.errors,
          avgMs: s.avgDurationMs,
        }))
        .sort((a, b) => b.calls - a.calls)
        .slice(0, TOP_TOOLS_LIMIT);

      // --- hooksLast24h: lifecycle entries within windowHours ---
      const cutoff = Date.now() - windowHours * 3_600 * 1_000;
      const timeline = activityLog.queryTimeline({
        last: TIMELINE_QUERY_LIMIT,
      });
      const hooksLast24h = timeline.filter(
        (e) =>
          e.kind === "lifecycle" && new Date(e.timestamp).getTime() > cutoff,
      ).length;

      // --- recentAutomationTasks: last 20 tasks from orchestrator ---
      const recentAutomationTasks =
        orchestrator !== null
          ? orchestrator
              .list()
              .sort((a, b) => b.createdAt - a.createdAt)
              .slice(0, RECENT_TASKS_LIMIT)
              .map((t) => ({
                id: t.id,
                status: t.status,
                ...(t.triggerSource !== undefined && {
                  triggerSource: t.triggerSource,
                }),
                ...(t.startedAt !== undefined &&
                  t.doneAt !== undefined && {
                    durationMs: t.doneAt - t.startedAt,
                  }),
                createdAt: new Date(t.createdAt).toISOString(),
              }))
          : [];

      return successStructured({
        generatedAt: new Date().toISOString(),
        windowHours,
        topTools,
        hooksLast24h,
        recentAutomationTasks,
        hint:
          "Use windowHours to adjust the hook-event lookback window. " +
          "topTools shows all-time session stats. " +
          "recentAutomationTasks lists the last 20 orchestrator tasks sorted newest first.",
      });
    },
  };
}
