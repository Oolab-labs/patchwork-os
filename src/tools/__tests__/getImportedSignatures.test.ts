import { describe, expect, it, vi } from "vitest";
import { createGetImportedSignaturesTool } from "../getImportedSignatures.js";

const workspace = "/tmp";

function makeClient(overrides: Record<string, any> = {}) {
  return {
    isConnected: vi.fn(() => true),
    goToDefinition: vi.fn(() =>
      Promise.resolve([{ file: "/tmp/lib.ts", line: 5, column: 1 }]),
    ),
    getHover: vi.fn(() =>
      Promise.resolve({
        contents: ["function useState<T>(value: T): [T, (v: T) => void]"],
      }),
    ),
    ...overrides,
  };
}

describe("getImportedSignatures", () => {
  it("returns extensionRequired when disconnected", async () => {
    const client = makeClient({ isConnected: vi.fn(() => false) });
    const tool = createGetImportedSignaturesTool(workspace, client as never);
    const result = (await tool.handler({ filePath: "/tmp/foo.ts" })) as any;
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/extension/i);
  });

  it("returns empty for a file with no imports", async () => {
    const client = makeClient();
    const tool = createGetImportedSignaturesTool(workspace, client as never);

    // Write a temp file with no imports
    const { promises: fsp } = await import("node:fs");
    await fsp.writeFile("/tmp/no-imports.ts", "const x = 1;\n");

    const result = (await tool.handler({
      filePath: "/tmp/no-imports.ts",
    })) as any;
    expect(result.content[0]).toBeDefined();
    const data = JSON.parse(result.content[0].text);
    expect(data.count).toBe(0);
    expect(data.imports).toEqual([]);
  });

  it("resolves a single named import", async () => {
    const client = makeClient();
    const tool = createGetImportedSignaturesTool(workspace, client as never);

    const { promises: fsp } = await import("node:fs");
    await fsp.writeFile(
      "/tmp/single-import.ts",
      "import { useState } from 'react';\n",
    );

    const result = (await tool.handler({
      filePath: "/tmp/single-import.ts",
    })) as any;
    const data = JSON.parse(result.content[0].text);
    expect(data.imports).toHaveLength(1);
    expect(data.imports[0].name).toBe("useState");
    expect(data.imports[0].source).toBe("react");
    expect(data.imports[0].signature).toContain("useState");
    expect(data.resolved).toBe(1);
  });

  it("marks import as unresolved when goToDefinition returns null", async () => {
    const client = makeClient({
      goToDefinition: vi.fn(() => Promise.resolve(null)),
    });
    const tool = createGetImportedSignaturesTool(workspace, client as never);

    const { promises: fsp } = await import("node:fs");
    await fsp.writeFile(
      "/tmp/no-def.ts",
      "import { unknown } from 'some-pkg';\n",
    );

    const result = (await tool.handler({ filePath: "/tmp/no-def.ts" })) as any;
    const data = JSON.parse(result.content[0].text);
    expect(data.imports[0].signature).toBeNull();
    expect(data.imports[0].definitionFile).toBeNull();
    expect(data.unresolved).toContain("unknown");
    expect(data.resolved).toBe(0);
  });

  it("resolves multiple named imports from one statement", async () => {
    const client = makeClient();
    const tool = createGetImportedSignaturesTool(workspace, client as never);

    const { promises: fsp } = await import("node:fs");
    await fsp.writeFile(
      "/tmp/multi-import.ts",
      "import { useState, useEffect } from 'react';\n",
    );

    const result = (await tool.handler({
      filePath: "/tmp/multi-import.ts",
    })) as any;
    const data = JSON.parse(result.content[0].text);
    expect(data.imports).toHaveLength(2);
    expect(data.imports.map((i: any) => i.name)).toContain("useState");
    expect(data.imports.map((i: any) => i.name)).toContain("useEffect");
  });

  it("skips namespace imports (import * as X)", async () => {
    const client = makeClient();
    const tool = createGetImportedSignaturesTool(workspace, client as never);

    const { promises: fsp } = await import("node:fs");
    await fsp.writeFile(
      "/tmp/namespace-import.ts",
      "import * as React from 'react';\n",
    );

    const result = (await tool.handler({
      filePath: "/tmp/namespace-import.ts",
    })) as any;
    const data = JSON.parse(result.content[0].text);
    expect(data.count).toBe(0);
  });

  it("handles type imports", async () => {
    const client = makeClient();
    const tool = createGetImportedSignaturesTool(workspace, client as never);

    const { promises: fsp } = await import("node:fs");
    await fsp.writeFile(
      "/tmp/type-import.ts",
      "import type { FC } from 'react';\n",
    );

    const result = (await tool.handler({
      filePath: "/tmp/type-import.ts",
    })) as any;
    const data = JSON.parse(result.content[0].text);
    expect(data.imports).toHaveLength(1);
    expect(data.imports[0].name).toBe("FC");
  });

  it("caps at maxImports", async () => {
    const client = makeClient();
    const tool = createGetImportedSignaturesTool(workspace, client as never);

    const { promises: fsp } = await import("node:fs");
    await fsp.writeFile(
      "/tmp/many-imports.ts",
      "import { a, b, c, d, e, f } from 'pkg';\n",
    );

    const result = (await tool.handler({
      filePath: "/tmp/many-imports.ts",
      maxImports: 3,
    })) as any;
    const data = JSON.parse(result.content[0].text);
    expect(data.imports.length).toBeLessThanOrEqual(3);
  });

  it("truncates hover content to 4000 chars", async () => {
    const longSig = "x".repeat(8000);
    const client = makeClient({
      getHover: vi.fn(() => Promise.resolve({ contents: [longSig] })),
    });
    const tool = createGetImportedSignaturesTool(workspace, client as never);

    const { promises: fsp } = await import("node:fs");
    await fsp.writeFile(
      "/tmp/long-hover.ts",
      "import { bigThing } from 'pkg';\n",
    );

    const result = (await tool.handler({
      filePath: "/tmp/long-hover.ts",
    })) as any;
    const data = JSON.parse(result.content[0].text);
    expect(data.imports[0].signature!.length).toBeLessThanOrEqual(4000);
  });

  it("returns empty imports when file cannot be read", async () => {
    const client = makeClient();
    const tool = createGetImportedSignaturesTool(workspace, client as never);

    const result = (await tool.handler({
      filePath: "/tmp/nonexistent-file-xyz.ts",
    })) as any;
    const data = JSON.parse(result.content[0].text);
    expect(data.count).toBe(0);
    expect(data.message).toMatch(/cannot read/i);
  });
});
