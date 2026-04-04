import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock node:fs before importing the tool
const mockExistsSync = vi.fn((_p: string) => false);
const mockReadFile = vi.fn(
  async (_p: string, _enc: string): Promise<string> => {
    throw new Error(`ENOENT: no such file: ${_p}`);
  },
);

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    default: {
      ...actual,
      existsSync: (...args: Parameters<typeof actual.existsSync>) =>
        mockExistsSync(...args),
      promises: {
        ...actual.promises,
        readFile: (...args: Parameters<typeof actual.promises.readFile>) =>
          mockReadFile(args[0] as string, args[1] as string),
      },
    },
  };
});

import { createGetImportTreeTool } from "../getImportTree.js";

const WS = "/workspace";

function parse(r: { content: Array<{ text: string }> }) {
  return JSON.parse(r.content[0]?.text ?? "{}");
}

// Helper: set up file contents and existence in the mocks
function setupFiles(files: Record<string, string>) {
  mockExistsSync.mockImplementation((p: string) => p in files);
  mockReadFile.mockImplementation(async (p: string) => {
    if (p in files) return files[p]!;
    throw Object.assign(new Error(`ENOENT: ${p}`), { code: "ENOENT" });
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("createGetImportTreeTool", () => {
  it("returns tree for a file with ES module imports", async () => {
    setupFiles({
      "/workspace/src/index.ts": `import { foo } from "./foo.ts";\nimport bar from "./bar.ts";`,
      "/workspace/src/foo.ts": "export const foo = 1;",
      "/workspace/src/bar.ts": `export default "bar";`,
    });

    const tool = createGetImportTreeTool(WS);
    const data = parse(await tool.handler({ file: "/workspace/src/index.ts" }));

    expect(data.tree).toBeTruthy();
    expect(data.tree.file).toBe("/workspace/src/index.ts");
    expect(data.tree.imports).toHaveLength(2);
    const importFiles = data.tree.imports.map((n: { file: string }) => n.file);
    expect(importFiles).toContain("/workspace/src/foo.ts");
    expect(importFiles).toContain("/workspace/src/bar.ts");
    expect(data.totalFiles).toBe(3);
  });

  it("handles files with no imports", async () => {
    setupFiles({
      "/workspace/src/leaf.ts": "export const x = 42;",
    });

    const tool = createGetImportTreeTool(WS);
    const data = parse(await tool.handler({ file: "/workspace/src/leaf.ts" }));

    expect(data.tree.imports).toHaveLength(0);
    expect(data.cycles).toHaveLength(0);
    expect(data.totalFiles).toBe(1);
  });

  it("detects and marks circular imports", async () => {
    setupFiles({
      "/workspace/src/a.ts": `import { b } from "./b.ts";`,
      "/workspace/src/b.ts": `import { a } from "./a.ts";`,
    });

    const tool = createGetImportTreeTool(WS);
    const data = parse(
      await tool.handler({ file: "/workspace/src/a.ts", maxDepth: 5 }),
    );

    expect(data.cycles.length).toBeGreaterThan(0);
    // The cycle node should have cycle: true
    const bNode = data.tree.imports.find(
      (n: { file: string }) => n.file === "/workspace/src/b.ts",
    );
    expect(bNode).toBeTruthy();
    const cycleNode = bNode.imports.find(
      (n: { cycle?: boolean }) => n.cycle === true,
    );
    expect(cycleNode).toBeTruthy();
  });

  it("respects maxDepth", async () => {
    setupFiles({
      "/workspace/src/a.ts": `import "./b.ts";`,
      "/workspace/src/b.ts": `import "./c.ts";`,
      "/workspace/src/c.ts": `import "./d.ts";`,
      "/workspace/src/d.ts": "export const deep = true;",
    });

    const tool = createGetImportTreeTool(WS);
    // maxDepth=1: only a.ts -> b.ts, b's children not explored
    const data = parse(
      await tool.handler({ file: "/workspace/src/a.ts", maxDepth: 1 }),
    );
    const bNode = data.tree.imports.find(
      (n: { file: string }) => n.file === "/workspace/src/b.ts",
    );
    expect(bNode).toBeTruthy();
    expect(bNode.imports).toHaveLength(0); // depth limit hit
  });

  it("excludes external packages when includeExternal: false", async () => {
    setupFiles({
      "/workspace/src/index.ts": `import React from "react";\nimport { join } from "path";`,
    });

    const tool = createGetImportTreeTool(WS);
    const data = parse(
      await tool.handler({
        file: "/workspace/src/index.ts",
        includeExternal: false,
      }),
    );
    expect(data.tree.external).toBeUndefined();
    expect(data.tree.imports).toHaveLength(0);
  });

  it("includes external packages when includeExternal: true", async () => {
    setupFiles({
      "/workspace/src/index.ts": `import React from "react";\nimport { readFile } from "node:fs/promises";`,
    });

    const tool = createGetImportTreeTool(WS);
    const data = parse(
      await tool.handler({
        file: "/workspace/src/index.ts",
        includeExternal: true,
      }),
    );
    // external is now a flat root-level array, not per-node
    expect(Array.isArray(data.external)).toBe(true);
    expect(data.external).toContain("react");
    expect(data.external).toContain("node:fs/promises");
    expect(data.tree.external).toBeUndefined();
  });

  it("includes both local and external when includeExternal: true", async () => {
    setupFiles({
      "/workspace/src/app.ts": `import { helper } from "./helper.ts";\nimport express from "express";`,
      "/workspace/src/helper.ts": "export const helper = () => {};",
    });

    const tool = createGetImportTreeTool(WS);
    const data = parse(
      await tool.handler({
        file: "/workspace/src/app.ts",
        includeExternal: true,
      }),
    );
    expect(data.tree.imports).toHaveLength(1);
    // external is now flat at root level
    expect(data.external).toContain("express");
    expect(data.tree.external).toBeUndefined();
  });
});
