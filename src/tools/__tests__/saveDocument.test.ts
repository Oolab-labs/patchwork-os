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
    // saveFile returns { saved, error? } after v2.25.24 — normalize the
    // legacy boolean test flag to the current client contract.
    saveFile: vi.fn(async () => {
      if (opts.throwTimeout) throw new ExtensionTimeoutError("timeout");
      const saved = opts.savedResult ?? true;
      return { saved };
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

  it("returns saved:false when file not open in editor (saveFile returns { saved: false })", async () => {
    const tool = createSaveDocumentTool(
      ws,
      makeClient({ connected: true, savedResult: false }),
    );
    const data = parse(await tool.handler({ filePath: `${ws}/a.ts` }));
    expect(data.success).toBe(true);
    expect(data.saved).toBe(false);
    expect(data.message).toContain("not open in VS Code");
  });

  it("surfaces handler error message when saveFile returns { saved: false, error }", async () => {
    // Regression for v2.25.24 latent bug: handler returns
    // { success: false, error: "Cannot save untitled document" } for untitled docs.
    // Before v2.25.24 the client cast `result === true` on the object → false,
    // and the consumer reported the generic "not open in editor" message,
    // hiding the real error. New client returns { saved, error? }.
    const client = {
      isConnected: vi.fn(() => true),
      saveFile: vi.fn(async () => ({
        saved: false,
        error: "Cannot save untitled document",
      })),
    } as never;
    const tool = createSaveDocumentTool(ws, client);
    const data = parse(await tool.handler({ filePath: `${ws}/a.ts` }));
    expect(data.saved).toBe(false);
    expect(data.message).toBe("Cannot save untitled document");
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
