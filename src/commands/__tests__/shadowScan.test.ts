import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  parseRunsFile,
  parseSinceDuration,
  runShadowScanCli,
} from "../shadowScan.js";

// ---------------------------------------------------------------------------
// parseSinceDuration
// ---------------------------------------------------------------------------

describe("parseSinceDuration", () => {
  it("parses '24h' to a date ~24 hours ago", () => {
    const before = Date.now();
    const result = parseSinceDuration("24h");
    const after = Date.now();

    const expectedMs = 24 * 3_600_000;
    const lower = before - expectedMs;
    const upper = after - expectedMs;

    expect(result.getTime()).toBeGreaterThanOrEqual(lower - 1000);
    expect(result.getTime()).toBeLessThanOrEqual(upper + 1000);
  });

  it("parses '7d' to a date ~7 days ago", () => {
    const before = Date.now();
    const result = parseSinceDuration("7d");
    const after = Date.now();

    const expectedMs = 7 * 86_400_000;
    const lower = before - expectedMs;
    const upper = after - expectedMs;

    expect(result.getTime()).toBeGreaterThanOrEqual(lower - 1000);
    expect(result.getTime()).toBeLessThanOrEqual(upper + 1000);
  });

  it("parses '1h' to a date ~1 hour ago", () => {
    const before = Date.now();
    const result = parseSinceDuration("1h");
    const after = Date.now();

    const expectedMs = 3_600_000;
    expect(result.getTime()).toBeGreaterThanOrEqual(before - expectedMs - 1000);
    expect(result.getTime()).toBeLessThanOrEqual(after - expectedMs + 1000);
  });

  it("parses '30d' to a date ~30 days ago", () => {
    const before = Date.now();
    const result = parseSinceDuration("30d");
    const after = Date.now();

    const expectedMs = 30 * 86_400_000;
    expect(result.getTime()).toBeGreaterThanOrEqual(before - expectedMs - 1000);
    expect(result.getTime()).toBeLessThanOrEqual(after - expectedMs + 1000);
  });

  it("parses a valid ISO 8601 string directly", () => {
    const iso = "2025-01-15T12:00:00.000Z";
    const result = parseSinceDuration(iso);
    expect(result.toISOString()).toBe(iso);
  });

  it("throws on an invalid string", () => {
    expect(() => parseSinceDuration("not-a-date")).toThrow(
      /Invalid since value/,
    );
  });

  it("handles whitespace-padded relative strings", () => {
    const before = Date.now();
    const result = parseSinceDuration("  24h  ");
    const after = Date.now();
    const expectedMs = 24 * 3_600_000;
    expect(result.getTime()).toBeGreaterThanOrEqual(before - expectedMs - 1000);
    expect(result.getTime()).toBeLessThanOrEqual(after - expectedMs + 1000);
  });
});

// ---------------------------------------------------------------------------
// parseRunsFile
// ---------------------------------------------------------------------------

describe("parseRunsFile", () => {
  it("parses valid JSONL into RunRecord array", () => {
    const record1 = {
      id: "r1",
      recipeName: "daily",
      toolName: "getDiagnostics",
      args: { uri: "src/index.ts" },
      timestamp: "2025-01-15T10:00:00.000Z",
    };
    const record2 = {
      id: "r2",
      recipeName: "nightly",
      toolName: "deleteFile",
      args: { filePath: "tmp/old.txt" },
      result: { success: true },
      timestamp: "2025-01-15T11:00:00.000Z",
    };
    const content = `${JSON.stringify(record1)}\n${JSON.stringify(record2)}\n`;

    const result = parseRunsFile(content);

    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject(record1);
    expect(result[1]).toMatchObject(record2);
  });

  it("skips malformed JSON lines gracefully", () => {
    const validRecord = {
      id: "r1",
      recipeName: "daily",
      toolName: "getDiagnostics",
      args: {},
      timestamp: "2025-01-15T10:00:00.000Z",
    };
    const content =
      `${JSON.stringify(validRecord)}\n` +
      "this is not valid json\n" +
      `${JSON.stringify({ ...validRecord, id: "r2" })}\n`;

    const result = parseRunsFile(content);

    expect(result).toHaveLength(2);
    expect(result[0]?.id).toBe("r1");
    expect(result[1]?.id).toBe("r2");
  });

  it("returns empty array for empty file content", () => {
    expect(parseRunsFile("")).toHaveLength(0);
    expect(parseRunsFile("\n\n\n")).toHaveLength(0);
  });

  it("skips non-object JSON values (strings, numbers, arrays)", () => {
    const content =
      '"just a string"\n' +
      "42\n" +
      "[1, 2, 3]\n" +
      `${JSON.stringify({ id: "r1", recipeName: "x", toolName: "y", args: {}, timestamp: "2025-01-15T00:00:00.000Z" })}\n`;

    const result = parseRunsFile(content);

    expect(result).toHaveLength(1);
    expect(result[0]?.id).toBe("r1");
  });

  it("handles JSONL with no trailing newline", () => {
    const record = {
      id: "r1",
      recipeName: "daily",
      toolName: "getDiagnostics",
      args: {},
      timestamp: "2025-01-15T10:00:00.000Z",
    };
    const result = parseRunsFile(JSON.stringify(record));
    expect(result).toHaveLength(1);
    expect(result[0]?.id).toBe("r1");
  });

  it("preserves all fields including optional result", () => {
    const record = {
      id: "r1",
      recipeName: "daily",
      toolName: "runInTerminal",
      args: { command: "echo hi" },
      result: { stdout: "hi\n", exitCode: 0 },
      timestamp: "2025-01-15T10:00:00.000Z",
    };
    const result = parseRunsFile(`${JSON.stringify(record)}\n`);
    expect(result[0]).toMatchObject(record);
  });
});

