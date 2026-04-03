import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { ExtensionTimeoutError } from "../../extensionClient.js";
import { createSignatureHelpTool } from "../signatureHelp.js";

let workspace: string;
let testFilePath: string;

beforeAll(() => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), "signatureHelp-test-"));
  testFilePath = path.join(workspace, "test.ts");
  fs.writeFileSync(testFilePath, "foo(a, b);\n");
});

afterAll(() => {
  fs.rmSync(workspace, { recursive: true, force: true });
});

function makeClient(opts: {
  connected: boolean;
  result?: object | null;
  throwTimeout?: boolean;
}) {
  return {
    isConnected: vi.fn(() => opts.connected),
    signatureHelp: vi.fn(async () => {
      if (opts.throwTimeout) throw new ExtensionTimeoutError("timeout");
      return opts.result ?? null;
    }),
  } as any;
}

function parse(r: { content: Array<{ text: string }> }) {
  return JSON.parse(r.content[0]?.text ?? "{}");
}

describe("createSignatureHelpTool", () => {
  it("returns found:true with signature data when a call site is matched", async () => {
    const sigData = {
      activeSignature: 0,
      activeParameter: 1,
      signatures: [
        {
          label: "foo(a: string, b: number)",
          documentation: null,
          parameters: [
            { label: "a: string", documentation: null },
            { label: "b: number", documentation: null },
          ],
        },
      ],
    };
    const tool = createSignatureHelpTool(
      workspace,
      makeClient({ connected: true, result: sigData }),
    );
    const result = await tool.handler({
      filePath: testFilePath,
      line: 1,
      column: 5,
    });
    expect(result.isError).toBeFalsy();
    const data = parse(result);
    expect(data.found).toBe(true);
    expect(data.activeSignature).toBe(0);
    expect(data.activeParameter).toBe(1);
    expect(data.signatures).toHaveLength(1);
    expect(data.signatures[0].label).toBe("foo(a: string, b: number)");
    expect(data.signatures[0].parameters).toHaveLength(2);
  });

  it("returns found:false when extension returns null (not at a call site)", async () => {
    const tool = createSignatureHelpTool(
      workspace,
      makeClient({ connected: true, result: null }),
    );
    const result = await tool.handler({
      filePath: testFilePath,
      line: 1,
      column: 5,
    });
    expect(result.isError).toBeFalsy();
    const data = parse(result);
    expect(data.found).toBe(false);
  });

  it("returns cold start error when extension times out", async () => {
    const tool = createSignatureHelpTool(
      workspace,
      makeClient({ connected: true, throwTimeout: true }),
    );
    const result = await tool.handler({
      filePath: testFilePath,
      line: 1,
      column: 5,
    });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("timed out");
  });

  it("returns extensionRequired error when extension is disconnected", async () => {
    const tool = createSignatureHelpTool(
      workspace,
      makeClient({ connected: false }),
    );
    const result = await tool.handler({
      filePath: testFilePath,
      line: 1,
      column: 5,
    });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("extension");
  });
});
