import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  escapeRegex,
  wordAtPosition,
  createGoToDefinitionTool,
  createFindReferencesTool,
  createSearchWorkspaceSymbolsTool,
} from "../lsp.js";

// ── Pure helper tests ─────────────────────────────────────────────────────

describe("escapeRegex", () => {
  it("escapes special regex characters", () => {
    expect(escapeRegex("foo.bar")).toBe("foo\\.bar");
    expect(escapeRegex("a*b+c?")).toBe("a\\*b\\+c\\?");
    expect(escapeRegex("(group)")).toBe("\\(group\\)");
    expect(escapeRegex("[0]")).toBe("\\[0\\]");
  });

  it("leaves alphanumeric chars alone", () => {
    expect(escapeRegex("fooBar123")).toBe("fooBar123");
  });
});

describe("wordAtPosition", () => {
  const code = "const foo = bar.baz(qux);";

  it("extracts word at start of line", () => {
    expect(wordAtPosition(code, 1, 1)).toBe("const");
  });

  it("extracts word in middle", () => {
    expect(wordAtPosition(code, 1, 7)).toBe("foo");
  });

  it("extracts word after dot", () => {
    expect(wordAtPosition(code, 1, 17)).toBe("baz");
  });

  it("returns null for non-word position", () => {
    // column 12 is '=' preceded by space
    expect(wordAtPosition(code, 1, 12)).toBe(null);
  });

  it("handles multi-line content", () => {
    const multiline = "line1\nfunction hello() {}";
    expect(wordAtPosition(multiline, 2, 10)).toBe("hello");
  });

  it("returns null for invalid line", () => {
    expect(wordAtPosition(code, 99, 1)).toBe(null);
  });

  it("handles $ in identifiers", () => {
    const jquery = "const $el = $(selector);";
    expect(wordAtPosition(jquery, 1, 7)).toBe("$el");
  });
});

// ── Integration tests with real files and ripgrep ─────────────────────────

function mockDisconnectedExtensionClient(): any {
  return {
    isConnected: () => false,
    goToDefinition: () => null,
    findReferences: () => null,
    searchSymbols: () => null,
  };
}

function isRgAvailable(): boolean {
  try {
    execFileSync("rg", ["--version"], { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

const rgAvailable = isRgAvailable();

describe.skipIf(!rgAvailable)("goToDefinition grep fallback", () => {
  let workspace: string;
  let tool: ReturnType<typeof createGoToDefinitionTool>;

  beforeAll(() => {
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), "test-lsp-goto-"));
    tool = createGoToDefinitionTool(workspace, mockDisconnectedExtensionClient());

    fs.writeFileSync(
      path.join(workspace, "math.ts"),
      `export function calculateSum(a: number, b: number): number {\n  return a + b;\n}\n`,
    );
    fs.writeFileSync(
      path.join(workspace, "main.ts"),
      `import { calculateSum } from "./math";\nconst result = calculateSum(1, 2);\n`,
    );
  });

  afterAll(() => {
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  it("finds definition by grep pattern", async () => {
    const result = await tool.handler({ filePath: "main.ts", line: 2, column: 17 });
    const data = JSON.parse((result as any).content[0].text);
    expect(data.found).toBe(true);
    expect(data.source).toBe("lexical-grep");
    expect(data.symbol).toBe("calculateSum");
    expect(data.definitions.length).toBeGreaterThanOrEqual(1);
    const mathDef = data.definitions.find((d: any) => d.filePath.includes("math.ts"));
    expect(mathDef).toBeTruthy();
  });

  it("returns not found for symbol at non-word position", async () => {
    // Line 1 col 1 of main.ts is "import" — this IS a word but won't match definition patterns
    const result = await tool.handler({ filePath: "main.ts", line: 1, column: 1 });
    const data = JSON.parse((result as any).content[0].text);
    expect(data.source).toBe("lexical-grep");
  });
});

describe.skipIf(!rgAvailable)("findReferences grep fallback", () => {
  let workspace: string;
  let tool: ReturnType<typeof createFindReferencesTool>;

  beforeAll(() => {
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), "test-lsp-refs-"));
    tool = createFindReferencesTool(workspace, mockDisconnectedExtensionClient());

    fs.writeFileSync(
      path.join(workspace, "lib.ts"),
      `export function greet(name: string) {\n  return "Hello " + name;\n}\n`,
    );
    fs.writeFileSync(
      path.join(workspace, "app.ts"),
      `import { greet } from "./lib";\nconsole.log(greet("world"));\nconsole.log(greet("Claude"));\n`,
    );
  });

  afterAll(() => {
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  it("finds all references across files", async () => {
    const result = await tool.handler({ filePath: "lib.ts", line: 1, column: 17 });
    const data = JSON.parse((result as any).content[0].text);
    expect(data.found).toBe(true);
    expect(data.source).toBe("lexical-grep");
    expect(data.symbol).toBe("greet");
    // Should find at least 3: definition + 2 usages in app.ts + import
    expect(data.references.length).toBeGreaterThanOrEqual(3);
  });
});

describe.skipIf(!rgAvailable)("searchWorkspaceSymbols grep fallback", () => {
  let workspace: string;
  let tool: ReturnType<typeof createSearchWorkspaceSymbolsTool>;

  beforeAll(() => {
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), "test-lsp-symbols-"));
    tool = createSearchWorkspaceSymbolsTool(workspace, mockDisconnectedExtensionClient());

    fs.writeFileSync(
      path.join(workspace, "models.ts"),
      `export interface UserProfile {\n  name: string;\n}\n\nexport class UserService {\n  getUser() {}\n}\n`,
    );
    fs.writeFileSync(
      path.join(workspace, "utils.ts"),
      `export function formatUser(u: any) {\n  return u.name;\n}\n`,
    );
  });

  afterAll(() => {
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  it("finds symbols matching query", async () => {
    const result = await tool.handler({ query: "User" });
    const data = JSON.parse((result as any).content[0].text);
    expect(data.source).toBe("lexical-grep");
    expect(data.symbols.length).toBeGreaterThanOrEqual(2);
    const texts = data.symbols.map((s: any) => s.text);
    expect(texts.some((t: string) => t.includes("UserProfile"))).toBe(true);
    expect(texts.some((t: string) => t.includes("UserService"))).toBe(true);
  });

  it("returns empty for non-existent symbol", async () => {
    const result = await tool.handler({ query: "NonExistentXyz123" });
    const data = JSON.parse((result as any).content[0].text);
    expect(data.symbols.length).toBe(0);
  });
});

describe("searchWorkspaceSymbols validation", () => {
  it("rejects empty query", async () => {
    const tool = createSearchWorkspaceSymbolsTool("/tmp", mockDisconnectedExtensionClient());
    const result = await tool.handler({ query: "   " });
    expect((result as any).isError).toBe(true);
  });
});
