import { beforeEach, describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";
import { handleGetTypeHierarchy } from "../../handlers/typeHierarchy";
import { __reset } from "../__mocks__/vscode";

beforeEach(() => {
  __reset();
});

function makeItem(
  name: string,
  kind: number,
  fsPath: string,
  line: number,
  character: number,
) {
  return {
    name,
    kind,
    uri: { fsPath, toString: () => `file://${fsPath}` },
    selectionRange: {
      start: new vscode.Position(line, character),
      end: new vscode.Position(line, character + name.length),
    },
  };
}

const BASE_PARAMS = { file: "/src/Animal.ts", line: 5, column: 10 };

describe("handleGetTypeHierarchy", () => {
  it("throws when file param is missing", async () => {
    await expect(
      handleGetTypeHierarchy({ line: 5, column: 10 }),
    ).rejects.toThrow("file is required");
  });

  it("throws when line param is missing", async () => {
    await expect(
      handleGetTypeHierarchy({ file: "/foo.ts", column: 10 }),
    ).rejects.toThrow("line is required");
  });

  it("throws when column param is missing", async () => {
    await expect(
      handleGetTypeHierarchy({ file: "/foo.ts", line: 5 }),
    ).rejects.toThrow("column is required");
  });

  it("returns {found:false} when prepareTypeHierarchy throws", async () => {
    vi.mocked(vscode.commands.executeCommand).mockRejectedValue(
      new Error("provider unavailable"),
    );
    const result = (await handleGetTypeHierarchy(BASE_PARAMS)) as any;
    expect(result.found).toBe(false);
    expect(result.message).toMatch(/unavailable/i);
  });

  it("returns {found:false} when prepareTypeHierarchy returns null", async () => {
    vi.mocked(vscode.commands.executeCommand).mockResolvedValue(null);
    const result = (await handleGetTypeHierarchy(BASE_PARAMS)) as any;
    expect(result.found).toBe(false);
  });

  it("returns {found:false} when prepareTypeHierarchy returns empty array", async () => {
    vi.mocked(vscode.commands.executeCommand).mockResolvedValue([]);
    const result = (await handleGetTypeHierarchy(BASE_PARAMS)) as any;
    expect(result.found).toBe(false);
  });

  it("returns {found:true, root} with serialized item (name, kind as string, file, 1-based line/col)", async () => {
    const rootItem = makeItem(
      "Animal",
      vscode.SymbolKind.Class,
      "/src/Animal.ts",
      3,
      6,
    );
    vi.mocked(vscode.commands.executeCommand)
      .mockResolvedValueOnce([rootItem]) // prepareTypeHierarchy
      .mockResolvedValueOnce([]) // provideSupertypes
      .mockResolvedValueOnce([]); // provideSubtypes

    const result = (await handleGetTypeHierarchy(BASE_PARAMS)) as any;
    expect(result.found).toBe(true);
    expect(result.root.name).toBe("Animal");
    expect(result.root.kind).toBe("Class"); // SymbolKind[4] = "Class"
    expect(result.root.file).toBe("/src/Animal.ts");
    expect(result.root.line).toBe(4); // 3 + 1
    expect(result.root.column).toBe(7); // 6 + 1
  });

  it("fetches both supertypes and subtypes when direction='both' (default)", async () => {
    const rootItem = makeItem("Animal", 4, "/src/Animal.ts", 0, 0);
    const parent = makeItem("LivingThing", 4, "/src/LivingThing.ts", 0, 0);
    const child = makeItem("Dog", 4, "/src/Dog.ts", 0, 0);

    vi.mocked(vscode.commands.executeCommand)
      .mockResolvedValueOnce([rootItem]) // prepareTypeHierarchy
      .mockResolvedValueOnce([parent]) // provideSupertypes
      .mockResolvedValueOnce([child]); // provideSubtypes

    const result = (await handleGetTypeHierarchy(BASE_PARAMS)) as any;
    expect(result.supertypes).toHaveLength(1);
    expect(result.supertypes[0].name).toBe("LivingThing");
    expect(result.subtypes).toHaveLength(1);
    expect(result.subtypes[0].name).toBe("Dog");
    expect(result.direction).toBe("both");
  });

  it("fetches only supertypes when direction='supertypes' and does NOT call provideSubtypes", async () => {
    const rootItem = makeItem("Animal", 4, "/src/Animal.ts", 0, 0);
    const parent = makeItem("LivingThing", 4, "/src/LivingThing.ts", 0, 0);

    vi.mocked(vscode.commands.executeCommand)
      .mockResolvedValueOnce([rootItem]) // prepareTypeHierarchy
      .mockResolvedValueOnce([parent]); // provideSupertypes

    const result = (await handleGetTypeHierarchy({
      ...BASE_PARAMS,
      direction: "supertypes",
    })) as any;

    expect(result.supertypes).toHaveLength(1);
    expect(result.subtypes).toHaveLength(0);
    expect(result.direction).toBe("supertypes");
    // provideSubtypes should NOT have been called — only 2 calls total
    expect(vscode.commands.executeCommand).toHaveBeenCalledTimes(2);
  });

  it("fetches only subtypes when direction='subtypes' and does NOT call provideSupertypes", async () => {
    const rootItem = makeItem("Animal", 4, "/src/Animal.ts", 0, 0);
    const child = makeItem("Dog", 4, "/src/Dog.ts", 0, 0);

    vi.mocked(vscode.commands.executeCommand)
      .mockResolvedValueOnce([rootItem]) // prepareTypeHierarchy
      .mockResolvedValueOnce([child]); // provideSubtypes

    const result = (await handleGetTypeHierarchy({
      ...BASE_PARAMS,
      direction: "subtypes",
    })) as any;

    expect(result.supertypes).toHaveLength(0);
    expect(result.subtypes).toHaveLength(1);
    expect(result.direction).toBe("subtypes");
    // provideSupertypes should NOT have been called — only 2 calls total
    expect(vscode.commands.executeCommand).toHaveBeenCalledTimes(2);
  });

  it("respects maxResults cap for supertypes and subtypes", async () => {
    const rootItem = makeItem("Animal", 4, "/src/Animal.ts", 0, 0);
    const manyParents = Array.from({ length: 30 }, (_, i) =>
      makeItem(`Parent${i}`, 4, `/src/Parent${i}.ts`, i, 0),
    );
    const manyChildren = Array.from({ length: 30 }, (_, i) =>
      makeItem(`Child${i}`, 4, `/src/Child${i}.ts`, i, 0),
    );

    vi.mocked(vscode.commands.executeCommand)
      .mockResolvedValueOnce([rootItem]) // prepareTypeHierarchy
      .mockResolvedValueOnce(manyParents) // provideSupertypes
      .mockResolvedValueOnce(manyChildren); // provideSubtypes

    const result = (await handleGetTypeHierarchy({
      ...BASE_PARAMS,
      maxResults: 5,
    })) as any;

    expect(result.supertypes).toHaveLength(5);
    expect(result.subtypes).toHaveLength(5);
  });

  it("uses default maxResults of 20 when not specified", async () => {
    const rootItem = makeItem("Animal", 4, "/src/Animal.ts", 0, 0);
    const manyParents = Array.from({ length: 30 }, (_, i) =>
      makeItem(`Parent${i}`, 4, `/src/Parent${i}.ts`, i, 0),
    );

    vi.mocked(vscode.commands.executeCommand)
      .mockResolvedValueOnce([rootItem])
      .mockResolvedValueOnce(manyParents)
      .mockResolvedValueOnce([]);

    const result = (await handleGetTypeHierarchy(BASE_PARAMS)) as any;
    expect(result.supertypes).toHaveLength(20);
  });
});
