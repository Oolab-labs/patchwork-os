import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    existsSync: vi.fn(() => false),
    promises: {
      ...actual.promises,
      readFile: vi.fn(async () => ""),
    },
  };
});

import { existsSync, promises as fsPromises } from "node:fs";
import { createTestTraceToSourceTool } from "../testTraceToSource.js";

const mockExistsSync = vi.mocked(existsSync);
const mockReadFile = vi.mocked(fsPromises.readFile);

const WORKSPACE = "/tmp/test-ws";

function parse(r: { content: Array<{ type: string; text: string }> }) {
  return JSON.parse(r.content[0]?.text ?? "{}");
}

const LCOV_SAMPLE = `SF:/tmp/test-ws/src/auth.ts
DA:1,1
DA:2,0
DA:3,5
end_of_record
SF:/tmp/test-ws/src/utils.ts
DA:10,3
DA:11,0
end_of_record
`;

const COVERAGE_SUMMARY_SAMPLE = JSON.stringify({
  total: { lines: { pct: 75 } },
  "/tmp/test-ws/src/auth.ts": {
    lines: { covered: 2, total: 3, pct: 66.67 },
  },
  "/tmp/test-ws/src/utils.ts": {
    lines: { covered: 1, total: 2, pct: 50 },
  },
});

describe("testTraceToSource", () => {
  const tool = createTestTraceToSourceTool(WORKSPACE);

  beforeEach(() => {
    vi.clearAllMocks();
    mockExistsSync.mockReturnValue(false);
  });

  it("returns error when coverage dir missing", async () => {
    mockExistsSync.mockReturnValue(false);
    const result = await tool.handler({ testPattern: "auth" });
    expect(result.content[0]?.text).toContain("Coverage directory not found");
    expect((result as { isError?: boolean }).isError).toBe(true);
  });

  it("returns error when no coverage files in dir", async () => {
    // dir exists but no lcov/summary
    mockExistsSync.mockImplementation((p) => {
      if (typeof p === "string" && p.endsWith("coverage")) return true;
      return false;
    });
    const result = await tool.handler({ testPattern: "auth" });
    expect(result.content[0]?.text).toContain("No coverage file found");
    expect((result as { isError?: boolean }).isError).toBe(true);
  });

  it("parses lcov.info and filters by pattern", async () => {
    mockExistsSync.mockImplementation((p) => {
      if (typeof p === "string") {
        if (p.endsWith("coverage")) return true;
        if (p.endsWith("lcov.info")) return true;
      }
      return false;
    });
    mockReadFile.mockResolvedValue(LCOV_SAMPLE as unknown as Buffer);

    const result = await tool.handler({ testPattern: "auth" });
    const data = parse(result as Parameters<typeof parse>[0]);

    expect(data.coverageFile).toContain("lcov.info");
    expect(data.sourceFiles).toHaveLength(1);
    expect(data.sourceFiles[0].file).toContain("auth.ts");
    expect(data.sourceFiles[0].coveredLines).toBe(2);
    expect(data.sourceFiles[0].totalLines).toBe(3);
    expect(data.sourceFiles[0].hotLines).toEqual([1, 3]);
    expect(data.note).toContain("lcov.info");
  });

  it("parses coverage-summary.json when lcov missing", async () => {
    mockExistsSync.mockImplementation((p) => {
      if (typeof p === "string") {
        if (p.endsWith("coverage")) return true;
        if (p.endsWith("coverage-summary.json")) return true;
      }
      return false;
    });
    mockReadFile.mockResolvedValue(
      COVERAGE_SUMMARY_SAMPLE as unknown as Buffer,
    );

    const result = await tool.handler({ testPattern: "utils" });
    const data = parse(result as Parameters<typeof parse>[0]);

    expect(data.coverageFile).toContain("coverage-summary.json");
    expect(data.sourceFiles).toHaveLength(1);
    expect(data.sourceFiles[0].file).toContain("utils.ts");
    expect(data.sourceFiles[0].coveredLines).toBe(1);
    expect(data.sourceFiles[0].hotLines).toEqual([]);
    expect(data.note).toContain("coverage-summary.json");
  });

  it("applies minCoverage filter", async () => {
    mockExistsSync.mockImplementation((p) => {
      if (typeof p === "string") {
        if (p.endsWith("coverage")) return true;
        if (p.endsWith("lcov.info")) return true;
      }
      return false;
    });
    mockReadFile.mockResolvedValue(LCOV_SAMPLE as unknown as Buffer);

    // auth.ts ~66%, utils.ts 50%
    const result = await tool.handler({ testPattern: "src", minCoverage: 60 });
    const data = parse(result as Parameters<typeof parse>[0]);

    // Only auth.ts should pass (66% >= 60%)
    expect(data.sourceFiles.every((f: { pct: number }) => f.pct >= 60)).toBe(
      true,
    );
  });

  it("returns all files when pattern matches all filenames", async () => {
    mockExistsSync.mockImplementation((p) => {
      if (typeof p === "string") {
        if (p.endsWith("coverage")) return true;
        if (p.endsWith("lcov.info")) return true;
      }
      return false;
    });
    mockReadFile.mockResolvedValue(LCOV_SAMPLE as unknown as Buffer);

    const result = await tool.handler({ testPattern: "ts" });
    const data = parse(result as Parameters<typeof parse>[0]);

    // "ts" matches both auth.ts and utils.ts
    expect(data.sourceFiles.length).toBeGreaterThanOrEqual(2);
  });

  it("output shape has required fields", async () => {
    mockExistsSync.mockImplementation((p) => {
      if (typeof p === "string") {
        if (p.endsWith("coverage")) return true;
        if (p.endsWith("lcov.info")) return true;
      }
      return false;
    });
    mockReadFile.mockResolvedValue(LCOV_SAMPLE as unknown as Buffer);

    const result = await tool.handler({ testPattern: "auth" });
    const data = parse(result as Parameters<typeof parse>[0]);

    expect(typeof data.coverageFile).toBe("string");
    expect(Array.isArray(data.sourceFiles)).toBe(true);
    expect(typeof data.note).toBe("string");
    for (const sf of data.sourceFiles) {
      expect(typeof sf.file).toBe("string");
      expect(typeof sf.coveredLines).toBe("number");
      expect(typeof sf.totalLines).toBe("number");
      expect(typeof sf.pct).toBe("number");
      expect(Array.isArray(sf.hotLines)).toBe(true);
    }
  });
});

// ── Path traversal guard ───────────────────────────────────────────────────────

describe("testTraceToSource: coverageDir path traversal guard", () => {
  it("rejects coverageDir that escapes the workspace via ../", async () => {
    const tool = createTestTraceToSourceTool(WORKSPACE);
    const result = await tool.handler({
      testPattern: "auth",
      coverageDir: "../../etc",
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/must be within the workspace/i);
  });

  it("rejects absolute coverageDir outside workspace", async () => {
    const tool = createTestTraceToSourceTool(WORKSPACE);
    const result = await tool.handler({
      testPattern: "auth",
      coverageDir: "/etc",
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/must be within the workspace/i);
  });

  it("accepts relative coverageDir inside workspace", async () => {
    const tool = createTestTraceToSourceTool(WORKSPACE);
    // Non-existent dir → "coverage directory not found" error, NOT a traversal error.
    const result = await tool.handler({
      testPattern: "auth",
      coverageDir: "coverage/sub",
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).not.toMatch(/must be within the workspace/i);
  });
});
