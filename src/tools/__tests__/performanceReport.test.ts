import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    default: {
      ...actual,
      existsSync: vi.fn(() => true),
      mkdirSync: vi.fn(),
      writeFileSync: vi.fn(),
      readFileSync: vi.fn(() => ""),
      promises: {
        ...actual.promises,
        appendFile: vi.fn(() => Promise.resolve()),
        stat: vi.fn(() => Promise.resolve({ size: 0 })),
        open: vi.fn(() => Promise.resolve({ close: vi.fn() })),
      },
    },
  };
});

import { ActivityLog } from "../../activityLog.js";
import type { ExtensionClient } from "../../extensionClient.js";
import { createGetPerformanceReportTool } from "../performanceReport.js";

function makeExtensionClient(
  connected = true,
  suspended = false,
): ExtensionClient {
  return {
    isConnected: () => connected,
    getCircuitBreakerState: () => ({
      suspended,
      suspendedUntil: 0,
      failures: 0,
    }),
  } as unknown as ExtensionClient;
}

function makeDeps(opts: {
  connected?: boolean;
  suspended?: boolean;
  rateLimitRejected?: number;
  disconnectCount?: number;
  activeSessions?: number;
  inGrace?: number;
}) {
  const log = new ActivityLog();
  // Record a few tool calls so percentiles are populated
  for (let i = 0; i < 5; i++) {
    log.record("getDiagnostics", 100 + i * 10, "success");
    log.record("openFile", 50, i === 2 ? "error" : "success");
  }
  if (opts.rateLimitRejected) {
    for (let i = 0; i < opts.rateLimitRejected; i++) {
      log.recordRateLimitRejection();
    }
  }
  const client = makeExtensionClient(
    opts.connected ?? true,
    opts.suspended ?? false,
  );
  return createGetPerformanceReportTool({
    activityLog: log,
    extensionClient: client,
    getSessions: () => ({
      active: opts.activeSessions ?? 1,
      inGrace: opts.inGrace ?? 0,
    }),
    getRateLimitRejected: () => log.getRateLimitRejections(),
    getExtensionDisconnectCount: () => opts.disconnectCount ?? 0,
  });
}

describe("getPerformanceReport", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns correct top-level shape", async () => {
    const tool = makeDeps({});
    const result = await tool.handler({});
    const data = JSON.parse(result.content[0]?.text ?? "{}") as Record<
      string,
      unknown
    >;
    expect(data).toHaveProperty("generatedAt");
    expect(data).toHaveProperty("windowMinutes", 60);
    expect(data).toHaveProperty("latency");
    expect(data).toHaveProperty("throughput");
    expect(data).toHaveProperty("extension");
    expect(data).toHaveProperty("sessions");
    expect(data).toHaveProperty("health");
  });

  it("uses custom windowMinutes", async () => {
    const tool = makeDeps({});
    const result = await tool.handler({ windowMinutes: 30 });
    const data = JSON.parse(result.content[0]?.text ?? "{}") as {
      windowMinutes: number;
    };
    expect(data.windowMinutes).toBe(30);
  });

  it("health score is 100 when no negative signals", async () => {
    // Use a fresh log with only successes and no rate-limit rejections
    const log = new ActivityLog();
    for (let i = 0; i < 5; i++) {
      log.record("getDiagnostics", 100 + i * 10, "success");
    }
    const client = makeExtensionClient(true, false);
    const tool = createGetPerformanceReportTool({
      activityLog: log,
      extensionClient: client,
      getSessions: () => ({ active: 1, inGrace: 0 }),
      getRateLimitRejected: () => 0,
      getExtensionDisconnectCount: () => 0,
    });
    const result = await tool.handler({});
    const data = JSON.parse(result.content[0]?.text ?? "{}") as {
      health: { score: number; signals: string[] };
    };
    expect(data.health.score).toBe(100);
    expect(data.health.signals).toHaveLength(0);
  });

  it("health score -20 for circuit breaker suspended", async () => {
    const tool = makeDeps({ suspended: true });
    const result = await tool.handler({});
    const data = JSON.parse(result.content[0]?.text ?? "{}") as {
      health: { score: number; signals: string[] };
    };
    expect(data.health.score).toBeLessThanOrEqual(80);
    expect(data.health.signals.some((s) => s.includes("Circuit breaker"))).toBe(
      true,
    );
  });

  it("health score -10 for rate limit rejections", async () => {
    const tool = makeDeps({ rateLimitRejected: 3 });
    const result = await tool.handler({});
    const data = JSON.parse(result.content[0]?.text ?? "{}") as {
      health: { score: number; signals: string[] };
    };
    expect(data.health.score).toBeLessThanOrEqual(90);
    expect(data.health.signals.some((s) => s.includes("rate-limit"))).toBe(
      true,
    );
  });

  it("health score clamped to [0,100]", async () => {
    // Multiple bad signals
    const tool = makeDeps({
      suspended: true,
      rateLimitRejected: 5,
      connected: false,
    });
    const result = await tool.handler({});
    const data = JSON.parse(result.content[0]?.text ?? "{}") as {
      health: { score: number };
    };
    expect(data.health.score).toBeGreaterThanOrEqual(0);
    expect(data.health.score).toBeLessThanOrEqual(100);
  });

  it("connectionQuality disconnected when not connected", async () => {
    const tool = makeDeps({ connected: false });
    const result = await tool.handler({});
    const data = JSON.parse(result.content[0]?.text ?? "{}") as {
      extension: { connectionQuality: string; connected: boolean };
    };
    expect(data.extension.connectionQuality).toBe("disconnected");
    expect(data.extension.connected).toBe(false);
  });

  it("connectionQuality poor when circuit breaker suspended", async () => {
    const tool = makeDeps({ connected: true, suspended: true });
    const result = await tool.handler({});
    const data = JSON.parse(result.content[0]?.text ?? "{}") as {
      extension: { connectionQuality: string };
    };
    expect(data.extension.connectionQuality).toBe("poor");
  });

  it("connectionQuality healthy when connected and not suspended", async () => {
    const tool = makeDeps({ connected: true, suspended: false });
    const result = await tool.handler({});
    const data = JSON.parse(result.content[0]?.text ?? "{}") as {
      extension: { connectionQuality: string };
    };
    expect(data.extension.connectionQuality).toBe("healthy");
  });

  it("sessions reflect getSessions output", async () => {
    const tool = makeDeps({ activeSessions: 3, inGrace: 1 });
    const result = await tool.handler({});
    const data = JSON.parse(result.content[0]?.text ?? "{}") as {
      sessions: { active: number; inGrace: number };
    };
    expect(data.sessions.active).toBe(3);
    expect(data.sessions.inGrace).toBe(1);
  });

  it("perTool latency keys populated when samples exist", async () => {
    const tool = makeDeps({});
    const result = await tool.handler({});
    const data = JSON.parse(result.content[0]?.text ?? "{}") as {
      latency: { perTool: Record<string, unknown>; overallP95Ms: number };
    };
    expect(Object.keys(data.latency.perTool).length).toBeGreaterThan(0);
    expect(data.latency.overallP95Ms).toBeGreaterThan(0);
  });
});
