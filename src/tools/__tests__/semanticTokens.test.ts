import { describe, expect, it, vi } from "vitest";
import { ExtensionTimeoutError } from "../../extensionClient.js";
import { createGetSemanticTokensTool } from "../semanticTokens.js";

function makeClient(
  overrides: Partial<{
    isConnected: () => boolean;
    getSemanticTokens: () => Promise<unknown>;
  }> = {},
) {
  return {
    isConnected: vi.fn(() => true),
    getSemanticTokens: vi.fn(() => Promise.resolve(null)),
    lspReadyLanguages: new Set<string>(),
    ...overrides,
  };
}

const workspace = "/tmp";

describe("getSemanticTokens", () => {
  it("returns extensionRequired error when disconnected", async () => {
    const client = makeClient({ isConnected: () => false });
    const tool = createGetSemanticTokensTool(workspace, client as never);
    const result = (await tool.handler({ filePath: "/tmp/foo.ts" })) as any;
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/extension/i);
  });

  it("returns empty result on null from extension", async () => {
    const client = makeClient({
      getSemanticTokens: () => Promise.resolve(null),
    });
    const tool = createGetSemanticTokensTool(workspace, client as never);
    const result = (await tool.handler({ filePath: "/tmp/foo.ts" })) as any;
    expect(result.isError).toBeFalsy();
    const data = JSON.parse(result.content[0].text);
    expect(data.tokens).toEqual([]);
  });

  it("returns decoded token data on success", async () => {
    const tokenData = {
      tokens: [
        {
          line: 1,
          column: 1,
          length: 3,
          type: "function",
          modifiers: ["declaration"],
        },
      ],
      count: 1,
      capped: false,
      legend: { tokenTypes: ["function"], tokenModifiers: ["declaration"] },
    };
    const client = makeClient({
      getSemanticTokens: () => Promise.resolve(tokenData),
    });
    const tool = createGetSemanticTokensTool(workspace, client as never);
    const result = (await tool.handler({ filePath: "/tmp/foo.ts" })) as any;
    expect(result.isError).toBeFalsy();
    const data = JSON.parse(result.content[0].text);
    expect(data.tokens).toHaveLength(1);
    expect(data.tokens[0].type).toBe("function");
    expect(data.tokens[0].modifiers).toContain("declaration");
  });

  it("returns cold-start error on ExtensionTimeoutError", async () => {
    const client = makeClient({
      getSemanticTokens: () =>
        Promise.reject(new ExtensionTimeoutError("timeout")),
    });
    const tool = createGetSemanticTokensTool(workspace, client as never);
    const result = (await tool.handler({ filePath: "/tmp/foo.ts" })) as any;
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/indexing|timed out/i);
  });

  it("passes optional startLine/endLine/maxTokens to extension", async () => {
    const client = makeClient();
    const tool = createGetSemanticTokensTool(workspace, client as never);
    await tool.handler({
      filePath: "/tmp/foo.ts",
      startLine: 5,
      endLine: 10,
      maxTokens: 100,
    });
    expect(client.getSemanticTokens).toHaveBeenCalledWith(
      "/tmp/foo.ts",
      5,
      10,
      100,
      undefined,
    );
  });

  it("throws on missing filePath", async () => {
    const client = makeClient();
    const tool = createGetSemanticTokensTool(workspace, client as never);
    await expect(tool.handler({})).rejects.toThrow(/filePath/i);
  });
});
