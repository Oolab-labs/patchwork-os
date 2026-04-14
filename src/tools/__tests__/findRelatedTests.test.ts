import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createFindRelatedTestsTool } from "../findRelatedTests.js";

function parse(r: { content: Array<{ text: string }> }) {
  return JSON.parse(r.content[0]?.text ?? "{}");
}

let workspace: string;

beforeAll(() => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), "find-related-tests-"));

  // Source file
  fs.mkdirSync(path.join(workspace, "src"), { recursive: true });
  fs.writeFileSync(
    path.join(workspace, "src", "utils.ts"),
    "export function add(a: number, b: number) { return a + b; }\n",
  );

  // Co-located test file (name-pattern match)
  fs.writeFileSync(
    path.join(workspace, "src", "utils.test.ts"),
    "import { add } from './utils';\ndescribe('add', () => { it('works', () => {}); });\n",
  );

  // Test file in __tests__ dir that imports the source (import-reference match)
  fs.mkdirSync(path.join(workspace, "src", "__tests__"), { recursive: true });
  fs.writeFileSync(
    path.join(workspace, "src", "__tests__", "utils.spec.ts"),
    "import { add } from '../utils';\ndescribe('add', () => {});\n",
  );

  // Unrelated test file (should NOT appear)
  fs.writeFileSync(
    path.join(workspace, "src", "other.test.ts"),
    "describe('other', () => {});\n",
  );
});

afterAll(() => {
  fs.rmSync(workspace, { recursive: true, force: true });
});

const noProbes = { rg: false } as never;

describe("createFindRelatedTestsTool", () => {
  it("returns required output fields", async () => {
    const tool = createFindRelatedTestsTool(workspace, noProbes);
    const result = parse(
      await tool.handler({ filePath: path.join(workspace, "src", "utils.ts") }),
    );
    expect(typeof result.sourceFile).toBe("string");
    expect(Array.isArray(result.testFiles)).toBe(true);
    expect(typeof result.totalFound).toBe("number");
    expect(typeof result.coverageAvailable).toBe("boolean");
  });

  it("finds test file by name-pattern via find", async () => {
    const tool = createFindRelatedTestsTool(workspace, noProbes);
    const result = parse(
      await tool.handler({ filePath: path.join(workspace, "src", "utils.ts") }),
    );
    const nameMatches = result.testFiles.filter(
      (f: { matchReason: string }) => f.matchReason === "name-pattern",
    );
    expect(nameMatches.length).toBeGreaterThan(0);
    expect(
      nameMatches.some((f: { file: string }) => f.file.includes("utils.test")),
    ).toBe(true);
  });

  it("accepts workspace-relative path", async () => {
    const tool = createFindRelatedTestsTool(workspace, noProbes);
    const result = parse(await tool.handler({ filePath: "src/utils.ts" }));
    expect(result.totalFound).toBeGreaterThan(0);
  });

  it("coverageAvailable is false when no coverage file exists", async () => {
    const tool = createFindRelatedTestsTool(workspace, noProbes);
    const result = parse(
      await tool.handler({
        filePath: path.join(workspace, "src", "utils.ts"),
        includeCoverage: true,
      }),
    );
    expect(result.coverageAvailable).toBe(false);
  });

  it("coverageAvailable is true when coverage-summary.json present", async () => {
    const covDir = path.join(workspace, "coverage");
    fs.mkdirSync(covDir, { recursive: true });
    const covData = {
      total: { lines: { pct: 100 } },
      [path.join(workspace, "src/utils.ts")]: { lines: { pct: 85 } },
    };
    fs.writeFileSync(
      path.join(covDir, "coverage-summary.json"),
      JSON.stringify(covData),
    );

    const tool = createFindRelatedTestsTool(workspace, noProbes);
    const result = parse(
      await tool.handler({
        filePath: path.join(workspace, "src", "utils.ts"),
        includeCoverage: true,
      }),
    );
    expect(result.coverageAvailable).toBe(true);

    fs.rmSync(covDir, { recursive: true, force: true });
  });

  it("name-pattern matches sorted before import-reference", async () => {
    // With rg available, we can test sorting. With find-only, we just check structure.
    const tool = createFindRelatedTestsTool(workspace, noProbes);
    const result = parse(
      await tool.handler({ filePath: path.join(workspace, "src", "utils.ts") }),
    );
    if (result.testFiles.length >= 2) {
      // name-pattern matches should come first
      const firstReason = result.testFiles[0].matchReason;
      expect(firstReason).toBe("name-pattern");
    }
  });

  it("returns memoryGraphHint for deep discovery", async () => {
    const tool = createFindRelatedTestsTool(workspace, noProbes);
    const result = parse(
      await tool.handler({ filePath: path.join(workspace, "src", "utils.ts") }),
    );
    expect(typeof result.memoryGraphHint).toBe("string");
    expect(result.memoryGraphHint).toContain("utils");
  });

  it("returns empty testFiles for file with no matching tests", async () => {
    const loneFile = path.join(workspace, "src", "completely_unique_xyzzy.ts");
    fs.writeFileSync(loneFile, "export const x = 1;\n");

    const tool = createFindRelatedTestsTool(workspace, noProbes);
    const result = parse(await tool.handler({ filePath: loneFile }));
    expect(result.testFiles.length).toBe(0);
    expect(result.totalFound).toBe(0);

    fs.rmSync(loneFile);
  });

  it("sourceFile is workspace-relative", async () => {
    const tool = createFindRelatedTestsTool(workspace, noProbes);
    const result = parse(
      await tool.handler({ filePath: path.join(workspace, "src", "utils.ts") }),
    );
    expect(result.sourceFile).not.toContain(workspace);
    expect(result.sourceFile).toMatch(/utils\.ts$/);
  });
});
