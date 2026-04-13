import { describe, expect, it, vi } from "vitest";
import { createNavigateToSymbolByNameTool } from "../navigateToSymbolByName.js";

function parse(r: { content: Array<{ text: string }> }) {
  return JSON.parse(r.content[0]?.text ?? "{}");
}

function makeClient(opts: {
  connected?: boolean;
  searchResult?: unknown;
  definitionResult?: unknown;
  openFileResult?: boolean;
}) {
  return {
    isConnected: vi.fn(() => opts.connected ?? true),
    searchSymbols: vi.fn(async () => opts.searchResult ?? { symbols: [] }),
    goToDefinition: vi.fn(async () => opts.definitionResult ?? null),
    openFile: vi.fn(async () => opts.openFileResult ?? true),
  } as never;
}

describe("createNavigateToSymbolByNameTool", () => {
  it("returns extensionRequired error when disconnected", async () => {
    const client = makeClient({ connected: false });
    const tool = createNavigateToSymbolByNameTool(client);
    const result = await tool.handler({ query: "foo" });
    expect(result.isError).toBe(true);
  });

  it("returns { found: false } when searchSymbols returns no symbols", async () => {
    const client = makeClient({ searchResult: { symbols: [], count: 0 } });
    const tool = createNavigateToSymbolByNameTool(client);
    const data = parse(await tool.handler({ query: "foo" }));
    expect(data.found).toBe(false);
    expect(
      (client as never as { goToDefinition: { mock: { calls: unknown[] } } })
        .goToDefinition.mock.calls.length,
    ).toBe(0);
  });

  it("resolves first match and opens the definition location", async () => {
    const client = makeClient({
      searchResult: {
        symbols: [
          {
            name: "foo",
            kind: "Function",
            file: "/ws/src/foo.ts",
            line: 10,
            column: 5,
            containerName: null,
          },
          {
            name: "foo",
            kind: "Method",
            file: "/ws/src/bar.ts",
            line: 22,
            column: 3,
            containerName: "Bar",
          },
        ],
        count: 2,
      },
      definitionResult: [
        {
          file: "/ws/src/foo-impl.ts",
          line: 15,
          column: 1,
          endLine: 15,
          endColumn: 30,
        },
      ],
    });
    const tool = createNavigateToSymbolByNameTool(client);
    const data = parse(await tool.handler({ query: "foo" }));
    expect(data.found).toBe(true);
    expect(data.symbol.name).toBe("foo");
    expect(data.symbol.file).toBe("/ws/src/foo.ts");
    expect(data.definition.file).toBe("/ws/src/foo-impl.ts");
    expect(data.definition.line).toBe(15);
    expect(data.alternatives.length).toBe(1);
    expect(
      (client as never as { openFile: { mock: { calls: unknown[][] } } })
        .openFile.mock.calls[0],
    ).toEqual(["/ws/src/foo-impl.ts", 15]);
  });

  it("returns found:true with definition: null when goToDefinition returns null", async () => {
    const client = makeClient({
      searchResult: {
        symbols: [
          {
            name: "foo",
            kind: "Class",
            file: "/ws/foo.ts",
            line: 1,
            column: 1,
          },
        ],
      },
      definitionResult: null,
    });
    const tool = createNavigateToSymbolByNameTool(client);
    const data = parse(await tool.handler({ query: "foo" }));
    expect(data.found).toBe(true);
    expect(data.definition).toBe(null);
    expect(data.symbol.name).toBe("foo");
  });

  it("returns error when first symbol is missing required fields", async () => {
    const client = makeClient({
      searchResult: { symbols: [{ name: "foo" }] }, // missing file/line/column
    });
    const tool = createNavigateToSymbolByNameTool(client);
    const result = await tool.handler({ query: "foo" });
    expect(result.isError).toBe(true);
  });

  it("returns found:true with definition:null when goToDefinition returns empty array", async () => {
    const client = makeClient({
      searchResult: {
        symbols: [
          {
            name: "foo",
            kind: "Class",
            file: "/ws/foo.ts",
            line: 1,
            column: 1,
          },
        ],
      },
      definitionResult: [],
    });
    const tool = createNavigateToSymbolByNameTool(client);
    const data = parse(await tool.handler({ query: "foo" }));
    expect(data.found).toBe(true);
    expect(data.definition).toBe(null);
  });
});
