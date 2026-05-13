import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    existsSync: vi.fn(() => false),
    promises: { ...actual.promises, readFile: vi.fn() },
  };
});

import { existsSync, promises as fsPromises } from "node:fs";
import path from "node:path";
import { createGetCodeCoverageTool } from "../getCodeCoverage.js";

const mockExistsSync = vi.mocked(existsSync);
const mockReadFile = vi.mocked(fsPromises.readFile);

const WORKSPACE = "/tmp/test-workspace";

function makeHandler() {
  return createGetCodeCoverageTool(WORKSPACE).handler;
}

function parse(result: unknown) {
  return JSON.parse(
    (result as { content: Array<{ text: string }> }).content[0]!.text,
  );
}

describe("getCodeCoverage", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockExistsSync.mockReturnValue(false);
  });

  describe("auto-detection", () => {
    it("returns error when no report found", async () => {
      const result = await makeHandler()({});
      expect((result as { isError: true }).isError).toBe(true);
      const text =
        (result as { content: Array<{ text: string }> }).content[0]?.text ?? "";
      expect(text).toContain("No coverage report found");
    });

    it("detects coverage-summary.json first", async () => {
      const summaryPath = path.join(
        WORKSPACE,
        "coverage",
        "coverage-summary.json",
      );
      mockExistsSync.mockImplementation((p) => p === summaryPath);
      mockReadFile.mockResolvedValue(
        JSON.stringify({
          total: {
            lines: { pct: 80 },
            branches: { pct: 70 },
            functions: { pct: 90 },
          },
          "/some/file.ts": {
            lines: { pct: 75 },
            branches: { pct: 60 },
            functions: { pct: 85 },
          },
        }) as unknown as Buffer,
      );

      const data = parse(await makeHandler()({}));
      expect(data.format).toBe("coverage-summary");
      expect(data.files).toHaveLength(1);
      expect(data.files[0].lines).toBe(75);
    });
  });

  describe("coverage-summary.json parsing", () => {
    it("parses lines/branches/functions percentages", async () => {
      const summaryPath = path.join(
        WORKSPACE,
        "coverage",
        "coverage-summary.json",
      );
      mockExistsSync.mockImplementation((p) => p === summaryPath);
      mockReadFile.mockResolvedValue(
        JSON.stringify({
          total: {
            lines: { pct: 80 },
            branches: { pct: 70 },
            functions: { pct: 90 },
          },
          [`${WORKSPACE}/src/foo.ts`]: {
            lines: { pct: 55.5 },
            branches: { pct: 40 },
            functions: { pct: 66.6 },
          },
          [`${WORKSPACE}/src/bar.ts`]: {
            lines: { pct: 95 },
            branches: { pct: 88 },
            functions: { pct: 100 },
          },
        }) as unknown as Buffer,
      );

      const data = parse(await makeHandler()({}));
      expect(data.format).toBe("coverage-summary");
      expect(data.files).toHaveLength(2);

      // Sorted ascending by lines (worst first)
      expect(data.files[0].file).toBe("src/foo.ts");
      expect(data.files[0].lines).toBe(55.5);
      expect(data.files[0].branches).toBe(40);
      expect(data.files[0].functions).toBe(66.6);
      expect(data.files[1].file).toBe("src/bar.ts");
      expect(data.files[1].lines).toBe(95);
    });

    it("skips the 'total' key", async () => {
      const summaryPath = path.join(
        WORKSPACE,
        "coverage",
        "coverage-summary.json",
      );
      mockExistsSync.mockImplementation((p) => p === summaryPath);
      mockReadFile.mockResolvedValue(
        JSON.stringify({
          total: {
            lines: { pct: 80 },
            branches: { pct: 70 },
            functions: { pct: 90 },
          },
        }) as unknown as Buffer,
      );

      const data = parse(await makeHandler()({}));
      expect(data.files).toHaveLength(0);
    });
  });

  describe("lcov.info parsing", () => {
    it("parses lcov records correctly", async () => {
      const lcovPath = path.join(WORKSPACE, "coverage", "lcov.info");
      mockExistsSync.mockImplementation((p) => p === lcovPath);

      const lcovContent = [
        "SF:/project/src/utils.ts",
        "FNF:5",
        "FNH:4",
        "BRF:10",
        "BRH:7",
        "LF:50",
        "LH:40",
        "end_of_record",
        "SF:/project/src/index.ts",
        "FNF:2",
        "FNH:2",
        "BRF:0",
        "BRH:0",
        "LF:20",
        "LH:20",
        "end_of_record",
      ].join("\n");

      mockReadFile.mockResolvedValue(lcovContent as unknown as Buffer);

      const data = parse(await makeHandler()({}));
      expect(data.format).toBe("lcov");
      expect(data.files).toHaveLength(2);

      const utils = data.files.find((f: { file: string }) =>
        f.file.includes("utils"),
      );
      expect(utils.lines).toBe(80);
      expect(utils.branches).toBe(70);
      expect(utils.functions).toBe(80);

      const index = data.files.find((f: { file: string }) =>
        f.file.includes("index"),
      );
      expect(index.lines).toBe(100);
      expect(index.branches).toBeNull(); // BRF:0 → null
    });
  });

  describe("minCoverage filter", () => {
    it("filters files below threshold", async () => {
      const summaryPath = path.join(
        WORKSPACE,
        "coverage",
        "coverage-summary.json",
      );
      mockExistsSync.mockImplementation((p) => p === summaryPath);
      mockReadFile.mockResolvedValue(
        JSON.stringify({
          total: {},
          [`${WORKSPACE}/src/low.ts`]: {
            lines: { pct: 40 },
            branches: { pct: 30 },
            functions: { pct: 50 },
          },
          [`${WORKSPACE}/src/high.ts`]: {
            lines: { pct: 95 },
            branches: { pct: 90 },
            functions: { pct: 100 },
          },
        }) as unknown as Buffer,
      );

      const data = parse(await makeHandler()({ minCoverage: 80 }));
      expect(data.files).toHaveLength(1);
      expect(data.files[0].file).toBe("src/low.ts");
    });
  });

  describe("sort order", () => {
    it("sorts by line coverage ascending", async () => {
      const summaryPath = path.join(
        WORKSPACE,
        "coverage",
        "coverage-summary.json",
      );
      mockExistsSync.mockImplementation((p) => p === summaryPath);
      mockReadFile.mockResolvedValue(
        JSON.stringify({
          total: {},
          [`${WORKSPACE}/src/c.ts`]: { lines: { pct: 70 } },
          [`${WORKSPACE}/src/a.ts`]: { lines: { pct: 30 } },
          [`${WORKSPACE}/src/b.ts`]: { lines: { pct: 50 } },
        }) as unknown as Buffer,
      );

      const data = parse(await makeHandler()({}));
      expect(data.files.map((f: { file: string }) => f.file)).toEqual([
        "src/a.ts",
        "src/b.ts",
        "src/c.ts",
      ]);
    });
  });

  describe("explicit file path", () => {
    it("uses provided file path", async () => {
      const customPath = path.join(WORKSPACE, "custom", "report.json");
      mockReadFile.mockResolvedValue(
        JSON.stringify({
          total: {},
          [`${WORKSPACE}/src/x.ts`]: { lines: { pct: 88 } },
        }) as unknown as Buffer,
      );

      const data = parse(await makeHandler()({ file: customPath }));
      expect(data.reportFile).toBe(customPath);
    });
  });
});