// ---------------------------------------------------------------------------
// runShadowScanCli — the CLI entrypoint (buildLoadPastRuns, path resolution,
// printHumanReadable, exit-code signaling) had zero coverage: the tests above
// only exercised the two exported pure helpers directly.
// ---------------------------------------------------------------------------

describe("runShadowScanCli", () => {
  let workdir: string;
  let stdoutSpy: ReturnType<typeof vi.spyOn>;
  let stderrSpy: ReturnType<typeof vi.spyOn>;
  let origExitCode: typeof process.exitCode;

  beforeEach(() => {
    workdir = mkdtempSync(join(tmpdir(), "shadow-scan-cli-test-"));
    stdoutSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
    stderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    origExitCode = process.exitCode;
    process.exitCode = undefined;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(workdir, { recursive: true, force: true });
    process.exitCode = origExitCode;
  });

  function stdout(): string {
    return stdoutSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("");
  }

  it("reads a workspace-scoped --runs-file, reports scanned/reclassified counts in human-readable form, and sets exitCode 1 when any run is reclassified", async () => {
    const runsFile = join(workdir, "runs.jsonl");
    writeFileSync(
      runsFile,
      [
        JSON.stringify({
          id: "r1",
          recipeName: "daily",
          toolName: "deleteFile",
          timestamp: new Date().toISOString(),
        }),
        JSON.stringify({
          id: "r2",
          recipeName: "daily",
          toolName: "getGitStatus",
          timestamp: new Date().toISOString(),
        }),
      ].join("\n"),
    );

    await runShadowScanCli({
      runsFile: "runs.jsonl",
      workspace: workdir,
      since: "30d",
    });

    expect(stdout()).toContain("Scanned: 2");
    expect(stdout()).toContain("Reclassified: 1");
    expect(stdout()).toContain("[REVIEW] daily / deleteFile");
    expect(process.exitCode).toBe(1);
  });

  it("does not set exitCode and prints 'No runs would be reclassified' when nothing is destructive", async () => {
    const runsFile = join(workdir, "runs.jsonl");
    writeFileSync(
      runsFile,
      JSON.stringify({
        id: "r1",
        recipeName: "daily",
        toolName: "getGitStatus",
        timestamp: new Date().toISOString(),
      }),
    );

    await runShadowScanCli({
      runsFile: "runs.jsonl",
      workspace: workdir,
      since: "30d",
    });

    expect(stdout()).toContain("No runs would be reclassified.");
    expect(process.exitCode).toBeUndefined();
  });

  it("rejects a --runs-file that escapes the workspace via resolveFilePath's path-traversal guard", async () => {
    await expect(
      runShadowScanCli({
        runsFile: "../../../etc/passwd",
        workspace: workdir,
      }),
    ).rejects.toThrow();
  });

  it("returns an empty scan (not a throw) when the default runs path does not exist", async () => {
    // No --runs-file supplied → defaultRunsPath() is used, which points at
    // the real ~/.claude/ide/runs.jsonl. We can't control whether that file
    // exists on the machine running this test, so instead verify the ENOENT
    // branch directly through a workspace-scoped file we simply never create.
    await runShadowScanCli({
      runsFile: "does-not-exist.jsonl",
      workspace: workdir,
      since: "30d",
    });
    expect(stdout()).toContain("Scanned: 0");
    expect(process.exitCode).toBeUndefined();
  });

  it("skips reading (and reports zero scanned) when the runs file exceeds the 1 MB size limit", async () => {
    const runsFile = join(workdir, "big-runs.jsonl");
    writeFileSync(runsFile, "x".repeat(1_048_577));

    await runShadowScanCli({
      runsFile: "big-runs.jsonl",
      workspace: workdir,
      since: "30d",
    });

    expect(
      stderrSpy.mock.calls.map((c: unknown[]) => String(c[0])).join(""),
    ).toContain("> 1 MB limit");
    expect(stdout()).toContain("Scanned: 0");
  });

  it("outputs JSON instead of human-readable text when options.json is set", async () => {
    const runsFile = join(workdir, "runs.jsonl");
    writeFileSync(
      runsFile,
      JSON.stringify({
        id: "r1",
        recipeName: "daily",
        toolName: "deleteFile",
        timestamp: new Date().toISOString(),
      }),
    );

    await runShadowScanCli({
      runsFile: "runs.jsonl",
      workspace: workdir,
      since: "30d",
      json: true,
    });

    const parsed = JSON.parse(stdout());
    expect(parsed.scanned).toBe(1);
    expect(parsed.reclassified).toBe(1);
  });

  it("defaults --since to the last 7 days when not supplied", async () => {
    const runsFile = join(workdir, "runs.jsonl");
    // A run from 30 days ago should be excluded by the default 7-day window.
    writeFileSync(
      runsFile,
      JSON.stringify({
        id: "r1",
        recipeName: "daily",
        toolName: "deleteFile",
        timestamp: new Date(Date.now() - 30 * 86_400_000).toISOString(),
      }),
    );

    await runShadowScanCli({ runsFile: "runs.jsonl", workspace: workdir });

    expect(stdout()).toContain("Scanned: 0");
  });
});
