import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createGetSymbolHistoryTool } from "../getSymbolHistory.js";

function parse(r: { content: Array<{ text: string }> }) {
  return JSON.parse(r.content[0]?.text ?? "{}");
}

let workspace: string;
let testFile: string;

beforeAll(async () => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), "symbol-history-test-"));
  // init git repo so checkGitRepo passes
  const { execSync } = await import("node:child_process");
  execSync("git init -b main", { cwd: workspace });
  execSync('git config user.email "test@test.com"', { cwd: workspace });
  execSync('git config user.name "Test"', { cwd: workspace });
  testFile = path.join(workspace, "src", "app.ts");
  fs.mkdirSync(path.dirname(testFile), { recursive: true });
  fs.writeFileSync(testFile, "export function hello() { return 1; }\n");
  execSync("git add .", { cwd: workspace });
  execSync('git commit -m "initial"', { cwd: workspace });
});

afterAll(() => {
  fs.rmSync(workspace, { recursive: true, force: true });
});

function makeExtClient(opts: {
  connected?: boolean;
  definition?: unknown;
  definitionError?: boolean;
}) {
  const { connected = true, definition, definitionError = false } = opts;
  return {
    isConnected: vi.fn().mockReturnValue(connected),
    goToDefinition: definitionError
      ? vi.fn().mockRejectedValue(new Error("LSP error"))
      : vi.fn().mockResolvedValue(definition ?? null),
  } as never;
}

describe("createGetSymbolHistoryTool", () => {
  it("returns isError when extension disconnected", async () => {
    const ext = makeExtClient({ connected: false });
    const tool = createGetSymbolHistoryTool(workspace, ext);
    const result = await tool.handler({
      filePath: testFile,
      line: 1,
      column: 1,
    });
    expect(result.isError).toBe(true);
  });

  it("returns required output fields on success", async () => {
    const ext = makeExtClient({
      definition: [{ uri: `file://${testFile}`, line: 1 }],
    });
    const tool = createGetSymbolHistoryTool(workspace, ext);
    const result = parse(
      await tool.handler({ filePath: testFile, line: 1, column: 1 }),
    );
    expect(result.symbol).toBeDefined();
    expect(result.symbol.queryFile).toBe(testFile);
    expect(result.symbol.queryLine).toBe(1);
    expect(Array.isArray(result.blame)).toBe(true);
    expect(Array.isArray(result.recentCommits)).toBe(true);
  });

  it("populates definition from LSP result", async () => {
    const ext = makeExtClient({
      definition: [{ uri: `file://${testFile}`, line: 1 }],
    });
    const tool = createGetSymbolHistoryTool(workspace, ext);
    const result = parse(
      await tool.handler({ filePath: testFile, line: 1, column: 1 }),
    );
    expect(result.definition).not.toBeNull();
    expect(result.definition.file).toBe(testFile);
    expect(result.definition.line).toBe(1);
  });

  it("definition is null when LSP returns null", async () => {
    const ext = makeExtClient({ definition: null });
    const tool = createGetSymbolHistoryTool(workspace, ext);
    const result = parse(
      await tool.handler({ filePath: testFile, line: 1, column: 1 }),
    );
    expect(result.definition).toBeNull();
  });

  it("definition is null when LSP throws", async () => {
    const ext = makeExtClient({ definitionError: true });
    const tool = createGetSymbolHistoryTool(workspace, ext);
    const result = parse(
      await tool.handler({ filePath: testFile, line: 1, column: 1 }),
    );
    expect(result.definition).toBeNull();
    // blame and commits still attempted on the query file
    expect(Array.isArray(result.blame)).toBe(true);
  });

  it("recentCommits contains at least the initial commit", async () => {
    const ext = makeExtClient({ definition: null });
    const tool = createGetSymbolHistoryTool(workspace, ext);
    const result = parse(
      await tool.handler({ filePath: testFile, line: 1, column: 1 }),
    );
    expect(result.recentCommits.length).toBeGreaterThan(0);
    const first = result.recentCommits[0];
    expect(typeof first.hash).toBe("string");
    expect(first.hash.length).toBe(40);
    expect(typeof first.shortHash).toBe("string");
    expect(typeof first.author).toBe("string");
    expect(typeof first.date).toBe("string");
    expect(typeof first.message).toBe("string");
    expect(first.message).toBe("initial");
  });

  it("maxCommits limits recentCommits length", async () => {
    // add a second commit
    const { execSync } = await import("node:child_process");
    fs.appendFileSync(testFile, "// line 2\n");
    execSync("git add .", { cwd: workspace });
    execSync('git commit -m "second"', { cwd: workspace });

    const ext = makeExtClient({ definition: null });
    const tool = createGetSymbolHistoryTool(workspace, ext);
    const result = parse(
      await tool.handler({
        filePath: testFile,
        line: 1,
        column: 1,
        maxCommits: 1,
      }),
    );
    expect(result.recentCommits.length).toBe(1);
  });

  it("blame contains entries for a tracked file", async () => {
    const ext = makeExtClient({ definition: null });
    const tool = createGetSymbolHistoryTool(workspace, ext);
    const result = parse(
      await tool.handler({ filePath: testFile, line: 1, column: 1 }),
    );
    expect(result.blame.length).toBeGreaterThan(0);
    const entry = result.blame[0];
    expect(typeof entry.line).toBe("number");
    expect(typeof entry.hash).toBe("string");
    expect(typeof entry.author).toBe("string");
    expect(typeof entry.summary).toBe("string");
  });

  it("symbol.queryLine and queryColumn reflect the input", async () => {
    const ext = makeExtClient({ definition: null });
    const tool = createGetSymbolHistoryTool(workspace, ext);
    const result = parse(
      await tool.handler({ filePath: testFile, line: 3, column: 7 }),
    );
    expect(result.symbol.queryLine).toBe(3);
    expect(result.symbol.queryColumn).toBe(7);
  });

  it("file:// URI in definition is decoded to plain path", async () => {
    const ext = makeExtClient({
      definition: [{ uri: `file://${testFile}`, line: 1 }],
    });
    const tool = createGetSymbolHistoryTool(workspace, ext);
    const result = parse(
      await tool.handler({ filePath: testFile, line: 1, column: 1 }),
    );
    expect(result.definition.file).not.toContain("file://");
    expect(result.definition.file).toBe(testFile);
  });
});
