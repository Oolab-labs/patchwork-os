import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createGetDocumentLinksTool } from "../documentLinks.js";

// resolveFilePath requires real workspace + file on disk for symlink-containment
// check (lstat / realpathSync). Hard-coding "/tmp/foo.ts" breaks on Win32 where
// "/tmp" resolves to "D:\tmp".
let workspace: string;
let filePath: string;

beforeAll(() => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), "doc-links-"));
  filePath = path.join(workspace, "foo.ts");
  fs.writeFileSync(filePath, "export const x = 1;\n");
});

afterAll(() => {
  fs.rmSync(workspace, { recursive: true, force: true });
});

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
            target: "https://example.com/foo",
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
    const result = (await tool.handler({ filePath })) as any;
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/extension/i);
  });

  it("returns empty links when extension returns null", async () => {
    const client = makeClient({
      getDocumentLinks: vi.fn(() => Promise.resolve(null)),
    });
    const tool = createGetDocumentLinksTool(workspace, client as never);
    const result = (await tool.handler({ filePath })) as any;
    const data = JSON.parse(result.content[0].text);
    expect(data.links).toEqual([]);
    expect(data.count).toBe(0);
  });

  it("passes through result on success", async () => {
    const client = makeClient();
    const tool = createGetDocumentLinksTool(workspace, client as never);
    const result = (await tool.handler({ filePath })) as any;
    const data = JSON.parse(result.content[0].text);
    expect(data.links).toHaveLength(1);
    expect(data.links[0].target).toBe("https://example.com/foo");
  });

  it("throws when filePath is missing", async () => {
    const client = makeClient();
    const tool = createGetDocumentLinksTool(workspace, client as never);
    await expect(tool.handler({})).rejects.toThrow("filePath");
  });

  it("calls getDocumentLinks with resolved path", async () => {
    const client = makeClient();
    const tool = createGetDocumentLinksTool(workspace, client as never);
    await tool.handler({ filePath });
    expect(client.getDocumentLinks).toHaveBeenCalledWith(filePath, undefined);
  });
});
