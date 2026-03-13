import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("../utils.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../utils.js")>();
  return { ...actual, execSafe: vi.fn() };
});

import { execSafe } from "../utils.js";
import { createFindFilesTool } from "../findFiles.js";

const mockExecSafe = vi.mocked(execSafe);
const ws = "/fake/workspace";

const ok = (stdout: string) => ({ stdout, stderr: "", exitCode: 0, timedOut: false, durationMs: 10 });

function parse(r: { content: Array<{ type: string; text: string }> }) {
  return JSON.parse(r.content[0]?.text ?? "{}");
}

beforeEach(() => vi.clearAllMocks());

describe("createFindFilesTool — fd path", () => {
  const probes = { fd: true, git: true } as any;

  it("uses fd and returns file list", async () => {
    mockExecSafe.mockResolvedValue(ok("/fake/workspace/src/index.ts\n/fake/workspace/src/app.ts\n"));
    const tool = createFindFilesTool(ws, probes);
    const result = parse(await tool.handler({ pattern: "*.ts" }));
    expect(result.tool).toBe("fd");
    expect(result.files).toContain("src/index.ts");
    expect(result.count).toBe(2);
  });

  it("passes pattern, --max-results, and searchDir to fd", async () => {
    mockExecSafe.mockResolvedValue(ok(""));
    const tool = createFindFilesTool(ws, probes);
    await tool.handler({ pattern: "*.tsx" });
    const args = mockExecSafe.mock.calls[0]?.[1] as string[];
    expect(args).toContain("--glob");
    expect(args).toContain("*.tsx");
    expect(args).toContain("--max-results");
  });

  it("marks truncated when exactly 100 results returned", async () => {
    const lines = Array.from({ length: 100 }, (_, i) => `/fake/workspace/f${i}.ts`).join("\n");
    mockExecSafe.mockResolvedValue(ok(lines));
    const tool = createFindFilesTool(ws, probes);
    const result = parse(await tool.handler({ pattern: "*.ts" }));
    expect(result.truncated).toBe(true);
  });

  it("does not mark truncated when fewer than 100 results", async () => {
    mockExecSafe.mockResolvedValue(ok("/fake/workspace/a.ts\n"));
    const tool = createFindFilesTool(ws, probes);
    const result = parse(await tool.handler({ pattern: "*.ts" }));
    expect(result.truncated).toBeUndefined();
  });
});

describe("createFindFilesTool — git path", () => {
  const probes = { fd: false, git: true } as any;

  it("uses git ls-files and filters by pattern", async () => {
    mockExecSafe.mockResolvedValue(ok("src/index.ts\nsrc/app.ts\nREADME.md\n"));
    const tool = createFindFilesTool(ws, probes);
    const result = parse(await tool.handler({ pattern: "*.ts" }));
    expect(result.tool).toBe("git-ls-files");
    expect(result.files).toContain("src/index.ts");
    expect(result.files).not.toContain("README.md");
  });

  it("supports ** glob patterns", async () => {
    mockExecSafe.mockResolvedValue(ok("deep/nested/file.ts\nshallow.ts\n"));
    const tool = createFindFilesTool(ws, probes);
    const result = parse(await tool.handler({ pattern: "**/*.ts" }));
    expect(result.files).toContain("deep/nested/file.ts");
  });

  it("marks truncated when more than 100 matches exist", async () => {
    const files = Array.from({ length: 150 }, (_, i) => `f${i}.ts`).join("\n");
    mockExecSafe.mockResolvedValue(ok(files));
    const tool = createFindFilesTool(ws, probes);
    const result = parse(await tool.handler({ pattern: "*.ts" }));
    expect(result.truncated).toBe(true);
    expect(result.files).toHaveLength(100);
    expect(result.totalMatches).toBe(150);
  });
});

describe("createFindFilesTool — find fallback", () => {
  const probes = { fd: false, git: false } as any;

  it("falls back to find and returns files", async () => {
    mockExecSafe.mockResolvedValue(ok("/fake/workspace/src/main.ts\n"));
    const tool = createFindFilesTool(ws, probes);
    const result = parse(await tool.handler({ pattern: "*.ts" }));
    expect(result.tool).toBe("find");
    expect(result.files).toContain("src/main.ts");
  });

  it("passes pattern with -name to find", async () => {
    mockExecSafe.mockResolvedValue(ok(""));
    const tool = createFindFilesTool(ws, probes);
    await tool.handler({ pattern: "*.ts" });
    const args = mockExecSafe.mock.calls[0]?.[1] as string[];
    expect(args).toContain("-name");
    expect(args).toContain("*.ts");
  });
});


describe("createFindFilesTool — missing pattern", () => {
  it("throws when pattern is missing", async () => {
    const probes = { fd: false, git: true } as any;
    const tool = createFindFilesTool(ws, probes);
    await expect(tool.handler({})).rejects.toThrow();
  });
});
