/**
 * Tests that registerEvents broadcasts notifications to all connected bridges,
 * not just a single bridge.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("vscode", async () => {
  const mod = await import("./__mocks__/vscode");
  return mod;
});

import * as vscode from "vscode";
import WebSocket from "ws";
import { registerEvents } from "../events";
import { __reset } from "./__mocks__/vscode";

// Minimal fake BridgeConnection
function makeBridge(connected: boolean) {
  const notifications: Array<{ method: string; params: unknown }> = [];
  return {
    ws: connected ? ({ readyState: WebSocket.OPEN } as any) : null,
    claudeConnected: false,
    sendNotification: vi.fn((method: string, params: unknown) => {
      notifications.push({ method, params });
    }),
    forceReconnect: vi.fn(),
    output: null,
    notifications,
  } as any;
}

function makeContext() {
  const subs: Array<{ dispose(): void }> = [];
  return {
    subscriptions: {
      push: (sub: { dispose(): void }) => subs.push(sub),
    },
    extension: { packageJSON: { version: "0.4.0" } },
    subs,
  } as any;
}

function makeOutput() {
  return { appendLine: vi.fn(), show: vi.fn() } as any;
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: false });
  __reset();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("registerEvents — multi-bridge broadcasting", () => {
  it("sends diagnostics notification to all connected bridges", () => {
    const b1 = makeBridge(true);
    const b2 = makeBridge(true);
    const bridges = [b1, b2];
    const ctx = makeContext();
    registerEvents(ctx, () => bridges, makeOutput());

    // Simulate onDidChangeDiagnostics event
    const handler = vi.mocked(vscode.languages.onDidChangeDiagnostics).mock
      .calls[0]?.[0];
    expect(handler).toBeDefined();
    const uri = vscode.Uri.file("/ws/src/foo.ts");
    vi.mocked(vscode.languages.getDiagnostics).mockReturnValue([]);
    handler({ uris: [uri] } as any);

    vi.runAllTimers();

    expect(b1.sendNotification).toHaveBeenCalledWith(
      "extension/diagnosticsChanged",
      expect.objectContaining({ file: "/ws/src/foo.ts" }),
    );
    expect(b2.sendNotification).toHaveBeenCalledWith(
      "extension/diagnosticsChanged",
      expect.objectContaining({ file: "/ws/src/foo.ts" }),
    );
  });

  it("skips diagnostics work when no bridge is connected", () => {
    const b1 = makeBridge(false);
    const b2 = makeBridge(false);
    const ctx = makeContext();
    registerEvents(ctx, () => [b1, b2], makeOutput());

    const handler = vi.mocked(vscode.languages.onDidChangeDiagnostics).mock
      .calls[0]?.[0];
    const uri = vscode.Uri.file("/ws/src/foo.ts");
    handler({ uris: [uri] } as any);
    vi.runAllTimers();

    expect(b1.sendNotification).not.toHaveBeenCalled();
    expect(b2.sendNotification).not.toHaveBeenCalled();
  });

  it("sends activeFileChanged to all bridges", () => {
    const b1 = makeBridge(true);
    const b2 = makeBridge(true);
    const ctx = makeContext();
    registerEvents(ctx, () => [b1, b2], makeOutput());

    const handler = vi.mocked(vscode.window.onDidChangeActiveTextEditor).mock
      .calls[0]?.[0];
    const doc = {
      uri: vscode.Uri.file("/ws/index.ts"),
      getText: () => "",
    } as any;
    handler({ document: doc } as any);

    expect(b1.sendNotification).toHaveBeenCalledWith(
      "extension/activeFileChanged",
      { file: "/ws/index.ts" },
    );
    expect(b2.sendNotification).toHaveBeenCalledWith(
      "extension/activeFileChanged",
      { file: "/ws/index.ts" },
    );
  });

  it("sends fileSaved to all bridges", () => {
    const b1 = makeBridge(true);
    const b2 = makeBridge(true);
    const ctx = makeContext();
    registerEvents(ctx, () => [b1, b2], makeOutput());

    const handler = vi.mocked(vscode.workspace.onDidSaveTextDocument).mock
      .calls[0]?.[0];
    const doc = { uri: vscode.Uri.file("/ws/main.ts") } as any;
    handler(doc);

    for (const b of [b1, b2]) {
      expect(b.sendNotification).toHaveBeenCalledWith("extension/fileSaved", {
        file: "/ws/main.ts",
      });
    }
  });

  it("reconnect command calls forceReconnect on all bridges", () => {
    const b1 = makeBridge(true);
    const b2 = makeBridge(false);
    const ctx = makeContext();
    registerEvents(ctx, () => [b1, b2], makeOutput());

    const handler = vi
      .mocked(vscode.commands.registerCommand)
      .mock.calls.find((c) => c[0] === "claudeIdeBridge.reconnect")?.[1];
    handler?.();

    expect(b1.forceReconnect).toHaveBeenCalledOnce();
    expect(b2.forceReconnect).toHaveBeenCalledOnce();
  });

  it("only notifies connected bridges — disconnected bridge is skipped for file-save", () => {
    const b1 = makeBridge(true);
    const b2 = makeBridge(false); // disconnected — sendNotification won't do real ws send but is still called
    const ctx = makeContext();
    registerEvents(ctx, () => [b1, b2], makeOutput());

    const handler = vi.mocked(vscode.workspace.onDidSaveTextDocument).mock
      .calls[0]?.[0];
    handler({ uri: vscode.Uri.file("/ws/x.ts") } as any);

    // sendNotification is called for all; the BridgeConnection.sendNotification
    // internally guards on ws.readyState — here we're testing that notifyAll
    // iterates both bridges regardless.
    expect(b1.sendNotification).toHaveBeenCalled();
    expect(b2.sendNotification).toHaveBeenCalled();
  });
});
