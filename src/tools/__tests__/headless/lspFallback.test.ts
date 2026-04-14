import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock the lspClient module
vi.mock("../../headless/lspClient.js", () => {
  const mockClient = {
    isReady: true,
    initialize: vi.fn().mockResolvedValue(undefined),
    openFile: vi.fn().mockResolvedValue(undefined),
    request: vi.fn(),
    dispose: vi.fn(),
  };
  return {
    getHeadlessLspClient: () => mockClient,
    disposeHeadlessLspClient: vi.fn(),
    _mockClient: mockClient,
  };
});

// Mock fs so openFile doesn't need a real disk
vi.mock("node:fs", () => ({
  default: {
    readFileSync: vi.fn().mockReturnValue("const x: number = 1;"),
  },
}));

import * as lspClientMod from "../../headless/lspClient.js";
import {
  lspDefinition,
  lspHover,
  lspReferences,
} from "../../headless/lspFallback.js";

// Access the mock client
const mockClient = (
  lspClientMod as unknown as {
    _mockClient: {
      request: ReturnType<typeof vi.fn>;
      openFile: ReturnType<typeof vi.fn>;
    };
  }
)._mockClient;

describe("lspDefinition", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockClient.openFile.mockResolvedValue(undefined);
  });

  it("returns locations from LSP definition response", async () => {
    mockClient.request.mockResolvedValue([
      {
        uri: "file:///workspace/src/foo.ts",
        range: {
          start: { line: 9, character: 4 },
          end: { line: 9, character: 8 },
        },
      },
    ]);

    const locs = await lspDefinition(
      "/workspace/src/bar.ts",
      5,
      10,
      "/workspace",
    );

    expect(locs).toHaveLength(1);
    expect(locs[0]).toMatchObject({
      uri: "file:///workspace/src/foo.ts",
      range: { start: { line: 9, character: 4 } },
    });
  });

  it("returns empty array when LSP returns null", async () => {
    mockClient.request.mockResolvedValue(null);
    const locs = await lspDefinition(
      "/workspace/src/bar.ts",
      1,
      1,
      "/workspace",
    );
    expect(locs).toEqual([]);
  });

  it("converts 1-based line/column to 0-based LSP position", async () => {
    mockClient.request.mockResolvedValue([]);
    await lspDefinition("/workspace/src/bar.ts", 3, 7, "/workspace");

    expect(mockClient.request).toHaveBeenCalledWith(
      "textDocument/definition",
      expect.objectContaining({
        position: { line: 2, character: 6 },
      }),
    );
  });
});

describe("lspReferences", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockClient.openFile.mockResolvedValue(undefined);
  });

  it("returns references array from LSP response", async () => {
    mockClient.request.mockResolvedValue([
      {
        uri: "file:///workspace/src/a.ts",
        range: {
          start: { line: 0, character: 0 },
          end: { line: 0, character: 5 },
        },
      },
      {
        uri: "file:///workspace/src/b.ts",
        range: {
          start: { line: 2, character: 0 },
          end: { line: 2, character: 5 },
        },
      },
    ]);

    const refs = await lspReferences("/workspace/src/a.ts", 1, 1, "/workspace");
    expect(refs).toHaveLength(2);
    expect(refs[1]!.uri).toBe("file:///workspace/src/b.ts");
  });

  it("returns empty array when LSP returns null", async () => {
    mockClient.request.mockResolvedValue(null);
    const refs = await lspReferences("/workspace/src/a.ts", 1, 1, "/workspace");
    expect(refs).toEqual([]);
  });
});

describe("lspHover", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockClient.openFile.mockResolvedValue(undefined);
  });

  it("extracts string from MarkupContent hover", async () => {
    mockClient.request.mockResolvedValue({
      contents: { kind: "markdown", value: "```ts\nconst x: number\n```" },
    });

    const text = await lspHover("/workspace/src/a.ts", 1, 1, "/workspace");
    expect(text).toBe("```ts\nconst x: number\n```");
  });

  it("extracts string from plain-string hover", async () => {
    mockClient.request.mockResolvedValue({
      contents: "const x: number",
    });

    const text = await lspHover("/workspace/src/a.ts", 1, 1, "/workspace");
    expect(text).toBe("const x: number");
  });

  it("returns null when LSP returns null", async () => {
    mockClient.request.mockResolvedValue(null);
    const text = await lspHover("/workspace/src/a.ts", 1, 1, "/workspace");
    expect(text).toBeNull();
  });

  it("joins array hover contents", async () => {
    mockClient.request.mockResolvedValue({
      contents: [
        { kind: "markdown", value: "**description**" },
        { kind: "plaintext", value: "const x: number" },
      ],
    });

    const text = await lspHover("/workspace/src/a.ts", 1, 1, "/workspace");
    expect(text).toContain("description");
    expect(text).toContain("const x");
  });
});
