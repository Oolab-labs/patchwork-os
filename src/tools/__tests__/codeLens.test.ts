import { describe, expect, it, vi } from "vitest";
import { ExtensionTimeoutError } from "../../extensionClient.js";
import { createGetCodeLensTool } from "../codeLens.js";

function makeClient(
  overrides: Partial<{
    isConnected: () => boolean;
    getCodeLens: () => Promise<unknown>;
  }> = {},
) {
  return {
    isConnected: vi.fn(() => true),
    getCodeLens: vi.fn(() => Promise.resolve(null)),
    lspReadyLanguages: new Set<string>(),
    ...overrides,
  };
}

const workspace = "/tmp";

describe("getCodeLens", () => {
  it("returns extensionRequired error when disconnected", async () => {
    const client = makeClient({ isConnected: () => false });
    const tool = createGetCodeLensTool(workspace, client as never);
    const result = (await tool.handler({ filePath: "/tmp/foo.ts" })) as any;
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/extension/i);
  });

  it("returns empty lenses on null from extension", async () => {
    const client = makeClient({ getCodeLens: () => Promise.resolve(null) });
    const tool = createGetCodeLensTool(workspace, client as never);
    const result = (await tool.handler({ filePath: "/tmp/foo.ts" })) as any;
    expect(result.isError).toBeFalsy();
    const data = JSON.parse(result.content[0].text);
    expect(data.lenses).toEqual([]);
    expect(data.count).toBe(0);
  });

  it("returns code lens data on success", async () => {
    const lensData = {
      lenses: [
        {
          line: 5,
          column: 1,
          endLine: 5,
          endColumn: 20,
          command: "2 references",
        },
      ],
      count: 1,
    };
    const client = makeClient({ getCodeLens: () => Promise.resolve(lensData) });
    const tool = createGetCodeLensTool(workspace, client as never);
    const result = (await tool.handler({ filePath: "/tmp/foo.ts" })) as any;
    expect(result.isError).toBeFalsy();
    const data = JSON.parse(result.content[0].text);
    expect(data.lenses).toHaveLength(1);
    expect(data.lenses[0].command).toBe("2 references");
    expect(data.lenses[0].commandId).toBeUndefined();
  });

  it("returns cold-start error on ExtensionTimeoutError", async () => {
    const client = makeClient({
      getCodeLens: () => Promise.reject(new ExtensionTimeoutError("timeout")),
    });
    const tool = createGetCodeLensTool(workspace, client as never);
    const result = (await tool.handler({ filePath: "/tmp/foo.ts" })) as any;
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/indexing|timed out/i);
  });

  it("throws on missing filePath", async () => {
    const client = makeClient();
    const tool = createGetCodeLensTool(workspace, client as never);
    await expect(tool.handler({})).rejects.toThrow(/filePath/i);
  });
});
