import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ProbeResults } from "../../probe.js";
import { createFindFilesTool } from "../findFiles.js";
import { createGetFileTreeTool } from "../getFileTree.js";
import { createSearchWorkspaceTool } from "../searchWorkspace.js";

function parse(result: { content: Array<{ type: string; text: string }> }) {
  return JSON.parse(result.content.at(0)?.text ?? "{}");
}

const allFalseProbes: ProbeResults = {
  rg: false,
  fd: false,
  git: false,
  gh: false,
  tsc: false,
  eslint: false,
  pyright: false,
  ruff: false,
  cargo: false,
  go: false,
  biome: false,
  prettier: false,
  black: false,
  gofmt: false,
  rustfmt: false,
  vitest: false,
  jest: false,
  pytest: false,
};

describe("search tools", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "search-test-"));
    // Create sample workspace files
    fs.writeFileSync(
      path.join(tmpDir, "main.ts"),
      'const greeting = "hello world";\nconsole.log(greeting);\n',
    );
    fs.writeFileSync(
      path.join(tmpDir, "utils.ts"),
      "export function add(a: number, b: number) { return a + b; }\n",
    );
    fs.mkdirSync(path.join(tmpDir, "sub"));
    fs.writeFileSync(
      path.join(tmpDir, "sub", "data.json"),
      '{"key": "value"}\n',
    );
    fs.writeFileSync(
      path.join(tmpDir, "readme.md"),
      "# Project\nSome documentation\n",
    );
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("searchWorkspace", () => {
    it("rejects ReDoS pattern (a+)+b with isRegex:true", async () => {
      const tool = createSearchWorkspaceTool(tmpDir, { ...allFalseProbes });
      const result = await tool.handler({ query: "(a+)+b", isRegex: true });
      const data = parse(result);
      expect(result.isError).toBe(true);
      expect(data.error ?? result.content[0]?.text).toMatch(
        /dangerous|catastrophic|nested quantifier|ReDoS/i,
      );
    });

    it("rejects ReDoS pattern (x+x+)+y with isRegex:true", async () => {
      const tool = createSearchWorkspaceTool(tmpDir, { ...allFalseProbes });
      const result = await tool.handler({ query: "(x+x+)+y", isRegex: true });
      const data = parse(result);
      expect(result.isError).toBe(true);
      expect(data.error ?? result.content[0]?.text).toMatch(
        /dangerous|catastrophic|nested quantifier|ReDoS/i,
      );
    });

    it("allows safe regex patterns", async () => {
      const tool = createSearchWorkspaceTool(tmpDir, { ...allFalseProbes });
      const result = await tool.handler({
        query: "hello\\s+world",
        isRegex: true,
      });
      expect(result.isError).toBeUndefined();
    });

    it("rejects empty query", async () => {
      const tool = createSearchWorkspaceTool(tmpDir, { ...allFalseProbes });
      await expect(tool.handler({ query: "   " })).rejects.toThrow(
        "query must not be empty",
      );
    });

    it("finds text in a file using grep fallback", async () => {
      const tool = createSearchWorkspaceTool(tmpDir, {
        ...allFalseProbes,
        rg: false,
      });
      const result = await tool.handler({ query: "hello world" });
      const data = parse(result);

      expect(data.tool).toBe("grep");
      expect(data.totalMatches).toBeGreaterThanOrEqual(1);
      expect(data.matches.length).toBeGreaterThanOrEqual(1);

      const match = data.matches.find((m: { file: string }) =>
        m.file.includes("main.ts"),
      );
      expect(match).toBeDefined();
      expect(match.matchText).toContain("hello world");
    });

    it("respects caseSensitive option", async () => {
      const tool = createSearchWorkspaceTool(tmpDir, { ...allFalseProbes });
      // Search with wrong case, case-sensitive (default) - should NOT find
      const result = await tool.handler({
        query: "HELLO WORLD",
        caseSensitive: true,
      });
      const data = parse(result);
      expect(data.totalMatches).toBe(0);

      // Search with wrong case, case-insensitive - should find
      const result2 = await tool.handler({
        query: "HELLO WORLD",
        caseSensitive: false,
      });
      const data2 = parse(result2);
      expect(data2.totalMatches).toBeGreaterThanOrEqual(1);
    });

    it("finds text with fileGlob filter", async () => {
      const tool = createSearchWorkspaceTool(tmpDir, { ...allFalseProbes });
      const result = await tool.handler({
        query: "hello world",
        fileGlob: "*.ts",
      });
      const data = parse(result);

      expect(data.totalMatches).toBeGreaterThanOrEqual(1);
      for (const m of data.matches) {
        expect(m.file).toMatch(/\.ts$/);
      }
    });
  });

  describe("findFiles", () => {
    it("finds files by glob pattern using find fallback", async () => {
      const tool = createFindFilesTool(tmpDir, {
        ...allFalseProbes,
        fd: false,
        git: false,
      });
      const result = await tool.handler({ pattern: "*.ts" });
      const data = parse(result);

      expect(data.tool).toBe("find");
      expect(data.files.length).toBe(2);
      const basenames = data.files.map((f: string) => path.basename(f));
      expect(basenames).toContain("main.ts");
      expect(basenames).toContain("utils.ts");
    });

    it("finds json files in subdirectory", async () => {
      const tool = createFindFilesTool(tmpDir, { ...allFalseProbes });
      const result = await tool.handler({ pattern: "*.json" });
      const data = parse(result);

      expect(data.files.length).toBeGreaterThanOrEqual(1);
      const found = data.files.some((f: string) => f.includes("data.json"));
      expect(found).toBe(true);
    });

    it("returns empty for non-matching pattern", async () => {
      const tool = createFindFilesTool(tmpDir, { ...allFalseProbes });
      const result = await tool.handler({ pattern: "*.xyz" });
      const data = parse(result);

      expect(data.files.length).toBe(0);
    });
  });

  describe("getFileTree", () => {
    it("returns file entries for the workspace", async () => {
      const tool = createGetFileTreeTool(tmpDir, { ...allFalseProbes });
      const result = await tool.handler({});
      const data = parse(result);

      expect(data.tool).toBe("fs");
      expect(data.entries.length).toBeGreaterThanOrEqual(3);
      // Should include files and the sub directory
      const entryNames = data.entries.map((e: string) => e.replace(/\/$/, ""));
      expect(entryNames).toContain("main.ts");
      expect(entryNames).toContain("utils.ts");
      expect(entryNames).toContain("readme.md");
    });

    it("includes subdirectory entries", async () => {
      const tool = createGetFileTreeTool(tmpDir, { ...allFalseProbes });
      const result = await tool.handler({});
      const data = parse(result);

      const hasSubDir = data.entries.some((e: string) => e.includes("sub"));
      expect(hasSubDir).toBe(true);
    });

    it("respects maxDepth", async () => {
      // Create a deeply nested structure
      const deep = path.join(tmpDir, "a", "b", "c");
      fs.mkdirSync(deep, { recursive: true });
      fs.writeFileSync(path.join(deep, "deep.txt"), "deep\n");

      const tool = createGetFileTreeTool(tmpDir, { ...allFalseProbes });
      // maxDepth=1 should only show top-level entries
      const result = await tool.handler({ maxDepth: 1 });
      const data = parse(result);

      // Should NOT contain deeply nested files
      const hasDeep = data.entries.some((e: string) => e.includes("deep.txt"));
      expect(hasDeep).toBe(false);
    });
  });
});
