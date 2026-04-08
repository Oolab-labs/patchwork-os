import { beforeEach, describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";
import { handleGetDocumentLinks } from "../../handlers/documentLinks";
import { __reset, Range } from "../__mocks__/vscode";

beforeEach(() => {
  __reset();
});

function _makeLink(
  startLine: number,
  startChar: number,
  target: string | undefined,
) {
  return {
    range: new Range(startLine, startChar, startLine, startChar + 10),
    target: target
      ? {
          scheme: target.startsWith("file://")
            ? "file"
            : target.startsWith("https")
              ? "https"
              : "vscode",
          fsPath: target.replace("file://", ""),
          toString: () => target,
          authority:
            new URL(target.startsWith("file://") ? "https://x" : target)
              .hostname ?? "",
        }
      : undefined,
  };
}

function makeFileLink(startLine: number, startChar: number, fsPath: string) {
  return {
    range: new Range(startLine, startChar, startLine, startChar + 10),
    target: {
      scheme: "file",
      fsPath,
      toString: () => `file://${fsPath}`,
      authority: "",
    },
  };
}

function makeHttpLink(
  startLine: number,
  startChar: number,
  url: string,
  host: string,
) {
  return {
    range: new Range(startLine, startChar, startLine, startChar + 10),
    target: {
      scheme: "https",
      fsPath: "",
      toString: () => url,
      authority: host,
    },
  };
}

describe("handleGetDocumentLinks", () => {
  it("throws when file param is missing", async () => {
    await expect(handleGetDocumentLinks({})).rejects.toThrow(
      "file is required",
    );
  });

  it("returns empty links when provider returns null", async () => {
    vi.mocked(vscode.commands.executeCommand).mockResolvedValue(null);
    const result = (await handleGetDocumentLinks({ file: "/foo.ts" })) as any;
    expect(result.links).toEqual([]);
    expect(result.count).toBe(0);
  });

  it("returns empty links when provider returns empty array", async () => {
    vi.mocked(vscode.commands.executeCommand).mockResolvedValue([]);
    const result = (await handleGetDocumentLinks({ file: "/foo.ts" })) as any;
    expect(result.links).toEqual([]);
  });

  it("serializes file links within workspace with 1-based line/column", async () => {
    vi.mocked(vscode.workspace as any).workspaceFolders = [
      { uri: { fsPath: "/workspace" } },
    ];
    vi.mocked(vscode.commands.executeCommand).mockResolvedValue([
      makeFileLink(2, 0, "/workspace/src/foo.ts"),
    ]);
    const result = (await handleGetDocumentLinks({
      file: "/workspace/index.ts",
    })) as any;
    expect(result.links).toHaveLength(1);
    expect(result.links[0].line).toBe(3);
    expect(result.links[0].column).toBe(1);
    expect(result.links[0].target).toBe("/workspace/src/foo.ts");
  });

  it("omits file links outside the workspace", async () => {
    vi.mocked(vscode.workspace as any).workspaceFolders = [
      { uri: { fsPath: "/workspace" } },
    ];
    vi.mocked(vscode.commands.executeCommand).mockResolvedValue([
      makeFileLink(0, 0, "/etc/passwd"),
    ]);
    const result = (await handleGetDocumentLinks({
      file: "/workspace/index.ts",
    })) as any;
    expect(result.links[0].target).toBeNull();
  });

  it("includes public https links", async () => {
    vi.mocked(vscode.workspace as any).workspaceFolders = [
      { uri: { fsPath: "/workspace" } },
    ];
    vi.mocked(vscode.commands.executeCommand).mockResolvedValue([
      makeHttpLink(0, 0, "https://example.com/docs", "example.com"),
    ]);
    const result = (await handleGetDocumentLinks({
      file: "/workspace/index.ts",
    })) as any;
    expect(result.links[0].target).toBe("https://example.com/docs");
  });

  it("redacts private/internal https links (localhost)", async () => {
    vi.mocked(vscode.workspace as any).workspaceFolders = [
      { uri: { fsPath: "/workspace" } },
    ];
    vi.mocked(vscode.commands.executeCommand).mockResolvedValue([
      makeHttpLink(0, 0, "http://localhost:3000/api", "localhost"),
    ]);
    const result = (await handleGetDocumentLinks({
      file: "/workspace/index.ts",
    })) as any;
    expect(result.links[0].target).toBeNull();
  });

  it("caps output at 100 links", async () => {
    vi.mocked(vscode.workspace as any).workspaceFolders = [
      { uri: { fsPath: "/workspace" } },
    ];
    const manyLinks = Array.from({ length: 150 }, (_, i) =>
      makeFileLink(i, 0, `/workspace/f${i}.ts`),
    );
    vi.mocked(vscode.commands.executeCommand).mockResolvedValue(manyLinks);
    const result = (await handleGetDocumentLinks({
      file: "/workspace/index.ts",
    })) as any;
    expect(result.links).toHaveLength(100);
    expect(result.count).toBe(100);
  });

  it("returns unavailable message when provider throws", async () => {
    vi.mocked(vscode.commands.executeCommand).mockRejectedValue(
      new Error("no provider"),
    );
    const result = (await handleGetDocumentLinks({ file: "/foo.ts" })) as any;
    expect(result.links).toEqual([]);
    expect(result.message).toMatch(/unavailable/i);
  });

  it("calls executeLinkProvider with linkResolveCount=100", async () => {
    vi.mocked(vscode.commands.executeCommand).mockResolvedValue([]);
    await handleGetDocumentLinks({ file: "/foo.ts" });
    expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
      "vscode.executeLinkProvider",
      expect.anything(),
      100,
    );
  });
});
