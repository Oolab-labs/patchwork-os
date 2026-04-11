import os from "node:os";
import { describe, expect, it } from "vitest";
import { createWatchDiagnosticsTool } from "../watchDiagnostics.js";

const WORKSPACE = os.tmpdir();

function mockConnectedClient(
  overrides: {
    cachedDiagnostics?: Record<string, unknown>[];
    lastDiagnosticsUpdate?: number;
  } = {},
) {
  const { cachedDiagnostics = [], lastDiagnosticsUpdate = 1000 } = overrides;
  return {
    isConnected: () => true,
    getCachedDiagnostics: () => cachedDiagnostics,
    lastDiagnosticsUpdate,
    addDiagnosticsListener: () => () => {},
  };
}

function parseTool(result: { content: unknown }) {
  return JSON.parse((result.content as Array<{ text: string }>)[0]!.text);
}

describe("diagnostic enrichment", () => {
  it("adds firstSeenAt and recurrenceCount=1 to new diagnostics", async () => {
    const diags = [
      {
        file: "src/app.ts",
        line: 10,
        message: "Type error",
        severity: "error",
      },
    ];
    const client = mockConnectedClient({
      cachedDiagnostics: diags,
      lastDiagnosticsUpdate: 2000,
    });
    const tool = createWatchDiagnosticsTool(WORKSPACE, client as never);
    const before = Date.now();
    const data = parseTool(await tool.handler({ sinceTimestamp: 0 }));
    const after = Date.now();

    expect(data.diagnostics[0].firstSeenAt).toBeGreaterThanOrEqual(before);
    expect(data.diagnostics[0].firstSeenAt).toBeLessThanOrEqual(after);
    expect(data.diagnostics[0].recurrenceCount).toBe(1);
  });

  it("increments recurrenceCount on second call with same diagnostic", async () => {
    const diags = [
      {
        file: "src/app.ts",
        line: 10,
        message: "Type error",
        severity: "error",
      },
    ];
    const client = mockConnectedClient({
      cachedDiagnostics: diags,
      lastDiagnosticsUpdate: 2000,
    });
    const tool = createWatchDiagnosticsTool(WORKSPACE, client as never);

    // First call
    const d1 = parseTool(await tool.handler({ sinceTimestamp: 0 }));
    expect(d1.diagnostics[0].recurrenceCount).toBe(1);
    const firstSeenAt = d1.diagnostics[0].firstSeenAt;

    // Second call — same diagnostic key
    const d2 = parseTool(await tool.handler({ sinceTimestamp: 0 }));
    expect(d2.diagnostics[0].recurrenceCount).toBe(2);
    // firstSeenAt stays the same
    expect(d2.diagnostics[0].firstSeenAt).toBe(firstSeenAt);
  });

  it("tracks different diagnostics independently", async () => {
    const diagsA = [
      { file: "src/a.ts", line: 1, message: "err A", severity: "error" },
    ];
    const diagsB = [
      { file: "src/b.ts", line: 2, message: "err B", severity: "error" },
    ];

    const clientA = mockConnectedClient({
      cachedDiagnostics: diagsA,
      lastDiagnosticsUpdate: 2000,
    });
    const clientB = mockConnectedClient({
      cachedDiagnostics: diagsB,
      lastDiagnosticsUpdate: 2000,
    });

    // Two separate tool instances (separate diagHistory closures)
    const toolA = createWatchDiagnosticsTool(WORKSPACE, clientA as never);
    const toolB = createWatchDiagnosticsTool(WORKSPACE, clientB as never);

    const dA = parseTool(await toolA.handler({ sinceTimestamp: 0 }));
    const dB = parseTool(await toolB.handler({ sinceTimestamp: 0 }));

    expect(dA.diagnostics[0].recurrenceCount).toBe(1);
    expect(dB.diagnostics[0].recurrenceCount).toBe(1);
  });

  it("omits introducedByCommit gracefully when git blame fails (no git repo)", async () => {
    const diags = [
      {
        file: "/nonexistent/app.ts",
        line: 5,
        message: "err",
        severity: "error",
      },
    ];
    const client = mockConnectedClient({
      cachedDiagnostics: diags,
      lastDiagnosticsUpdate: 2000,
    });
    const tool = createWatchDiagnosticsTool("/nonexistent", client as never);
    const data = parseTool(await tool.handler({ sinceTimestamp: 0 }));

    // Should not throw; introducedByCommit simply absent
    expect(data.diagnostics[0].firstSeenAt).toBeTypeOf("number");
    expect(data.diagnostics[0].introducedByCommit).toBeUndefined();
  });
});
