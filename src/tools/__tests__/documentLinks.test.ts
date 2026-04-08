import { describe, expect, it, vi } from "vitest";
import { createGetDocumentLinksTool } from "../documentLinks.js";

const workspace = "/tmp";

function makeClient(overrides: Record<string, any> = {}) {
  return {
    isConnected: vi.fn(() => true),
    getDocumentLinks: vi.fn(() =>
      Promise.resolve({
        links: [
          {
            line: 1,
            column: 1,
            endLine: 1,
            endColumn: 10,
            target: "/tmp/foo.ts",
          },
        ],
        count: 1,
      }),
    ),
    ...overrides,
  };
}

describe("getDocumentLinks", () => {
  it("returns extensionRequired when disconnected", async () => {
    const client = makeClient({ isConnected: vi.fn(() => false) });
    const tool = createGetDocumentLinksTool(workspace, client as never);
    const result = (await tool.handler({ filePath: "/tmp/foo.ts" })) as any;
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/extension/i);
  });

  it("returns empty links when extension returns null", async () => {
    const client = makeClient({
      getDocumentLinks: vi.fn(() => Promise.resolve(null)),
    });
    const tool = createGetDocumentLinksTool(workspace, client as never);
    const result = (await tool.handler({ filePath: "/tmp/foo.ts" })) as any;
    const data = JSON.parse(result.content[0].text);
    expect(data.links).toEqual([]);
    expect(data.count).toBe(0);
  });

  it("passes through result on success", async () => {
    const client = makeClient();
    const tool = createGetDocumentLinksTool(workspace, client as never);
    const result = (await tool.handler({ filePath: "/tmp/foo.ts" })) as any;
    const data = JSON.parse(result.content[0].text);
    expect(data.links).toHaveLength(1);
    expect(data.links[0].target).toBe("/tmp/foo.ts");
  });

  it("throws when filePath is missing", async () => {
    const client = makeClient();
    const tool = createGetDocumentLinksTool(workspace, client as never);
    await expect(tool.handler({})).rejects.toThrow("filePath");
  });

  it("calls getDocumentLinks with resolved path", async () => {
    const client = makeClient();
    const tool = createGetDocumentLinksTool(workspace, client as never);
    await tool.handler({ filePath: "/tmp/foo.ts" });
    expect(client.getDocumentLinks).toHaveBeenCalledWith(
      "/tmp/foo.ts",
      undefined,
    );
  });
});
