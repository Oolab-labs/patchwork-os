import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFixAllLintErrorsTool } from "../fixAllLintErrors.js";

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
  stderr: "lint error output",
  exitCode: 1,
  timedOut: false,
  durationMs: 10,
};

function makeClient(connected: boolean, fixResult: unknown = {}) {
  return {
    isConnected: () => connected,
    fixAllLintErrors: vi.fn().mockResolvedValue(connected ? fixResult : null),
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
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fix-lint-test-"));
  tsFile = path.join(tmpDir, "index.ts");
  fs.writeFileSync(tsFile, "const x = 1\n");
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ── File not found ────────────────────────────────────────────────────────────

describe("fixAllLintErrors: file not found", () => {
  it("returns error when file does not exist", async () => {
    const tool = createFixAllLintErrorsTool(
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

describe("fixAllLintErrors: extension path", () => {
  it("returns source: extension and detects modification", async () => {
    const client = makeClient(true, {});
    // Simulate extension modifying the file
    const modifiedContent = "const x = 1;\n";
    (client.fixAllLintErrors as any).mockImplementation(async () => {
      fs.writeFileSync(tsFile, modifiedContent);
      return {};
    });
    const tool = createFixAllLintErrorsTool(tmpDir, makeProbes(), client);
    const result = await tool.handler({ filePath: tsFile });
    expect(result.isError).toBeFalsy();
    const data = parse(result);
    expect(data.source).toBe("extension");
    expect(data.changes).toBe("modified");
  });

  it("returns changes: none when file is unchanged", async () => {
    const originalContent = fs.readFileSync(tsFile, "utf-8");
    const client = makeClient(true, {});
    (client.fixAllLintErrors as any).mockImplementation(async () => {
      // Don't modify the file
      return {};
    });
    // Ensure content is same
    fs.writeFileSync(tsFile, originalContent);
    const tool = createFixAllLintErrorsTool(tmpDir, makeProbes(), client);
    const result = await tool.handler({ filePath: tsFile });
    const data = parse(result);
    expect(data.source).toBe("extension");
    expect(data.changes).toBe("none");
  });
});

// ── CLI fallback: eslint ──────────────────────────────────────────────────────

describe("fixAllLintErrors: CLI eslint fallback", () => {
  it("uses eslint when probe is available", async () => {
    mockExecSafe.mockResolvedValue(okResult);
    const tool = createFixAllLintErrorsTool(
      tmpDir,
      makeProbes({ eslint: true }),
      makeClient(false),
    );
    const result = await tool.handler({ filePath: tsFile });
    expect(result.isError).toBeFalsy();
    const data = parse(result);
    expect(data.source).toBe("cli");
    expect(data.fixerUsed).toBe("eslint");
    expect(mockExecSafe).toHaveBeenCalledWith(
      "eslint",
      expect.arrayContaining(["--fix", tsFile]),
      expect.any(Object),
    );
  });

  it("uses biome when eslint probe is absent", async () => {
    mockExecSafe.mockResolvedValue(okResult);
    const tool = createFixAllLintErrorsTool(
      tmpDir,
      makeProbes({ biome: true }),
      makeClient(false),
    );
    const result = await tool.handler({ filePath: tsFile });
    const data = parse(result);
    expect(data.fixerUsed).toBe("biome");
  });

  it("returns error when no probe is available", async () => {
    const tool = createFixAllLintErrorsTool(
      tmpDir,
      makeProbes(),
      makeClient(false),
    );
    const result = await tool.handler({ filePath: tsFile });
    expect(result.isError).toBe(true);
    expect(parse(result).error).toMatch(/eslint|biome/i);
  });

  it("returns error when fixer exits non-zero", async () => {
    mockExecSafe.mockResolvedValue(failResult);
    const tool = createFixAllLintErrorsTool(
      tmpDir,
      makeProbes({ eslint: true }),
      makeClient(false),
    );
    const result = await tool.handler({ filePath: tsFile });
    expect(result.isError).toBe(true);
    expect(parse(result).error).toContain("lint error output");
  });
});

// ── CLI fallback: unknown extension ──────────────────────────────────────────

describe("fixAllLintErrors: unknown file extension", () => {
  it("returns error for unsupported file type", async () => {
    const rbFile = path.join(tmpDir, "script.rb");
    fs.writeFileSync(rbFile, "def foo; end\n");
    const tool = createFixAllLintErrorsTool(
      tmpDir,
      makeProbes({ eslint: true }),
      makeClient(false),
    );
    const result = await tool.handler({ filePath: rbFile });
    expect(result.isError).toBe(true);
    expect(parse(result).error).toMatch(/\.rb/i);
  });
});
