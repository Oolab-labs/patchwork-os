import type { ActivityLog } from "../activityLog.js";
import type { ExtensionClient } from "../extensionClient.js";
import { successStructured } from "./utils.js";

const DEFAULT_WINDOW_MINUTES = 60;

export interface PerformanceReportDeps {
  activityLog: ActivityLog;
  extensionClient: ExtensionClient;
  getSessions: () => { active: number; inGrace: number };
  getRateLimitRejected: () => number;
  getExtensionDisconnectCount: () => number;
}

export function createGetPerformanceReportTool(deps: PerformanceReportDeps) {
  return {
    schema: {
      name: "getPerformanceReport",
      description:
        "Live performance assessment: per-tool latency percentiles, throughput, extension health, session counts, and overall health score.",
      annotations: { readOnlyHint: true },
      inputSchema: {
        type: "object" as const,
        additionalProperties: false as const,
        properties: {
          windowMinutes: {
            type: "number" as const,
            description:
              "Lookback window in minutes for throughput stats. Default: 60.",
            minimum: 1,
            maximum: 1440,
          },
        },
      },
      outputSchema: {
        type: "object",
        properties: {
          generatedAt: { type: "string" },
          windowMinutes: { type: "number" },
          latency: {
            type: "object",
            properties: {
              perTool: { type: "object" },
              overallP95Ms: { type: "number" },
            },
            required: ["perTool", "overallP95Ms"],
          },
          throughput: {
            type: "object",
            properties: {
              callsPerMinute: { type: "number" },
              errorsPerMinute: { type: "number" },
              errorRatePct: { type: "number" },
              rateLimitRejectedTotal: { type: "number" },
            },
            required: [
              "callsPerMinute",
              "errorsPerMinute",
              "errorRatePct",
              "rateLimitRejectedTotal",
            ],
          },
          extension: {
            type: "object",
            properties: {
              connected: { type: "boolean" },
              rttMs: { type: ["number", "null"] },
              circuitBreakerSuspended: { type: "boolean" },
              disconnectCount: { type: "number" },
              connectionQuality: {
                type: "string",
                enum: ["healthy", "degraded", "poor", "disconnected"],
              },
            },
            required: [
              "connected",
              "rttMs",
              "circuitBreakerSuspended",
              "disconnectCount",
              "connectionQuality",
            ],
          },
          sessions: {
            type: "object",
            properties: {
              active: { type: "number" },
              inGrace: { type: "number" },
            },
            required: ["active", "inGrace"],
          },
          health: {
            type: "object",
            properties: {
              score: { type: "number" },
              signals: { type: "array", items: { type: "string" } },
            },
            required: ["score", "signals"],
          },
        },
        required: [
          "generatedAt",
          "windowMinutes",
          "latency",
          "throughput",
          "extension",
          "sessions",
          "health",
        ],
      },
    },

    handler: async (params: { windowMinutes?: number }) => {
      const windowMinutes =
        typeof params.windowMinutes === "number" && params.windowMinutes >= 1
          ? params.windowMinutes
          : DEFAULT_WINDOW_MINUTES;
      const windowMs = windowMinutes * 60_000;

      // --- Latency ---
      const allPercentiles = deps.activityLog.percentiles();
      const windowedS = deps.activityLog.windowedStats(windowMs);
      const allStats = deps.activityLog.stats();

      const perTool: Record<
        string,
        {
          p50: number;
          p95: number;
          p99: number;
          sampleCount: number;
          avgMs: number;
          calls: number;
          errorRate: number;
        }
      > = {};

      for (const [tool, pct] of Object.entries(allPercentiles)) {
        const ws = windowedS[tool];
        const as = allStats[tool];
        perTool[tool] = {
          p50: pct.p50,
          p95: pct.p95,
          p99: pct.p99,
          sampleCount: pct.sampleCount,
          avgMs: as?.avgDurationMs ?? 0,
          calls: ws?.count ?? 0,
          errorRate:
            ws && ws.count > 0
              ? Math.round((ws.errors / ws.count) * 10000) / 100
              : 0,
        };
      }

      // Overall p95: max across all tools (worst-case SLA)
      const p95Values = Object.values(allPercentiles).map((p) => p.p95);
      const overallP95Ms = p95Values.length > 0 ? Math.max(...p95Values) : 0;

      // --- Throughput ---
      let totalCalls = 0;
      let totalErrors = 0;
      for (const s of Object.values(windowedS)) {
        totalCalls += s.count;
        totalErrors += s.errors;
      }
      const callsPerMinute =
        Math.round((totalCalls / windowMinutes) * 100) / 100;
      const errorsPerMinute =
        Math.round((totalErrors / windowMinutes) * 100) / 100;
      const errorRatePct =
        totalCalls > 0
          ? Math.round((totalErrors / totalCalls) * 10000) / 100
          : 0;
      const rateLimitRejectedTotal = deps.getRateLimitRejected();

      // --- Extension ---
      const connected = deps.extensionClient.isConnected();
      const cb = deps.extensionClient.getCircuitBreakerState();
      const circuitBreakerSuspended = cb.suspended;
      const disconnectCount = deps.getExtensionDisconnectCount();

      // RTT: not directly tracked; null unless we can derive it
      const rttMs: number | null = null;

      let connectionQuality: "healthy" | "degraded" | "poor" | "disconnected";
      if (!connected) {
        connectionQuality = "disconnected";
      } else if (circuitBreakerSuspended) {
        connectionQuality = "poor";
      } else if (rttMs !== null && rttMs > 500) {
        connectionQuality = "degraded";
      } else {
        connectionQuality = "healthy";
      }

      // --- Sessions ---
      const sessions = deps.getSessions();

      // --- Health score ---
      let score = 100;
      const signals: string[] = [];

      if (circuitBreakerSuspended) {
        score -= 20;
        signals.push("Circuit breaker suspended");
      }
      if (rttMs !== null && rttMs > 500) {
        score -= 10;
        signals.push(`Extension RTT high (${rttMs}ms)`);
      }
      if (errorRatePct > 5) {
        score -= 15;
        signals.push(`Error rate critical (${errorRatePct}%)`);
      } else if (errorRatePct > 1) {
        score -= 10;
        signals.push(`Error rate elevated (${errorRatePct}%)`);
      }
      if (overallP95Ms > 2000) {
        score -= 10;
        signals.push(`p95 latency critical (${overallP95Ms}ms)`);
      } else if (overallP95Ms > 500) {
        score -= 5;
        signals.push(`p95 latency elevated (${overallP95Ms}ms)`);
      }
      if (rateLimitRejectedTotal > 0) {
        score -= 10;
        signals.push(`${rateLimitRejectedTotal} rate-limit rejection(s)`);
      }
      if (!connected) {
        signals.push("Extension disconnected");
      }

      score = Math.max(0, Math.min(100, score));

      return successStructured({
        generatedAt: new Date().toISOString(),
        windowMinutes,
        latency: { perTool, overallP95Ms },
        throughput: {
          callsPerMinute,
          errorsPerMinute,
          errorRatePct,
          rateLimitRejectedTotal,
        },
        extension: {
          connected,
          rttMs,
          circuitBreakerSuspended,
          disconnectCount,
          connectionQuality,
        },
        sessions,
        health: { score, signals },
      });
    },
  };
}
