import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../utils.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../utils.js")>();
  return { ...actual, execSafe: vi.fn() };
});

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, existsSync: vi.fn(() => false) };
});

import { existsSync } from "node:fs";
import { createDetectUnusedCodeTool } from "../detectUnusedCode.js";
import { execSafe } from "../utils.js";

const mockExecSafe = vi.mocked(execSafe);
const mockExistsSync = vi.mocked(existsSync);

function parse(r: { content: Array<{ type: string; text: string }> }) {
  return JSON.parse(r.content[0]?.text ?? "{}");
}

const WORKSPACE = "/tmp/test-ws";

const TSC_OUTPUT = `src/utils.ts(12,5): error TS6133: 'helperFn' is declared but its value is never read.
src/server.ts(45,3): error TS6133: 'unusedVar' is declared but its value is never read.
src/handler.ts(8,12): error TS6192: All destructured elements are unused.`;

const TS_PRUNE_OUTPUT = `src/utils.ts:5 - exportedButUnused
src/models.ts:22 - AnotherUnused`;

describe("detectUnusedCode", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExistsSync.mockReturnValue(false); // no ts-prune by default
  });

  it("falls back to tsc when ts-prune not installed", async () => {
    mockExecSafe.mockResolvedValueOnce({
      stdout: TSC_OUTPUT,
      stderr: "",
      exitCode: 2,
      timedOut: false,
      durationMs: 500,
    });

    const tool = createDetectUnusedCodeTool(WORKSPACE);
    const result = parse(await tool.handler({}));
    expect(result.available).toBe(true);
    expect(result.detector).toBe("tsc");
    expect(result.total).toBe(3);
    expect(result.items[0].file).toBe("src/utils.ts");
    expect(result.items[0].line).toBe(12);
    expect(result.items[0].symbol).toBe("helperFn");
    expect(result.items[0].kind).toBe("local");
  });

  it("correctly identifies parameter kind for TS6192", async () => {
    mockExecSafe.mockResolvedValueOnce({
      stdout: TSC_OUTPUT,
      stderr: "",
      exitCode: 2,
      timedOut: false,
      durationMs: 500,
    });

    const tool = createDetectUnusedCodeTool(WORKSPACE);
    const result = parse(await tool.handler({}));
    const paramItem = result.items.find(
      (i: { kind: string }) => i.kind === "parameter",
    );
    expect(paramItem).toBeDefined();
    expect(paramItem.file).toBe("src/handler.ts");
  });

  it("uses ts-prune when binary exists", async () => {
    // Make ts-prune bin appear to exist
    mockExistsSync.mockImplementation((p) => String(p).endsWith("ts-prune"));
    mockExecSafe.mockResolvedValueOnce({
      stdout: TS_PRUNE_OUTPUT,
      stderr: "",
      exitCode: 1,
      timedOut: false,
      durationMs: 300,
    });

    const tool = createDetectUnusedCodeTool(WORKSPACE);
    const result = parse(await tool.handler({}));
    expect(result.available).toBe(true);
    expect(result.detector).toBe("ts-prune");
    expect(result.total).toBe(2);
    expect(result.items[0].symbol).toBe("exportedButUnused");
    expect(result.items[0].kind).toBe("export");
  });

  it("truncates results when maxResults exceeded", async () => {
    const manyLines = Array.from(
      { length: 10 },
      (_, i) =>
        `src/file.ts(${i + 1},5): error TS6133: 'sym${i}' is declared but its value is never read.`,
    ).join("\n");

    mockExecSafe.mockResolvedValueOnce({
      stdout: manyLines,
      stderr: "",
      exitCode: 2,
      timedOut: false,
      durationMs: 500,
    });

    const tool = createDetectUnusedCodeTool(WORKSPACE);
    const result = parse(await tool.handler({ maxResults: 3 }));
    expect(result.items).toHaveLength(3);
    expect(result.truncated).toBe(true);
    expect(result.total).toBe(10);
  });

  it("returns available:false when no detector available and no output", async () => {
    mockExecSafe.mockResolvedValueOnce({
      stdout: "",
      stderr: "",
      exitCode: 1,
      timedOut: false,
      durationMs: 100,
    });

    const tool = createDetectUnusedCodeTool(WORKSPACE);
    const result = parse(await tool.handler({}));
    expect(result.available).toBe(false);
    expect(result.error).toContain("ts-prune");
  });
});
