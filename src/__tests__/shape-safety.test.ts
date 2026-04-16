/**
 * Shape-safety regression tests.
 *
 * Each test seeds a latent bug fixed during the v2.25.18–v2.25.24 sweep, when
 * the `proxy<T>()` blind cast in extensionClient.ts masked shape mismatches
 * between extension handler responses and client-side type assumptions.
 *
 * If one of these fails, the migration from proxy<T> to
 * tryRequest/validatedRequest/inline-unwrap has regressed for that method.
 *
 * See documents/roadmap.md "Eight latent shape-mismatch bugs" and
 * project_shape_mismatch_prevention.md.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import { ExtensionClient } from "../extensionClient.js";
import { Logger } from "../logger.js";

let wss: WebSocketServer;
let port: number;
let client: ExtensionClient;

function waitForOpen(ws: WebSocket): Promise<void> {
  return new Promise((resolve) => {
    if (ws.readyState === WebSocket.OPEN) return resolve();
    ws.on("open", () => resolve());
  });
}

async function connect(): Promise<WebSocket> {
  const serverConn = new Promise<WebSocket>((resolve) => {
    wss.on("connection", resolve);
  });
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  await waitForOpen(ws);
  const serverWs = await serverConn;
  client.handleExtensionConnection(serverWs);
  return ws;
}

function stubHandler(ws: WebSocket, method: string, result: unknown): void {
  ws.on("message", (data) => {
    const msg = JSON.parse(data.toString("utf-8"));
    if (msg.method === method) {
      ws.send(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }));
    }
  });
}

beforeEach(async () => {
  const logger = new Logger(false);
  client = new ExtensionClient(logger);
  wss = new WebSocketServer({ port: 0 });
  const addr = wss.address();
  port = typeof addr === "object" && addr ? addr.port : 0;
});

afterEach(async () => {
  client.disconnect();
  await new Promise<void>((resolve) => {
    wss.close(() => resolve());
  });
});

describe("shape-safety regressions (v2.25.18–v2.25.24 bug seeds)", () => {
  // v2.25.24 — saveFile returned bare `true` success, client did `result===true`
  // causing every error path to be silently reported as failed save.
  describe("saveFile (v2.25.24)", () => {
    it("bare true response → { saved: true }", async () => {
      const ws = await connect();
      stubHandler(ws, "extension/saveFile", true);
      const r = await client.saveFile("/a.ts");
      expect(r).toEqual({ saved: true });
      ws.close();
    });

    it("{ success:false, error } response → { saved:false, error }", async () => {
      const ws = await connect();
      stubHandler(ws, "extension/saveFile", {
        success: false,
        error: "untitled document",
      });
      const r = await client.saveFile("/a.ts");
      expect(r).toEqual({ saved: false, error: "untitled document" });
      ws.close();
    });
  });

  // v2.25.20 — closeTab always reported failure because client checked
  // `result===true` but handler returned `{ success:true, promptedToSave }`.
  describe("closeTab (v2.25.20)", () => {
    it("{ success:true, promptedToSave:false } → success:true", async () => {
      const ws = await connect();
      stubHandler(ws, "extension/closeTab", {
        success: true,
        promptedToSave: false,
      });
      const r = await client.closeTab("/a.ts");
      expect(r).toEqual({ success: true, promptedToSave: false });
      ws.close();
    });

    it("{ success:false, error } → success:false + error surfaced", async () => {
      const ws = await connect();
      stubHandler(ws, "extension/closeTab", {
        success: false,
        error: "tab not found",
      });
      const r = await client.closeTab("/missing.ts");
      expect(r).toEqual({ success: false, error: "tab not found" });
      ws.close();
    });
  });

  // v2.25.20 — formatDocument masked handler-reported errors as success
  // because proxy<T> cast the `{ error: "..." }` shape through unchecked.
  // tryRequest must unwrap error-objects to null so callers fall through
  // to their CLI formatter fallback.
  describe("formatDocument (v2.25.20)", () => {
    it("{ error } response → null (caller falls back)", async () => {
      const ws = await connect();
      stubHandler(ws, "extension/formatDocument", {
        error: "No formatter configured",
      });
      const r = await client.formatDocument("/a.ts");
      expect(r).toBeNull();
      ws.close();
    });

    it("valid success response passes through unchanged", async () => {
      const ws = await connect();
      stubHandler(ws, "extension/formatDocument", { formatted: true });
      const r = await client.formatDocument("/a.ts");
      expect(r).toEqual({ formatted: true });
      ws.close();
    });
  });

  // v2.25.20 — same shape-mismatch class as formatDocument.
  describe("fixAllLintErrors (v2.25.20)", () => {
    it("{ error } response → null (caller falls back)", async () => {
      const ws = await connect();
      stubHandler(ws, "extension/fixAllLintErrors", {
        error: "command failed",
      });
      const r = await client.fixAllLintErrors("/a.ts");
      expect(r).toBeNull();
      ws.close();
    });

    it("{ success:false, error } also unwraps to null", async () => {
      const ws = await connect();
      stubHandler(ws, "extension/fixAllLintErrors", {
        success: false,
        error: "no ESLint config",
      });
      const r = await client.fixAllLintErrors("/a.ts");
      expect(r).toBeNull();
      ws.close();
    });
  });

  // v2.25.19 — getSelection: error-object leaked as valid SelectionState.
  // (already has a test in extensionClient.test.ts; here we add the positive
  // complement to lock in the shape contract.)
  describe("getSelection (v2.25.19)", () => {
    it("valid selection shape passes through", async () => {
      const ws = await connect();
      stubHandler(ws, "extension/getSelection", {
        file: "/a.ts",
        startLine: 1,
        startColumn: 1,
        endLine: 1,
        endColumn: 5,
        selectedText: "hello",
      });
      const r = await client.getSelection();
      expect(r?.file).toBe("/a.ts");
      expect(r?.selectedText).toBe("hello");
      ws.close();
    });

    it("{ success:false, error } unwraps to null (not partial shape)", async () => {
      const ws = await connect();
      stubHandler(ws, "extension/getSelection", {
        success: false,
        error: "no active editor",
      });
      const r = await client.getSelection();
      expect(r).toBeNull();
      ws.close();
    });
  });

  // v2.25.19 — getWorkspaceFolders: handler returned `{ folders, count }`
  // while client typed as WorkspaceFolder[]. validatedRequest now unwraps.
  // Negative test: garbage shape must resolve null, not throw.
  describe("getWorkspaceFolders (v2.25.19)", () => {
    it("garbage response → null (validator rejects)", async () => {
      const ws = await connect();
      stubHandler(ws, "extension/getWorkspaceFolders", {
        unexpected: "shape",
      });
      const r = await client.getWorkspaceFolders();
      expect(r).toBeNull();
      ws.close();
    });
  });

  // v2.25.21 — writeClipboard: handler returned `{ written, byteLength }`
  // but tool's outputSchema required `success`. This test locks in that
  // requestOrNull passes the handler shape through verbatim, leaving the
  // tool-level wrapper responsible for success-normalization.
  describe("writeClipboard (v2.25.21)", () => {
    it("response shape passes through (tool wrapper normalizes)", async () => {
      const ws = await connect();
      stubHandler(ws, "extension/writeClipboard", {
        written: true,
        byteLength: 5,
      });
      const r = await client.writeClipboard("hello");
      expect(r).toEqual({ written: true, byteLength: 5 });
      ws.close();
    });
  });
});
