import { describe, expect, it, vi } from "vitest";
import { ExtensionTimeoutError } from "../../extensionClient.js";
import { createSaveDocumentTool } from "../saveDocument.js";

function parse(r: { content: Array<{ text: string }> }) {
  return JSON.parse(r.content[0]?.text ?? "{}");
}

import os from "node:os";
const ws = os.tmpdir();

function makeClient(opts: {
  connected: boolean;
  savedResult?: boolean;
  throwTimeout?: boolean;
}) {
  return {
    isConnected: vi.fn(() => opts.connected),
    saveFile: vi.fn(async () => {
      if (opts.throwTimeout) throw new ExtensionTimeoutError("timeout");
      return opts.savedResult ?? true;
    }),
  } as any;
}

describe("createSaveDocumentTool", () => {
  it("returns no-op when extension not provided", async () => {
    const tool = createSaveDocumentTool(ws);
    const data = parse(await tool.handler({ filePath: `${ws}/a.ts` }));
    expect(data.success).toBe(true);
    expect(data.saved).toBe(false);
    expect(data.message).toContain("Extension not connected");
  });

  it("returns no-op when extension disconnected", async () => {
    const tool = createSaveDocumentTool(ws, makeClient({ connected: false }));
    const data = parse(await tool.handler({ filePath: `${ws}/a.ts` }));
    expect(data.success).toBe(true);
    expect(data.saved).toBe(false);
  });

  it("returns saved:true when extension saves buffer successfully", async () => {
    const tool = createSaveDocumentTool(
      ws,
      makeClient({ connected: true, savedResult: true }),
    );
    const data = parse(await tool.handler({ filePath: `${ws}/a.ts` }));
    expect(data.success).toBe(true);
    expect(data.saved).toBe(true);
    expect(data.source).toBe("vscode-buffer");
  });

  it("returns saved:false when file not open in editor (saveFile returns false)", async () => {
    const tool = createSaveDocumentTool(
      ws,
      makeClient({ connected: true, savedResult: false }),
    );
    const data = parse(await tool.handler({ filePath: `${ws}/a.ts` }));
    expect(data.success).toBe(true);
    expect(data.saved).toBe(false);
    expect(data.message).toContain("not open in VS Code");
  });

  it("falls back to no-op on ExtensionTimeoutError", async () => {
    const tool = createSaveDocumentTool(
      ws,
      makeClient({ connected: true, throwTimeout: true }),
    );
    const data = parse(await tool.handler({ filePath: `${ws}/a.ts` }));
    expect(data.success).toBe(true);
    expect(data.saved).toBe(false);
  });

  it("re-throws non-timeout errors", async () => {
    const client = {
      isConnected: vi.fn(() => true),
      saveFile: vi.fn(async () => {
        throw new Error("unexpected");
      }),
    } as any;
    const tool = createSaveDocumentTool(ws, client);
    await expect(tool.handler({ filePath: `${ws}/a.ts` })).rejects.toThrow(
      "unexpected",
    );
  });

  it("throws when filePath is missing", async () => {
    const tool = createSaveDocumentTool(ws);
    await expect(tool.handler({})).rejects.toThrow();
  });
});
