import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock child_process spawn before importing the module under test
const mockProc = {
  stdin: {
    write: vi.fn(),
  },
  stdout: new EventEmitter(),
  stderr: new EventEmitter(),
  kill: vi.fn(),
  on: vi.fn(),
  pid: 12345,
};

vi.mock("node:child_process", () => ({
  spawn: vi.fn(() => mockProc),
}));

import { spawn } from "node:child_process";
import {
  disposeHeadlessLspClient,
  getHeadlessLspClient,
  HeadlessLspClient,
} from "../../headless/lspClient.js";

/** Helper: emit a Content-Length framed LSP message on stdout. */
function emitLspMessage(obj: unknown) {
  const body = JSON.stringify(obj);
  const frame = `Content-Length: ${Buffer.byteLength(body, "utf-8")}\r\n\r\n${body}`;
  mockProc.stdout.emit("data", Buffer.from(frame));
}

function buildInitResult(id: number) {
  return {
    jsonrpc: "2.0",
    id,
    result: {
      capabilities: {
        hoverProvider: true,
        definitionProvider: true,
        referencesProvider: true,
      },
    },
  };
}

describe("HeadlessLspClient", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset event listeners on the mock stdout EventEmitter
    mockProc.stdout.removeAllListeners();
    // Reset proc.on mock — collect registered callbacks
    mockProc.on.mockImplementation((_event: string, _cb: unknown) => {});
    disposeHeadlessLspClient();
  });

  afterEach(() => {
    disposeHeadlessLspClient();
  });

  it("initializes successfully when spawn succeeds and server responds", async () => {
    const client = new HeadlessLspClient();

    // Simulate the server responding to initialize (id=1)
    const initPromise = client.initialize("/workspace");

    // The client sent the initialize request — respond immediately
    await Promise.resolve(); // flush microtask queue
    emitLspMessage(buildInitResult(1));

    await initPromise;
    expect(client.isReady).toBe(true);
    expect(spawn).toHaveBeenCalledWith(
      "typescript-language-server",
      ["--stdio"],
      expect.any(Object),
    );
  });

  it("rejects with helpful message when spawn throws", async () => {
    vi.mocked(spawn).mockImplementationOnce(() => {
      throw new Error("ENOENT: typescript-language-server not found");
    });

    const client = new HeadlessLspClient();
    await expect(client.initialize("/workspace")).rejects.toThrow(
      "typescript-language-server not available",
    );
  });

  it("times out a request that receives no response", async () => {
    const client = new HeadlessLspClient();

    // First initialize (id=1) → respond so we can reach request()
    const initPromise = client.initialize("/workspace");
    await Promise.resolve();
    emitLspMessage(buildInitResult(1));
    await initPromise;

    // Now send a request with 100ms timeout — no response emitted
    await expect(client.request("textDocument/hover", {}, 100)).rejects.toThrow(
      "timed out",
    );
  });

  it("dispatches response to correct pending request by id", async () => {
    const client = new HeadlessLspClient();

    const initPromise = client.initialize("/workspace");
    await Promise.resolve();
    emitLspMessage(buildInitResult(1));
    await initPromise;

    // Send a hover request (id=2) and respond
    const reqPromise = client.request("textDocument/hover", {
      textDocument: { uri: "file:///foo.ts" },
      position: { line: 0, character: 0 },
    });

    emitLspMessage({
      jsonrpc: "2.0",
      id: 2,
      result: {
        contents: { kind: "markdown", value: "```ts\nconst x: number\n```" },
      },
    });

    const result = await reqPromise;
    expect(result).toMatchObject({
      contents: { value: expect.stringContaining("const x") },
    });
  });

  it("singleton getHeadlessLspClient returns the same instance", () => {
    const a = getHeadlessLspClient();
    const b = getHeadlessLspClient();
    expect(a).toBe(b);
  });

  it("disposeHeadlessLspClient resets singleton", () => {
    const a = getHeadlessLspClient();
    disposeHeadlessLspClient();
    const b = getHeadlessLspClient();
    expect(a).not.toBe(b);
  });

  it("rejects pending requests on dispose", async () => {
    const client = new HeadlessLspClient();

    const initPromise = client.initialize("/workspace");
    await Promise.resolve();
    emitLspMessage(buildInitResult(1));
    await initPromise;

    const reqPromise = client.request("textDocument/hover", {}, 5000);
    client.dispose();

    await expect(reqPromise).rejects.toThrow("disposed");
  });
});
