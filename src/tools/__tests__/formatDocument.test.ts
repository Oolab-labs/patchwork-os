import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFormatDocumentTool } from "../formatDocument.js";

// Mock execSafe while keeping all other utils intact
vi.mock("../utils.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../utils.js")>();
  return { ...actual, execSafe: vi.fn() };
});

import { execSafe } from "../utils.js";
const mockExecSafe = vi.mocked(execSafe);

const okResult = {
  stdout: "",
  stderr: "",
  exitCode: 0,
  timedOut: false,
  durationMs: 10,
};

const failResult = {
  stdout: "",
  stderr: "formatter error",
  exitCode: 1,
  timedOut: false,
  durationMs: 10,
};

function makeClient(connected: boolean, fmtImpl?: () => Promise<unknown>) {
  return {
    isConnected: () => connected,
    formatDocument: vi
      .fn()
      .mockImplementation(fmtImpl ?? (async () => (connected ? {} : null))),
  } as unknown as import("../../extensionClient.js").ExtensionClient;
}

function makeProbes(overrides: Record<string, boolean> = {}) {
  return {
    eslint: false,
    biome: false,
    prettier: false,
    black: false,
    ruff: false,
    gofmt: false,
    rustfmt: false,
    cargo: false,
    pipAudit: false,
    ...overrides,
  } as import("../../probe.js").ProbeResults;
}

function parse(result: any) {
  return JSON.parse(result.content[0].text);
}

let tmpDir: string;
let tsFile: string;

beforeEach(() => {
  vi.clearAllMocks();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "format-doc-test-"));
  tsFile = path.join(tmpDir, "index.ts");
  fs.writeFileSync(tsFile, "const x=1\n");
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ── File not found ────────────────────────────────────────────────────────────

describe("formatDocument: file not found", () => {
  it("returns error when file does not exist", async () => {
    const tool = createFormatDocumentTool(
      tmpDir,
      makeProbes(),
      makeClient(false),
    );
    const result = await tool.handler({ filePath: `${tmpDir}/missing.ts` });
    expect(result.isError).toBe(true);
    expect(parse(result).error).toMatch(/not found/i);
  });
});

// ── Extension path ────────────────────────────────────────────────────────────

describe("formatDocument: extension path", () => {
  it("returns source: extension, changes: modified with line counts", async () => {
    const client = makeClient(true, async () => {
      fs.writeFileSync(tsFile, "const x = 1;\n");
      return {};
    });
    const tool = createFormatDocumentTool(tmpDir, makeProbes(), client);
    const result = await tool.handler({ filePath: tsFile });
    expect(result.isError).toBeFalsy();
    const data = parse(result);
    expect(data.source).toBe("extension");
    expect(data.changes).toBe("modified");
    expect(typeof data.linesBeforeCount).toBe("number");
    expect(typeof data.linesAfterCount).toBe("number");
  });

  it("returns changes: none when file is unchanged (no line counts)", async () => {
    const originalContent = fs.readFileSync(tsFile, "utf-8");
    const client = makeClient(true, async () => {
      fs.writeFileSync(tsFile, originalContent);
      return {};
    });
    const tool = createFormatDocumentTool(tmpDir, makeProbes(), client);
    const result = await tool.handler({ filePath: tsFile });
    const data = parse(result);
    expect(data.changes).toBe("none");
    expect(data.linesBeforeCount).toBeUndefined();
  });
});

// ── CLI fallback: prettier ────────────────────────────────────────────────────

describe("formatDocument: CLI prettier fallback", () => {
  it("uses prettier when probe is available", async () => {
    mockExecSafe.mockResolvedValue(okResult);
    const tool = createFormatDocumentTool(
      tmpDir,
      makeProbes({ prettier: true }),
      makeClient(false),
    );
    const result = await tool.handler({ filePath: tsFile });
    expect(result.isError).toBeFalsy();
    const data = parse(result);
    expect(data.source).toBe("cli");
    expect(data.formatterUsed).toBe("prettier");
    expect(mockExecSafe).toHaveBeenCalledWith(
      "prettier",
      expect.arrayContaining(["--write", tsFile]),
      expect.any(Object),
    );
  });

  it("falls back to biome when prettier is absent", async () => {
    mockExecSafe.mockResolvedValue(okResult);
    const tool = createFormatDocumentTool(
      tmpDir,
      makeProbes({ biome: true }),
      makeClient(false),
    );
    const result = await tool.handler({ filePath: tsFile });
    const data = parse(result);
    expect(data.formatterUsed).toBe("biome");
  });

  it("returns error when no formatter probe is available for .ts", async () => {
    const tool = createFormatDocumentTool(
      tmpDir,
      makeProbes(),
      makeClient(false),
    );
    const result = await tool.handler({ filePath: tsFile });
    expect(result.isError).toBe(true);
    expect(parse(result).error).toMatch(/prettier|biome/i);
  });

  it("returns error when formatter exits non-zero", async () => {
    mockExecSafe.mockResolvedValue(failResult);
    const tool = createFormatDocumentTool(
      tmpDir,
      makeProbes({ prettier: true }),
      makeClient(false),
    );
    const result = await tool.handler({ filePath: tsFile });
    expect(result.isError).toBe(true);
    expect(parse(result).error).toContain("formatter error");
  });
});

// ── CLI fallback: Python / ruff ───────────────────────────────────────────────

describe("formatDocument: Python CLI fallback", () => {
  it("uses ruff for .py files", async () => {
    mockExecSafe.mockResolvedValue(okResult);
    const pyFile = path.join(tmpDir, "script.py");
    fs.writeFileSync(pyFile, "x=1\n");
    const tool = createFormatDocumentTool(
      tmpDir,
      makeProbes({ ruff: true }),
      makeClient(false),
    );
    const result = await tool.handler({ filePath: pyFile });
    const data = parse(result);
    expect(data.formatterUsed).toBe("ruff");
  });
});

// ── Unknown extension ─────────────────────────────────────────────────────────

describe("formatDocument: unknown file extension", () => {
  it("returns error for unsupported file type", async () => {
    const rbFile = path.join(tmpDir, "script.rb");
    fs.writeFileSync(rbFile, "def foo; end\n");
    const tool = createFormatDocumentTool(
      tmpDir,
      makeProbes({ prettier: true }),
      makeClient(false),
    );
    const result = await tool.handler({ filePath: rbFile });
    expect(result.isError).toBe(true);
    expect(parse(result).error).toMatch(/\.rb/i);
  });
});
