import os from "node:os";
import { describe, expect, it, vi } from "vitest";
import {
  createFindReferencesTool,
  createGetCallHierarchyTool,
} from "../lsp.js";

const WS = os.tmpdir();
const FILE = `${WS}/app.ts`;

function makeExtensionClient(overrides: Record<string, unknown> = {}) {
  return {
    isConnected: () => true,
    lspReadyLanguages: new Set(["typescript"]),
    findReferences: vi.fn(),
    getCallHierarchy: vi.fn(),
    ...overrides,
  };
}

function parseTool(result: { content: unknown }) {
  return JSON.parse((result.content as Array<{ text: string }>)[0]!.text);
}

function makeRefs(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    uri: `file://${WS}/file${i}.ts`,
    range: {
      start: { line: i, character: 0 },
      end: { line: i, character: 10 },
    },
  }));
}

describe("findReferences cursor pagination", () => {
  it("first page returns results and nextCursor when more exist", async () => {
    const refs = makeRefs(150);
    const client = makeExtensionClient({
      findReferences: vi.fn(async () => ({ found: true, references: refs })),
    });
    const tool = createFindReferencesTool(WS, client as never);
    const result = await tool.handler({ filePath: FILE, line: 1, column: 1 });
    const out = parseTool(result);
    expect(out.found).toBe(true);
    expect(out.references).toHaveLength(100);
    expect(out.total).toBe(150);
    expect(typeof out.nextCursor).toBe("string");
  });

  it("second page returns remaining items and no nextCursor", async () => {
    const refs = makeRefs(150);
    const client = makeExtensionClient({
      findReferences: vi.fn(async () => ({ found: true, references: refs })),
    });
    const tool = createFindReferencesTool(WS, client as never);
    const first = await tool.handler({ filePath: FILE, line: 1, column: 1 });
    const { nextCursor } = parseTool(first);
    const second = await tool.handler({
      filePath: FILE,
      line: 1,
      column: 1,
      cursor: nextCursor,
    });
    const out = parseTool(second);
    expect(out.references).toHaveLength(50);
    expect(out.total).toBe(150);
    expect(out.nextCursor).toBeUndefined();
  });

  it("all pages combined equal full result", async () => {
    const refs = makeRefs(150);
    const client = makeExtensionClient({
      findReferences: vi.fn(async () => ({ found: true, references: refs })),
    });
    const tool = createFindReferencesTool(WS, client as never);
    const p1 = parseTool(
      await tool.handler({ filePath: FILE, line: 1, column: 1 }),
    );
    const p2 = parseTool(
      await tool.handler({
        filePath: FILE,
        line: 1,
        column: 1,
        cursor: p1.nextCursor,
      }),
    );
    expect(p1.references.length + p2.references.length).toBe(150);
  });

  it("malformed cursor falls back to offset 0", async () => {
    const refs = makeRefs(10);
    const client = makeExtensionClient({
      findReferences: vi.fn(async () => ({ found: true, references: refs })),
    });
    const tool = createFindReferencesTool(WS, client as never);
    const result = await tool.handler({
      filePath: FILE,
      line: 1,
      column: 1,
      cursor: "!!!bad!!!",
    });
    const out = parseTool(result);
    expect(out.references).toHaveLength(10);
  });

  it("small result set has no nextCursor", async () => {
    const refs = makeRefs(5);
    const client = makeExtensionClient({
      findReferences: vi.fn(async () => ({ found: true, references: refs })),
    });
    const tool = createFindReferencesTool(WS, client as never);
    const result = await tool.handler({ filePath: FILE, line: 1, column: 1 });
    const out = parseTool(result);
    expect(out.nextCursor).toBeUndefined();
    expect(out.references).toHaveLength(5);
  });
});

describe("getCallHierarchy cursor pagination", () => {
  it("first page returns nextCursor when incoming > 50", async () => {
    const incoming = Array.from({ length: 80 }, (_, i) => ({ name: `fn${i}` }));
    const outgoing = Array.from({ length: 10 }, (_, i) => ({
      name: `dep${i}`,
    }));
    const client = makeExtensionClient({
      getCallHierarchy: vi.fn(async () => ({
        found: true,
        incoming,
        outgoing,
      })),
    });
    const tool = createGetCallHierarchyTool(WS, client as never);
    const result = await tool.handler({ filePath: FILE, line: 1, column: 1 });
    const out = parseTool(result);
    expect(out.incoming).toHaveLength(50);
    expect(out.incomingTotal).toBe(80);
    expect(out.outgoingTotal).toBe(10);
    expect(typeof out.nextCursor).toBe("string");
  });

  it("second page returns remaining callers", async () => {
    const incoming = Array.from({ length: 80 }, (_, i) => ({ name: `fn${i}` }));
    const outgoing: unknown[] = [];
    const client = makeExtensionClient({
      getCallHierarchy: vi.fn(async () => ({
        found: true,
        incoming,
        outgoing,
      })),
    });
    const tool = createGetCallHierarchyTool(WS, client as never);
    const first = parseTool(
      await tool.handler({ filePath: FILE, line: 1, column: 1 }),
    );
    const second = parseTool(
      await tool.handler({
        filePath: FILE,
        line: 1,
        column: 1,
        cursor: first.nextCursor,
      }),
    );
    expect(second.incoming).toHaveLength(30);
    expect(second.nextCursor).toBeUndefined();
  });
});
