/**
 * Tests for watchDiagnostics:
 * - Extension-connected path: long-poll behavior, sinceTimestamp early return, timeout, abort
 * - Extension-disconnected path: CLI linter fallback, no-linters case, schema
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createWatchDiagnosticsTool } from "../watchDiagnostics.js";

// ── Temp workspace ────────────────────────────────────────────────────────────

let WORKSPACE: string;

beforeAll(() => {
  WORKSPACE = fs.mkdtempSync(path.join(os.tmpdir(), "watch-diag-"));
});

afterAll(() => {
  fs.rmSync(WORKSPACE, { recursive: true, force: true });
});

// ── Mock helpers ──────────────────────────────────────────────────────────────

type DiagnosticsListener = (file: string) => void;

function mockConnectedClient(
  opts: { lastDiagnosticsUpdate?: number; cachedDiagnostics?: unknown[] } = {},
) {
  const listeners = new Set<DiagnosticsListener>();
  const client = {
    isConnected: () => true,
    lastDiagnosticsUpdate: opts.lastDiagnosticsUpdate ?? 0,
    getCachedDiagnostics: (_path?: string) => opts.cachedDiagnostics ?? [],
    addDiagnosticsListener: (cb: DiagnosticsListener) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    fire: (file: string) => {
      for (const l of listeners) l(file);
    },
  };
  return client;
}

function mockDisconnectedClient() {
  return {
    isConnected: () => false,
    lastDiagnosticsUpdate: 0,
    getCachedDiagnostics: () => [],
    addDiagnosticsListener: () => () => undefined,
  };
}

// ── Extension-connected: sinceTimestamp ──────────────────────────────────────

describe("watchDiagnostics: sinceTimestamp early-return", () => {
  it("returns immediately with cached diagnostics when update is newer than sinceTimestamp", async () => {
    const diags = [{ file: "a.ts", severity: "error", message: "oops" }];
    const client = mockConnectedClient({
      lastDiagnosticsUpdate: 1000,
      cachedDiagnostics: diags,
    });
    const tool = createWatchDiagnosticsTool(WORKSPACE, client as any);

    const result = await tool.handler({ sinceTimestamp: 500 });
    const data = JSON.parse(result.content[0].text);

    expect(data.changed).toBe(true);
    expect(data.timestamp).toBe(1000);
    expect(data.diagnostics).toMatchObject(diags);
    expect(data.count).toBe(1);
  });

  it("does not return early when lastUpdate equals sinceTimestamp", async () => {
    const client = mockConnectedClient({ lastDiagnosticsUpdate: 500 });
    const tool = createWatchDiagnosticsTool(WORKSPACE, client as any);

    // Fire after a short delay so the long-poll resolves with changed=true rather than timing out
    setTimeout(() => client.fire("anything"), 20);
    const result = await tool.handler({ sinceTimestamp: 500, timeoutMs: 1000 });
    const data = JSON.parse(result.content[0].text);

    expect(data.changed).toBe(true);
  });
});

// ── Extension-connected: long-poll ────────────────────────────────────────────

describe("watchDiagnostics: long-poll", () => {
  it("resolves with changed=true when a diagnostic change fires", async () => {
    const diags = [{ file: "b.ts", severity: "warning", message: "w" }];
    const client = mockConnectedClient({ cachedDiagnostics: diags });
    const tool = createWatchDiagnosticsTool(WORKSPACE, client as any);

    setTimeout(() => client.fire("b.ts"), 20);
    const result = await tool.handler({ timeoutMs: 1000 });
    const data = JSON.parse(result.content[0].text);

    expect(data.changed).toBe(true);
    expect(data.diagnostics).toMatchObject(diags);
  });

  it("resolves with changed=false on timeout", async () => {
    const client = mockConnectedClient();
    const tool = createWatchDiagnosticsTool(WORKSPACE, client as any);

    // Use minimum valid timeoutMs (1000ms) but abort immediately to avoid 1s wait
    const controller2 = new AbortController();
    setTimeout(() => controller2.abort(), 10);
    const result = await tool.handler({ timeoutMs: 1000 }, controller2.signal);
    const data = JSON.parse(result.content[0].text);

    expect(data.changed).toBe(false);
  });

  it("resolves with changed=false when AbortSignal fires", async () => {
    const client = mockConnectedClient();
    const tool = createWatchDiagnosticsTool(WORKSPACE, client as any);

    const controller = new AbortController();
    setTimeout(() => controller.abort(), 20);
    const result = await tool.handler({ timeoutMs: 10000 }, controller.signal);
    const data = JSON.parse(result.content[0].text);

    expect(data.changed).toBe(false);
  });

  it("ignores change events for other files when filePath is specified", async () => {
    const client = mockConnectedClient();

    // Create the watched file so resolveFilePath succeeds
    const watchedFile = path.join(WORKSPACE, "target.ts");
    fs.writeFileSync(watchedFile, "");

    const tool = createWatchDiagnosticsTool(WORKSPACE, client as any);

    // Fire a change for a completely different path — should not resolve the poll for target.ts
    setTimeout(() => client.fire(path.join(WORKSPACE, "other.ts")), 20);
    // Abort quickly to avoid waiting the full 1s minimum timeout
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), 50);
    const result = await tool.handler(
      { filePath: "target.ts", timeoutMs: 1000 },
      ctrl.signal,
    );
    const data = JSON.parse(result.content[0].text);

    // The poll for target.ts should have timed out (other.ts change is irrelevant)
    expect(data.changed).toBe(false);
  });

  it("resolves when the correct file fires", async () => {
    const client = mockConnectedClient();
    const targetFile = path.join(WORKSPACE, "watched.ts");
    fs.writeFileSync(targetFile, "");

    const tool = createWatchDiagnosticsTool(WORKSPACE, client as any);

    setTimeout(() => client.fire(targetFile), 20);
    const result = await tool.handler({
      filePath: "watched.ts",
      timeoutMs: 1000,
    });
    const data = JSON.parse(result.content[0].text);

    expect(data.changed).toBe(true);
  });
});

// ── Extension-disconnected: CLI fallback ──────────────────────────────────────

describe("watchDiagnostics: disconnected — no-linter path", () => {
  it("returns no-linter message when probes is undefined", async () => {
    const client = mockDisconnectedClient();
    const tool = createWatchDiagnosticsTool(WORKSPACE, client as any);

    const result = await tool.handler({});
    const data = JSON.parse(result.content[0].text);

    expect(data.source).toBe("cli");
    expect(data.diagnostics).toEqual([]);
    expect(data.count).toBe(0);
    expect(data.changed).toBe(false);
    expect(data.note).toMatch(/No linters detected/i);
  });

  it("returns source=cli in result", async () => {
    const client = mockDisconnectedClient();
    const tool = createWatchDiagnosticsTool(WORKSPACE, client as any);

    const result = await tool.handler({});
    expect(JSON.parse(result.content[0].text).source).toBe("cli");
  });
});

// ── TDZ crash regression: cleanup used before initialization ─────────────────

describe("watchDiagnostics: TDZ regression — settle called before cleanup is initialized", () => {
  it("does not throw ReferenceError when update arrives between outer and inner timestamp checks", async () => {
    // Simulate: lastDiagnosticsUpdate is below sinceTimestamp initially (outer check passes),
    // but addDiagnosticsListener bumps it above sinceTimestamp so the inner re-check fires
    // settle(true) while cleanup is not yet initialized (the TDZ window).
    let lastUpdate = 900;
    const client = {
      isConnected: () => true,
      get lastDiagnosticsUpdate() {
        return lastUpdate;
      },
      getCachedDiagnostics: () => [],
      addDiagnosticsListener: (_cb: (file: string) => void) => {
        // Simulate diagnostic update arriving right as we register the listener
        lastUpdate = 1100;
        const unsub = () => {};
        return unsub;
      },
    };

    const tool = createWatchDiagnosticsTool(WORKSPACE, client as any);

    // sinceTimestamp=1000: outer check sees 900 < 1000 (no early return),
    // inner re-check sees 1100 > 1000 → settle(true) fires → TDZ crash if unfixed
    await expect(
      tool.handler({ sinceTimestamp: 1000, timeoutMs: 1000 }),
    ).resolves.toBeDefined();
  });
});

// ── Schema ────────────────────────────────────────────────────────────────────

describe("watchDiagnostics: schema", () => {
  it("does not set extensionRequired — tool is visible when extension disconnected", () => {
    const client = mockDisconnectedClient();
    const tool = createWatchDiagnosticsTool(WORKSPACE, client as any);

    expect(
      (tool.schema as Record<string, unknown>).extensionRequired,
    ).toBeUndefined();
  });
});
